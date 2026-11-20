import bpy
import bmesh

from . import utility_panel

###########################################################################
# Skip reasons reported for objects that cannot be converted

SKIP_MISSING_UV = "MISSING_UV"
SKIP_NO_FACES = "NO_FACES"
SKIP_ERROR = "ERROR"


###########################################################################
# Helper functions

def get_uv_map_items(self, context):
	# Reads UV map names from the evaluated mesh (including Geometry Nodes output)
	# of the active object, so dynamically generated UV maps are available even
	# when the source mesh itself has none.
	items = []
	obj = context.active_object
	if obj and obj.type == 'MESH':
		depsgraph = context.evaluated_depsgraph_get()
		obj_eval = obj.evaluated_get(depsgraph)
		try:
			mesh_eval = obj_eval.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
			for index, uv_layer in enumerate(mesh_eval.uv_layers):
				items.append((uv_layer.name, uv_layer.name, "", index))
		finally:
			obj_eval.to_mesh_clear()
	if not items:
		items.append(('NONE', "No UV Maps", "Active object has no UV maps available to convert"))
	return items


def _build_uv_mesh(obj, context, uv_name, weld_distance):
	# Builds a flat mesh from the object's evaluated UV map at the current frame,
	# preserving n-gons (no triangulation) and welding coincident UV vertices so
	# faces that share a UV edge share topology instead of remaining disconnected.
	# Returns (mesh, None) on success or (None, reason) when the object has to be
	# skipped. The mesh is guaranteed to contain at least one polygon on success,
	# so callers never create empty objects.
	depsgraph = context.evaluated_depsgraph_get()

	try:
		obj_eval = obj.evaluated_get(depsgraph)
		mesh_eval = obj_eval.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
	except Exception:
		return None, SKIP_ERROR

	if mesh_eval is None:
		return None, SKIP_ERROR

	new_mesh = None
	try:
		uv_layer = mesh_eval.uv_layers.get(uv_name)
		if uv_layer is None:
			return None, SKIP_MISSING_UV
		if len(mesh_eval.polygons) == 0:
			return None, SKIP_NO_FACES

		bm = bmesh.new()
		try:
			# New object's own UVMap mirrors its vertex positions (which are the source
			# UV coordinates), so images map identically to how they did on the source.
			new_uv_layer = bm.loops.layers.uv.new("UVMap")
			for polygon in mesh_eval.polygons:
				verts = []
				for loop_index in polygon.loop_indices:
					uv = uv_layer.uv[loop_index].vector
					verts.append(bm.verts.new((uv.x, uv.y, 0.0)))
				try:
					face = bm.faces.new(verts)
				except ValueError:
					# Degenerate or duplicate face; its vertices are cleaned up below
					continue
				for loop in face.loops:
					loop[new_uv_layer].uv = (loop.vert.co.x, loop.vert.co.y)

			# UV-degenerate faces (all corners at the same coordinate) contribute no
			# geometry, so drop them before counting what is actually convertible
			degenerate = [face for face in bm.faces if face.calc_area() <= 0.0]
			if degenerate:
				bmesh.ops.delete(bm, geom=degenerate, context='FACES')

			# Drop vertices left behind by skipped polygons
			loose = [vert for vert in bm.verts if not vert.link_faces]
			if loose:
				bmesh.ops.delete(bm, geom=loose, context='VERTS')

			if bm.verts:
				bm.verts.ensure_lookup_table()
				bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=weld_distance)

			# Welding can collapse faces onto themselves; drop anything now degenerate
			# and sweep up the loose vertices that leaves behind
			collapsed = [face for face in bm.faces if face.calc_area() <= 0.0]
			if collapsed:
				bmesh.ops.delete(bm, geom=collapsed, context='FACES')
			loose = [vert for vert in bm.verts if not vert.link_faces]
			if loose:
				bmesh.ops.delete(bm, geom=loose, context='VERTS')

			if len(bm.faces) == 0:
				return None, SKIP_NO_FACES

			bm.normal_update()
			new_mesh = bpy.data.meshes.new(name="UVMesh")
			# From here on any failure must also delete the half-filled mesh datablock
			try:
				bm.to_mesh(new_mesh)
				if len(new_mesh.polygons) == 0:
					raise ValueError("converted mesh has no polygons")
			except Exception:
				bpy.data.meshes.remove(new_mesh)
				new_mesh = None
				return None, SKIP_NO_FACES
		finally:
			bm.free()

		return new_mesh, None
	finally:
		obj_eval.to_mesh_clear()


def build_uv_mesh(obj, context, uv_name, weld_distance):
	# Backwards-compatible wrapper: returns a new Mesh datablock, or None if the
	# UV map is unavailable or nothing convertible was produced.
	mesh, _reason = _build_uv_mesh(obj, context, uv_name, weld_distance)
	return mesh


def _remove_mesh(mesh):
	# Removes an unlinked Mesh datablock without touching shared mesh data
	if mesh is None:
		return
	try:
		if bpy.data.meshes.get(mesh.name) is mesh and mesh.users == 0:
			bpy.data.meshes.remove(mesh)
	except ReferenceError:
		pass


def _create_uv_object(context, source_obj, mesh, separator, uv_name):
	# Creates and links a new object for a freshly built mesh. Names always come
	# from the source object plus separator plus UV map name; Blender appends a
	# numeric suffix when that name is already taken, so repeated runs never
	# reuse or overwrite the meshes produced by an earlier run.
	mesh.name = f"{source_obj.name}{separator}{uv_name}"
	obj = bpy.data.objects.new(mesh.name, mesh)
	collection = context.collection or context.scene.collection
	try:
		collection.objects.link(obj)
	except Exception:
		# Roll back the unlinked object so no half-created datablock is left behind
		bpy.data.objects.remove(obj, do_unlink=True)
		raise
	return obj


def _deselect_all(context):
	for obj in list(context.selected_objects):
		try:
			obj.select_set(False)
		except RuntimeError:
			pass


def _apply_selection(context, created, previous_selection, previous_active):
	"""Selects only the objects created by this run, or restores the previous
	selection and active object when nothing was created."""
	view_layer = context.view_layer

	_deselect_all(context)

	if created:
		for obj in created:
			try:
				obj.select_set(True)
			except RuntimeError:
				pass
		try:
			view_layer.objects.active = created[-1]
		except (RuntimeError, TypeError):
			pass
		return

	previous_selection = [obj for obj in previous_selection if obj is not None]
	for obj in previous_selection:
		try:
			if obj.name in view_layer.objects:
				obj.select_set(True)
		except (RuntimeError, ReferenceError):
			pass

	try:
		if previous_active is not None and previous_active.name in view_layer.objects:
			view_layer.objects.active = previous_active
		else:
			view_layer.objects.active = None
	except (RuntimeError, TypeError, ReferenceError):
		pass


def convert_selected_uv_maps(context, uv_name, separator, weld_distance):
	"""Converts the named UV map of every selected mesh into a new flat mesh
	object. Objects without that UV map, without convertible faces, or that fail
	to evaluate are skipped without interrupting the rest of the batch.

	Returns (created_objects, skipped) where skipped is a list of
	(object_name, reason) tuples using the SKIP_* constants.

	Selection afterwards contains only the newly created objects (with one of
	them active), or is restored to its pre-run state when nothing was created.
	"""
	previous_selection = list(context.selected_objects)
	previous_active = context.view_layer.objects.active

	created = []
	skipped = []

	for obj in previous_selection:
		if obj.type != 'MESH':
			continue

		try:
			new_mesh, reason = _build_uv_mesh(obj, context, uv_name, weld_distance)
		except Exception as exc:
			print(f"UV to Mesh failed | {obj.name} | {exc}")
			new_mesh, reason = None, SKIP_ERROR

		if new_mesh is None:
			skipped.append((obj.name, reason or SKIP_ERROR))
			continue

		try:
			new_obj = _create_uv_object(context, obj, new_mesh, separator, uv_name)
		except Exception as exc:
			print(f"UV to Mesh failed | {obj.name} | {exc}")
			_remove_mesh(new_mesh)
			skipped.append((obj.name, SKIP_ERROR))
			continue

		created.append(new_obj)

	_apply_selection(context, created, previous_selection, previous_active)
	return created, skipped


def _reason_label(reason):
	if reason == SKIP_MISSING_UV:
		return "UV map missing"
	if reason == SKIP_NO_FACES:
		return "no convertible faces"
	return "evaluation failed"


def _summarise_skips(skipped, uv_name):
	missing_uv = sum(1 for _name, reason in skipped if reason == SKIP_MISSING_UV)
	no_faces = sum(1 for _name, reason in skipped if reason == SKIP_NO_FACES)
	errors = len(skipped) - missing_uv - no_faces

	parts = []
	if missing_uv:
		parts.append(f"{missing_uv} missing UV map '{uv_name}'")
	if no_faces:
		parts.append(f"{no_faces} with no convertible faces")
	if errors:
		parts.append(f"{errors} that failed to evaluate")

	return f"Skipped {len(skipped)} object(s): " + ", ".join(parts)



###########################################################################
# Main class

class OBJECT_OT_uv_mesh(bpy.types.Operator):
	"""Convert the selected UV map into a new flat mesh object, preserving n-gons"""
	bl_idname = "object.uv_mesh"
	bl_label = "UV to Mesh"
	bl_description = "Bake the selected UV map of the evaluated mesh (including Geometry Nodes output) into a new static mesh object at the current frame"
	bl_options = {'REGISTER', 'UNDO'}

	@classmethod
	def poll(cls, context):
		return any(obj.type == 'MESH' for obj in context.selected_objects)

	def execute(self, context):
		settings = context.scene.mesh_kit_settings
		uv_name = settings.uv_mesh_map

		if not uv_name or uv_name == 'NONE':
			self.report({'ERROR'}, "No UV map selected")
			return {'CANCELLED'}

		if not any(obj.type == 'MESH' for obj in context.selected_objects):
			self.report({'ERROR'}, "No mesh objects selected")
			return {'CANCELLED'}

		created, skipped = convert_selected_uv_maps(
			context,
			uv_name,
			settings.uv_mesh_separator,
			settings.uv_mesh_weld_distance)

		if skipped:
			self.report({'WARNING'}, _summarise_skips(skipped, uv_name))
			for name, reason in skipped:
				print(f"UV to Mesh skipped | {name} | {_reason_label(reason)}")

		if not created:
			# Nothing was created, any partial data was cleaned up, and the previous
			# selection/active object has been restored by the batch conversion
			return {'CANCELLED'}

		if skipped:
			self.report({'INFO'}, f"Created {len(created)} UV mesh object(s); skipped {len(skipped)}")
		else:
			self.report({'INFO'}, f"Created {len(created)} UV mesh object(s)")
		return {'FINISHED'}



###########################################################################
# UI rendering class

class MESHKIT_PT_uvToMesh(bpy.types.Panel):
	bl_label = "UV to Mesh"
	bl_idname = "MESHKIT_PT_uvToMesh"
	bl_space_type = "VIEW_3D"
	bl_region_type = "UI"
	bl_category = 'Launch'
	bl_order = 37
	bl_options = {'DEFAULT_CLOSED'}
	category_preference = "uv_mesh_category"

	@classmethod
	def poll(cls, context):
		return True

	def draw(self, context):
		settings = context.scene.mesh_kit_settings
		try:
			layout = self.layout
			layout.use_property_decorate = False # No animation

			obj = context.active_object
			if obj and obj.type == 'MESH':
				layout.prop(settings, 'uv_mesh_map', text="UV Map")

				row = layout.row(align=True)
				row.prop(settings, 'uv_mesh_separator', text="Separator")
				layout.prop(settings, 'uv_mesh_weld_distance')

				layout.operator(OBJECT_OT_uv_mesh.bl_idname)

				mesh_targets = [o for o in context.selected_objects if o.type == 'MESH']
				box = layout.box()
				box.label(text=str(len(mesh_targets)) + " selected mesh object(s)")
			else:
				layout.label(text="Active object must be a mesh")
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit UV to Mesh panel")



###########################################################################
# Addon registration functions

classes = (OBJECT_OT_uv_mesh,)

panels = [MESHKIT_PT_uvToMesh]


def register():
	# Register classes
	for cls in classes:
		bpy.utils.register_class(cls)
	# Register panels
	utility_panel.register_panels(panels)


def unregister():
	# Unregister panels
	utility_panel.unregister_panels(panels)
	# Unregister classes
	for cls in reversed(classes):
		bpy.utils.unregister_class(cls)


if __name__ == "__main__":
	try:
		unregister()
	except Exception:
		pass
	register()
