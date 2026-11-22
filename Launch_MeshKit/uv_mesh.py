import bpy
import bmesh
import json

from . import utility_panel

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


def _join_names(names):
	# Serialises a list of datablock names for storage in a StringProperty
	# (JSON instead of a delimiter join, since Blender names allow most characters)
	return json.dumps(list(names))


def _split_names(text):
	# Deserialises a name list stored by _join_names, tolerating empty/invalid data
	if not text:
		return []
	try:
		names = json.loads(text)
	except (ValueError, TypeError):
		return []
	if not isinstance(names, list):
		return []
	return [name for name in names if isinstance(name, str) and name]


def build_uv_mesh(obj, context, uv_name, weld_distance):
	# Builds a flat mesh from the object's evaluated UV map at the current frame,
	# preserving n-gons (no triangulation) and welding coincident UV vertices so
	# faces that share a UV edge share topology instead of remaining disconnected.
	# Returns a new Mesh datablock, or None if the UV map isn't available.
	# If construction fails partway, any half-built bmesh/mesh data is cleaned up
	# before the exception propagates, so no orphaned datablocks are left behind.
	depsgraph = context.evaluated_depsgraph_get()
	obj_eval = obj.evaluated_get(depsgraph)
	try:
		mesh_eval = obj_eval.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
		uv_layer = mesh_eval.uv_layers.get(uv_name)
		if uv_layer is None or len(mesh_eval.polygons) == 0:
			return None

		bm = bmesh.new()
		new_mesh = None
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
					# Degenerate face (should not normally happen), skip it
					continue
				for loop in face.loops:
					loop[new_uv_layer].uv = (loop.vert.co.x, loop.vert.co.y)

			bm.verts.ensure_lookup_table()
			bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld_distance)
			bm.normal_update()

			new_mesh = bpy.data.meshes.new(name="UVMesh")
			bm.to_mesh(new_mesh)
		except Exception:
			# Never leave a half-built mesh datablock behind on failure
			if new_mesh is not None:
				bpy.data.meshes.remove(new_mesh)
			raise
		finally:
			bm.free()
		return new_mesh
	finally:
		obj_eval.to_mesh_clear()


def _convert_objects(targets, context, uv_name, separator, weld_distance):
	# Shared conversion loop used by both the batch operator and the retry operator.
	# Returns (created_objects, failed_names, error_messages). Each object is fully
	# isolated: a failure cleans up any partial datablocks for that object and the
	# remaining objects are still processed.
	created = []
	failed = []
	errors = []

	for obj in targets:
		new_mesh = None
		new_obj = None
		try:
			new_mesh = build_uv_mesh(obj, context, uv_name, weld_distance)
			if new_mesh is None:
				failed.append(obj.name)
				continue

			new_mesh.name = f"{obj.name}{separator}{uv_name}"
			new_obj = bpy.data.objects.new(new_mesh.name, new_mesh)
			context.collection.objects.link(new_obj)
			created.append(new_obj)
		except Exception as exc:
			# Clean up whatever was partially created for this object
			if new_obj is not None and new_obj.users == 0:
				try:
					bpy.data.objects.remove(new_obj)
				except Exception:
					pass
			if new_mesh is not None and new_mesh.users == 0:
				try:
					bpy.data.meshes.remove(new_mesh)
				except Exception:
					pass
			failed.append(obj.name)
			errors.append(f"{obj.name}: {exc}")

	return created, failed, errors


def _select_created(context, created):
	for obj in context.selected_objects:
		obj.select_set(False)
	for obj in created:
		obj.select_set(True)
	if created:
		context.view_layer.objects.active = created[-1]



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

		separator = settings.uv_mesh_separator
		weld_distance = settings.uv_mesh_weld_distance

		targets = [obj for obj in context.selected_objects if obj.type == 'MESH']

		# Start a new session, completely replacing the previous one so results
		# from separate runs never mix. The state lives in scene settings, so it
		# rolls back together with undo.
		settings.uv_mesh_session_status = 'RUNNING'
		settings.uv_mesh_session_uv_map = uv_name
		settings.uv_mesh_session_sources = _join_names(obj.name for obj in targets)
		settings.uv_mesh_session_created = ""
		settings.uv_mesh_session_failed = ""

		created = []
		failed = []
		errors = []
		try:
			created, failed, errors = _convert_objects(targets, context, uv_name, separator, weld_distance)
		finally:
			# The session must never be left in a "running" state, even if the
			# batch is cancelled or an unexpected exception escapes the loop
			settings.uv_mesh_session_created = _join_names(obj.name for obj in created)
			settings.uv_mesh_session_failed = _join_names(failed)
			settings.uv_mesh_session_status = 'DONE'

		_select_created(context, created)

		for error in errors:
			self.report({'ERROR'}, error)
		if failed:
			self.report({'WARNING'}, f"UV map '{uv_name}' not found or conversion failed on: {', '.join(failed)}")
		if created:
			self.report({'INFO'}, f"Created {len(created)} UV mesh object(s)")
		else:
			self.report({'WARNING'}, "No UV mesh objects were created")

		# Always finish (even when everything failed) so the session summary is
		# committed as an undoable step and can roll back with the new objects
		return {'FINISHED'}



class OBJECT_OT_uv_mesh_retry_failed(bpy.types.Operator):
	"""Retry conversion only for the objects that failed in the last UV to Mesh session"""
	bl_idname = "object.uv_mesh_retry_failed"
	bl_label = "Retry Failed Objects"
	bl_description = "Retry UV to Mesh only for objects that failed in the last session and still exist; already-succeeded objects are not converted again"
	bl_options = {'REGISTER', 'UNDO'}

	@classmethod
	def poll(cls, context):
		settings = context.scene.mesh_kit_settings
		return bool(_split_names(settings.uv_mesh_session_failed))

	def execute(self, context):
		settings = context.scene.mesh_kit_settings

		# Use the UV map recorded by the session, falling back to the current selection
		uv_name = settings.uv_mesh_session_uv_map or settings.uv_mesh_map
		if not uv_name or uv_name == 'NONE':
			self.report({'ERROR'}, "No UV map recorded for the last session")
			return {'CANCELLED'}

		separator = settings.uv_mesh_separator
		weld_distance = settings.uv_mesh_weld_distance

		failed_names = _split_names(settings.uv_mesh_session_failed)
		if not failed_names:
			self.report({'INFO'}, "No failed objects to retry")
			return {'CANCELLED'}

		# Only retry failures that still exist; objects that already succeeded in
		# the session are never touched, so no duplicate meshes are generated
		targets = []
		missing = []
		for name in failed_names:
			obj = bpy.data.objects.get(name)
			if obj is not None and obj.type == 'MESH':
				targets.append(obj)
			else:
				missing.append(name)

		settings.uv_mesh_session_status = 'RUNNING'

		created = []
		still_failed = list(missing)
		errors = []
		try:
			created, retried_failed, errors = _convert_objects(targets, context, uv_name, separator, weld_distance)
			still_failed.extend(retried_failed)
		finally:
			# Recovered objects move out of the failure list and join the session's
			# created list; unrecovered ones stay failed for a future retry
			settings.uv_mesh_session_failed = _join_names(still_failed)
			previous_created = _split_names(settings.uv_mesh_session_created)
			previous_created.extend(obj.name for obj in created)
			settings.uv_mesh_session_created = _join_names(previous_created)
			settings.uv_mesh_session_status = 'DONE'

		_select_created(context, created)

		for error in errors:
			self.report({'ERROR'}, error)
		if missing:
			self.report({'WARNING'}, f"Skipped objects that no longer exist: {', '.join(missing)}")
		unavailable = [name for name in still_failed if name not in missing]
		if unavailable:
			self.report({'WARNING'}, f"UV map '{uv_name}' still not available on: {', '.join(unavailable)}")
		if created:
			self.report({'INFO'}, f"Recovered {len(created)} of {len(failed_names)} failed object(s)")
		else:
			self.report({'WARNING'}, "No failed objects could be recovered")

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

			# Last session summary (stored in scene settings, rolls back with undo)
			created_names = _split_names(settings.uv_mesh_session_created)
			failed_names = _split_names(settings.uv_mesh_session_failed)
			if settings.uv_mesh_session_status != 'IDLE' or created_names or failed_names:
				box = layout.box()
				if settings.uv_mesh_session_status == 'RUNNING':
					box.label(text="Session in progress...", icon='TIME')
				else:
					box.label(text=f"Last session: {len(created_names)} succeeded, {len(failed_names)} failed", icon='INFO')
				if failed_names:
					col = box.column(align=True)
					for name in failed_names[:10]:
						col.label(text=name, icon='ERROR')
					if len(failed_names) > 10:
						col.label(text=f"... and {len(failed_names) - 10} more")
					box.operator(OBJECT_OT_uv_mesh_retry_failed.bl_idname, icon='FILE_REFRESH')
		except Exception as exc:
			print(str(exc) + " | Error in Mesh Kit UV to Mesh panel")



###########################################################################
# Addon registration functions

classes = (OBJECT_OT_uv_mesh, OBJECT_OT_uv_mesh_retry_failed)

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
