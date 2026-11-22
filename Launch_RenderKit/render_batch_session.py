# General features
import bpy
import os
from re import search

# Local imports
from .render_variables import replaceVariables
from . import utility_data

###########################################################################
# Batch Render Session Lifecycle
#
# A batch session:
#   1. Snapshots every scene/addon value it is about to change BEFORE touching
#      anything (target list, output path template, camera, resolution,
#      collection visibility, object selection/render state, texture node).
#   2. Renders each target against that immutable snapshot, so UI edits made
#      while the batch is running can never change the targets or output path.
#   3. Restores the full snapshot on every exit path: normal completion, user
#      cancellation, or a single target failing.
#   4. Only treats a render as "completed" when it finishes without
#      cancellation or exceptions; the serial number ({serial}) is incremented
#      exclusively by the render_complete handler, so cancelled/failed renders
#      never consume a serial and retrying a batch reproduces the original
#      numbering.
#   5. Removes any partial output (placeholder files, half-written frames)
#      created by a failed/cancelled target, while keeping every output that
#      was produced by an earlier successful target.
#
# Only one batch session may exist at a time; a second invocation is rejected
# up-front instead of interleaving with the running batch.


class BatchRenderError(Exception):
	"""Raised when a batch cannot be started (bad configuration or busy session)."""


class BatchRenderTargetError(Exception):
	"""Raised when an individual target render fails or is cancelled."""


# Module-level session reference. Blender runs operators on a single main
# thread, and this flag additionally guards against re-entrant invocation.
_session = None


def session_active():
	return _session is not None


def _safe_set(obj, attr, value):
	# RNA pointers (objects, collections, nodes) can be removed mid-batch by the
	# user; never let a stale restoration target break the rest of the rollback.
	try:
		setattr(obj, attr, value)
	except Exception as exc:
		print(f"Render Kit Batch: could not restore {attr}: {exc}")


def _safe_call(obj, method, *args):
	try:
		getattr(obj, method)(*args)
	except Exception as exc:
		print(f"Render Kit Batch: could not restore selection state: {exc}")


def _output_dir_snapshot(scene):
	# Snapshot the contents of the directory the next render will write to.
	# The path is resolved through the same variable replacement the render
	# handlers use, so cleanup targets exactly the location Blender writes to.
	try:
		resolved = replaceVariables(scene, scene.render.filepath)
		directory = os.path.dirname(bpy.path.abspath(resolved))
	except Exception:
		directory = bpy.path.abspath(scene.render.filepath)
		directory = os.path.dirname(directory)
	if not directory or not os.path.isdir(directory):
		return directory, set()
	return directory, set(os.listdir(directory))


def _remove_partial_outputs(directory, before):
	# Delete only files that appeared during the failed/cancelled render,
	# leaving pre-existing files and earlier targets' outputs untouched.
	if not directory or not os.path.isdir(directory):
		return
	for name in os.listdir(directory):
		if name in before:
			continue
		path = os.path.join(directory, name)
		try:
			if os.path.isfile(path) or os.path.islink(path):
				os.remove(path)
		except Exception as exc:
			print(f"Render Kit Batch: could not remove partial output {path}: {exc}")


class BatchSession:
	"""Owns the snapshot, target loop, rollback, and serial semantics of one batch."""

	def __init__(self, context, settings):
		self.context = context
		self.scene = context.scene
		self.settings = settings
		self.batch_type = settings.batch_type
		self.batch_range = settings.batch_range
		self.view_layer = context.view_layer

		# Captured once and never re-read from the UI while the batch runs
		self.targets = []
		self.snapshot = {}
		self.index = 0
		self.completed_count = 0
		self.cancelled = False
		self.failed = False
		self.error_message = ''

		# Per-target output directory state, refreshed immediately before render
		self._output_directory = ''
		self._output_before = set()

	# ------------------------------------------------------------------
	# Snapshot building (per batch type)
	# ------------------------------------------------------------------

	def _snapshot_common(self):
		s = self.settings
		self.snapshot['batch_index'] = s.batch_index
		self.snapshot['batch_factor'] = s.batch_factor
		self.snapshot['batch_random'] = s.batch_random
		self.snapshot['batch_collection_name'] = s.batch_collection_name
		self.snapshot['output_file_serial'] = s.output_file_serial
		# The output path template itself is part of the snapshot: handlers keep
		# restoring scene.render.filepath from this live value, and the batch
		# never re-reads the panel while running.
		self.snapshot['render_filepath'] = self.scene.render.filepath

	def _collect_cameras(self):
		context = self.context
		selected = [obj for obj in context.selected_objects if obj.type == 'CAMERA']
		if selected:
			self.targets = list(selected)
		elif context.view_layer.active_layer_collection:
			collection = context.view_layer.active_layer_collection.collection
			cameras = [obj for obj in collection.all_objects if obj.type == 'CAMERA']
			if cameras:
				self.targets = list(cameras)
		if not self.targets:
			raise BatchRenderError('Cameras not found.')

		self.snapshot['camera'] = self.scene.camera
		self.snapshot['resolution_x'] = self.scene.render.resolution_x
		self.snapshot['resolution_y'] = self.scene.render.resolution_y

	def _collect_collections(self):
		layer_collection = self.context.view_layer.active_layer_collection
		children = list(layer_collection.children) if layer_collection else []
		if not children:
			raise BatchRenderError('Collections not found.')
		self.targets = children
		self.snapshot['collections'] = [
			(lc, lc.collection.hide_render, lc.exclude) for lc in children
		]

	def _collect_items(self):
		context = self.context
		selected = [obj for obj in context.selected_objects if obj.type != 'CAMERA']
		if selected:
			self.targets = list(selected)
		elif context.view_layer.active_layer_collection:
			collection = context.view_layer.active_layer_collection.collection
			items = [obj for obj in collection.all_objects if obj.type != 'CAMERA']
			if items:
				self.targets = list(items)
		if not self.targets:
			raise BatchRenderError('Items not found.')

		# Selection is captured per-object so the exact selection (including
		# non-target objects) can be reconstructed on rollback.
		self.snapshot['selection'] = [
			(obj, obj.select_get()) for obj in self.view_layer.objects
		]
		self.snapshot['active_object'] = self.view_layer.objects.active
		self.snapshot['hide_render'] = [(obj, obj.hide_render) for obj in self.targets]

	def _collect_images(self):
		source_folder = bpy.path.abspath(self.settings.batch_images_location)
		if not os.path.isdir(source_folder):
			raise BatchRenderError('Image source directory not found.')
		image_files = sorted(
			f for f in os.listdir(source_folder)
			if f.lower().endswith(tuple(bpy.path.extensions_image))
		)
		if not image_files:
			raise BatchRenderError('No images found in source directory.')

		material_name = self.settings.batch_images_material
		node_name = self.settings.batch_images_node
		material = bpy.data.materials.get(material_name)
		node = None
		if material and material.node_tree:
			node = material.node_tree.nodes.get(node_name)
		if not node or node.type != 'TEX_IMAGE':
			raise BatchRenderError('Target material node not found.')

		# Folder contents and folder path are frozen in the snapshot so later
		# filesystem/UI changes cannot drift the batch's target list or paths.
		self.targets = [os.path.join(source_folder, f) for f in image_files]
		self.snapshot['source_folder'] = source_folder
		self.snapshot['image_files'] = list(image_files)
		self.snapshot['target_node'] = node
		self.snapshot['original_image'] = node.image if node.image and node.image.has_data else None

	# ------------------------------------------------------------------
	# Per-target scene preparation / cleanup / rollback
	# ------------------------------------------------------------------

	def _set_batch_values(self):
		length = max(len(self.targets) - 1, 1)
		self.settings.batch_factor = self.index / length
		self.settings.batch_random = hash(self.settings.batch_factor * 0.9998 + 0.0001) / 1000000 % 1

	def _prepare_camera(self, cam):
		self.scene.camera = cam
		match = search(r'(\d+)x(\d+)$', cam.name)
		if match is not None:
			self.scene.render.resolution_x = int(match.group(1))
			self.scene.render.resolution_y = int(match.group(2))
			original_name = cam.name
			cam.name = original_name.replace(match.group(0), '')
			return original_name
		self.scene.render.resolution_x = self.snapshot['resolution_x']
		self.scene.render.resolution_y = self.snapshot['resolution_y']
		return None

	def _cleanup_camera(self, cam, original_name):
		if original_name is not None:
			_safe_set(cam, 'name', original_name)

	def _restore_cameras(self):
		_safe_set(self.scene, 'camera', self.snapshot['camera'])
		_safe_set(self.scene.render, 'resolution_x', self.snapshot['resolution_x'])
		_safe_set(self.scene.render, 'resolution_y', self.snapshot['resolution_y'])

	def _prepare_collection(self, layer_collection):
		self.settings.batch_collection_name = layer_collection.name
		layer_collection.collection.hide_render = False
		layer_collection.exclude = False

	def _cleanup_collection(self, layer_collection):
		layer_collection.collection.hide_render = True
		layer_collection.exclude = True

	def _restore_collections(self):
		for layer_collection, hide_render, exclude in self.snapshot['collections']:
			_safe_set(layer_collection.collection, 'hide_render', hide_render)
			_safe_set(layer_collection, 'exclude', exclude)
		self.settings.batch_collection_name = self.snapshot['batch_collection_name']

	def _prepare_item(self, item):
		_safe_call(item, 'select_set', True)
		self.view_layer.objects.active = item
		item.hide_render = False

	def _cleanup_item(self, item):
		_safe_call(item, 'select_set', False)
		item.hide_render = True

	def _restore_items(self):
		for item, hide_render in self.snapshot['hide_render']:
			_safe_set(item, 'hide_render', hide_render)
		for obj, was_selected in self.snapshot['selection']:
			_safe_call(obj, 'select_set', was_selected)
		active = self.snapshot['active_object']
		if active is not None:
			try:
				self.view_layer.objects.active = active
			except Exception as exc:
				print(f"Render Kit Batch: could not restore active object: {exc}")

	def _prepare_image(self, image_path):
		image = bpy.data.images.load(image_path, check_existing=True)
		self.snapshot['target_node'].image = image

	def _restore_images(self):
		node = self.snapshot['target_node']
		original_image = self.snapshot['original_image']
		if original_image is not None:
			_safe_set(node, 'image', original_image)

	# ------------------------------------------------------------------
	# Dispatch helpers
	# ------------------------------------------------------------------

	def _collect(self):
		self._snapshot_common()
		if self.batch_type == 'cams':
			self._collect_cameras()
		elif self.batch_type == 'cols':
			self._collect_collections()
		elif self.batch_type == 'itms':
			self._collect_items()
		elif self.batch_type == 'imgs':
			self._collect_images()
		else:
			raise BatchRenderError(f"Unknown batch type: {self.batch_type}")

	def _prepare_target(self, target):
		if self.batch_type == 'cams':
			return self._prepare_camera(target)
		if self.batch_type == 'cols':
			return self._prepare_collection(target)
		if self.batch_type == 'itms':
			return self._prepare_item(target)
		return self._prepare_image(target)

	def _cleanup_target(self, target, prep_data):
		try:
			if self.batch_type == 'cams':
				self._cleanup_camera(target, prep_data)
			elif self.batch_type == 'cols':
				self._cleanup_collection(target)
			elif self.batch_type == 'itms':
				self._cleanup_item(target)
		except Exception as exc:
			print(f"Render Kit Batch: target cleanup error: {exc}")

	def _restore(self):
		# Every restoration step is isolated: one failure must not prevent the
		# remaining snapshot values from being restored.
		try:
			if self.batch_type == 'cams':
				self._restore_cameras()
			elif self.batch_type == 'cols':
				self._restore_collections()
			elif self.batch_type == 'itms':
				self._restore_items()
			elif self.batch_type == 'imgs':
				self._restore_images()
		except Exception as exc:
			print(f"Render Kit Batch: error while restoring scene state: {exc}")

		# Common settings are always restored, even on partial rollback.
		s = self.settings
		s.batch_index = self.snapshot['batch_index']
		s.batch_factor = self.snapshot['batch_factor']
		s.batch_random = self.snapshot['batch_random']
		s.batch_collection_name = self.snapshot['batch_collection_name']
		# Restore the output path template directly as well. The render handlers
		# normally do this too, but restoring here guarantees it even if a handler
		# was interrupted (e.g. a hard render error) and makes rollback self-contained.
		_safe_set(self.scene.render, 'filepath', self.snapshot['render_filepath'])

		# Serial handling differs by outcome:
		#   • Full success: the render_complete handler advanced the serial once
		#     per completed target, so the new value is kept (monotonic progress).
		#   • Cancel/failure: no serial may be consumed by an unsuccessful batch.
		#     Roll back to the snapshot so a retry reproduces clean-run numbering.
		if self.cancelled or self.failed:
			s.output_file_serial = self.snapshot['output_file_serial']

	# ------------------------------------------------------------------
	# Render invocation
	# ------------------------------------------------------------------

	def _invoke_render(self):
		if self.batch_range == 'img':
			return bpy.ops.render.render(animation=False, write_still=True, use_viewport=True)
		return bpy.ops.render.render(animation=True, use_viewport=True)

	def _render_one(self, target):
		# Freeze the output directory contents immediately before this render so
		# partial-file cleanup can distinguish new files from existing ones.
		self._output_directory, self._output_before = _output_dir_snapshot(self.scene)

		prep_data = self._prepare_target(target)
		try:
			result = self._invoke_render()
		except Exception as exc:
			# A hard render error leaves Blender's cancel/complete handlers
			# un-fired; clear the per-render serial latch defensively so it can
			# never leak into a later standalone render.
			utility_data.render_set_serial(False)
			utility_data.render_set_cancelled(False)
			raise BatchRenderTargetError(str(exc))
		finally:
			self._cleanup_target(target, prep_data)

		# bpy.ops.render.render returns {'CANCELLED'} when the user stops the
		# render; the cancel handler also latches the batch cancellation flag.
		if result == {'CANCELLED'} or utility_data.render_get_cancelled():
			utility_data.batch_set_cancel_requested(True)
			raise BatchRenderTargetError('Render cancelled by user.')

	# ------------------------------------------------------------------
	# Public lifecycle
	# ------------------------------------------------------------------

	def run(self):
		# Reset batch index before the loop; the original value is in the
		# snapshot and is restored on every exit path.
		self.settings.batch_index = 0

		for target in self.targets:
			self._set_batch_values()
			try:
				self._render_one(target)
			except BatchRenderTargetError as exc:
				# Failed/cancelled target: drop anything it partially wrote,
				# but keep outputs from targets that already succeeded.
				_remove_partial_outputs(self._output_directory, self._output_before)
				if utility_data.batch_get_cancel_requested():
					self.cancelled = True
					self.error_message = 'Batch render cancelled by user.'
					print('Render Kit Batch: cancelled during target '
						f"{self.index + 1} of {len(self.targets)}.")
				else:
					self.failed = True
					self.error_message = str(exc)
					print('Render Kit Batch: target '
						f"{self.index + 1} of {len(self.targets)} failed: {exc}")
				break

			# Only reached after a fully successful render. The serial number
			# was already incremented by render_complete; the batch index mirrors
			# that "one successful render at a time" progression.
			self.completed_count += 1
			self.index += 1
			self.settings.batch_index = self.index


def begin_session(context, settings):
	"""Validate and snapshot everything before the first state change.

	Returns a ready BatchSession or raises BatchRenderError. Never partially
	mutates the scene: all preparation is read-only snapshot collection.
	"""
	global _session
	if _session is not None:
		raise BatchRenderError('A batch render is already in progress.')

	session = BatchSession(context, settings)
	session._collect()
	_session = session
	return session


def end_session():
	"""Restore the snapshot and release the single-session lock. Always safe to call."""
	global _session
	if _session is None:
		return
	session = _session
	try:
		session._restore()
	finally:
		utility_data.batch_set_cancel_requested(False)
		utility_data.render_set_cancelled(False)
		_session = None
