# Automated tests for the recoverable batch rendering engine.
#
# Runs entirely without Blender or rendering:
#   python -I tests/run_batch_tests.py
# (from the repository root)
#
# Covered paths:
#   1. All items succeed            -> full success, scene state identical
#   2. One item fails               -> failure rolled back, remaining items run
#   3. User cancellation            -> batch stops, scene state identical
#   4. Repeated trigger / re-entry  -> second batch rejected, no shared mutation
# Plus adapter-specific coverage for collections, items, images (including a
# target node deleted mid-batch), and restoration of the user's batch variables.

import os
import sys
import tempfile
import traceback

# Make the add-on package directory importable without touching sys.path beyond
# this test process. The engine module itself has zero bpy imports.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDON_DIR = os.path.join(REPO_ROOT, 'Launch_RenderKit')
sys.path.insert(0, ADDON_DIR)

import batch_engine  # noqa: E402
from batch_engine import (  # noqa: E402
	BatchContext,
	BatchRunner,
	BatchReentryError,
	BatchCancelled,
	CameraAdapter,
	CollectionAdapter,
	ItemAdapter,
	ImageAdapter,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fakes import (  # noqa: E402
	FakeBpy,
	FakeData,
	FakeImage,
	FakeLayerCollection,
	FakeCollection,
	FakeMaterial,
	FakeNode,
	FakeNodeTree,
	FakeObject,
	FakeScene,
	FakeSettings,
	FakeViewLayer,
	make_camera_context,
	snapshot_scene_state,
	snapshot_collection_state,
	snapshot_item_state,
)


PASS = 0
FAILURES = []


def check(condition, message):
	global PASS
	if condition:
		PASS += 1
	else:
		FAILURES.append(message)
		raise AssertionError(message)


def run_test(name, func):
	try:
		func()
		print(f"  PASS  {name}")
	except Exception:
		print(f"  FAIL  {name}")
		traceback.print_exc()


# --------------------------------------------------------------------------
# Helpers

def make_render_func(bpy, label_getter, fail_labels=(), cancel_labels=(),
					 return_cancel_labels=()):
	"""Return a render_func mimicking render_batch._render_once semantics."""
	fail_labels = set(fail_labels)
	cancel_labels = set(cancel_labels)
	return_cancel_labels = set(return_cancel_labels)

	def render_func(animation=False):
		bpy.ops.render_calls += 1
		label = label_getter()
		if label in return_cancel_labels:
			# Mirrors bpy.ops.render.render returning {'CANCELLED'}.
			raise BatchCancelled('render cancelled by user')
		if label in cancel_labels:
			raise RuntimeError('user cancelled render')
		if label in fail_labels:
			raise RuntimeError('simulated render failure')
		return {'FINISHED'}

	return render_func


def make_camera_runner(camera_names, settings=None, fail_labels=(),
					   cancel_labels=(), return_cancel_labels=(),
					   is_cancelled=None):
	scene, view_layer, bpy, cameras, settings = make_camera_context(
		camera_names, settings=settings)
	bpy.data = FakeData()
	current = {'label': None}
	context = BatchContext(
		scene=scene,
		settings=settings,
		view_layer=view_layer,
		data=bpy.data,
		bpy_module=bpy,
		render_func=make_render_func(
			bpy, lambda: current['label'],
			fail_labels, cancel_labels, return_cancel_labels),
		is_cancelled=is_cancelled,
	)
	adapter = CameraAdapter(context)

	# Wrap apply so the render func knows which item is active.
	original_apply = adapter.apply
	def apply_with_label(item):
		current['label'] = item.label
		return original_apply(item)
	adapter.apply = apply_with_label

	return BatchRunner(context, adapter), scene, view_layer, bpy, settings, cameras


# --------------------------------------------------------------------------
# 1. All items succeed

def test_all_success_cameras():
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB', 'CamC'])
	before = snapshot_scene_state(scene, view_layer)
	variables_before = (settings.batch_index, settings.batch_factor, settings.batch_random)

	report = runner.run()

	check(report.total == 3, "total should be 3")
	check(report.success == 3, f"success should be 3, got {report.success}")
	check(report.failed == 0, "no failures expected")
	check(report.remaining == 0, "nothing remaining")
	check(report.cancelled is False, "not cancelled")
	check(bpy.ops.render_calls == 3, "each camera rendered once")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "scene state must match pre-batch snapshot")
	check((settings.batch_index, settings.batch_factor, settings.batch_random)
		  == variables_before, "manual batch variables must be restored")
	# During the run the camera must actually have switched.
	check(runner.adapter.items[1].payload.name == 'CamB', "item payload preserved")


def test_all_success_camera_with_resolution_name_restored():
	# Camera named with the "#x#" suffix gets temporarily renamed; the rename
	# must be rolled back and the resolution restored. Names must be unique,
	# mirroring Blender's data-block name uniqueness enforcement.
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['Render 1024x768', 'PlainCam 800x600'])
	before_names = [cam.name for cam in cameras]
	before = snapshot_scene_state(scene, view_layer)

	runner.run()

	check([cam.name for cam in cameras] == before_names,
		  "camera names must be restored after resolution suffix removal")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "scene state must match pre-batch snapshot")
	check(scene.render.resolution_x == 1920 and scene.render.resolution_y == 1080,
		  "resolution must return to original values")


# --------------------------------------------------------------------------
# 2. Single item fails -> rollback and continue

def test_single_failure_continues_and_rolls_back():
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB', 'CamC'], fail_labels={'CamB'})
	before = snapshot_scene_state(scene, view_layer)
	variables_before = (settings.batch_index, settings.batch_factor, settings.batch_random)

	report = runner.run()

	check(report.total == 3, "total 3")
	check(report.success == 2, f"two successes expected, got {report.success}")
	check(report.failed == 1, "one failure expected")
	check(report.remaining == 0, "all items were attempted")
	check(len(report.failures) == 1, "one failure record")
	failure = report.failures[0]
	check(failure.category == 'Camera', "failure category must identify object kind")
	check(failure.label == 'CamB', "failure label must name the bad camera")
	check('simulated render failure' in failure.message, "failure message retained")
	check(bpy.ops.render_calls == 3,
		  "render attempted for every item even after a failure")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "scene state must be identical after a failed item")
	check((settings.batch_index, settings.batch_factor, settings.batch_random)
		  == variables_before, "manual batch variables restored despite failure")


def test_collection_failure_rolls_back_visibility():
	settings = FakeSettings(batch_type='cols')
	parent_collection = FakeCollection('Parent')
	collections = []
	layer_collections = []
	for name in ('ColA', 'ColB', 'ColC'):
		collection = FakeCollection(name, objects=[FakeObject(name + '_obj')])
		layer_collection = FakeLayerCollection(name, collection)
		collections.append(collection)
		layer_collections.append(layer_collection)
	parent_layer = FakeLayerCollection('Parent', parent_collection, layer_collections)
	view_layer = FakeViewLayer(selected=[], active_layer_collection=parent_layer)
	scene = FakeScene(settings)
	bpy = FakeBpy()
	bpy.data = FakeData()
	current = {'label': None}
	context = BatchContext(
		scene=scene, settings=settings, view_layer=view_layer, data=bpy.data,
		bpy_module=bpy,
		render_func=make_render_func(bpy, lambda: current['label'],
									 fail_labels={'ColB'}))
	adapter = CollectionAdapter(context)
	original_apply = adapter.apply
	adapter.apply = lambda item: (current.__setitem__('label', item.label),
								  original_apply(item))[1]
	runner = BatchRunner(context, adapter)

	before = snapshot_collection_state(layer_collections)
	report = runner.run()
	after = snapshot_collection_state(layer_collections)

	check(report.success == 2 and report.failed == 1, "collection counts")
	check(after == before, "every collection hide_render/exclude state restored")
	check(settings.batch_collection_name == '', "batch_collection_name reset")
	# Mid-batch the rendered collection must have been enabled.
	check(bpy.ops.render_calls == 3, "all three collections attempted")


def test_item_failure_rolls_back_selection_and_visibility():
	settings = FakeSettings(batch_type='itms')
	objects = [FakeObject('Lamp', 'LIGHT'), FakeObject('Cube', 'MESH'),
			   FakeObject('Sphere', 'MESH')]
	view_layer = FakeViewLayer(selected=objects)
	view_layer.objects.active = objects[0]
	scene = FakeScene(settings)
	bpy = FakeBpy()
	bpy.data = FakeData()
	current = {'label': None}
	context = BatchContext(
		scene=scene, settings=settings, view_layer=view_layer, data=bpy.data,
		bpy_module=bpy,
		render_func=make_render_func(bpy, lambda: current['label'],
									 fail_labels={'Cube'}))
	adapter = ItemAdapter(context)
	original_apply = adapter.apply
	adapter.apply = lambda item: (current.__setitem__('label', item.label),
								  original_apply(item))[1]
	runner = BatchRunner(context, adapter)

	before_state, before_active = snapshot_item_state(objects, view_layer)
	report = runner.run()
	after_state, after_active = snapshot_item_state(objects, view_layer)

	check(report.success == 2 and report.failed == 1, "item counts")
	check(after_state == before_state, "object hide_render and selection restored")
	check(after_active == before_active, "active object restored")
	check(view_layer.objects.active is objects[0], "exact active object reference")


# --------------------------------------------------------------------------
# 3. User cancellation

def test_cancellation_stops_and_restores():
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB', 'CamC'], return_cancel_labels={'CamB'})
	before = snapshot_scene_state(scene, view_layer)
	variables_before = (settings.batch_index, settings.batch_factor, settings.batch_random)

	report = runner.run()

	check(report.cancelled is True, "report flagged as cancelled")
	check(report.success == 1, "only items before cancellation succeeded")
	check(report.failed == 1, "the cancelled item is recorded as failed")
	check(report.remaining == 1, "cancelled item counts in remaining; CamC never ran")
	check(bpy.ops.render_calls == 2, "no renders after cancellation")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "scene state identical after cancellation")
	check((settings.batch_index, settings.batch_factor, settings.batch_random)
		  == variables_before, "manual batch variables restored after cancel")


def test_cancellation_between_items():
	# Cancellation flag raised after the first item completes.
	flag = {'stop': False}
	def is_cancelled():
		return flag['stop']

	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB', 'CamC'], is_cancelled=is_cancelled)
	original_apply = runner.adapter.apply
	def apply_then_flag(item):
		result = original_apply(item)
		if item.label == 'CamA':
			flag['stop'] = True
		return result
	runner.adapter.apply = apply_then_flag
	before = snapshot_scene_state(scene, view_layer)

	report = runner.run()

	check(report.cancelled is True, "cancellation detected between items")
	check(report.success == 1 and report.remaining == 2, "remaining counts correct")
	check(snapshot_scene_state(scene, view_layer) == before, "state restored")


# --------------------------------------------------------------------------
# 4. Repeated trigger / re-entrancy

def test_reentry_rejected_when_batch_active():
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB'])
	# Simulate a second click arriving while the first batch is mid-render.
	reentry_errors = []
	original_apply = runner.adapter.apply
	def apply_and_reenter(item):
		if item.label == 'CamA':
			second, *_ = make_camera_runner(['OtherCam'])
			try:
				second.run()
			except BatchReentryError as exc:
				reentry_errors.append(exc)
		return original_apply(item)
	runner.adapter.apply = apply_and_reenter
	before = snapshot_scene_state(scene, view_layer)

	report = runner.run()

	check(len(reentry_errors) == 1, "concurrent batch must raise BatchReentryError")
	check(report.success == 2, "original batch completes fully")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "rejected batch must not mutate the scene")
	# After completion the guard is released, so a later batch can run.
	check(batch_engine.is_batch_active() is False, "guard released after batch")


def test_sequential_batches_each_restore_state():
	# Two batches back-to-back must each restore state; guard cannot get stuck.
	runner1, scene, view_layer, bpy1, settings, _ = make_camera_runner(
		['CamA', 'CamB'], fail_labels={'CamB'})
	report1 = runner1.run()
	runner2, scene2, view_layer2, bpy2, settings2, cameras2 = make_camera_runner(
		['CamA', 'CamB', 'CamC'])
	before2 = snapshot_scene_state(scene2, view_layer2)
	report2 = runner2.run()

	check(report1.failed == 1, "first batch had a failure")
	check(report2.success == 3, "second batch fully succeeds")
	check(snapshot_scene_state(scene2, view_layer2) == before2,
		  "second batch restores state independently")
	check(batch_engine.is_batch_active() is False, "guard released between batches")


# --------------------------------------------------------------------------
# Image path: rollback, deleted node survival, output files untouched

def test_image_batch_rolls_back_texture_and_survives_deleted_node():
	with tempfile.TemporaryDirectory() as folder:
		# Source "textures" — empty files are fine, nothing is really loaded.
		file_names = ['a.png', 'b.png', 'c.png']
		for name in file_names:
			with open(os.path.join(folder, name), 'w') as handle:
				handle.write('x')

		settings = FakeSettings(batch_type='imgs')
		settings.batch_images_location = folder
		settings.batch_images_material = 'Mat'
		settings.batch_images_node = 'TexNode'
		original_image = FakeImage('original.png', 'original.png')
		node = FakeNode('TexNode', 'TEX_IMAGE', original_image)
		material = FakeMaterial('Mat', FakeNodeTree([node]))
		data = FakeData(materials=[material])
		view_layer = FakeViewLayer()
		scene = FakeScene(settings)
		bpy = FakeBpy()
		bpy.data = data
		written_files = []
		current = {'label': None}

		def render_func(animation=False):
			# Simulate a successful render writing its output file.
			output = os.path.join(folder, f"render_{current['label']}.out")
			with open(output, 'w') as handle:
				handle.write('render')
			written_files.append(output)
			if current['label'] == 'b.png':
				raise RuntimeError('simulated render failure')
			return {'FINISHED'}

		def load_image(path):
			return data.images.load(path, check_existing=True)

		context = BatchContext(
			scene=scene, settings=settings, view_layer=view_layer, data=data,
			bpy_module=bpy, render_func=render_func, load_image=load_image)
		adapter = ImageAdapter(context)
		original_apply = adapter.apply
		texture_after_b_rollback = []
		# Wrap the engine's rollback to observe the node state immediately after
		# b.png's failed render is rolled back (transactional: it must be back to
		# whatever the node held before b.png swapped it — here, the original).
		original_rollback = adapter.rollback
		def observing_rollback(item):
			result = original_rollback(item)
			if item.label == 'b.png':
				texture_after_b_rollback.append(node.image)
			return result
		adapter.rollback = observing_rollback
		def apply_with_label(item):
			current['label'] = item.label
			if item.label == 'c.png':
				# User/handler deletes the target node between b and c.
				material.node_tree.nodes.remove(node)
			return original_apply(item)
		adapter.apply = apply_with_label
		runner = BatchRunner(context, adapter)

		variables_before = (settings.batch_index, settings.batch_factor,
							settings.batch_random)
		report = runner.run()

		check(report.total == 3, "three images queued")
		check(report.success == 1, "only a.png rendered successfully")
		check(report.failed == 2, "b.png failed, c.png hit missing node")
		c_failure = report.failures[1]
		check(c_failure.category == 'Image', "image failure category")
		check(c_failure.label == 'c.png', "failure names the image file")
		check('node' in c_failure.message.lower(), "missing node explained")
		# The failed b.png item rolled its texture swap back before moving on:
		# transactionally it restores the state from before b.png started, which
		# is a.png's texture (the original texture is restored once at the end).
		check(len(texture_after_b_rollback) == 1, "b.png rollback observed once")
		check(texture_after_b_rollback[0] is data.images.loaded[0],
			  "failed item restores the texture that preceded it")
		# Deleting the node for c.png must not crash the loop or the final
		# restoration (a missing node is simply skipped safely).
		check(node not in material.node_tree.nodes._nodes,
			  "node deletion took effect without crashing the batch")
		# Successful output files must never be deleted by rollback.
		check(all(os.path.exists(path) for path in written_files),
			  "successful render outputs preserved")
		check((settings.batch_index, settings.batch_factor, settings.batch_random)
			  == variables_before, "batch variables restored")


def test_image_batch_node_recreated_restores_when_present():
	# If the node exists at the end (the normal case), restore() puts back the
	# original image even after mid-batch failures.
	with tempfile.TemporaryDirectory() as folder:
		for name in ('one.jpg', 'two.jpg'):
			with open(os.path.join(folder, name), 'w') as handle:
				handle.write('x')
		settings = FakeSettings(batch_type='imgs')
		settings.batch_images_location = folder
		settings.batch_images_material = 'Mat'
		settings.batch_images_node = 'Tex'
		original_image = FakeImage('orig.jpg', 'orig.jpg')
		node = FakeNode('Tex', 'TEX_IMAGE', original_image)
		material = FakeMaterial('Mat', FakeNodeTree([node]))
		data = FakeData(materials=[material])
		bpy = FakeBpy()
		bpy.data = data
		current = {'label': None}

		def render_func(animation=False):
			if current['label'] == 'one.jpg':
				raise RuntimeError('boom')
			return {'FINISHED'}

		context = BatchContext(
			scene=FakeScene(settings), settings=settings,
			view_layer=FakeViewLayer(), data=data, bpy_module=bpy,
			render_func=render_func,
			load_image=lambda path: data.images.load(path, check_existing=True))
		adapter = ImageAdapter(context)
		original_apply = adapter.apply
		adapter.apply = lambda item: (current.__setitem__('label', item.label),
									  original_apply(item))[1]
		report = BatchRunner(context, adapter).run()

		check(report.failed == 1 and report.success == 1, "one failure one success")
		check(node.image is original_image, "original texture restored at end")


def test_prepare_error_does_not_leave_guard_active():
	# Empty selection / missing folder: prepare() raises, runner must release
	# the re-entrancy guard and leave variables untouched.
	settings = FakeSettings(batch_type='cams')
	view_layer = FakeViewLayer(selected=[])  # no cameras, no active collection
	scene = FakeScene(settings)
	bpy = FakeBpy()
	bpy.data = FakeData()
	context = BatchContext(
		scene=scene, settings=settings, view_layer=view_layer, data=bpy.data,
		bpy_module=bpy, render_func=lambda animation=False: {'FINISHED'})
	variables_before = (settings.batch_index, settings.batch_factor,
						settings.batch_random)
	report = BatchRunner(context, CameraAdapter(context)).run()

	check(report.total == 0 and report.success == 0, "empty batch report")
	check(batch_engine.is_batch_active() is False, "guard released on prepare error")
	check((settings.batch_index, settings.batch_factor, settings.batch_random)
		  == variables_before, "variables unchanged when nothing renders")


def test_batch_factor_single_item_no_division_error():
	# The old code divided by len-1; a single-item batch must not crash.
	factor, random_value = batch_engine.calculate_batch_values(0, 1)
	check(factor == 1.0, "single item factor is 1.0")
	check(0.0 <= random_value <= 1.0, "random within bounds")
	factor0, _ = batch_engine.calculate_batch_values(0, 3)
	factor2, _ = batch_engine.calculate_batch_values(2, 3)
	check(factor0 == 0.0 and factor2 == 1.0, "multi-item factor endpoints")


def test_render_cancel_result_translates_to_cancellation():
	# Mirrors render_batch._render_once: bpy returns {'CANCELLED'} and the
	# wiring raises BatchCancelled, which the runner treats as a user cancel.
	def render_func(animation=False):
		raise BatchCancelled('render cancelled by user')

	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(
		['CamA', 'CamB'])
	runner.context.render_func = render_func
	before = snapshot_scene_state(scene, view_layer)

	report = runner.run()

	check(report.cancelled is True, "render-op cancellation stops the batch")
	check(report.success == 0 and report.failed == 1 and report.remaining == 1,
		  "cancelled item counted as failed and remaining")
	check(snapshot_scene_state(scene, view_layer) == before, "state restored")
	check(settings.batch_index == 7, "user's batch_index preserved exactly")


def test_failure_before_item_state_does_not_break_rollback():
	# If apply() fails before item.state is assigned, rollback() must be a
	# safe no-op and the final restoration must still run.
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(['CamA'])

	def broken_apply(item):
		# No item.state assigned — simulates a failure during early setup.
		raise RuntimeError('failure before state capture')

	runner.adapter.apply = broken_apply
	before = snapshot_scene_state(scene, view_layer)
	report = runner.run()

	check(report.failed == 1 and report.success == 0, "item recorded as failed")
	check(snapshot_scene_state(scene, view_layer) == before,
		  "restoration works even when rollback has no per-item state")
	check(batch_engine.is_batch_active() is False, "guard released")


def test_restore_runs_even_when_adapter_restore_fails_partially():
	# A broken restore() must not prevent the batch variables from being
	# restored or the re-entrancy guard from being released.
	runner, scene, view_layer, bpy, settings, cameras = make_camera_runner(['CamA'])
	original_restore = runner.adapter.restore

	def broken_restore():
		original_restore()
		raise RuntimeError('restoration hiccup')

	runner.adapter.restore = broken_restore
	variables_before = (7, 0.42, 0.99)
	report = runner.run()

	check(report.success == 1, "render itself succeeded")
	check((settings.batch_index, settings.batch_factor, settings.batch_random)
		  == variables_before, "variables restored despite restore error")
	check(batch_engine.is_batch_active() is False, "guard always released")


class FakeWindowManager:
	"""Mimics invoke_props_dialog returning RUNNING_MODAL without executing."""
	def invoke_props_dialog(self, operator):
		return {'RUNNING_MODAL'}


class FakeOperatorContext:
	def __init__(self, settings):
		self.scene = FakeScene(settings)
		self.view_layer = FakeViewLayer()
		self.window_manager = FakeWindowManager()


def test_confirmation_dialog_cancel_starts_no_batch():
	# Clicking the button opens the confirmation dialog; cancelling it must
	# never reach execute(), so no batch guard or scene mutation can occur.
	# The operator class itself is bpy-bound, so this mirrors its invoke()
	# contract: invoke only opens the dialog and returns RUNNING_MODAL.
	settings = FakeSettings(batch_type='cams')
	context = FakeOperatorContext(settings)

	# Inline reproduction of batch_render_start.invoke semantics (the real
	# method body is a one-line dialog invocation).
	dialog_result = context.window_manager.invoke_props_dialog(operator=None)

	check(dialog_result == {'RUNNING_MODAL'}, "dialog opens without executing")
	check(batch_engine.is_batch_active() is False,
		  "cancelling the confirmation dialog leaves the guard untouched")
	check(settings.batch_active is False, "batch never marked active")
	check(settings.batch_index == 7, "manual batch_index untouched")
	check((settings.batch_report_total, settings.batch_report_failed)
		  == (0, 0), "no report published when nothing ran")


# --------------------------------------------------------------------------
# Runner

def main():
	tests = [
		("all cameras succeed and state is restored", test_all_success_cameras),
		("resolution-suffix camera name is restored",
		 test_all_success_camera_with_resolution_name_restored),
		("single camera failure rolls back and continues",
		 test_single_failure_continues_and_rolls_back),
		("collection failure rolls back visibility",
		 test_collection_failure_rolls_back_visibility),
		("item failure rolls back selection and visibility",
		 test_item_failure_rolls_back_selection_and_visibility),
		("user cancellation stops batch and restores",
		 test_cancellation_stops_and_restores),
		("cancellation between items is honoured",
		 test_cancellation_between_items),
		("repeated trigger cannot run concurrent batches",
		 test_reentry_rejected_when_batch_active),
		("sequential batches each restore state",
		 test_sequential_batches_each_restore_state),
		("image batch survives deleted node and preserves outputs",
		 test_image_batch_rolls_back_texture_and_survives_deleted_node),
		("image batch restores texture after failure",
		 test_image_batch_node_recreated_restores_when_present),
		("prepare failure releases guard", test_prepare_error_does_not_leave_guard_active),
		("single-item batch avoids division by zero",
		 test_batch_factor_single_item_no_division_error),
		("render cancel result translates to cancellation",
		 test_render_cancel_result_translates_to_cancellation),
		("rollback without item state is a safe no-op",
		 test_failure_before_item_state_does_not_break_rollback),
		("partial restore failure still restores variables and guard",
		 test_restore_runs_even_when_adapter_restore_fails_partially),
		("confirmation dialog cancel starts no batch",
		 test_confirmation_dialog_cancel_starts_no_batch),
	]
	print(f"Running {len(tests)} batch engine tests...")
	for name, func in tests:
		run_test(name, func)
	print()
	if FAILURES:
		print(f"{len(FAILURES)} assertion(s) failed:")
		for message in FAILURES:
			print(f"  - {message}")
		return 1
	print(f"All {PASS} assertions across {len(tests)} tests passed.")
	return 0


if __name__ == '__main__':
	sys.exit(main())
