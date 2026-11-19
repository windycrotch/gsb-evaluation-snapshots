"""Blender-headless integration tests for the Planar UV operators.

Run with:

    blender --background --python tests/test_planar_uv_blender.py

The script enables the add-on, exercises both operators against real bpy
data, and exits with a non-zero status if any check fails. It covers the same
guarantees as the stub-based suite using the genuine Blender API:

  * normal projection into an existing UV layer
  * projection on a mesh without a UV layer (explicit creation)
  * empty selection / non-mesh active object -> CANCELLED, no exception
  * exception rollback restoring mode, selection and UV-layer state
  * multi-object mixed batch with independent per-object outcomes
  * Load Selection bounding box, including zero-size axes
"""

import bpy
import sys
import traceback


FAILURES = []


def check(name, condition, detail=""):
	if condition:
		print(f"  PASS | {name}")
	else:
		FAILURES.append(f"{name}: {detail}")
		print(f"  FAIL | {name} | {detail}")


def reset_scene():
	bpy.ops.wm.read_factory_settings(use_empty=True)
	bpy.ops.object.select_all(action='SELECT')
	bpy.ops.object.delete(use_global=False)


def make_mesh(name, selected=True, active=False,
			  with_uv=True, faces_selected=True, verts_selected=True):
	mesh = bpy.data.meshes.new(name)
	mesh.from_pydata(
		[(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)],
		[],
		[(0, 1, 2, 3)])
	mesh.update()
	obj = bpy.data.objects.new(name, mesh)
	bpy.context.collection.objects.link(obj)
	obj.select_set(selected)
	if active:
		bpy.context.view_layer.objects.active = obj
	if with_uv:
		mesh.uv_layers.new(name="UVMap")
	for poly in mesh.polygons:
		poly.select = faces_selected
	for vert in mesh.vertices:
		vert.select = verts_selected
	return obj


def configure_settings():
	# read_factory_settings() replaces the scene, so the property group must
	# be re-fetched (and reconfigured) after every reset.
	settings = bpy.context.scene.mesh_kit_settings
	settings.projection_axis = 'Z'
	settings.projection_centre = (0.0, 0.0, 0.0)
	settings.projection_size = (2.0, 2.0, 2.0)
	settings.projection_space = 'L'
	settings.projection_rotation = '+XY'
	settings.projection_flip = '1.0'
	settings.projection_align = '0.0'
	return settings


def main():
	# Make the add-on package importable when running from a checkout.
	# This file lives at <repo>/tests/, the package at <repo>/Launch_MeshKit/.
	import os
	repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
	if repo_root not in sys.path:
		sys.path.append(repo_root)

	import importlib
	addon = importlib.import_module("Launch_MeshKit")
	addon.register()

	# --- 1. Normal projection into an existing UV layer -------------------
	reset_scene()
	settings = configure_settings()
	obj = make_mesh("Normal", active=True)
	result = bpy.ops.ops.meshkit_uv_planar_projection()
	check("normal projection returns FINISHED", result == {'FINISHED'}, str(result))
	uvs = [tuple(obj.data.uv_layers.active.data[i].uv) for i in range(4)]
	check("normal projection writes expected UVs",
		  uvs == [(0.0, 0.0), (0.5, 0.0), (0.5, 0.5), (0.0, 0.5)], str(uvs))
	check("normal projection restores object mode", obj.mode == 'OBJECT', obj.mode)
	check("normal projection keeps selection", obj.select_get())

	# --- 2. Object without a UV layer gets an explicit new layer ----------
	reset_scene()
	settings = configure_settings()
	obj = make_mesh("NoUV", active=True, with_uv=False)
	result = bpy.ops.ops.meshkit_uv_planar_projection()
	check("no-UV projection returns FINISHED", result == {'FINISHED'}, str(result))
	check("no-UV projection creates exactly one layer",
		  len(obj.data.uv_layers) == 1 and obj.data.uv_layers[0].name == "UVMap",
		  str([layer.name for layer in obj.data.uv_layers]))

	# --- 3a. Empty face selection cancels without touching UV layers ------
	reset_scene()
	settings = configure_settings()
	obj = make_mesh("EmptyFaces", active=True, with_uv=False, faces_selected=False)
	result = bpy.ops.ops.meshkit_uv_planar_projection()
	check("empty faces returns CANCELLED", result == {'CANCELLED'}, str(result))
	check("empty faces creates no UV layer", len(obj.data.uv_layers) == 0)
	check("empty faces leaves mode untouched", obj.mode == 'OBJECT', obj.mode)

	# --- 3b. Non-mesh active object cancels -------------------------------
	reset_scene()
	settings = configure_settings()
	curve = bpy.data.curves.new("CurveData", type='CURVE')
	curve_obj = bpy.data.objects.new("CurveObj", curve)
	bpy.context.collection.objects.link(curve_obj)
	curve_obj.select_set(True)
	bpy.context.view_layer.objects.active = curve_obj
	result = bpy.ops.ops.meshkit_uv_planar_projection()
	check("non-mesh active returns CANCELLED", result == {'CANCELLED'}, str(result))

	# --- 4. Exception rollback: mode and selection are restored -----------
	reset_scene()
	settings = configure_settings()
	obj = make_mesh("Rollback", active=True)
	obj.mode = 'EDIT'
	from Launch_MeshKit import planar_uv
	original_project = planar_uv.project_object_uv

	def failing_project(target, scene_settings):
		raise RuntimeError("synthetic failure")

	planar_uv.project_object_uv = failing_project
	try:
		result = bpy.ops.ops.meshkit_uv_planar_projection()
	finally:
		planar_uv.project_object_uv = original_project
	check("failing batch returns CANCELLED", result == {'CANCELLED'}, str(result))
	check("rollback restores edit mode", obj.mode == 'EDIT', obj.mode)
	check("rollback restores selection", obj.select_get())
	check("rollback keeps existing UV layer", len(obj.data.uv_layers) == 1)

	# --- 5. Multi-object mixed batch --------------------------------------
	reset_scene()
	settings = configure_settings()
	good = make_mesh("Good", active=True, with_uv=True)
	skipped = make_mesh("Skipped", selected=True, with_uv=False, faces_selected=False)
	bad = make_mesh("Bad", selected=True, with_uv=False)
	curve = bpy.data.curves.new("CurveData2", type='CURVE')
	curve_obj = bpy.data.objects.new("CurveObj2", curve)
	bpy.context.collection.objects.link(curve_obj)
	curve_obj.select_set(True)

	def routing(target, scene_settings):
		if target.name == "Bad":
			raise RuntimeError("synthetic batch failure")
		return original_project(target, scene_settings)

	planar_uv.project_object_uv = routing
	try:
		result = bpy.ops.ops.meshkit_uv_planar_projection()
	finally:
		planar_uv.project_object_uv = original_project

	check("mixed batch returns FINISHED (one success)", result == {'FINISHED'}, str(result))
	check("good object received UVs",
		  any(uv != (0.0, 0.0) for uv in
			  [tuple(good.data.uv_layers.active.data[i].uv) for i in range(4)]))
	check("skipped object gained no UV layer", len(skipped.data.uv_layers) == 0)
	check("failed object rolled back new UV layer", len(bad.data.uv_layers) == 0)
	check("non-mesh object untouched", curve_obj.mode == 'OBJECT')
	for target in (good, skipped, bad, curve_obj):
		check(f"selection restored for {target.name}", target.select_get())
	check("active object restored", bpy.context.view_layer.objects.active == good)

	# --- 6. Load Selection: bounding box and zero-size axes ---------------
	reset_scene()
	settings = configure_settings()
	obj = make_mesh("Bounds", active=True)
	result = bpy.ops.ops.meshkit_uv_load_selection()
	check("load selection returns FINISHED", result == {'FINISHED'}, str(result))
	check("load selection centre",
		  tuple(settings.projection_centre) == (0.5, 0.5, 0.0),
		  str(tuple(settings.projection_centre)))
	check("load selection size has no zero axis",
		  all(component > 0.0 for component in settings.projection_size)
		  and settings.projection_size[2] == 1.0,
		  str(tuple(settings.projection_size)))

	reset_scene()
	settings = configure_settings()
	obj = make_mesh("NoVerts", active=True, verts_selected=False)
	previous_size = tuple(settings.projection_size)
	result = bpy.ops.ops.meshkit_uv_load_selection()
	check("load selection empty returns CANCELLED", result == {'CANCELLED'}, str(result))
	check("load selection empty writes nothing",
		  tuple(settings.projection_size) == previous_size)
	check("load selection restores mode", obj.mode == 'OBJECT', obj.mode)

	obj.mode = 'EDIT'
	result = bpy.ops.ops.meshkit_uv_load_selection()
	check("load selection restores edit mode", result == {'FINISHED'} and obj.mode == 'EDIT',
		  f"{result} / {obj.mode}")

	addon.unregister()

	print("\n==================================================")
	if FAILURES:
		print(f"Blender integration tests FAILED: {len(FAILURES)} failure(s)")
		for failure in FAILURES:
			print(f"  - {failure}")
		sys.exit(1)
	print("All Blender integration tests passed.")
	sys.exit(0)


if __name__ == "__main__":
	try:
		main()
	except Exception:
		traceback.print_exc()
		sys.exit(1)
