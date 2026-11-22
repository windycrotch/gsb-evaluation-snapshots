import bpy
import os
from re import search

# Internal imports
from .render_variables import renderkit_variable_ui
from . import utility_panel
from . import render_batch_session
from .render_batch_session import (
	BatchRenderError,
	session_active,
	begin_session,
	end_session,
)

###########################################################################
# Batch Render Functions
# •Process batch rendering queue
#	•Cameras
#	•Collections
#	•Items (objects and/or lights)
#	•Images (requires specific folder input and target material node)
# •Set target material > node for Batch Render Images
#
# The recoverable lifecycle (snapshot → render loop → guaranteed rollback,
# serial protection, partial-output cleanup, single-session locking) lives in
# render_batch_session.py. This module is the Blender operator/UI entry point.

# Process batch rendering queue
class batch_render_start(bpy.types.Operator):
	bl_idname = 'render.batch_render_start'
	bl_label = 'Begin Batch Render'
	bl_description = "Batch render specified elements"
	bl_space_type = "VIEW_3D"

	@classmethod
	def poll(cls, context):
		# Disable the start button while a batch is already running so a second
		# invocation cannot interleave with the active batch.
		return not session_active()

	def invoke(self, context, event):
			return context.window_manager.invoke_props_dialog(self)

	def draw(self, context):
		try:
			layout = self.layout
			layout.label(text="Blender will be unresponsive while rendering")
		except Exception as exc:
			print(str(exc) + ' | Error in Render Kit: Begin Batch Render confirmation header')

	def execute(self, context):
		# Get scene from context
		scene = context.scene
		# Get settings from scene
		settings = scene.render_kit_settings

		# Hard guard against a second batch starting while one is running.
		# poll() disables the UI, but operators can still be invoked from
		# Python or the render menu, so this is the authoritative rejection.
		if session_active():
			self.report({'WARNING'}, 'Batch render already in progress — new batch rejected.')
			print('Render Kit Batch: rejected re-entrant batch render request.')
			return {'CANCELLED'}

		# Build the entire snapshot before any scene state is changed. If the
		# configuration is invalid this raises and nothing is touched.
		try:
			session = begin_session(context, settings)
		except BatchRenderError as exc:
			settings.batch_active = False
			self.report({'ERROR'}, f'Render Kit Batch: {exc}')
			print(f'Render Kit Batch: {exc}')
			return {'CANCELLED'}

		settings.batch_active = True
		try:
			session.run()
		finally:
			# Runs on normal completion, cancellation, and target failure.
			# Restores every snapshotted value and releases the session lock.
			end_session()
			settings.batch_active = False

		if session.cancelled:
			self.report({'WARNING'}, session.error_message)
			return {'CANCELLED'}
		if session.failed:
			self.report({'ERROR'}, f"Batch render stopped: {session.error_message}")
			return {'CANCELLED'}

		self.report({'INFO'}, f"Batch render complete: {session.completed_count} target(s).")
		return {'FINISHED'}

# Set target material > node for Batch Render Images
class batch_image_target(bpy.types.Operator):
	bl_idname = 'render.batch_image_target'
	bl_label = 'Assign image target'
	bl_description = "Assign active node in material as target for batch rendering images"
	bl_space_type = "NODE_EDITOR"
	bl_options = {'REGISTER', 'UNDO'}

	@classmethod
	def poll(cls, context):
		# Check if necessary object > material > node > node type is selected
		return (
			context.view_layer.objects.active
			and context.view_layer.objects.active.active_material
			and context.view_layer.objects.active.active_material.node_tree.nodes.active
			and context.view_layer.objects.active.active_material.node_tree.nodes.active.type == 'TEX_IMAGE'
		)

	def execute(self, context):
		settings = context.scene.render_kit_settings

		# Assign active material from active object
		settings.batch_images_material = context.view_layer.objects.active.active_material.name
		# Assign active node from active material from active object
		settings.batch_images_node = context.view_layer.objects.active.active_material.node_tree.nodes.active.name
		return {'FINISHED'}

# Manually set camera and/or render resolution
class batch_camera_update(bpy.types.Operator):
	bl_idname = 'render.batch_camera_update'
	bl_label = 'Update batch rendering camera'
	bl_description = "Update batch rendering camera"
	bl_space_type = "VIEW_3D"

	list_offset: bpy.props.IntProperty() = 0

	@classmethod
	def poll(cls, context):
		# Never allow camera stepping edits while a batch owns the scene state;
		# the running batch works from its own snapshot and would otherwise be
		# racing UI-driven camera/resolution changes.
		return not session_active()

	def execute(self, context):
		scene = context.scene
		settings = scene.render_kit_settings

		# Defensive rejection in case poll() is bypassed via Python
		if session_active():
			self.report({'WARNING'}, 'Batch render in progress — camera update rejected.')
			return {'CANCELLED'}

		# Get current camera
		target_camera = scene.camera

		# If offset, get previous or next camera from selection or collection
		if self.list_offset != 0:
			# If cameras are selected
			if len(context.selected_objects) > 0 and len([obj for obj in context.selected_objects if obj.type == 'CAMERA']) > 0:
				source_cameras = [obj for obj in context.selected_objects if obj.type == 'CAMERA']

			# If no cameras are selected, check for an active collection with cameras
			elif context.view_layer.active_layer_collection and len(context.view_layer.active_layer_collection.collection.all_objects) > 0 and len([obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type == 'CAMERA']) > 0:
				source_cameras = [obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type == 'CAMERA']

			# If still no cameras are available, return cancelled
			else:
				print('Render Kit Batch: Cameras not found.')
				return {'CANCELLED'}

			batch_length = len(source_cameras) - 1

			# If active camera is in the current group, offset from that position
			if target_camera in source_cameras:
				index = source_cameras.index(target_camera) + self.list_offset
				if index < 0:
					index += batch_length + 1
				elif index > batch_length:
					index -= batch_length + 1

				settings.batch_index = index
				target_camera = source_cameras[index]

			# Otherwise start at zero
			else:
				settings.batch_index = 0
				target_camera = source_cameras[0]

			# Set batch values
			settings.batch_factor = settings.batch_index / batch_length
			settings.batch_random = hash(settings.batch_factor * 0.9998 + 0.0001) / 1000000 % 1

			# Set rendering camera to current camera and make the item active for editing
			scene.camera = target_camera
			context.view_layer.objects.active = target_camera

		# Set scene resolution from camera name if appended "#x#" pattern is found
		resolution_match = search(r'(\d+)x(\d+)$', scene.camera.name)
		if resolution_match != None:
			scene.render.resolution_x = int(resolution_match.group(1))
			scene.render.resolution_y = int(resolution_match.group(2))

		return {'FINISHED'}



###########################################################################
# Batch Render UI
# •Properties > Options > Batch Render Panel
#	•Cameras
#	•Collections
#	•Items (objects and/or lights)
#	•Images (with folder and material node selection)

class BATCH_PT_batch_render(bpy.types.Panel):
	bl_label = 'Batch Render'
	bl_idname = 'BATCH_PT_batch_render'
	bl_description = 'Manage batch rendering options'
	bl_space_type = 'PROPERTIES'
	bl_region_type = 'WINDOW'
	bl_context = "output"
	bl_category = 'Batch'
	bl_order = 44
	bl_options = {'DEFAULT_CLOSED'}

	@classmethod
	def poll(cls, context):
		return context.preferences.addons[__package__].preferences.batch_enable

	def draw_header(self, context):
		try:
			layout = self.layout
		except Exception as exc:
			print(str(exc) + ' | Error in Render Kit: Batch Render panel header')

	def draw(self, context):
		if True:
			prefs = context.preferences.addons[__package__].preferences
			scene = context.scene
			settings = scene.render_kit_settings

			# UI Layout
			layout = self.layout
			layout.use_property_decorate = False # No animation

			# While a batch is running, show a non-interactive status banner and
			# disable the settings controls so the snapshot in use cannot drift.
			batch_running = session_active()
			if batch_running:
				banner = layout.box()
				banner.label(text="Batch render in progress…", icon='RENDER_ANIMATION')
				banner.label(text="Settings are locked until it finishes or is cancelled")

			# General variables
			batch_count = 0
			batch_error = False

			# Batch type
			input0 = layout.column(align=True)
			if batch_running:
				input0.active = False
				input0.enabled = False
			input0.prop(settings, 'batch_type', text='')

			input1 = layout.column(align=True)
			input2 = layout.column(align=True)
			if batch_running:
				input1.active = False
				input1.enabled = False
				input2.active = False
				input2.enabled = False

			# Settings for Cameras
			if settings.batch_type == 'cams':
				# Direct selection of cameras
				batch_count = len([obj for obj in context.selected_objects if obj.type == 'CAMERA'])

				# Set up feedback message for selected cameras
				if batch_count > 0:
					if batch_count == 1:
						feedback_text=str(batch_count) + ' camera selected'
					else:
						feedback_text=str(batch_count) + ' cameras selected'
					feedback_icon='CAMERA_DATA' # Alt: VIEW_CAMERA

				# If no cameras are selected, check for an active collection
				elif context.view_layer.active_layer_collection and len(context.view_layer.active_layer_collection.collection.all_objects) > 0 and len([obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type == 'CAMERA']) > 0:
					batch_count = len([obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type == 'CAMERA'])
					if batch_count == 1:
						feedback_text=str(batch_count) + ' camera in collection'
					else:
						feedback_text=str(batch_count) + ' cameras in collection'
					feedback_icon='OUTLINER_COLLECTION'

				# If still no items are selected, display an error
				else:
					feedback_text='Invalid selection'
					feedback_icon='ERROR'

				# Display feedback
				feedback = input0.box()
				feedback.label(text=feedback_text, icon=feedback_icon)

				# Display previous / update / next camera buttons
				if feedback_icon != "ERROR":
					buttons = input1.row(align=True)

					# Switch to previous camera in list
					if batch_count > 1:
						op0 = buttons.operator(batch_camera_update.bl_idname, text = "Previous", icon = "TRIA_LEFT") #
						op0.list_offset = -1

					# Update current camera
					op1 = buttons.operator(batch_camera_update.bl_idname, text = "Update", icon = "FILE_REFRESH") #
					op1.list_offset = 0

					# Switch to next camera in list
					if batch_count > 1:
						op2 = buttons.operator(batch_camera_update.bl_idname, text = "Next", icon = "TRIA_RIGHT") #
						op2.list_offset = 1

			# Settings for Collections
			if settings.batch_type == 'cols':
				# Collection children (no direct selection of collections currently supported)
				batch_count = len(context.view_layer.active_layer_collection.children)

				# Set up feedback message for child collections
				if batch_count > 0:
					if batch_count == 1:
						feedback_text=str(batch_count) + ' sub-collection available'
					else:
						feedback_text=str(batch_count) + ' sub-collections available'
					feedback_icon='OUTLINER_COLLECTION'

				# If no collections are available, display an error
				else:
					feedback_text='Invalid selection'
					feedback_icon='ERROR'

				# Display feedback
				feedback = input0.box()
				feedback.label(text=feedback_text, icon=feedback_icon)

			# Settings for Items
			if settings.batch_type == 'itms':
				# Direct selection of items
				batch_count = len([obj for obj in context.selected_objects if obj.type != 'CAMERA'])

				# Set up feedback message for selected items
				if batch_count > 0:
					if batch_count == 1:
						feedback_text=str(batch_count) + ' item selected'
					else:
						feedback_text=str(batch_count) + ' items selected'
					feedback_icon='OBJECT_DATA'

				# If no items are selected, check for an active collection
				elif context.view_layer.active_layer_collection and len(context.view_layer.active_layer_collection.collection.all_objects) > 0 and len([obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type != 'CAMERA']) > 0:
					batch_count = len([obj for obj in context.view_layer.active_layer_collection.collection.all_objects if obj.type != 'CAMERA'])
					if batch_count == 1:
						feedback_text=str(batch_count) + ' item in collection'
					else:
						feedback_text=str(batch_count) + ' items in collection'
					feedback_icon='OUTLINER_COLLECTION'

				# If still no items are selected, display an error
				else:
					feedback_text='Invalid selection'
					feedback_icon='ERROR'

				# Display feedback
				feedback = input0.box()
				feedback.label(text=feedback_text, icon=feedback_icon)

			# Settings for Images
			if settings.batch_type == 'imgs':
				# Source directory
				input1.prop(settings, 'batch_images_location', text='')

				# Get source folder and image count
				source_folder = bpy.path.abspath(settings.batch_images_location)
				if os.path.isdir(source_folder):
					# Image extensions attribute is undocumented
					# https://blenderartists.org/t/bpy-ops-image-open-supported-formats/1237197/6
					source_images = [f for f in os.listdir(source_folder) if f.lower().endswith(tuple(bpy.path.extensions_image))]
					batch_count = len(source_images)
					feedback_text=str(batch_count) + ' images found'
					feedback_icon='IMAGE_DATA'
				else:
					feedback_text='Invalid location'
					feedback_icon='ERROR'
					batch_error = True

				feedback = input1.box()
				feedback.label(text=feedback_text, icon=feedback_icon)

				# Material node assignment
				if context.view_layer.objects.active and context.view_layer.objects.active.active_material and context.view_layer.objects.active.active_material.node_tree.nodes.active and context.view_layer.objects.active.active_material.node_tree.nodes.active.type == 'TEX_IMAGE':
					target_text = 'Assign ' + context.view_layer.objects.active.active_material.name + ' > ' + context.view_layer.objects.active.active_material.node_tree.nodes.active.name
					target_icon = 'IMPORT'
				else:
					target_text = 'Assign Image Node'
					target_icon = 'ERROR'

				input2.operator(batch_image_target.bl_idname, text=target_text)

				# List the assigned material node if it exists
				if bpy.data.materials.get(settings.batch_images_material) and bpy.data.materials[settings.batch_images_material].node_tree.nodes.get(settings.batch_images_node):
					feedback_text = settings.batch_images_material + ' > ' + settings.batch_images_node
					feedback_icon = 'NODE'
				else:
					feedback_text = 'Select object > material > image node'
					feedback_icon = 'ERROR'
					batch_error = True

				feedback = input2.box()
				feedback.label(text=feedback_text, icon=feedback_icon)



			# Batch values, set during rendering
			field = layout.column(align=True)
			field.label(text="Batch values")
			field.prop(settings, 'batch_index', text='Index', icon='MODIFIER') # PREFERENCES MODIFIER
			field.prop(settings, 'batch_factor', text='Factor', icon='MODIFIER') # PREFERENCES MODIFIER
			field.prop(settings, 'batch_random', text='Random', icon='MODIFIER') # PREFERENCES MODIFIER



			# Render variables and output path
			input3 = layout.column(align=True)
			input3.separator()
			input3.label(text="Batch output")
			if batch_running:
				input3.active = False
				input3.enabled = False

			# Variable list UI
			renderkit_variable_ui(input3, context, paths=bpy.context.scene.render.filepath, postrender=False, noderender=False, autoclose=True, customserial=False, align=True)

			# Output path
			row = input3.row(align=True)
			row.prop(context.scene.render, "filepath", text="")

			# Feedback
			if not prefs.render_variable_enable:
				box = input3.box()
				box.label(text='Open Render Kit preferences and enable variables', icon='ERROR') # ERROR WARNING_LARGE
			elif '{batch}' not in context.scene.render.filepath:
				if settings.batch_type == 'cams' and '{camera}' not in context.scene.render.filepath:
					box = input3.box()
					box.label(text='Add {{camera}} or {{batch}} variable', icon='ERROR')
				elif settings.batch_type == 'cols' and '{collection}' not in context.scene.render.filepath:
					box = input3.box()
					box.label(text='Add {{collection}} or {{batch}} variable', icon='ERROR')
				elif settings.batch_type == 'itms' and '{item}' not in context.scene.render.filepath:
					box = input3.box()
					box.label(text='Add {{item}} or {{batch}} variable', icon='ERROR')
				elif settings.batch_type == 'imgs' and '{node}' not in context.scene.render.filepath:
					box = input3.box()
					box.label(text='Add {{node}} or {{batch}} variable', icon='ERROR')



			# Final settings and start render
			input4 = layout.column(align=True)
			input4.separator()
			if batch_running:
				input4.active = False
				input4.enabled = False

			# Batch range setting (still or sequence)
			buttons = input4.row(align=True)
			buttons.prop(settings, 'batch_range', expand = True)

			# Start Batch Render button with title feedback
			button = input4.row(align=True)
			if batch_running:
				# Running batch: the operator poll() also disables this button
				batch_text = 'Batch Render In Progress…'
				batch_icon = 'RENDER_ANIMATION'
				button.active = False
				button.enabled = False
			elif batch_count == 0 or batch_error:
				button.active = False
				button.enabled = False
				batch_text = 'Batch Render'
				batch_icon = 'ERROR'
			else:
				batch_text = 'Batch Render '
				batch_text += str(batch_count)
				if settings.batch_range == 'img':
					batch_text += ' Image'
					batch_icon = 'RENDER_STILL'
				else:
					batch_text += ' Animation'
					batch_icon = 'RENDER_ANIMATION'
				batch_text += 's' if batch_count > 1 else ''

			# Start batch render button
			button.operator(batch_render_start.bl_idname, text=batch_text, icon=batch_icon)



###########################################################################
# Instance panel in the 3D View

class BATCH_PT_batch_render_3dview(bpy.types.Panel):
	bl_label = "Batch Render"
	bl_idname = "BATCH_PT_batch_render_3DView"
	bl_space_type = 'VIEW_3D'
	bl_region_type = 'UI'
	bl_category = 'Launch'
	bl_order = 40
	bl_options = {'DEFAULT_CLOSED'}
	category_preference = "batch_category"

	@classmethod
	def poll(cls, context):
		# Reuse the poll method from BATCH_PT_batch_render
		return BATCH_PT_batch_render.poll(context)

	def draw(self, context):
		# Reuse the draw method from BATCH_PT_batch_render
		BATCH_PT_batch_render.draw(self, context)

###########################################################################
# Menu UI rendering class

def render_batch_menu_item(self,context):
	try:
		if context.preferences.addons[__package__].preferences.batch_enable:
			layout = self.layout
			# Disable the menu entry while a batch is already running
			row = layout.row()
			row.enabled = not session_active()
			row.operator(batch_render_start.bl_idname, text="Render Batch", icon='RENDER_STILL')
	except Exception as exc:
		print(str(exc) + " Render Kit | Error in Topbar Mt Render when adding to menu")



###########################################################################
# Addon registration functions
# •Define classes being registered
# •Registration function
# •Unregistration function

classes = [batch_render_start, batch_image_target, batch_camera_update, BATCH_PT_batch_render]

# Registered from the tab category set in the extension preferences
panels = [BATCH_PT_batch_render_3dview]

def register():
	# Register classes
	for cls in classes:
		bpy.utils.register_class(cls)

	# Register panels
	utility_panel.register_panels(panels)

	# Add menu item
	bpy.types.TOPBAR_MT_render.prepend(render_batch_menu_item)

def unregister():
	# Remove menu item
	bpy.types.TOPBAR_MT_render.remove(render_batch_menu_item)

	# Deregister panels
	utility_panel.unregister_panels(panels)

	# Deregister classes
	for cls in reversed(classes):
		bpy.utils.unregister_class(cls)

if __package__ == "__main__":
	register()
