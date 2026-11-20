"""Local Blender verification sample for the batch "UV to Mesh" conversion.

Run from the repository root with Blender in background mode:

    blender --background --python tests/uv_mesh_batch_test.py --python-exit-code 1

The script exercises the operator in a real bpy environment and covers:

  * all selected objects convert successfully
  * some objects are skipped (missing UV map, no faces, degenerate UVs) while the
    rest still convert, with a warning and a success/skip count report
  * every selected object is skipped -> operator cancels, nothing is left behind
    and the previous selection / active object is restored
  * running the same batch twice never reuses or overwrites earlier mesh data

Exit code is non-zero when ``--python-exit-code`` is supplied and a check fails.
It can also be run from Blender's Text Editor, where it prints a summary.
"""

import os
import sys
import traceback

import bpy

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
	sys.path.insert(0, REPO_ROOT)

# Prefer the copy Blender already loaded (add-on installed and enabled) so the
# test exercises the running code instead of a duplicate module instance.
if "Launch_MeshKit" not in sys.modules:
	import Launch_MeshKit  # noqa: F401

import Launch_MeshKit as meshkit
from Launch_MeshKit import uv_mesh as uv_mesh_module


###########################################################################
# Operator under test, with report capture so the user-facing messages can be
# asserted on (bpy.ops itself does not expose operator reports).

_reports = []


class _CapturingUVToMesh(uv_mesh_module.OBJECT_OT_uv_mesh):
	bl_idname = "object.uv_mesh_verify"
	bl_label = "UV to Mesh (verify)"

	def report(self, type, message):
		_reports.append((set(type), str(message)))


_registered = False
_owns_settings = False


def _scene_has_settings():
	# True when the add-on is installed/enabled and already registered the property
	try:
		return getattr(bpy.context.scene, "mesh_kit_settings", None) is not None
	except (AttributeError, RuntimeError):
		return False


def _register():
	global _registered, _owns_settings
	if _registered:
		return

	# Register the minimum needed by the operator. When the extension is already
	# enabled its settings property is reused instead of being replaced, so
	# unregistering the test never breaks the installed add-on.
	_owns_settings = not _scene_has_settings()
	if _owns_settings:
		try:
			bpy.utils.register_class(meshkit.MeshKitSettings)
		except RuntimeError:
			# Class already registered (e.g. by an enabled add-on); reuse it
			pass
		bpy.types.Scene.mesh_kit_settings = bpy.props.PointerProperty(type=meshkit.MeshKitSettings)

	bpy.utils.register_class(_CapturingUVToMesh)
	_registered = True


def _unregister():
	global _registered, _owns_settings
	if not _registered:
		return
	try:
		bpy.utils.unregister_class(_CapturingUVToMesh)
	except Exception:
		pass
	if _owns_settings:
		try:
			delattr(bpy.types.Scene, "mesh_kit_settings")
		except Exception:
			pass
		try:
			bpy.utils.unregister_class(meshkit.MeshKitSettings)
		except Exception:
			pass
	_registered = False
	_owns_settings = False


###########################################################################
# Helpers

class Checker:
	def __init__(self, case):
		self.case = case
		self.failures = []

	def check(self, condition, message):
		if condition:
			return True
		self.failures.append(message)
		print(f"  FAIL [{self.case}] {message}")
		return False

	def equal(self, actual, expected, message):
		return self.check(actual == expected, f"{message} (expected {expected!r}, got {actual!r})")


# Names of objects/meshes that existed before the tests started. Anything not in
# these sets was created by the tests and can safely be removed afterwards, so
# running from Blender's Text Editor never deletes the user's own scene data.
_baseline_objects = set()
_baseline_meshes = set()


def capture_baseline():
	_baseline_objects.clear()
	_baseline_objects.update(obj.name for obj in bpy.data.objects)
	_baseline_meshes.clear()
	_baseline_meshes.update(mesh.name for mesh in bpy.data.meshes)


def reset_scene():
	"""Removes only data created by this test run and resets the relevant settings."""
	if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
		bpy.ops.object.mode_set(mode='OBJECT')

	# Deselect anything that is about to disappear
	for obj in list(bpy.context.selected_objects):
		try:
			obj.select_set(False)
		except RuntimeError:
			pass
	bpy.context.view_layer.objects.active = None

	for obj in list(bpy.data.objects):
		if obj.name in _baseline_objects:
			continue
		try:
			mesh = obj.data
			bpy.data.objects.remove(obj, do_unlink=True)
			if mesh is not None and mesh.name not in _baseline_meshes and mesh.users == 0:
				bpy.data.meshes.remove(mesh)
		except Exception:
			pass

	for mesh in list(bpy.data.meshes):
		if mesh.name not in _baseline_meshes and mesh.users == 0:
			try:
				bpy.data.meshes.remove(mesh)
			except Exception:
				pass

	for scene in bpy.data.scenes:
		settings = scene.mesh_kit_settings
		settings.uv_mesh_separator = '_'
		settings.uv_mesh_weld_distance = 0.000001


def make_quad_object(name, uv_name='UVMap', uv_coords=None, with_face=True):
	"""Creates a mesh object with one quad (or loose verts) and an optional UV map."""
	mesh = bpy.data.meshes.new(f"{name}Data")
	if with_face:
		mesh.from_pydata(
			[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)],
			[],
			[(0, 1, 2, 3)],
		)
	else:
		mesh.from_pydata(
			[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0)],
			[],
			[],
		)
	mesh.update()
	mesh.validate()

	if uv_name:
		# A face-less mesh still gets a UV layer of the requested name, so the UV
		# lookup succeeds and the "no convertible faces" path is exercised instead
		# of being short-circuited by a missing UV map.
		layer = mesh.uv_layers.new(name=uv_name)
		coords = uv_coords or [(0.0, 0.0), (0.5, 0.0), (0.5, 0.5), (0.0, 0.5)]
		for polygon in mesh.polygons:
			for index, loop_index in enumerate(polygon.loop_indices):
				layer.data[loop_index].uv = coords[index % len(coords)]

	obj = bpy.data.objects.new(name, mesh)
	bpy.context.scene.collection.objects.link(obj)
	return obj


def select_only(objects, active):
	for obj in list(bpy.context.selected_objects):
		obj.select_set(False)
	for obj in objects:
		obj.select_set(True)
	bpy.context.view_layer.objects.active = active


def set_uv_map(name, provider):
	"""Assigns the UV map enum, which validates items against the active object."""
	previous_active = bpy.context.view_layer.objects.active
	bpy.context.view_layer.objects.active = provider
	try:
		bpy.context.scene.mesh_kit_settings.uv_mesh_map = name
	finally:
		bpy.context.view_layer.objects.active = previous_active


def run_operator():
	_reports.clear()
	return bpy.ops.object.uv_mesh_verify()


def selection_names():
	return {obj.name for obj in bpy.context.selected_objects}


def object_names():
	return {obj.name for obj in bpy.data.objects}


def mesh_names():
	return {mesh.name for mesh in bpy.data.meshes}


def find_reports(kind):
	"""Returns messages reported with the given type label ('INFO'/'WARNING')."""
	if isinstance(kind, (set, frozenset, list, tuple)):
		labels = set(kind)
	else:
		labels = {kind}
	return [message for kinds, message in _reports if kinds & labels]


def check_no_empty_meshes(checker, baseline=None):
	"""Asserts the operator did not leave newly created meshes without faces.
	Meshes present before the run (test fixtures) are ignored."""
	baseline = baseline or set()
	empty = [
		mesh.name for mesh in bpy.data.meshes
		if len(mesh.polygons) == 0 and mesh.name not in baseline
	]
	checker.check(not empty, f"No empty mesh datablocks may be left behind, found {empty}")


###########################################################################
# Test cases

def case_all_success(checker):
	reset_scene()

	objects = [
		make_quad_object('Alpha'),
		make_quad_object('Beta', uv_coords=[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]),
		make_quad_object('Gamma', uv_coords=[(1.0, 1.0), (2.0, 1.0), (2.0, 2.0), (1.0, 2.0)]),
	]
	select_only(objects, objects[0])
	set_uv_map('UVMap', objects[0])

	before_objects = object_names()
	before_meshes = mesh_names()
	result = run_operator()

	checker.equal(result, {'FINISHED'}, "Operator should finish when every object converts")

	expected = {'Alpha_UVMap', 'Beta_UVMap', 'Gamma_UVMap'}
	new_names = object_names() - before_objects
	checker.equal(new_names, expected, "Each source object should produce one named mesh object")

	for name in expected:
		obj = bpy.data.objects.get(name)
		if not checker.check(obj is not None, f"Missing created object {name}"):
			continue
		checker.check(len(obj.data.polygons) > 0, f"{name} must contain at least one face")
		checker.check(obj.data.uv_layers.get('UVMap') is not None, f"{name} must carry a UV map")

	checker.equal(selection_names(), expected, "Selection should contain only the newly created objects")
	active = bpy.context.view_layer.objects.active
	checker.check(active is not None, "There must be an active object")
	checker.check(active is not None and active.name in expected,
		"Active object should be one of the newly created objects")

	infos = find_reports({'INFO'})
	checker.check(any('Created 3' in message for message in infos),
		f"Success count should be reported, got {infos}")
	checker.check(not find_reports({'WARNING'}), "No warning expected when everything converts")
	check_no_empty_meshes(checker, before_meshes)


def case_partial_skip(checker):
	reset_scene()

	good = make_quad_object('Good')
	missing_uv = make_quad_object('MissingUV', uv_name='OtherMap')
	no_faces = make_quad_object('NoFaces', with_face=False)
	degenerate = make_quad_object('Degenerate', uv_coords=[(0.0, 0.0)] * 4)

	select_only([good, missing_uv, no_faces, degenerate], good)
	set_uv_map('UVMap', good)

	before_objects = object_names()
	before_meshes = mesh_names()
	result = run_operator()

	checker.equal(result, {'FINISHED'}, "Operator should finish when at least one object converts")

	new_names = object_names() - before_objects
	checker.equal(new_names, {'Good_UVMap'}, "Only the convertible object should produce a mesh")
	checker.equal(len(mesh_names() - before_meshes), 1, "Exactly one new mesh datablock should remain")
	checker.equal(selection_names(), {'Good_UVMap'}, "Selection should contain only the created object")
	active = bpy.context.view_layer.objects.active
	checker.check(active is not None and active.name == 'Good_UVMap',
		"Active object should be the newly created object")

	warnings = find_reports({'WARNING'})
	checker.check(bool(warnings), "Skipped objects should raise a warning")
	checker.check(any('Skipped 3 object(s)' in message for message in warnings),
		f"Warning should count the three skipped objects, got {warnings}")

	infos = find_reports({'INFO'})
	checker.check(any('Created 1' in message and 'skipped 3' in message for message in infos),
		f"Info report should include both counts, got {infos}")

	for name in ('MissingUV', 'NoFaces', 'Degenerate'):
		checker.check(name in object_names(), f"Source object {name} must not be deleted")

	check_no_empty_meshes(checker, before_meshes)


def case_skip_reasons_and_repeat(checker):
	"""Same setup, inspected through the batch helper for skip reasons and reuse."""
	reset_scene()

	good = make_quad_object('Good')
	missing_uv = make_quad_object('MissingUV', uv_name='OtherMap')
	no_faces = make_quad_object('NoFaces', with_face=False)
	degenerate = make_quad_object('Degenerate', uv_coords=[(0.0, 0.0)] * 4)

	select_only([good, missing_uv, no_faces, degenerate], good)

	before_meshes = mesh_names()
	created, skipped = uv_mesh_module.convert_selected_uv_maps(
		bpy.context, 'UVMap', '_', 0.000001)

	checker.equal([obj.name for obj in created], ['Good_UVMap'], "Helper should report one created object")
	reasons = dict(skipped)
	checker.equal(reasons.get('MissingUV'), uv_mesh_module.SKIP_MISSING_UV, "Missing UV reason")
	checker.equal(reasons.get('NoFaces'), uv_mesh_module.SKIP_NO_FACES, "Empty mesh reason")
	checker.equal(reasons.get('Degenerate'), uv_mesh_module.SKIP_NO_FACES, "Degenerate UV reason")

	# Repeated execution must not touch data produced by the previous run
	first_object = bpy.data.objects['Good_UVMap']
	first_mesh = first_object.data
	first_mesh_name = first_mesh.name
	first_polygons = len(first_mesh.polygons)

	select_only([good], good)
	created_again, _skipped_again = uv_mesh_module.convert_selected_uv_maps(
		bpy.context, 'UVMap', '_', 0.000001)

	checker.equal(len(created_again), 1, "Second run should create one more object")
	if created_again:
		second_mesh = created_again[0].data
		checker.check(second_mesh is not first_mesh, "Second run must create a fresh mesh datablock")
		checker.check(created_again[0].name != 'Good_UVMap',
			"Second run must not reuse the previous object")
		checker.check(bpy.data.objects.get('Good_UVMap') is first_object,
			"Previous result object must survive a repeated run")
		checker.check(bpy.data.objects['Good_UVMap'].data is first_mesh,
			"Previous result mesh must not be replaced")
		checker.equal(first_mesh.name, first_mesh_name, "Previous mesh name must not change")
		checker.equal(len(first_mesh.polygons), first_polygons, "Previous mesh geometry must not change")

	check_no_empty_meshes(checker, before_meshes)


def case_all_skipped(checker):
	reset_scene()

	# The Degenerate object carries the requested UV map (so the enum selection is
	# valid) but produces no faces, which makes every selected object skippable.
	# Each target exercises a different skip reason: missing UV, no faces, and a
	# UV map whose faces all collapse to zero area.
	missing_uv = make_quad_object('MissingUV', uv_name='OtherMap')
	no_faces = make_quad_object('NoFaces', uv_name='UVMap', with_face=False)
	degenerate = make_quad_object('Degenerate', uv_coords=[(0.0, 0.0)] * 4)

	targets = [missing_uv, no_faces, degenerate]
	select_only(targets, degenerate)
	set_uv_map('UVMap', degenerate)

	before_objects = object_names()
	before_meshes = mesh_names()
	before_selection = selection_names()
	before_active = bpy.context.view_layer.objects.active.name

	result = run_operator()

	checker.equal(result, {'CANCELLED'}, "Operator should cancel when nothing converts")
	checker.equal(object_names(), before_objects, "No objects may be left behind")
	checker.equal(mesh_names(), before_meshes, "No mesh datablocks may be left behind")
	checker.equal(selection_names(), before_selection, "Previous selection should be restored")
	active = bpy.context.view_layer.objects.active
	checker.check(active is not None and active.name == before_active,
		"Previous active object should be restored")

	checker.check(
		all('Created' not in message for message in find_reports({'INFO'})),
		"No success report should be emitted when everything is skipped")
	warnings = find_reports({'WARNING'})
	checker.check(bool(warnings), "Skipped objects should raise a warning")
	checker.check(any('Skipped 3 object(s)' in message for message in warnings),
		f"Warning should count all skipped objects, got {warnings}")

	check_no_empty_meshes(checker, before_meshes)


def case_no_mesh_selected(checker):
	reset_scene()
	bpy.context.view_layer.objects.active = None

	before_objects = object_names()
	_reports.clear()
	try:
		result = bpy.ops.object.uv_mesh_verify()
	except RuntimeError:
		# Operator poll rejects the empty selection, which is the expected guard
		result = {'CANCELLED'}
	checker.equal(result, {'CANCELLED'}, "Operator should cancel without selected meshes")
	checker.equal(object_names(), before_objects, "No objects should be created")


CASES = (
	('all-success', case_all_success),
	('partial-skip', case_partial_skip),
	('skip-reasons-and-repeat', case_skip_reasons_and_repeat),
	('all-skipped', case_all_skipped),
	('no-mesh-selected', case_no_mesh_selected),
)


def _running_in_blender():
	"""True for a headless Blender run, False for the Text Editor or the offline mock."""
	return bool(getattr(bpy.app, "background", False))


def main():
	print("UV to Mesh batch verification")
	print(f"  repo: {REPO_ROOT}")
	print(f"  blender: {bpy.app.version_string}")

	_register()
	capture_baseline()
	total_failures = 0
	try:
		for name, case in CASES:
			print(f"\n[{name}]")
			checker = Checker(name)
			try:
				case(checker)
			except Exception:
				checker.failures.append("unhandled exception")
				traceback.print_exc()
			if checker.failures:
				print(f"  -> {len(checker.failures)} failure(s)")
			else:
				print("  -> PASS")
			total_failures += len(checker.failures)
	finally:
		reset_scene()
		_unregister()

	print()
	if total_failures:
		print(f"FAILED: {total_failures} check(s) did not pass")
		if _running_in_blender():
			# --python-exit-code does not catch SystemExit raised from a Text
			# Editor run, so only propagate the failure code in background mode
			raise SystemExit(1)
		return 1

	print("PASSED: all UV to Mesh batch checks succeeded")
	return 0


if __name__ == "__main__":
	main()
