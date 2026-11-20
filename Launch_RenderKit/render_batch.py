import bpy
import os
import json
from re import search

# Internal imports
from .render_variables import renderkit_variable_ui
from . import utility_panel
from . import batch_engine
from .batch_engine import (
	BatchContext,
	BatchRunner,
	BatchReentryError,
	ADAPTERS,
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
# Recoverable execution semantics live in batch_engine.py (pure Python,
# unit-testable without Blender). This module only supplies the bpy adapter
# wiring, operators, and panel UI.

def _render_once(animation):
	"""Perform one still or animation render, translating cancellation.

	bpy.ops.render.render returns {'CANCELLED'} when the user aborts a render;
	the engine treats that as a per-item cancellation rather than a generic
	failure so the batch stops cleanly and still restores every scene value.
	"""
	if animation:
		result = bpy.ops.render.render(animation=True, use_viewport=True)
	else:
		result = bpy.ops.render.render(animation=False, write_still=True, use_viewport=True)
	if result == {'CANCELLED'}:
		raise BatchCancelled('render cancelled by user')
	return result


def _load_image(path):
	# check_existing reuses an already-loaded image data-block instead of
	# creating duplicates, matching the original behaviour.
	return bpy.data.images.load(path, check_existing=True)


# Process batch rendering queue
class batch_render_start(bpy.types.Operator):
	bl_idname = 'render.batch_render_start'
	bl_label = 'Begin Batch Render'
	bl_description = "Batch render specified elements"
	bl_space_type = "VIEW_3D"

	@classmethod
	def poll(cls, context):
		# Disable the button while a batch is already running so a second click
		# cannot start a concurrent batch mutating the same scene.
		return not context.scene.render_kit_settings.batch_active

	def invoke(self, context, event):
		# The dialog itself must not start anything: cancelling the confirmation
		# box simply closes it, and the engine-level guard remains untouched.
		return context.window_manager.invoke_props_dialog(self)

	def draw(self, context):
		try:
			layout = self.layout
			layout.label(text="Blender will be unresponsive while rendering")
		except Exception as exc:
			print(str(exc) + ' | Error in Render Kit: Begin Batch Render confirmation header')

	def execute(self, context):
		scene = context.scene
		settings = scene.render_kit_settings

		# Hard guard in addition to poll(): if a batch is somehow already
		# active (e.g. invoked via Python or a stale UI), refuse immediately.
		if settings.batch_active or batch_engine.is_batch_active():
			self.report({'WARNING'}, "A batch render is already in progress")
			return {'CANCELLED'}

		adapter_class = ADAPTERS.get(settings.batch_type)
		if adapter_class is None:
			self.report({'ERROR'}, "Unknown batch type")
			return {'CANCELLED'}

		batch_context = BatchContext(
			scene=scene,
			settings=settings,
			view_layer=context.view_layer,
			data=bpy.data,
			bpy_module=bpy,
			render_func=_render_once,
			load_image=_load_image,
		)
		adapter = adapter_class(batch_context)
		runner = BatchRunner(batch_context, adapter)

		settings.batch_active = True
		try:
			report = runner.run()
		except BatchReentryError as exc:
			# Defensive: the guard at the top should make this unreachable.
			print(f"Render Kit Batch: {exc}")
			return {'CANCELLED'}
		finally:
			settings.batch_active = False

		# Publish the report to the property group so the panel can display
		# success / failure / remaining counts and per-failure object kinds.
		settings.batch_report_total = report.total
		settings.batch_report_success = report.success
		settings.batch_report_failed = report.failed
		settings.batch_report_cancelled = report.cancelled
		settings.batch_report_failures = json.dumps(report.failure_lines())

		if report.failed:
			for line in report.failure_lines():
				print(f"Render Kit Batch failure: {line}")
			self.report(
				{'WARNING'},
				f"Batch finished with {report.failed} failed item(s); scene restored",
			)
			return {'FINISHED'}
		if report.cancelled:
			self.report({'WARNING'}, "Batch render cancelled; scene restored")
			return {'FINISHED'}
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
		return True

	def execute(self, context):
		scene = context.scene
		settings = scene.render_kit_settings

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
			factor, random_value = batch_engine.calculate_batch_values(settings.batch_index, len(source_cameras))
			settings.batch_factor = factor
			settings.batch_random = random_value

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

			# General variables
			batch_count = 0
			batch_error = False

			# Batch type
			input0 = layout.column(align=True)
			input0.prop(settings, 'batch_type', text='')

			input1 = layout.column(align=True)
			input2 = layout.column(align=True)

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

			# Last batch report: success / failure / remaining counters and the
			# object category each failed item belonged to.
			if settings.batch_report_total > 0:
				report_box = layout.box()
				report_box.label(
					text=(
						f"Last batch — succeeded: {settings.batch_report_success}   "
						f"failed: {settings.batch_report_failed}   "
						f"remaining: {settings.batch_report_total - settings.batch_report_success - settings.batch_report_failed}"
					),
					icon='CANCEL' if settings.batch_report_cancelled else (
						'ERROR' if settings.batch_report_failed else 'CHECKMARK'
					),
				)
				try:
					failure_lines = json.loads(settings.batch_report_failures or '[]')
				except ValueError:
					failure_lines = []
				for line in failure_lines:
					report_box.label(text=line, icon='ERROR')



			# Render variables and output path
			input3 = layout.column(align=True)
			input3.separator()
			input3.label(text="Batch output")

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

			# Batch range setting (still or sequence)
			buttons = input4.row(align=True)
			buttons.prop(settings, 'batch_range', expand = True)

			# Start Batch Render button with title feedback
			button = input4.row(align=True)
			if batch_count == 0 or batch_error or settings.batch_active:
				button.active = False
				button.enabled = False
				if settings.batch_active:
					batch_text = 'Batch Rendering…'
					batch_icon = 'SORTTIME'
				else:
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
			layout.operator(batch_render_start.bl_idname, text="Render Batch", icon='RENDER_STILL')
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
