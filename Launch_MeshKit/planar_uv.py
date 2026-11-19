import bpy
import bmesh
from mathutils import Vector

from . import utility_panel

###########################################################################
# Shared helpers

# Name used when an explicit UV layer has to be created. This mirrors the
# historical bmesh "verify()" fallback, which creates a layer named "UVMap".
DEFAULT_UV_LAYER_NAME = "UVMap"


def _safe_size(size):
	"""Return a local copy of projection size with zero/negative axes made safe.

	Never mutates the scene property, and never leaves a zero entry that would
	cause divide-by-zero downstream.
	"""
	return tuple(component if component > 0.0 else 1.0 for component in size)


def _project_coordinate(pos, axis, rotation, flip, align, safe_size, centre):
	"""Pure planar-projection math shared by the operator and its tests."""
	scaled = (
		(pos[0] - centre[0]) / safe_size[0],
		(pos[1] - centre[1]) / safe_size[1],
		(pos[2] - centre[2]) / safe_size[2],
	)

	# Projection Axis
	if axis == "X":
		u, v = scaled[1], scaled[2]
	elif axis == "Y":
		u, v = scaled[0], scaled[2]
	else:  # axis == "Z"
		u, v = scaled[0], scaled[1]

	# Projection Rotation
	if "YX" in rotation:
		u, v = v, u
		u *= -1.0
	if "-" in rotation:
		u *= -1.0
		v *= -1.0

	# Projection Flip, then image centre or zero point alignment
	return (u * flip + align, v * flip + align)


def _mesh_has_selected_faces(obj):
	"""True when the mesh has at least one selected polygon.

	Polygon selection flags are readable without changing modes, so the guard
	runs before any mode/selection state is touched.
	"""
	mesh = obj.data
	return bool(mesh.polygons) and any(polygon.select for polygon in mesh.polygons)


class mode_and_selection_restored:
	"""Snapshot and restore object mode, active object and selection state.

	Used as a context manager so the guarantee holds for normal completion,
	exceptions and operator cancellation alike. Only objects selected at entry
	are restored; objects created during the operation are deselected.
	"""

	def __init__(self, context):
		self.context = context
		self.original_mode = None
		self.original_active = None
		self.original_selected = ()

	def __enter__(self):
		context = self.context
		self.original_active = context.view_layer.objects.active
		if self.original_active is not None:
			self.original_mode = self.original_active.mode
		self.original_selected = tuple(context.selected_objects)
		return self

	def __exit__(self, exc_type, exc_value, traceback):
		context = self.context
		try:
			# All mode operations require object mode and an active object.
			if context.view_layer.objects.active is not None and context.active_object.mode != 'OBJECT':
				bpy.ops.object.mode_set(mode='OBJECT')

			for obj in context.selected_objects:
				if obj not in self.original_selected:
					obj.select_set(False)
			for obj in self.original_selected:
				if obj.name in bpy.data.objects:
					obj.select_set(True)

			if self.original_active is not None and self.original_active.name in bpy.data.objects:
				context.view_layer.objects.active = self.original_active
				if self.original_mode != 'OBJECT':
					bpy.ops.object.mode_set(mode=self.original_mode)
		except Exception:
			# Restoration is best effort; returning a falsy value implicitly
			# keeps the original exception/cancellation propagating.
			pass


def _get_or_create_uv_layer(bm):
	"""Return (layer, created) using an explicit rule instead of verify().

	Existing layers are reused untouched. Only when the mesh has no UV layer
	at all is one created with the default name, allowing callers to roll the
	creation back on failure.
	"""
	existing = bm.loops.layers.uv.active
	if existing is not None:
		return existing, False
	return bm.loops.layers.uv.new(DEFAULT_UV_LAYER_NAME), True


def project_object_uv(obj, settings):
	"""Project selected faces of one mesh into its UV layer.

	Returns a status string: "success", "empty" (no selected faces), or
	"error: <details>". All mode changes are reverted before returning. UV
	layers created here are removed again on failure; UV values of existing
	layers are restored from a pre-write snapshot on failure.
	"""
	if obj.type != "MESH":
		return "error: object is not a mesh"
	if not _mesh_has_selected_faces(obj):
		return "empty"

	axis = settings.projection_axis
	world = settings.projection_space == "W"
	rotation = settings.projection_rotation
	flip = float(settings.projection_flip)
	align = float(settings.projection_align)
	centre = tuple(settings.projection_centre)
	safe_size = _safe_size(settings.projection_size)

	# The object must be active and in edit mode for bmesh edit access.
	bm = None
	uv_layer = None
	created_layer = False
	snapshot = None
	try:
		obj.select_set(True)
		obj.view_layer.objects.active = obj
		bpy.ops.object.mode_set(mode='EDIT')

		mesh = obj.data
		mat = obj.matrix_world
		bm = bmesh.from_edit_mesh(mesh)

		uv_layer, created_layer = _get_or_create_uv_layer(bm)

		selected_faces = [face for face in bm.faces if face.select]
		if not selected_faces:
			# Defensive fallback: bmesh selection state disagreed with the mesh.
			return "empty"

		# Snapshot existing UV values so an existing layer can be fully
		# restored if anything fails partway through writing.
		snapshot = [
			(loop, tuple(loop[uv_layer].uv))
			for face in selected_faces
			for loop in face.loops
		]

		for face in selected_faces:
			for loop in face.loops:
				# copy() prevents accidental edits of the source vertex coordinates
				pos = loop.vert.co.copy()
				if world:
					pos = mat @ pos
				loop[uv_layer].uv = _project_coordinate(
					pos, axis, rotation, flip, align, safe_size, centre)

		bmesh.update_edit_mesh(mesh)
		return "success"
	except Exception as exc:
		# Roll back partial writes before leaving edit mode.
		if bm is not None and uv_layer is not None and snapshot is not None:
			try:
				for loop, values in snapshot:
					loop[uv_layer].uv = values
				bmesh.update_edit_mesh(obj.data)
			except Exception:
				pass
		if created_layer:
			try:
				bm.loops.layers.uv.remove(uv_layer)
				bmesh.update_edit_mesh(obj.data)
			except Exception:
				pass
		return f"error: {exc}"
	finally:
		if obj.mode == 'EDIT':
			bpy.ops.object.mode_set(mode='OBJECT')


def load_selection_bounds(obj, settings):
	"""Load centre/size from the selected vertices' bounding box.

	Returns a status string: "success", "empty" (no selected vertices) or
	"error: <details>". Zero-size bounding-box axes are written as 1.0 so the
	projection step can never divide by zero. All mode changes are reverted.
	"""
	if obj.type != "MESH":
		return "error: object is not a mesh"

	try:
		obj.select_set(True)
		obj.view_layer.objects.active = obj
		bpy.ops.object.mode_set(mode='EDIT')
		mesh = obj.data
		mat = obj.matrix_world
		bm = bmesh.from_edit_mesh(mesh)

		min_co = Vector((float("inf"), float("inf"), float("inf")))
		max_co = Vector((float("-inf"), float("-inf"), float("-inf")))
		for vert in bm.verts:
			if vert.select:
				min_co.x = min(min_co.x, vert.co.x)
				min_co.y = min(min_co.y, vert.co.y)
				min_co.z = min(min_co.z, vert.co.z)
				max_co.x = max(max_co.x, vert.co.x)
				max_co.y = max(max_co.y, vert.co.y)
				max_co.z = max(max_co.z, vert.co.z)

		if min_co.x == float("inf"):
			return "empty"

		# Convert to world space if enabled
		if settings.projection_space == "W":
			min_co = mat @ min_co
			max_co = mat @ max_co

		centre = (min_co + max_co) * 0.5
		dimensions = max_co - min_co

		# Zero-size axes must not be written as 0: the projection divides by
		# these values. A flat selection on one axis keeps a safe 1.0 entry.
		dimensions = tuple(component if component != 0.0 else 1.0 for component in dimensions)

		settings.projection_centre = centre
		settings.projection_size = dimensions
		return "success"
	except Exception as exc:
		return f"error: {exc}"
	finally:
		if obj.mode == 'EDIT':
			bpy.ops.object.mode_set(mode='OBJECT')


###########################################################################
# Operators

class MeshKit_UV_Planar_Projection(bpy.types.Operator):
	bl_idname = "ops.meshkit_uv_planar_projection"
	bl_label = "Set UV Map"
	bl_description = "Numerical planar projection of 3D meshes into UV space"
	bl_options = {'REGISTER', 'UNDO'}

	def execute(self, context):
		active = context.view_layer.objects.active
		if active is None or active.type != "MESH":
			self.report({'WARNING'}, "Planar UV: active object must be a mesh")
			return {'CANCELLED'}
		if not _mesh_has_selected_faces(active):
			self.report({'WARNING'}, "Planar UV: no selected faces to project")
			return {'CANCELLED'}

		settings = context.scene.mesh_kit_settings
		targets = [obj for obj in context.selected_objects if obj.type == "MESH"]

		successes = []
		skipped = []
		failures = []

		# Mode and selection are restored on every exit path: success,
		# exception, or user cancellation propagated from bpy.ops.
		with mode_and_selection_restored(context):
			for obj in targets:
				try:
					status = project_object_uv(obj, settings)
				except Exception as exc:
					# One bad object must never stop the rest of the batch.
					status = f"error: {exc}"
				if status == "success":
					successes.append(obj)
				elif status == "empty":
					skipped.append((obj, "no selected faces"))
				else:
					failures.append((obj, status))

		for obj, reason in failures:
			print(f"Planar UV failed | {obj.name} | {reason}")
		if failures:
			self.report(
				{'WARNING'},
				f"Planar UV: {len(successes)} succeeded, {len(skipped)} skipped, "
				f"{len(failures)} failed. See console")
		else:
			self.report(
				{'INFO'},
				f"Planar UV: {len(successes)} succeeded, {len(skipped)} skipped")
		return {'FINISHED'} if successes else {'CANCELLED'}


class MeshKit_UV_Load_Selection(bpy.types.Operator):
	bl_idname = "ops.meshkit_uv_load_selection"
	bl_label = "Load Selection Settings"
	bl_description = "Set the Centre and Size variables to the bounding box of the selected geometry"
	bl_options = {'REGISTER', 'UNDO'}

	def execute(self, context):
		active = context.view_layer.objects.active
		if active is None or active.type != "MESH":
			self.report({'WARNING'}, "Load Selection: active object must be a mesh")
			return {'CANCELLED'}
		if not active.data.vertices:
			self.report({'WARNING'}, "Load Selection: mesh has no geometry")
			return {'CANCELLED'}

		settings = context.scene.mesh_kit_settings

		with mode_and_selection_restored(context):
			status = load_selection_bounds(active, settings)

		if status == "empty":
			self.report({'WARNING'}, "Load Selection: no selected vertices")
			return {'CANCELLED'}
		if status.startswith("error"):
			print(f"Load Selection failed | {active.name} | {status}")
			self.report({'WARNING'}, f"Load Selection failed: {status}")
			return {'CANCELLED'}

		self.report({'INFO'}, "Load Selection: bounding box applied")
		return {'FINISHED'}

###########################################################################
# UI rendering classes

class MESHKIT_PT_planar_uv(bpy.types.Panel):
	bl_idname = "MESHKIT_PT_planar_uv"
	bl_label = "Planar UV"
	bl_space_type = "VIEW_3D"
	bl_region_type = "UI"
	bl_category = "Launch"
	bl_order = 36
	bl_options = {'DEFAULT_CLOSED'}
	category_preference = "planaruv_category"

	@classmethod
	def poll(cls, context):
		return True

	def draw_header(self, context):
		try:
			layout = self.layout
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit Planar UV panel header")

	def draw(self, context):
		try:
			layout = self.layout
			layout.use_property_split = True
			layout.use_property_decorate = False # No animation
			layout.prop(context.scene.mesh_kit_settings, 'projection_axis', expand=True)

			col = layout.column()
			col.prop(context.scene.mesh_kit_settings, 'projection_centre')
			col = layout.column()
			col.prop(context.scene.mesh_kit_settings, 'projection_size')

			layout.prop(context.scene.mesh_kit_settings, 'projection_space', expand=True)

			button = layout.row()
			if not (context.view_layer.objects.active and context.view_layer.objects.active.type == "MESH"):
				button.active = False
				button.enabled = False
			button.operator(MeshKit_UV_Planar_Projection.bl_idname, icon="GROUP_UVS")
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit Planar UV panel")

class MESHKIT_PT_planar_uv_advanced(bpy.types.Panel):
	bl_idname = "MESHKIT_PT_planar_uv_advanced"
	bl_label = "Advanced"
	bl_space_type = "VIEW_3D"
	bl_region_type = "UI"
	bl_parent_id = "MESHKIT_PT_planar_uv"
	bl_options = {'DEFAULT_CLOSED'}
	category_preference = "planaruv_category"

	@classmethod
	def poll(cls, context):
		return True

	def draw_header(self, context):
		try:
			layout = self.layout
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit Planar UV Advanced panel header")

	def draw(self, context):
		try:
			layout = self.layout
			layout.use_property_split = True
			layout.use_property_decorate = False # No animation

			button = layout.row()
			if not (context.view_layer.objects.active and context.view_layer.objects.active.type == "MESH"):
				button.active = False
				button.enabled = False
			button.operator(MeshKit_UV_Load_Selection.bl_idname, icon="SHADING_BBOX")

			layout.prop(context.scene.mesh_kit_settings, 'projection_rotation', expand=True)
			layout.prop(context.scene.mesh_kit_settings, 'projection_flip', expand=True)
			layout.prop(context.scene.mesh_kit_settings, 'projection_align', expand=True)
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit Planar UV Advanced panel")




###########################################################################
# Registration

classes = (
	MeshKit_UV_Planar_Projection,
	MeshKit_UV_Load_Selection,
)

# Registered from the tab category set in the extension preferences, parent panel first
panels = [
	MESHKIT_PT_planar_uv,
	MESHKIT_PT_planar_uv_advanced,
]



def register():
	for cls in classes:
		bpy.utils.register_class(cls)
	# Register panels
	utility_panel.register_panels(panels)



def unregister():
	# Unregister panels
	utility_panel.unregister_panels(panels)
	for cls in reversed(classes):
		bpy.utils.unregister_class(cls)



if __name__ == "__main__":
	register()
