"""Minimal in-memory fakes for the subset of the Blender Python API (bpy) used by
Render Kit's batch lifecycle code. These are test doubles only — they implement
just enough RNA-like behaviour (attribute storage, select_set, collections,
render handlers, render op result sets) to exercise the add-on without Blender.
"""
import os


# ---------------------------------------------------------------------------
# Render operation control
# ---------------------------------------------------------------------------

# Scripted behaviour consumed by FakeRenderOps.render. Each entry is one of:
#   {'result': 'FINISHED', 'files': [names written into the output dir],
#    'cancel_handler': bool, 'complete_handler': bool, 'raise': exc}
# Tests push/pop entries; a default successful render is used when empty.
RENDER_SCRIPT = []
RENDER_CALLS = []


class _HandlerList(list):
	# bpy.app.handlers.render_* are plain lists of callables
	pass


class FakeApp:
	def __init__(self):
		handlers = type('Handlers', (), {
			'render_init': _HandlerList(),
			'render_pre': _HandlerList(),
			'render_post': _HandlerList(),
			'render_cancel': _HandlerList(),
			'render_complete': _HandlerList(),
		})()
		# bpy.app.handlers.persistent is an identity decorator
		handlers.persistent = lambda func: func
		self.handlers = handlers
		self.version = (4, 5, 0)
		self.version_string = '4.5.0'
		self.version_cycle = 'release'
		self.timers = type('Timers', (), {'register': staticmethod(lambda *a, **k: None)})()


class FakePath:
	# Mirrors bpy.path: extensions_image is a tuple of suffixes, abspath a function
	extensions_image = ('.png', '.jpg', '.jpeg', '.exr', '.tif', '.tiff', '.webp', '.bmp')

	@staticmethod
	def abspath(path):
		if path.startswith('//'):
			return os.path.join(FakePath._base, path[2:])
		return path

	# Base used to resolve // relative paths
	_base = ''


# ---------------------------------------------------------------------------
# Datablocks
# ---------------------------------------------------------------------------

class FakeObject:
	def __init__(self, name, obj_type='MESH'):
		self.name = name
		self.type = obj_type
		self.hide_render = False
		self._selected = False
		self.active_material = None

	def select_get(self):
		return self._selected

	def select_set(self, value):
		self._selected = bool(value)


class FakeCollection:
	def __init__(self, name, objects=None):
		self.name = name
		self.hide_render = False
		self.all_objects = list(objects or [])


class FakeLayerCollection:
	def __init__(self, name, collection=None, children=None):
		self.name = name
		self.collection = collection or FakeCollection(name)
		self.children = list(children or [])
		self.exclude = False


class FakeImage:
	def __init__(self, name, filepath='', has_data=True):
		self.name = name
		self.filepath = filepath
		self.filepath_raw = filepath
		self.has_data = has_data


class FakeNode:
	def __init__(self, name, node_type='TEX_IMAGE', image=None):
		self.name = name
		self.type = node_type
		self.image = image
		self.mute = False


class FakeNodeTree:
	def __init__(self, nodes=None):
		self.nodes = FakeNodeCollection(nodes or [])


class FakeNodeCollection:
	def __init__(self, nodes):
		self._nodes = list(nodes)

	def get(self, name):
		for node in self._nodes:
			if node.name == name:
				return node
		return None

	def __iter__(self):
		return iter(self._nodes)


class FakeMaterial:
	def __init__(self, name, node_tree=None):
		self.name = name
		self.use_nodes = node_tree is not None
		self.node_tree = node_tree


class MaterialCollection:
	def __init__(self):
		self._mats = {}

	def register(self, material):
		self._mats[material.name] = material

	def get(self, name):
		return self._mats.get(name)

	def __getitem__(self, name):
		return self._mats[name]

	def __contains__(self, name):
		return name in self._mats


class ImageCollection:
	def __init__(self):
		self._images = {}

	def load(self, filepath, check_existing=False):
		name = os.path.basename(filepath)
		if check_existing and name in self._images:
			return self._images[name]
		image = FakeImage(name, filepath)
		self._images[name] = image
		return image

	def get(self, name):
		return self._images.get(name)

	def __iter__(self):
		return iter(self._images.values())


# ---------------------------------------------------------------------------
# Render / scene
# ---------------------------------------------------------------------------

class FakeImageSettings:
	def __init__(self):
		self.file_format = 'PNG'
		self.color_mode = 'RGBA'
		self.color_depth = '8'
		self.color_management = 'FOLLOW_SCENE'


class FakeRender:
	def __init__(self):
		self.resolution_x = 1920
		self.resolution_y = 1080
		self.resolution_percentage = 100
		self.filepath = ''
		self.image_settings = FakeImageSettings()
		self.engine = 'BLENDER_EEVEE_NEXT'
		self.file_extension = '.png'
		self.use_compositing = False
		self.use_overwrite = True
		self.use_placeholder = False


class FakeEEVEE:
	def __init__(self):
		self.taa_render_samples = 64
		self.use_shadows = False
		self.volumetric_tile_size = 8
		self.volumetric_samples = 64
		self.volumetric_sample_distribution = 1.0
		self.volumetric_ray_depth = 1
		self.bokeh_max_size = 0.0
		self.bokeh_threshold = 0.0
		self.bokeh_neighbor_max = 0.0
		self.use_bokeh_jittered = False
		self.bokeh_overblur = 0.0
		self.use_motion_blur = False
		self.motion_blur_position = 'CENTER'
		self.motion_blur_shutter = 0.5
		self.motion_blur_depth_scale = 1.0
		self.motion_blur_max = 0
		self.motion_blur_steps = 1
		self.use_simplify = False
		self.use_high_quality_normals = False
		self.use_raytracing = False
		self.use_fast_gi = False
		self.shadow_ray_count = 1
		self.shadow_step_count = 1
		self.use_volumetric_shadows = False
		self.volumetric_shadow_samples = 1
		self.shadow_resolution_scale = 1


class FakeViewLayer:
	def __init__(self, objects, active_layer_collection):
		self.objects = FakeViewLayerObjects(objects)
		self.active_layer_collection = active_layer_collection
		self.name = 'ViewLayer'
		self.id_data = None  # set by FakeScene after construction


class FakeViewLayerObjects:
	def __init__(self, objects):
		self._objects = list(objects)
		self.active = None

	def __iter__(self):
		return iter(self._objects)


class FakeScene:
	def __init__(self, settings, objects, active_layer_collection):
		self.name = 'TestScene'
		self.render = FakeRender()
		self.render_kit_settings = settings
		self.camera = None
		self.eevee = FakeEEVEE()
		self.frame_current = 1
		self.frame_start = 1
		self.frame_end = 1
		self.view_layers = [FakeViewLayer(objects, active_layer_collection)]
		self.view_layers[0].id_data = self
		self.timeline_markers = []
		self.collection = FakeCollection('master', objects)
		self.node_tree = None
		self.compositing_node_group = None
		self.display = type('Display', (), {
			'render_aa': 'OFF',
			'shading': type('Shading', (), {'light': 'STUDIO', 'color_type': 'MATERIAL'})(),
		})()

	@property
	def view_layer(self):
		return self.view_layers[0]


# ---------------------------------------------------------------------------
# bpy.ops.render.render with handler orchestration
# ---------------------------------------------------------------------------

class FakeRenderOps:
	def render(self, animation=False, write_still=False, use_viewport=True):
		# Pull the next scripted behaviour (or a default successful still render)
		if RENDER_SCRIPT:
			step = RENDER_SCRIPT.pop(0)
		else:
			step = {'result': 'FINISHED', 'files': ['frame.png'],
					'cancel_handler': False, 'complete_handler': True}
		RENDER_CALLS.append(dict(step))

		scene = bpy.context.scene

		if step.get('raise'):
			raise step['raise']

		# Emit render_init + render_pre like Blender does before pixels render
		_run_handlers(bpy.app.handlers.render_init, scene)
		_run_handlers(bpy.app.handlers.render_pre, scene)

		out_dir = _resolve_output_dir(scene)
		cancelled = step.get('result') == 'CANCELLED'

		if cancelled:
			# Blender leaves a placeholder/partial file when cancelled mid-write
			for name in step.get('files', ['partial.png']):
				_touch(out_dir, name)
			_run_handlers(bpy.app.handlers.render_post, scene)
			if step.get('cancel_handler', True):
				_run_handlers(bpy.app.handlers.render_cancel, scene)
			return {'CANCELLED'}

		# Successful render: write the declared output files, then post + complete
		for name in step.get('files', ['frame.png']):
			_touch(out_dir, name)
		_run_handlers(bpy.app.handlers.render_post, scene)
		if step.get('complete_handler', True):
			_run_handlers(bpy.app.handlers.render_complete, scene)

		# Optional test hook fired after a successful render completes
		if step.get('side_effect'):
			step['side_effect'](scene)
		return {'FINISHED'}


class FakeOps:
	def __init__(self):
		self.render = FakeRenderOps()


# ---------------------------------------------------------------------------
# Context / preferences
# ---------------------------------------------------------------------------

class FakeAddonPrefs:
	def __init__(self):
		self.batch_enable = True
		self.render_variable_enable = True
		self.enable_autosave_render = False
		self.ffmpeg_processing = False
		self.ffmpeg_exists = False
		self.external_log_file = False
		self.pushover_enable = False
		self.voice_enable = False
		self.override_autosave_render = False


class FakeAddonEntry:
	def __init__(self, prefs):
		self.preferences = prefs


class FakePreferences:
	def __init__(self, prefs):
		self.addons = {'Launch_RenderKit': FakeAddonEntry(prefs)}


class FakeContext:
	def __init__(self, scene, selected_objects, prefs):
		self.scene = scene
		self.view_layer = scene.view_layer
		self.selected_objects = selected_objects
		self.preferences = FakePreferences(prefs)
		self.window_manager = FakeWindowManager()
		self.collection = scene.collection


class FakeWindowManager:
	def __init__(self):
		self.clipboard = ''

	def invoke_props_dialog(self, operator):
		return {'RUNNING_MODAL'}

	def invoke_popup(self, operator, width=0):
		return {'RUNNING_MODAL'}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_handlers(handler_list, scene):
	for handler in handler_list:
		handler(scene)


def _resolve_output_dir(scene):
	path = scene.render.filepath
	# Tests use absolute paths; mirror bpy.path.abspath for // relative ones
	path = FakePath.abspath(path)
	return os.path.dirname(path) or path


def _touch(directory, name):
	os.makedirs(directory, exist_ok=True)
	with open(os.path.join(directory, name), 'w') as handle:
		handle.write('x')


# ---------------------------------------------------------------------------
# Public bpy module object
# ---------------------------------------------------------------------------

class FakeBpy:
	def __init__(self):
		self.app = FakeApp()
		self.ops = FakeOps()
		self.data = None  # set by build_world
		self.context = None  # set by build_world
		self.path = FakePath
		self.types = _build_types()
		self.props = _build_props()
		self.utils = type('Utils', (), {
			'register_class': staticmethod(lambda cls: None),
			'unregister_class': staticmethod(lambda cls: None),
		})()


def _build_types():
	# Operator/Panel base classes with no-op subclass machinery
	class Operator:
		bl_idname = ''
		bl_label = ''

		def report(self, level, message):
			pass

	class Panel:
		bl_label = ''

	class PropertyGroup:
		pass

	class AddonPreferences:
		bl_idname = ''

	class CompositorNodeOutputFile:
		pass

	return type('Types', (), {
		'Operator': Operator,
		'Panel': Panel,
		'PropertyGroup': PropertyGroup,
		'AddonPreferences': AddonPreferences,
		'CompositorNodeOutputFile': CompositorNodeOutputFile,
	})()


def _build_props():
	def _prop(default=None, *args, **kwargs):
		return default

	return type('Props', (), {
		'BoolProperty': staticmethod(lambda *a, **k: False),
		'IntProperty': staticmethod(lambda *a, **k: kwargs.get('default', 0)),
		'FloatProperty': staticmethod(lambda *a, **k: kwargs.get('default', 0.0)),
		'StringProperty': staticmethod(lambda *a, **k: kwargs.get('default', '')),
		'PointerProperty': staticmethod(lambda *a, **k: None),
		'EnumProperty': staticmethod(lambda *a, **k: _prop(kwargs.get('default', ''))),
	})()


# Singleton populated by build_world
bpy = FakeBpy()
