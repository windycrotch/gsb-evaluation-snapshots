# Minimal, in-memory fakes of the subset of the bpy data model used by
# Render Kit's batch engine. The real add-on code (batch_engine.py) is imported
# unchanged and driven through these fakes, so the tests exercise the actual
# recovery / rollback / re-entrancy logic without a Blender installation or any
# rendering. Every fake records enough state for tests to assert that the scene
# after a batch is identical to the scene before it.


class FakeRender:
	def __init__(self, resolution_x=1920, resolution_y=1080, filepath="//render.png"):
		self.resolution_x = resolution_x
		self.resolution_y = resolution_y
		self.filepath = filepath
		self.image_settings = self
		self.color_management = "FOLLOW_SCENE"


class FakeObject:
	def __init__(self, name, object_type='MESH', hide_render=False):
		self.name = name
		self.type = object_type
		self.hide_render = hide_render
		self.active_material = None
		self._selected = False

	def select_get(self):
		return self._selected

	def select_set(self, value):
		self._selected = bool(value)


class FakeCollection:
	def __init__(self, name, objects=None):
		self.name = name
		self.hide_render = False
		self._objects = list(objects or [])

	@property
	def all_objects(self):
		return list(self._objects)


class FakeLayerCollection:
	def __init__(self, name, collection=None, children=None):
		self.name = name
		self.collection = collection or FakeCollection(name)
		self.exclude = False
		self.children = list(children or [])


class FakeObjects:
	"""Mimics view_layer.objects (only the .active slot is needed)."""
	def __init__(self):
		self.active = None


class FakeViewLayer:
	def __init__(self, selected=None, active_layer_collection=None):
		self.objects = FakeObjects()
		self._selected = list(selected or [])
		for obj in self._selected:
			obj.select_set(True)
		self.active_layer_collection = active_layer_collection

	@property
	def selected_objects(self):
		return [obj for obj in self._selected if obj.select_get()]


class FakeImage:
	def __init__(self, name, filepath, has_data=True):
		self.name = name
		self.filepath = filepath
		self.has_data = has_data


class FakeNode:
	def __init__(self, name, node_type='TEX_IMAGE', image=None):
		self.name = name
		self.type = node_type
		self.image = image


class FakeNodes:
	def __init__(self, nodes=None):
		self._nodes = list(nodes or [])
		self.active = self._nodes[0] if self._nodes else None

	def get(self, name):
		for node in self._nodes:
			if node.name == name:
				return node
		return None

	def remove(self, node):
		if node in self._nodes:
			self._nodes.remove(node)


class FakeNodeTree:
	def __init__(self, nodes=None):
		self.nodes = FakeNodes(nodes)


class FakeMaterial:
	def __init__(self, name, node_tree=None):
		self.name = name
		self.node_tree = node_tree


class FakeMaterials:
	def __init__(self, materials=None):
		self._materials = list(materials or [])

	def get(self, name):
		for material in self._materials:
			if material.name == name:
				return material
		return None


class FakeImages:
	def __init__(self):
		self.loaded = []

	def load(self, path, check_existing=True):
		for image in self.loaded:
			if check_existing and image.filepath == path:
				return image
		name = path.replace('\\', '/').rstrip('/').split('/')[-1]
		image = FakeImage(name, path)
		self.loaded.append(image)
		return image


class FakeData:
	def __init__(self, materials=None):
		self.materials = FakeMaterials(materials)
		self.images = FakeImages()


class FakePath:
	extensions_image = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.exr', '.bmp')

	@staticmethod
	def abspath(path):
		# Tests pass absolute paths already; mirror bpy.path.abspath closely
		# enough for the engine's folder checks.
		return path


class FakeOps:
	def __init__(self):
		# Test hooks: either a set of item labels that should fail, or a custom
		# callable receiving the current camera/context state.
		self.fail_labels = set()
		self.cancel_label = None
		self.render_calls = 0
		self.cancelled_result = False
		# When True, render.render returns {'CANCELLED'} (user abort in Blender).
		self.return_cancel_for = set()

	def render(self, animation=False, write_still=False, use_viewport=True):
		self.render_calls += 1
		label = getattr(self, '_current_label', None)
		if label is not None and label in self.return_cancel_for:
			return {'CANCELLED'}
		if label is not None and self.cancel_label is not None and label == self.cancel_label:
			raise RuntimeError('user cancelled render')
		if label is not None and label in self.fail_labels:
			raise RuntimeError('simulated render failure')
		return {'FINISHED'}


class FakeBpy:
	def __init__(self):
		self.path = FakePath()
		self.ops = FakeOps()
		self.data = None  # assigned by the harness


class FakeSettings:
	"""Stand-in for scene.render_kit_settings with the batch properties."""
	def __init__(self, batch_type='cams', batch_range='img'):
		self.batch_active = False
		self.batch_type = batch_type
		self.batch_range = batch_range
		self.batch_collection_name = ''
		self.batch_images_location = ''
		self.batch_images_material = ''
		self.batch_images_node = ''
		# Manually entered values the user had before the batch.
		self.batch_index = 7
		self.batch_factor = 0.42
		self.batch_random = 0.99
		# Report properties (mirror the PropertyGroup fields added in __init__.py)
		self.batch_report_total = 0
		self.batch_report_success = 0
		self.batch_report_failed = 0
		self.batch_report_cancelled = False
		self.batch_report_failures = '[]'


class FakeScene:
	def __init__(self, settings, camera=None):
		self.render_kit_settings = settings
		self.render = FakeRender()
		self.camera = camera


def make_camera_context(camera_names, selected_names=None, settings=None):
	"""Build a ready-to-run camera batch context plus the raw objects."""
	settings = settings or FakeSettings(batch_type='cams')
	cameras = [FakeObject(name, 'CAMERA') for name in camera_names]
	by_name = {obj.name: obj for obj in cameras}
	selected = [by_name[name] for name in (selected_names or camera_names)]
	view_layer = FakeViewLayer(selected=selected)
	scene = FakeScene(settings, camera=cameras[0])
	bpy = FakeBpy()
	return scene, view_layer, bpy, cameras, settings


def snapshot_scene_state(scene, view_layer):
	"""Capture the externally observable scene state for equality assertions."""
	return {
		'camera': scene.camera.name if scene.camera else None,
		'resolution_x': scene.render.resolution_x,
		'resolution_y': scene.render.resolution_y,
		'active': view_layer.objects.active.name if view_layer.objects.active else None,
		'selection': sorted(obj.name for obj in view_layer.selected_objects),
	}


def snapshot_collection_state(layer_collections):
	return [
		(lc.collection.name, lc.collection.hide_render, lc.exclude)
		for lc in layer_collections
	]


def snapshot_item_state(objects, view_layer):
	return (
		sorted((obj.name, obj.hide_render, obj.select_get()) for obj in objects),
		view_layer.objects.active.name if view_layer.objects.active else None,
	)
