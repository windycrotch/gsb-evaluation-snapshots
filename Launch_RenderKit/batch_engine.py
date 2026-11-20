# Batch rendering engine — pure Python, no bpy dependency
#
# This module implements the recoverable, per-item execution semantics used by
# Render Kit's batch renderer. It deliberately contains zero Blender imports so
# that the complete state machine can be exercised by local automated tests
# without a Blender installation. All Blender interaction is funnelled through
# the small BatchContext value object and the adapter classes below.
#
# Guarantees provided by BatchRunner:
#   * A failure in one item is rolled back for that item and the remaining
#     items are still processed.
#   * After the batch ends — success, failure, or user cancellation — every
#     scene state value captured before the batch is restored. Files written by
#     successful renders are never deleted.
#   * Re-entrant execution raises BatchReentryError, so two batches can never
#     mutate the same scene concurrently.
#   * The caller's manually entered batch variables are always restored.

from dataclasses import dataclass, field
from re import search


###########################################################################
# Exceptions

class BatchError(Exception):
	"""Base class for batch engine errors."""


class BatchReentryError(BatchError):
	"""Raised when a second batch is started while one is already running."""


class BatchCancelled(BatchError):
	"""Raised by an adapter to signal a user-requested render cancellation."""


class BatchItemError(BatchError):
	"""Raised by an adapter when a single item cannot be processed."""


###########################################################################
# Helpers

def calculate_batch_values(index, total):
	"""Return the (factor, random) batch variables for *index* within *total* items.

	The math mirrors the original add-on behaviour, including the single-item
	edge case (the old code divided by zero); a lone item reports factor 1.0.
	"""
	if total <= 1:
		factor = 1.0
	else:
		factor = index / (total - 1)
	random_value = hash(factor * 0.9998 + 0.0001) / 1000000 % 1
	return factor, random_value


def safe_set(target, attribute, value):
	"""Assign an attribute without letting a failed write abort restoration.

	Objects can be removed mid-batch (a camera or image node may be deleted by a
	handler or the user), so every restoration write is defensive: a failure is
	reported but never masks the primary exception or skips remaining values.
	"""
	try:
		setattr(target, attribute, value)
	except Exception as exc:
		print(f"Render Kit Batch: could not restore {attribute}: {exc}")


def safe_call(func, *args, **kwargs):
	"""Call *func*, swallowing and reporting restoration errors."""
	try:
		func(*args, **kwargs)
	except Exception as exc:
		print(f"Render Kit Batch: restoration step failed: {exc}")


###########################################################################
# Data records

@dataclass
class BatchItem:
	"""One unit of work within a batch.

	*category* is the user-facing object kind ('Camera', 'Collection',
	'Item', 'Image') shown next to failures in the panel. *payload* is
	adapter-specific data (an object, layer collection, or file name).
	"""
	category: str
	label: str
	payload: object = None


@dataclass
class BatchFailure:
	index: int
	category: str
	label: str
	message: str

	def as_text(self):
		return f"#{self.index:04d} {self.category} '{self.label}': {self.message}"


@dataclass
class BatchReport:
	"""Result counters and failure details for one batch run."""
	total: int = 0
	success: int = 0
	failed: int = 0
	cancelled: bool = False
	failures: list = field(default_factory=list)

	@property
	def remaining(self):
		"""Items never attempted: not yet reached, plus the cancelled item."""
		return self.total - self.success - self.failed

	def record_failure(self, item, message):
		self.failed += 1
		self.failures.append(
			BatchFailure(
				index=len(self.failures),
				category=item.category,
				label=item.label,
				message=message,
			)
		)

	def failure_lines(self):
		return [failure.as_text() for failure in self.failures]


###########################################################################
# Context — the only Blender-facing surface the engine knows about

@dataclass
class BatchContext:
	"""Bundle of scene references and callables supplied by the Blender layer.

	Attributes:
		scene:        the active scene
		settings:     scene.render_kit_settings property group
		view_layer:   active view layer
		data:         bpy.data-like container (materials, images)
		bpy_module:   the bpy module (for bpy.path / bpy.ops helpers)
		render_func:  callable(animation: bool) performing one render
		load_image:   callable(path) -> image, loading (or reusing) an image
		is_cancelled: optional callable() -> bool checked between items
	"""
	scene: object
	settings: object
	view_layer: object
	data: object
	bpy_module: object
	render_func: object
	load_image: object = None
	is_cancelled: object = None


###########################################################################
# Adapter base class

class BatchAdapter:
	"""Strategy object implementing one batch type (cams/cols/itms/imgs).

	Lifecycle, driven exclusively by BatchRunner:
		snapshot()  -> capture every scene value that may be mutated
		prepare()   -> build the item list and perform upfront setup;
		               raise BatchItemError when nothing can be rendered
		items       -> iterable of BatchItem (populated by prepare())
		apply(item) -> mutate scene for *item* and render it
		rollback(item) -> undo apply() after a failure/cancellation
		restore()   -> restore the full pre-batch snapshot
	"""

	category = 'Item'

	def __init__(self, context):
		self.context = context
		self.items = []

	def snapshot(self):
		raise NotImplementedError

	def prepare(self):
		raise NotImplementedError

	def apply(self, item):
		raise NotImplementedError

	def rollback(self, item):
		raise NotImplementedError

	def restore(self):
		raise NotImplementedError

	# Shared helpers -----------------------------------------------------

	def _render(self):
		animation = self.context.settings.batch_range == 'anim'
		self.context.render_func(animation=animation)

	def _set_batch_variables(self, index, total):
		settings = self.context.settings
		factor, random_value = calculate_batch_values(index, total)
		settings.batch_factor = factor
		settings.batch_random = random_value


###########################################################################
# Camera batch

class CameraAdapter(BatchAdapter):
	category = 'Camera'

	def snapshot(self):
		scene = self.context.scene
		self._snapshot = {
			'camera': scene.camera,
			'resolution_x': scene.render.resolution_x,
			'resolution_y': scene.render.resolution_y,
		}

	def prepare(self):
		context = self.context
		view_layer = context.view_layer
		selected = [obj for obj in view_layer.selected_objects if obj.type == 'CAMERA']
		if selected:
			cameras = selected
		elif (
			view_layer.active_layer_collection
			and [obj for obj in view_layer.active_layer_collection.collection.all_objects if obj.type == 'CAMERA']
		):
			cameras = [
				obj for obj in view_layer.active_layer_collection.collection.all_objects
				if obj.type == 'CAMERA'
			]
		else:
			raise BatchItemError('Cameras not found.')
		self.items = [BatchItem(self.category, cam.name, cam) for cam in cameras]

	def apply(self, item):
		scene = self.context.scene
		cam = item.payload
		item.state = {
			'resolution_x': scene.render.resolution_x,
			'resolution_y': scene.render.resolution_y,
			'original_name': cam.name,
			'name_changed': False,
		}
		scene.camera = cam
		resolution_match = search(r'(\d+)x(\d+)$', cam.name)
		if resolution_match is not None:
			scene.render.resolution_x = int(resolution_match.group(1))
			scene.render.resolution_y = int(resolution_match.group(2))
			cam.name = cam.name.replace(resolution_match.group(0), "")
			item.state['name_changed'] = True
		else:
			scene.render.resolution_x = self._snapshot['resolution_x']
			scene.render.resolution_y = self._snapshot['resolution_y']
		try:
			self._render()
		finally:
			# On the success path the temporary name edit is undone immediately;
			# if the render raises, rollback() performs the same restoration.
			if item.state['name_changed'] and cam is not None and \
					getattr(cam, 'name', None) is not None:
				safe_set(cam, 'name', item.state['original_name'])

	def rollback(self, item):
		state = getattr(item, 'state', None)
		if not state:
			return
		scene = self.context.scene
		safe_set(scene.render, 'resolution_x', state['resolution_x'])
		safe_set(scene.render, 'resolution_y', state['resolution_y'])
		if state['name_changed']:
			cam = item.payload
			# The camera may have been removed mid-render; names can only be
			# restored while the data-block still exists.
			if cam is not None and getattr(cam, 'name', None) is not None:
				safe_set(cam, 'name', state['original_name'])

	def restore(self):
		scene = self.context.scene
		safe_set(scene, 'camera', self._snapshot['camera'])
		safe_set(scene.render, 'resolution_x', self._snapshot['resolution_x'])
		safe_set(scene.render, 'resolution_y', self._snapshot['resolution_y'])


###########################################################################
# Collection batch

class CollectionAdapter(BatchAdapter):
	category = 'Collection'

	def snapshot(self):
		self._snapshot = {
			'collection_name': self.context.settings.batch_collection_name,
			'states': [],  # [(layer_collection, hide_render, exclude)]
		}

	def prepare(self):
		view_layer = self.context.view_layer
		children = list(view_layer.active_layer_collection.children) if view_layer.active_layer_collection else []
		if not children:
			raise BatchItemError('Collections not found.')
		for layer_collection in children:
			self._snapshot['states'].append(
				(layer_collection, layer_collection.collection.hide_render, layer_collection.exclude)
			)
			layer_collection.collection.hide_render = True
			layer_collection.exclude = True
		self.items = [
			BatchItem(self.category, layer_collection.collection.name, layer_collection)
			for layer_collection in children
		]

	def apply(self, item):
		layer_collection = item.payload
		item.state = (layer_collection.collection.hide_render, layer_collection.exclude)
		self.context.settings.batch_collection_name = layer_collection.collection.name
		layer_collection.collection.hide_render = False
		layer_collection.exclude = False
		self._render()

	def rollback(self, item):
		state = getattr(item, 'state', None)
		if not state:
			return
		layer_collection = item.payload
		collection = getattr(layer_collection, 'collection', None)
		if collection is not None:
			safe_set(collection, 'hide_render', state[0])
		safe_set(layer_collection, 'exclude', state[1])

	def restore(self):
		for layer_collection, hidden, excluded in self._snapshot['states']:
			collection = getattr(layer_collection, 'collection', None)
			if collection is not None:
				safe_set(collection, 'hide_render', hidden)
			safe_set(layer_collection, 'exclude', excluded)
		safe_set(self.context.settings, 'batch_collection_name', self._snapshot['collection_name'])


###########################################################################
# Item (object/light) batch

class ItemAdapter(BatchAdapter):
	category = 'Item'

	def snapshot(self):
		view_layer = self.context.view_layer
		self._snapshot = {
			'selection': list(view_layer.selected_objects),
			'active': view_layer.objects.active,
			'states': [],  # [(object, hide_render, selected)]
		}

	def prepare(self):
		view_layer = self.context.view_layer
		selected = [obj for obj in view_layer.selected_objects if obj.type != 'CAMERA']
		if selected:
			items = selected
		elif (
			view_layer.active_layer_collection
			and [obj for obj in view_layer.active_layer_collection.collection.all_objects if obj.type != 'CAMERA']
		):
			items = [
				obj for obj in view_layer.active_layer_collection.collection.all_objects
				if obj.type != 'CAMERA'
			]
		else:
			raise BatchItemError('Items not found.')
		for obj in items:
			self._snapshot['states'].append((obj, obj.hide_render, obj.select_get()))
			obj.hide_render = True
			obj.select_set(False)
		self.items = [BatchItem(self.category, obj.name, obj) for obj in items]

	def apply(self, item):
		obj = item.payload
		view_layer = self.context.view_layer
		item.state = (obj.hide_render, obj.select_get(), view_layer.objects.active)
		obj.select_set(True)
		view_layer.objects.active = obj
		obj.hide_render = False
		self._render()

	def rollback(self, item):
		state = getattr(item, 'state', None)
		if not state:
			return
		obj = item.payload
		safe_set(obj, 'hide_render', state[0])
		safe_call(obj.select_set, state[1])

	def restore(self):
		view_layer = self.context.view_layer
		for obj, hidden, selected in self._snapshot['states']:
			safe_set(obj, 'hide_render', hidden)
			safe_call(obj.select_set, selected)
		safe_set(view_layer.objects, 'active', self._snapshot['active'])


###########################################################################
# Image (folder-driven material texture swap) batch

class ImageAdapter(BatchAdapter):
	category = 'Image'

	def snapshot(self):
		self._snapshot = {
			'material_name': self.context.settings.batch_images_material,
			'node_name': self.context.settings.batch_images_node,
			'original_image': None,
		}

	def _resolve_node(self):
		"""Look up the target image node afresh on every access.

		The node (or even its material) can be deleted mid-batch; resolving it
		lazily means a missing target fails one item instead of crashing every
		subsequent item with a stale StructRNA reference.
		"""
		settings = self.context.settings
		material = self.context.data.materials.get(settings.batch_images_material)
		if material is None or not getattr(material, 'node_tree', None):
			return None
		node = material.node_tree.nodes.get(settings.batch_images_node)
		if node is None or getattr(node, 'type', None) != 'TEX_IMAGE':
			return None
		return node

	def prepare(self):
		import os
		settings = self.context.settings
		bpy = self.context.bpy_module
		source_folder = bpy.path.abspath(settings.batch_images_location)
		if not os.path.isdir(source_folder):
			raise BatchItemError('Image source directory not found.')
		source_images = [
			file_name for file_name in os.listdir(source_folder)
			if file_name.lower().endswith(tuple(bpy.path.extensions_image))
		]
		source_images.sort()
		if not source_images:
			raise BatchItemError('No images found in source directory.')
		node = self._resolve_node()
		if node is None:
			raise BatchItemError('Target material node not found.')
		if node.image is not None and node.image.has_data:
			self._snapshot['original_image'] = node.image
		self._source_folder = source_folder
		self.items = [BatchItem(self.category, file_name, file_name) for file_name in source_images]

	def apply(self, item):
		import os
		node = self._resolve_node()
		if node is None:
			# Target node/material was removed after the batch started.
			raise BatchItemError('Target material node no longer exists.')
		item.state = node.image
		image = self.context.load_image(os.path.join(self._source_folder, item.payload))
		node.image = image
		self._render()

	def rollback(self, item):
		if not hasattr(item, 'state'):
			return
		node = self._resolve_node()
		if node is not None:
			safe_set(node, 'image', item.state)

	def restore(self):
		node = self._resolve_node()
		if node is not None:
			safe_set(node, 'image', self._snapshot['original_image'])


###########################################################################
# Runner

class BatchRunner:
	"""Executes one batch with recovery, rollback, and restoration semantics.

	A module-level guard (shared via *lock_holder*, defaulting to this module)
	makes concurrent batches impossible within one Blender session. The guard is
	released in run()'s finally block, so it is always cleared even when the
	caller forgets to or an unexpected exception escapes.
	"""

	def __init__(self, context, adapter, lock_holder=None):
		self.context = context
		self.adapter = adapter
		self.report = BatchReport()
		self._lock_holder = lock_holder if lock_holder is not None else _GLOBAL_LOCK

	def run(self):
		holder = self._lock_holder
		if holder['active']:
			raise BatchReentryError('A batch render is already in progress.')
		holder['active'] = True
		settings = self.context.settings
		# Preserve the user's manually entered batch variables for full restore.
		original_variables = (
			settings.batch_index,
			settings.batch_factor,
			settings.batch_random,
		)
		try:
			self.adapter.snapshot()
			try:
				self.adapter.prepare()
			except BatchItemError as exc:
				# Nothing renderable — treat as an empty, failed batch but still
				# run restoration so any snapshot side effects are undone.
				print(f'Render Kit Batch: {exc}')
				self.adapter.restore()
				return self.report
			items = self.adapter.items
			self.report.total = len(items)
			total = len(items)
			for index, item in enumerate(items):
				settings.batch_index = index
				self.adapter._set_batch_variables(index, total)
				try:
					self.adapter.apply(item)
				except BatchCancelled as exc:
					# User cancellation: roll this item back and stop entirely.
					self.report.cancelled = True
					self.report.record_failure(item, f'cancelled: {exc}')
					safe_call(self.adapter.rollback, item)
					print(f'Render Kit Batch: cancelled at {item.category} {item.label}')
					break
				except Exception as exc:
					# Single-item failure: roll it back, record it, continue.
					self.report.record_failure(item, str(exc) or exc.__class__.__name__)
					print(f'Render Kit Batch: item failed — {item.category} {item.label}: {exc}')
					safe_call(self.adapter.rollback, item)
					continue
				self.report.success += 1
				if self.context.is_cancelled is not None and self.context.is_cancelled():
					# Cancellation requested between renders (e.g. a flag set by
					# another operator while the synchronous loop is between items).
					self.report.cancelled = True
					print('Render Kit Batch: cancellation requested, stopping batch.')
					break
			return self.report
		finally:
			# Full restoration always runs — success, failure, or cancellation.
			# Successful output files on disk are intentionally never touched.
			safe_call(self.adapter.restore)
			safe_set(settings, 'batch_index', original_variables[0])
			safe_set(settings, 'batch_factor', original_variables[1])
			safe_set(settings, 'batch_random', original_variables[2])
			holder['active'] = False


# Process-wide re-entrancy guard. A dict (not a bare bool) so adapters/tests in
# other modules can share the exact same mutable instance.
_GLOBAL_LOCK = {'active': False}


def is_batch_active():
	return _GLOBAL_LOCK['active']


ADAPTERS = {
	'cams': CameraAdapter,
	'cols': CollectionAdapter,
	'itms': ItemAdapter,
	'imgs': ImageAdapter,
}
