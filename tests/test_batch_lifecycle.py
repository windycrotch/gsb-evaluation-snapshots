"""Acceptance tests for the recoverable Batch Render lifecycle.

Covers the required scenarios:
  1. Normal completion: state restored, serials advanced once per successful render.
  2. Mid-batch cancellation: full state rollback, no serial consumed, no partial files.
  3. Single-target failure followed by retry: completed outputs kept, retry numbering
     matches a clean successful run.
  4. Re-entrant trigger rejected while a batch is running.
  5. After rollback, a later normal batch still increments serials correctly.

Also covers: snapshot immutability under mid-batch UI edits, per-type state
restoration (cameras/collections/items/images), and partial-output cleanup.
"""
import os

import pytest

from fakes import fake_bpy
from fakes.world_builder import build_world, register_addon_handlers


@pytest.fixture
def world(tmp_path):
	w = build_world(tmp_path, batch_type='cams', serial_in_path=True)
	register_addon_handlers()
	return w


def _run_batch(world):
	from Launch_RenderKit import render_batch_session as session_mod
	session = session_mod.begin_session(world.context, world.settings)
	world.settings.batch_active = True
	try:
		session.run()
	finally:
		session_mod.end_session()
		world.settings.batch_active = False
	return session


def _script_finish(filenames):
	return {'result': 'FINISHED', 'files': list(filenames),
			'cancel_handler': False, 'complete_handler': True}


def _script_cancel(partial=('partial.png',)):
	return {'result': 'CANCELLED', 'files': list(partial),
			'cancel_handler': True, 'complete_handler': False}


def _script_error(exc):
	return {'result': 'FINISHED', 'files': [], 'raise': exc}


# ---------------------------------------------------------------------------
# 1. Normal completion
# ---------------------------------------------------------------------------

class TestNormalCompletion:
	def test_all_targets_render_and_state_restored(self, world):
		# Two cameras; the active camera + resolution must be restored afterwards
		original_camera = world.scene.camera
		original_rx = world.scene.render.resolution_x
		original_ry = world.scene.render.resolution_y
		world.scene.render.resolution_x = 999
		world.scene.render.resolution_y = 888
		world.settings.batch_index = 7
		world.settings.batch_factor = 0.5

		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['out_0000.png']),
			_script_finish(['out_0001.png']),
		]

		session = _run_batch(world)

		assert session.completed_count == 2
		assert not session.cancelled and not session.failed
		# Scene state restored
		assert world.scene.camera is original_camera
		assert world.scene.render.resolution_x == 999
		assert world.scene.render.resolution_y == 888
		assert world.settings.batch_index == 7
		assert world.settings.batch_factor == 0.5
		# Both outputs retained
		assert sorted(os.listdir(world.output_dir)) == ['out_0000.png', 'out_0001.png']

	def test_serial_advances_only_after_each_success(self, world):
		world.settings.output_file_serial = 10
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['out_0010.png']),
			_script_finish(['out_0011.png']),
			_script_finish(['out_0012.png']),
		]
		# Three cameras expected: add a third to the selected world
		cam_c = fake_bpy.FakeObject('CameraC', 'CAMERA')
		world.objects.append(cam_c)
		world.context.selected_objects.append(cam_c)
		world.scene.collection.all_objects.append(cam_c)

		session = _run_batch(world)

		assert session.completed_count == 3
		# Full success keeps the handler-advanced serial
		assert world.settings.output_file_serial == 13
		assert sorted(os.listdir(world.output_dir)) == [
			'out_0010.png', 'out_0011.png', 'out_0012.png']

	def test_single_target_batch_no_division_error(self, world):
		# Only one selected camera; batch_length of zero must not raise ZeroDivisionError
		world.context.selected_objects = [world.cameras[0]]
		fake_bpy.RENDER_SCRIPT[:] = [_script_finish(['out_0000.png'])]

		session = _run_batch(world)
		assert session.completed_count == 1

	def test_camera_name_resolution_suffix_restored(self, world):
		# Rebuild with a camera carrying a "#x#" resolution suffix
		world = build_world(str(world.bpy.path._base and os.path.dirname(world.output_dir)),
							batch_type='cams', include_resolution_camera=True)
		register_addon_handlers()
		world.context.selected_objects = [world.cameras[1]]
		cam = world.cameras[1]
		original_name = cam.name
		fake_bpy.RENDER_SCRIPT[:] = [_script_finish(['out_0000.png'])]

		session = _run_batch(world)
		assert session.completed_count == 1
		assert cam.name == original_name  # suffix restored
		assert world.scene.render.resolution_x == 1920  # original resolution restored


# ---------------------------------------------------------------------------
# 2. Mid-batch cancellation
# ---------------------------------------------------------------------------

class TestCancellation:
	def test_cancel_rolls_back_state_and_serial(self, world):
		world.settings.output_file_serial = 5
		original_camera = world.scene.camera
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['out_0005.png']),      # target 1 succeeds
			_script_cancel(['partial.png']),        # target 2 cancelled
		]

		session = _run_batch(world)

		assert session.cancelled is True
		assert session.completed_count == 1
		# Successful target's output kept, cancelled target's partial removed
		files = os.listdir(world.output_dir)
		assert 'out_0005.png' in files
		assert 'partial.png' not in files
		# Serial rolled back: cancellation consumed nothing
		assert world.settings.output_file_serial == 5
		# Scene state restored
		assert world.scene.camera is original_camera

	def test_cancel_first_target_consumes_no_serial(self, world):
		world.settings.output_file_serial = 0
		fake_bpy.RENDER_SCRIPT[:] = [_script_cancel(['partial.png'])]

		session = _run_batch(world)
		assert session.cancelled is True
		assert session.completed_count == 0
		assert world.settings.output_file_serial == 0
		assert os.listdir(world.output_dir) == []

	def test_cancel_latch_cleared_after_session(self, world):
		from Launch_RenderKit import utility_data
		fake_bpy.RENDER_SCRIPT[:] = [_script_cancel()]
		_run_batch(world)
		assert utility_data.batch_get_cancel_requested() is False
		assert utility_data.render_get_cancelled() is False


# ---------------------------------------------------------------------------
# 3. Single-target failure and retry numbering
# ---------------------------------------------------------------------------

class TestFailureAndRetry:
	def test_failure_keeps_prior_outputs_and_rolls_back_serial(self, world):
		world.settings.output_file_serial = 2
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['out_0002.png']),
			_script_error(RuntimeError('render device lost')),
		]

		session = _run_batch(world)
		assert session.failed is True
		assert session.completed_count == 1
		# First output retained; no partial file from the failed render
		assert os.listdir(world.output_dir) == ['out_0002.png']
		# Serial rolled back to the snapshot
		assert world.settings.output_file_serial == 2

	def test_retry_reproduces_clean_run_numbering(self, world):
		world.settings.output_file_serial = 0

		# First attempt: second target fails
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['out_0000.png']),
			_script_error(RuntimeError('boom')),
		]
		first = _run_batch(world)
		assert first.failed and first.completed_count == 1
		assert world.settings.output_file_serial == 0  # rolled back

		# Retry the same batch: both targets now succeed. Numbering must match a
		# clean run (0000, 0001), not continue from any partially consumed serial.
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['retry_0000.png']),
			_script_finish(['retry_0001.png']),
		]
		second = _run_batch(world)
		assert second.completed_count == 2
		assert world.settings.output_file_serial == 2
		# Distinct output names in the test avoid overwrite; the asserted serial
		# values prove the numbering sequence matches a first-time success.
		assert sorted(os.listdir(world.output_dir)) == [
			'out_0000.png', 'retry_0000.png', 'retry_0001.png']

	def test_cancelled_render_handler_does_not_increment_serial(self, world):
		from Launch_RenderKit import render_2_end
		world.settings.output_file_serial = 4
		# Directly invoke the cancel path as Blender would
		render_2_end.render_kit_cancel(world.scene)
		assert world.settings.output_file_serial == 4
		# And a normal completion does increment
		from Launch_RenderKit import utility_data
		utility_data.render_set_serial(True)
		render_2_end.render_kit_end(world.scene)
		assert world.settings.output_file_serial == 5


# ---------------------------------------------------------------------------
# 4. Re-entrant trigger rejected
# ---------------------------------------------------------------------------

class TestReentrancy:
	def test_second_session_rejected_while_running(self, world):
		from Launch_RenderKit import render_batch_session as session_mod
		from Launch_RenderKit.render_batch_session import BatchRenderError

		first = session_mod.begin_session(world.context, world.settings)
		try:
			assert session_mod.session_active() is True
			with pytest.raises(BatchRenderError):
				session_mod.begin_session(world.context, world.settings)
		finally:
			session_mod.end_session()
		assert session_mod.session_active() is False

	def test_operator_rejects_reentrant_call(self, world):
		from Launch_RenderKit.render_batch import batch_render_start
		from Launch_RenderKit import render_batch_session as session_mod

		# Hold an active session to simulate an in-progress batch
		active = session_mod.begin_session(world.context, world.settings)
		try:
			op = batch_render_start()
			result = op.execute(world.context)
			assert result == {'CANCELLED'}
		finally:
			session_mod.end_session()

	def test_operator_poll_disabled_while_active(self, world):
		from Launch_RenderKit.render_batch import batch_render_start
		from Launch_RenderKit import render_batch_session as session_mod

		assert batch_render_start.poll(world.context) is True
		active = session_mod.begin_session(world.context, world.settings)
		try:
			assert batch_render_start.poll(world.context) is False
		finally:
			session_mod.end_session()
		assert batch_render_start.poll(world.context) is True


# ---------------------------------------------------------------------------
# 5. Snapshot immutability and post-rollback serial progression
# ---------------------------------------------------------------------------

class TestSnapshotAndProgression:
	def test_target_list_and_path_frozen_at_start(self, world):
		# Two cameras at start; the snapshot must freeze that list even though a
		# third camera is "added" (selected) while the batch is running.
		cam_c = fake_bpy.FakeObject('CameraC', 'CAMERA')
		world.objects.append(cam_c)

		# Mutate mid-batch via a render script hook: after the first render, alter
		# the UI selection and output path. The running session must ignore both.
		original_path = world.scene.render.filepath

		def mutate_after_first(scene):
			world.context.selected_objects.append(cam_c)
			scene.render.filepath = os.path.join(world.output_dir, 'CHANGED_{serial}.png')

		fake_bpy.RENDER_SCRIPT[:] = [
			{'result': 'FINISHED', 'files': ['out_0000.png'],
			 'cancel_handler': False, 'complete_handler': True, 'side_effect': mutate_after_first},
			_script_finish(['out_0001.png']),
		]

		session = _run_batch(world)
		assert session.completed_count == 2
		# Only the two snapshotted cameras were rendered (two render calls),
		# regardless of the camera added mid-run.
		assert len(fake_bpy.RENDER_CALLS) == 2
		# Output path template restored after the run
		assert world.scene.render.filepath == original_path
		assert not any(name.startswith('CHANGED') for name in os.listdir(world.output_dir))

	def test_normal_batch_after_rollback_still_increments(self, world):
		# Batch 1: cancelled, serial untouched
		world.settings.output_file_serial = 3
		fake_bpy.RENDER_SCRIPT[:] = [_script_cancel()]
		cancelled = _run_batch(world)
		assert cancelled.cancelled
		assert world.settings.output_file_serial == 3

		# Batch 2: fully succeeds, serial advances normally from 3
		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['ok_0003.png']),
			_script_finish(['ok_0004.png']),
		]
		success = _run_batch(world)
		assert success.completed_count == 2
		assert world.settings.output_file_serial == 5


# ---------------------------------------------------------------------------
# Per-type state restoration
# ---------------------------------------------------------------------------

class TestStateRestorationByType:
	def test_collections_visibility_restored(self, tmp_path):
		world = build_world(tmp_path, batch_type='cols', serial_in_path=True)
		register_addon_handlers()
		lc_x, lc_y = world.layer_collections
		lc_x.collection.hide_render = False
		lc_x.exclude = False
		lc_y.collection.hide_render = True
		lc_y.exclude = True
		world.settings.batch_collection_name = 'pre-existing'

		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['c0.png']),
			_script_finish(['c1.png']),
		]
		session = _run_batch(world)

		assert session.completed_count == 2
		assert lc_x.collection.hide_render is False
		assert lc_x.exclude is False
		assert lc_y.collection.hide_render is True
		assert lc_y.exclude is True
		assert world.settings.batch_collection_name == 'pre-existing'

	def test_items_selection_and_hide_restored(self, tmp_path):
		world = build_world(tmp_path, batch_type='itms', serial_in_path=True)
		register_addon_handlers()
		item, light = world.items
		# Pre-existing selection/hide state
		item.select_set(True)
		light.select_set(False)
		item.hide_render = False
		light.hide_render = True
		original_active = world.scene.view_layer.objects.active = item

		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['i0.png']),
			_script_finish(['i1.png']),
		]
		session = _run_batch(world)

		assert session.completed_count == 2
		assert item.select_get() is True
		assert light.select_get() is False
		assert item.hide_render is False
		assert light.hide_render is True
		assert world.scene.view_layer.objects.active is original_active

	def test_image_node_restored_after_batch(self, tmp_path):
		world = build_world(tmp_path, batch_type='imgs', serial_in_path=True)
		register_addon_handlers()
		node = world.node
		assert node.image is world.original_image

		fake_bpy.RENDER_SCRIPT[:] = [
			_script_finish(['t0.png']),
			_script_finish(['t1.png']),
			_script_finish(['t2.png']),
		]
		session = _run_batch(world)

		assert session.completed_count == 3
		# Node restored to the texture that was assigned before the batch
		assert node.image is world.original_image
		# Snapshot used the folder contents captured at start (three images)
		assert len(session.targets) == 3
