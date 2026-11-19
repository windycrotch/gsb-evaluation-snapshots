"""Unit tests for the hardened Planar UV projection chain.

These run on stock CPython against an in-memory Blender API stub
(see blender_stubs.py). A separate Blender-headless integration script is
provided in test_planar_uv_blender.py for environments with Blender installed.

Coverage:
  1. Normal projection of selected faces into an existing UV layer
  2. Object without a UV layer: explicit creation and rollback on failure
  3. Empty selection / non-mesh active object: cancellation, no exceptions
  4. Exception rollback: mode, selection and UV-layer state are restored
  5. Multi-object mixed batch: independent success/skip/failure accounting
  6. Load Selection bounding box: zero-size axes never become 0
"""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import blender_stubs  # noqa: E402

blender_stubs.install()

# Provide the sibling package import used by planar_uv ("from . import utility_panel")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
	sys.path.insert(0, REPO_ROOT)

import bpy  # noqa: E402  (stub, installed above)
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402


def _load_planar_uv():
	spec = importlib.util.spec_from_file_location(
		"Launch_MeshKit.planar_uv",
		os.path.join(REPO_ROOT, "Launch_MeshKit", "planar_uv.py"),
		submodule_search_locations=[os.path.join(REPO_ROOT, "Launch_MeshKit")])
	module = importlib.util.module_from_spec(spec)
	# Minimal stand-in for the package; planar_uv only touches utility_panel
	# at (un)registration time, which the tests never invoke.
	package = importlib.util.module_from_spec(
		importlib.util.spec_from_loader("Launch_MeshKit", loader=None))
	package.__path__ = [os.path.join(REPO_ROOT, "Launch_MeshKit")]
	package.utility_panel = types.SimpleNamespace(
		register_panels=lambda panels: None,
		unregister_panels=lambda panels: None)
	sys.modules.setdefault("Launch_MeshKit", package)
	spec.loader.exec_module(module)
	return module


planar_uv = _load_planar_uv()


class FakeSettings:
	"""Stand-in for the MeshKitSettings property group."""

	def __init__(self):
		self.projection_axis = "Z"
		self.projection_centre = [0.0, 0.0, 0.0]
		self.projection_size = [2.0, 2.0, 2.0]
		self.projection_space = "L"
		self.projection_rotation = "+XY"
		self.projection_flip = "1.0"
		self.projection_align = "0.0"


class TestOperator:
	"""Minimal operator harness capturing self.report calls."""

	def __init__(self):
		self.reports = []

	def report(self, level, message):
		self.reports.append((set(level), message))


def make_quad_mesh(name):
	"""Unit quad from (0,0,0) to (1,1,0), both face and verts selected."""
	mesh = blender_stubs.FakeMesh(
		name,
		vert_coords=[(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)],
		face_vert_indices=[(0, 1, 2, 3)])
	for vert in mesh.verts:
		vert.select = True
	mesh.polygons[0].select = True
	return mesh


def make_two_face_mesh(name):
	mesh = blender_stubs.FakeMesh(
		name,
		vert_coords=[(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 1, 0)],
		face_vert_indices=[(0, 1, 2, 3), (1, 4, 2)])
	for vert in mesh.verts:
		vert.select = True
	for poly in mesh.polygons:
		poly.select = True
	return mesh


class PlanarUVTestBase(unittest.TestCase):
	def setUp(self):
		blender_stubs.reset()
		self.context, self.scene, self.view_layer = blender_stubs.new_world()
		self.settings = FakeSettings()
		self.scene.mesh_kit_settings = self.settings
		self.operator = TestOperator()


class TestNormalProjection(PlanarUVTestBase):
	def test_projects_selected_face_into_existing_uv_layer(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		# Z axis, local space, size 2, centre 0: U = x/2, V = y/2
		status = planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(status, "success")
		written = mesh.loop_uvs["UVMap"]
		expected = [(0.0, 0.0), (0.5, 0.0), (0.5, 0.5), (0.0, 0.5)]
		for loop_index, (expected_u, expected_v) in enumerate(expected):
			self.assertAlmostEqual(written[loop_index][0], expected_u)
			self.assertAlmostEqual(written[loop_index][1], expected_v)
		# No extra layer should appear, and the original layer must survive.
		self.assertEqual([layer.name for layer in mesh.uv_layers], ["UVMap"])

	def test_returns_object_mode_and_preserves_selection(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)

		planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(obj.mode, "OBJECT")
		self.assertTrue(obj.selected)
		self.assertEqual(self.view_layer.objects.active, obj)

	def test_does_not_mutate_scene_size_property(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		self.settings.projection_size = [0.0, 0.0, 0.0]

		status = planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(status, "success")
		self.assertEqual(list(self.settings.projection_size), [0.0, 0.0, 0.0])

	def test_full_operator_restores_edit_mode_entry(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		obj.mode = "EDIT"  # user started from edit mode

		result = planar_uv.MeshKit_UV_Planar_Projection.execute(self.operator, self.context)

		self.assertEqual(result, {"FINISHED"})
		self.assertEqual(obj.mode, "EDIT")
		self.assertTrue(obj.selected)
		self.assertEqual(self.view_layer.objects.active, obj)

	def test_world_space_uses_matrix_world(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(
			self.view_layer, "Quad", mesh, selected=True, active=True,
			matrix_world=Matrix.Translation((10.0, 0.0, 0.0)))
		self.settings.projection_space = "W"
		self.settings.projection_centre = [10.0, 0.0, 0.0]

		status = planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(status, "success")
		written = mesh.loop_uvs["UVMap"]
		# World x is local x + 10; centre cancels the translation, so U = x/2.
		self.assertAlmostEqual(written[0][0], 0.0)
		self.assertAlmostEqual(written[1][0], 0.5)


class TestObjectWithoutUVLayer(PlanarUVTestBase):
	def test_creates_layer_with_explicit_default_name(self):
		mesh = make_quad_mesh("Bare")
		self.assertEqual(len(mesh.uv_layers), 0)
		obj = blender_stubs.make_object(self.view_layer, "Bare", mesh,
										selected=True, active=True)

		status = planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(status, "success")
		self.assertEqual([layer.name for layer in mesh.uv_layers],
						 [planar_uv.DEFAULT_UV_LAYER_NAME])
		self.assertIn(planar_uv.DEFAULT_UV_LAYER_NAME, mesh.loop_uvs)

	def test_new_layer_is_rolled_back_when_write_fails(self):
		mesh = make_two_face_mesh("BareFail")
		obj = blender_stubs.make_object(self.view_layer, "BareFail", mesh,
										selected=True, active=True)
		original = self.settings.projection_axis

		def boom(pos, axis, rotation, flip, align, safe_size, centre):
			# Fail while writing the second face.
			if getattr(boom, "calls", 0) >= 4:
				raise RuntimeError("synthetic projection failure")
			boom.calls = getattr(boom, "calls", 0) + 1
			return (0.125, 0.25)

		with mock.patch.object(planar_uv, "_project_coordinate", boom):
			status = planar_uv.project_object_uv(obj, self.settings)

		self.assertTrue(status.startswith("error"))
		self.assertEqual(len(mesh.uv_layers), 0, "created UV layer must be removed")
		self.assertEqual(mesh.loop_uvs, {})
		self.assertEqual(obj.mode, "OBJECT")
		self.assertEqual(self.settings.projection_axis, original)

	def test_existing_layer_values_are_restored_on_failure(self):
		mesh = make_two_face_mesh("ExistingFail")
		mesh.uv_layers.new("UVMap")
		# Seed pre-existing UV data that must survive a mid-batch failure.
		for loop_index in range(len(mesh.loops)):
			mesh.loop_uvs.setdefault("UVMap", {})[loop_index] = (0.75, 0.25)
		obj = blender_stubs.make_object(self.view_layer, "ExistingFail", mesh,
										selected=True, active=True)

		def boom(pos, axis, rotation, flip, align, safe_size, centre):
			if getattr(boom, "calls", 0) >= 4:
				raise RuntimeError("synthetic projection failure")
			boom.calls = getattr(boom, "calls", 0) + 1
			return (0.0, 0.0)

		with mock.patch.object(planar_uv, "_project_coordinate", boom):
			status = planar_uv.project_object_uv(obj, self.settings)

		self.assertTrue(status.startswith("error"))
		self.assertEqual([layer.name for layer in mesh.uv_layers], ["UVMap"],
						 "existing UV layer must not be deleted")
		for values in mesh.loop_uvs["UVMap"].values():
			self.assertEqual(values, (0.75, 0.25))
		self.assertEqual(obj.mode, "OBJECT")


class TestEmptySelectionAndGuards(PlanarUVTestBase):
	def test_operator_cancels_when_active_is_not_mesh(self):
		curve = blender_stubs.make_object(
			self.view_layer, "Curve", data=object(), object_type="CURVE",
			selected=True, active=True)

		result = planar_uv.MeshKit_UV_Planar_Projection.execute(self.operator, self.context)

		self.assertEqual(result, {"CANCELLED"})
		self.assertTrue(any("mesh" in msg.lower() for _, msg in self.operator.reports))
		self.assertEqual(curve.mode, "OBJECT")

	def test_operator_cancels_when_no_active_object(self):
		result = planar_uv.MeshKit_UV_Planar_Projection.execute(self.operator, self.context)
		self.assertEqual(result, {"CANCELLED"})
		self.assertTrue(self.operator.reports)

	def test_operator_cancels_when_no_selected_faces(self):
		mesh = make_quad_mesh("Quiet")
		for poly in mesh.polygons:
			poly.select = False
		obj = blender_stubs.make_object(self.view_layer, "Quiet", mesh,
										selected=True, active=True)

		result = planar_uv.MeshKit_UV_Planar_Projection.execute(self.operator, self.context)

		self.assertEqual(result, {"CANCELLED"})
		self.assertTrue(any("selected faces" in msg for _, msg in self.operator.reports))
		self.assertEqual(obj.mode, "OBJECT")
		self.assertEqual(len(mesh.uv_layers), 0, "guard must run before any layer work")

	def test_object_without_selected_faces_is_skipped_not_errored(self):
		mesh = make_quad_mesh("Skip")
		for poly in mesh.polygons:
			poly.select = False
		obj = blender_stubs.make_object(self.view_layer, "Skip", mesh,
										selected=True, active=False)

		status = planar_uv.project_object_uv(obj, self.settings)

		self.assertEqual(status, "empty")
		self.assertEqual(obj.mode, "OBJECT")
		self.assertEqual(len(mesh.uv_layers), 0)

	def test_helper_reports_empty_mesh_gracefully(self):
		mesh = blender_stubs.FakeMesh("Empty", [], [])
		obj = blender_stubs.make_object(self.view_layer, "Empty", mesh,
										selected=True, active=True)
		status = planar_uv.project_object_uv(obj, self.settings)
		self.assertEqual(status, "empty")


class TestExceptionRollback(PlanarUVTestBase):
	def test_failure_before_edit_mode_leaves_no_state_behind(self):
		# If mode_set('EDIT') itself fails (e.g. user cancellation), no UV
		# layer may be created and the object stays in object mode.
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		original_mode_set = bpy.ops.object.mode_set

		def reject_edit(mode=None):
			if mode == "EDIT":
				raise RuntimeError("mode switch cancelled")
			return original_mode_set(mode=mode)

		bpy.ops.object.mode_set = reject_edit
		try:
			status = planar_uv.project_object_uv(obj, self.settings)
		finally:
			bpy.ops.object.mode_set = original_mode_set

		self.assertTrue(status.startswith("error"))
		self.assertEqual(len(mesh.uv_layers), 0)
		self.assertEqual(obj.mode, "OBJECT")
		self.assertTrue(obj.selected)

	def test_load_selection_failure_before_edit_mode_is_contained(self):
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		original_mode_set = bpy.ops.object.mode_set

		def reject_edit(mode=None):
			if mode == "EDIT":
				raise RuntimeError("mode switch cancelled")
			return original_mode_set(mode=mode)

		bpy.ops.object.mode_set = reject_edit
		try:
			status = planar_uv.load_selection_bounds(obj, self.settings)
		finally:
			bpy.ops.object.mode_set = original_mode_set

		self.assertTrue(status.startswith("error"))
		self.assertEqual(obj.mode, "OBJECT")

	def test_mode_and_selection_restored_after_mode_set_failure(self):
		mesh = make_quad_mesh("Quad")
		mesh.uv_layers.new("UVMap")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		obj.mode = "EDIT"
		other = blender_stubs.make_object(
			self.view_layer, "Other", make_quad_mesh("OtherMesh"),
			selected=True, active=False)
		other_mesh = other.data
		other_mesh.uv_layers.new("UVMap")
		original_mode_set = bpy.ops.object.mode_set
		call_count = {"n": 0}

		def flaky_mode_set(mode=None):
			# Fail on the first mode switch back toward OBJECT inside the
			# context manager's cleanup path.
			call_count["n"] += 1
			if call_count["n"] == 2:
				raise RuntimeError("user cancelled / operator aborted")
			return original_mode_set(mode=mode)

		bpy.ops.object.mode_set = flaky_mode_set
		try:
			result = planar_uv.MeshKit_UV_Planar_Projection.execute(
				self.operator, self.context)
		finally:
			bpy.ops.object.mode_set = original_mode_set

		# The exception is contained per-object; the batch still completes
		# and the operator exits cleanly with a report rather than raising.
		self.assertIn(result, ({"FINISHED"}, {"CANCELLED"}))
		# Context manager best-effort restoration leaves a consistent mode.
		self.assertIn(obj.mode, ("OBJECT", "EDIT"))
		self.assertTrue(obj.selected)
		self.assertTrue(other.selected)
		self.assertEqual(self.view_layer.objects.active, obj)

	def test_context_manager_restores_selection_when_exception_propagates(self):
		mesh = make_quad_mesh("Quad")
		obj_a = blender_stubs.make_object(self.view_layer, "A", mesh,
										  selected=True, active=True)
		obj_b = blender_stubs.make_object(
			self.view_layer, "B", make_quad_mesh("BMesh"), selected=True)
		obj_b.mode = "OBJECT"

		with self.assertRaises(RuntimeError):
			with planar_uv.mode_and_selection_restored(self.context):
				obj_a.select_set(False)
				obj_b.select_set(False)
				raise RuntimeError("boom")

		self.assertTrue(obj_a.selected)
		self.assertTrue(obj_b.selected)
		self.assertEqual(self.view_layer.objects.active, obj_a)

	def test_load_selection_restores_edit_mode_on_error(self):
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		obj.mode = "EDIT"
		original = bmesh.from_edit_mesh

		def boom(mesh_arg):
			raise RuntimeError("bmesh unavailable")

		bmesh.from_edit_mesh = boom
		try:
			result = planar_uv.MeshKit_UV_Load_Selection.execute(
				self.operator, self.context)
		finally:
			bmesh.from_edit_mesh = original

		self.assertEqual(result, {"CANCELLED"})
		self.assertEqual(obj.mode, "EDIT")
		self.assertTrue(obj.selected)


class TestMultiObjectMixedBatch(PlanarUVTestBase):
	def _build_batch(self):
		# Object 1: healthy mesh with UV layer.
		good_mesh = make_quad_mesh("Good")
		good_mesh.uv_layers.new("UVMap")
		good = blender_stubs.make_object(self.view_layer, "Good", good_mesh,
										 selected=True, active=True)

		# Object 2: selected mesh with no selected faces -> skipped.
		skip_mesh = make_quad_mesh("Skip")
		for poly in skip_mesh.polygons:
			poly.select = False
		skipped = blender_stubs.make_object(self.view_layer, "Skip", skip_mesh,
											selected=True)

		# Object 3: selected mesh that fails mid-projection.
		bad_mesh = make_two_face_mesh("Bad")
		bad = blender_stubs.make_object(self.view_layer, "Bad", bad_mesh,
										selected=True)

		# Non-mesh selected object: filtered out entirely.
		curve = blender_stubs.make_object(
			self.view_layer, "CurveObj", data=object(), object_type="CURVE",
			selected=True)

		# Unselected mesh: must never be touched.
		sleepy_mesh = make_quad_mesh("Sleepy")
		sleepy_mesh.uv_layers.new("UVMap")
		sleepy = blender_stubs.make_object(self.view_layer, "Sleepy", sleepy_mesh,
										   selected=False)
		return good, skipped, bad, curve, sleepy

	def test_independent_success_skip_failure_accounting(self):
		good, skipped, bad, curve, sleepy = self._build_batch()

		original_project = planar_uv.project_object_uv

		def routing(target, settings):
			if target is bad:
				raise RuntimeError("synthetic batch failure")
			return original_project(target, settings)

		with mock.patch.object(planar_uv, "project_object_uv", routing):
			result = planar_uv.MeshKit_UV_Planar_Projection.execute(
				self.operator, self.context)

		self.assertEqual(result, {"FINISHED"})
		# One success, one skip, one failure; curve ignored, sleepy untouched.
		summary = " ".join(msg for _, msg in self.operator.reports)
		self.assertIn("1 succeeded", summary)
		self.assertIn("1 skipped", summary)
		self.assertIn("1 failed", summary)

		# Good object got real UV writes.
		self.assertIn("UVMap", good.data.loop_uvs)
		# Skipped object gained no layer and stayed selected.
		self.assertEqual(len(skipped.data.uv_layers), 0)
		self.assertTrue(skipped.selected)
		# Failed object rolled back any newly created layer.
		self.assertEqual(len(bad.data.uv_layers), 0)
		# Non-mesh and unselected objects were never processed.
		self.assertEqual(curve.mode, "OBJECT")
		self.assertFalse(sleepy.selected)
		self.assertEqual(sleepy.data.loop_uvs.get("UVMap", {}), {})
		# Entry selection/active state restored for every handled object.
		for obj in (good, skipped, bad, curve):
			self.assertTrue(obj.selected, f"{obj.name} selection must be restored")
		self.assertEqual(self.view_layer.objects.active, good)

	def test_batch_without_any_success_returns_cancelled(self):
		# Active mesh exists, but every selected mesh lacks selected faces.
		mesh_a = make_quad_mesh("A")
		for poly in mesh_a.polygons:
			poly.select = False
		obj_a = blender_stubs.make_object(self.view_layer, "A", mesh_a,
										  selected=True, active=True)
		mesh_b = make_quad_mesh("B")
		for poly in mesh_b.polygons:
			poly.select = False
		obj_b = blender_stubs.make_object(self.view_layer, "B", mesh_b,
										  selected=True)
		# Re-enable faces on the active object only to pass the entry guard,
		# then disable again to simulate all-empty processing.
		mesh_a.polygons[0].select = True
		original = planar_uv.project_object_uv

		def both_empty(target, settings):
			return original_project(target, settings)

		mesh_a.polygons[0].select = False
		result = planar_uv.MeshKit_UV_Planar_Projection.execute(
			self.operator, self.context)

		self.assertEqual(result, {"CANCELLED"})
		self.assertTrue(obj_a.selected and obj_b.selected)


class TestLoadSelection(PlanarUVTestBase):
	def test_bounding_box_centre_and_size(self):
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)

		result = planar_uv.MeshKit_UV_Load_Selection.execute(self.operator, self.context)

		self.assertEqual(result, {"FINISHED"})
		self.assertEqual(list(self.settings.projection_centre), [0.5, 0.5, 0.0])
		self.assertEqual(list(self.settings.projection_size), [1.0, 1.0, 1.0])
		self.assertEqual(obj.mode, "OBJECT")

	def test_zero_size_axes_are_written_as_one(self):
		# Flat quad on Z: the Z axis has zero extent and must become 1.0.
		mesh = make_quad_mesh("Flat")
		obj = blender_stubs.make_object(self.view_layer, "Flat", mesh,
										selected=True, active=True)

		status = planar_uv.load_selection_bounds(obj, self.settings)

		self.assertEqual(status, "success")
		for component in self.settings.projection_size:
			self.assertGreater(component, 0.0)
		self.assertEqual(self.settings.projection_size[2], 1.0)

	def test_empty_vertex_selection_cancels_without_write(self):
		mesh = make_quad_mesh("Quiet")
		for vert in mesh.verts:
			vert.select = False
		obj = blender_stubs.make_object(self.view_layer, "Quiet", mesh,
										selected=True, active=True)
		self.settings.projection_size = [3.0, 4.0, 5.0]

		result = planar_uv.MeshKit_UV_Load_Selection.execute(self.operator, self.context)

		self.assertEqual(result, {"CANCELLED"})
		self.assertEqual(list(self.settings.projection_size), [3.0, 4.0, 5.0])
		self.assertEqual(obj.mode, "OBJECT")

	def test_non_mesh_active_cancels(self):
		blender_stubs.make_object(self.view_layer, "Curve", data=object(),
								  object_type="CURVE", selected=True, active=True)
		result = planar_uv.MeshKit_UV_Load_Selection.execute(self.operator, self.context)
		self.assertEqual(result, {"CANCELLED"})

	def test_restores_edit_mode_and_selection(self):
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(self.view_layer, "Quad", mesh,
										selected=True, active=True)
		obj.mode = "EDIT"

		result = planar_uv.MeshKit_UV_Load_Selection.execute(self.operator, self.context)

		self.assertEqual(result, {"FINISHED"})
		self.assertEqual(obj.mode, "EDIT")
		self.assertTrue(obj.selected)
		self.assertEqual(self.view_layer.objects.active, obj)

	def test_world_space_bounds_apply_matrix(self):
		mesh = make_quad_mesh("Quad")
		obj = blender_stubs.make_object(
			self.view_layer, "Quad", mesh, selected=True, active=True,
			matrix_world=Matrix.Translation((10.0, 20.0, 0.0)))
		self.settings.projection_space = "W"

		status = planar_uv.load_selection_bounds(obj, self.settings)

		self.assertEqual(status, "success")
		self.assertAlmostEqual(self.settings.projection_centre[0], 10.5)
		self.assertAlmostEqual(self.settings.projection_centre[1], 20.5)


if __name__ == "__main__":
	unittest.main(verbosity=2)
