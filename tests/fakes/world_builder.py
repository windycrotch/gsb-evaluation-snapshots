"""Construct a fake Blender world (scene, settings, objects, collections, materials)
and install the stub modules into sys.modules so the add-on package imports work.
"""
import os
import sys
import types

from . import fake_bpy


# Attributes the RenderKitSettings PropertyGroup exposes that the code under test
# touches. Defaults mirror the real add-on where relevant.
_SETTING_DEFAULTS = {
	# batch
	'batch_active': False,
	'batch_type': 'cams',
	'batch_range': 'img',
	'batch_collection_name': '',
	'batch_images_location': '',
	'batch_images_material': '',
	'batch_images_node': '',
	'batch_index': 0,
	'batch_factor': 0.25,
	'batch_random': 0.75,
	# serials / output
	'output_file_serial': 0,
	'output_file_path': '',
	'output_file_nodes': '',
	'file_serial': 0,
	'file_location': '/',
	'file_name_type': 'SERIAL',
	'file_name_custom': '{{project}}-{{serial}}',
	'file_format': 'PNG',
	'total_render_time': 0.0,
	# autosave video paths
	'autosave_video_render_path': '',
	'autosave_video_prores_path': '',
	'autosave_video_mp4_path': '',
	'autosave_video_custom_path': '',
	'autosave_video_still_path': '',
	'autosave_video_prores': False,
	'autosave_video_mp4': False,
	'autosave_video_custom': False,
	'autosave_video_still': False,
	'autosave_video_prores_location': '',
	'autosave_video_mp4_location': '',
	'autosave_video_custom_location': '',
	'autosave_video_still_location': '',
	# sync (referenced by render_sync import surface)
	'sync_render': True,
	'sync_output': True,
	'sync_renderkit': True,
	'sync_target': False,
}


class FakeSettings:
	def __init__(self, **overrides):
		for key, value in _SETTING_DEFAULTS.items():
			setattr(self, key, value)
		for key, value in overrides.items():
			setattr(self, key, value)


class FakeData:
	def __init__(self, materials, images, filepath=''):
		self.materials = materials
		self.images = images
		self._filepath = filepath

	@property
	def filepath(self):
		return self._filepath


def install_fake_modules():
	"""Register stub modules for every third-party/Blender import the add-on needs."""
	fb = fake_bpy.bpy

	# The real render_variables.replaceVariables reads dozens of Blender scene
	# fields. The lifecycle tests don't validate variable expansion (that is
	# exercised separately), so substitute a deterministic stub that performs the
	# {serial}/{batch} substitutions the tests assert on.
	render_variables_stub = types.ModuleType('Launch_RenderKit.render_variables')

	def _replace_variables(scene, string, render_time=-1.0, serial=-1, socket=''):
		settings = scene.render_kit_settings
		if serial < 0:
			serial = settings.output_file_serial
		result = string
		if '{serial}' in result:
			result = result.replace('{serial}', format(int(serial), '04'))
		if '{batch}' in result:
			result = result.replace('{batch}', format(int(settings.batch_index), '04'))
		return result

	render_variables_stub.replaceVariables = _replace_variables
	render_variables_stub.renderkit_variable_ui = lambda *a, **k: None
	render_variables_stub.sanitiseName = lambda value: value

	modules = {
		'bpy': fb,
		'bpy.app': fb.app,
		'bpy.app.handlers': fb.app.handlers,
		'bpy.props': fb.props,
		'bpy.types': fb.types,
		'bpy.utils': fb.utils,
		'bpy.path': fb.path,
		'bpy.data': types.SimpleNamespace(),  # replaced per-world
		# Third-party modules imported at module load time
		'requests': types.SimpleNamespace(exceptions=types.SimpleNamespace()),
		'numpy': types.SimpleNamespace(),
		'imbuf': types.SimpleNamespace(),
		# Add-on module stub
		'Launch_RenderKit.render_variables': render_variables_stub,
	}
	for name, module in modules.items():
		sys.modules[name] = module

	# A namespace stand-in for the add-on package. It keeps a real __path__ so
	# `from . import utility_data` style relative imports still resolve to the
	# actual add-on files on disk, while allowing selected heavy modules (notably
	# render_variables) to be replaced with stubs held in sys.modules.
	# __file__ lives in <repo>/tests/fakes/, so three dirnames reach the repo root.
	repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
	package_dir = os.path.join(repo_root, 'Launch_RenderKit')
	pkg = types.ModuleType('Launch_RenderKit')
	pkg.__path__ = [package_dir]
	pkg.__package__ = 'Launch_RenderKit'
	pkg.render_variables = render_variables_stub
	sys.modules['Launch_RenderKit'] = pkg
	sys.modules['Launch_RenderKit.render_variables'] = render_variables_stub


def build_world(tmp_path, batch_type='cams', serial_in_path=True, settings_overrides=None,
				image_folder=None, include_resolution_camera=False):
	"""Build a self-contained scene + context for one test.

	tmp_path: pytest tmp_path-like object exposing __str__ (we also accept plain str)
	"""
	fb = fake_bpy.bpy
	base = str(tmp_path)
	fake_bpy.FakePath._base = base
	install_fake_modules()

	settings = FakeSettings(**(settings_overrides or {}))
	settings.batch_type = batch_type

	# Output path (optionally using the {serial} variable)
	output_dir = os.path.join(base, 'renders')
	os.makedirs(output_dir, exist_ok=True)
	if serial_in_path:
		settings_render_filepath = os.path.join(output_dir, 'out_{serial}.png')
	else:
		settings_render_filepath = os.path.join(output_dir, 'out_{batch}.png')

	# ---- Cameras / items / collections world ----
	cam_a = fake_bpy.FakeObject('CameraA', 'CAMERA')
	cam_b = fake_bpy.FakeObject('CameraB', 'CAMERA')
	if include_resolution_camera:
		cam_b.name = 'CameraB1280x720'
	item = fake_bpy.FakeObject('MeshItem', 'MESH')
	light = fake_bpy.FakeObject('LightItem', 'LIGHT')

	objects = [cam_a, cam_b, item, light]

	# Layer collections: master active layer with two child collections
	col_x_coll = fake_bpy.FakeCollection('CollectionX', [item])
	col_y_coll = fake_bpy.FakeCollection('CollectionY', [light])
	lc_x = fake_bpy.FakeLayerCollection('CollectionX', col_x_coll)
	lc_y = fake_bpy.FakeLayerCollection('CollectionY', col_y_coll)
	master_coll = fake_bpy.FakeCollection('Master', objects)
	active_lc = fake_bpy.FakeLayerCollection('Master', master_coll, children=[lc_x, lc_y])

	scene = fake_bpy.FakeScene(settings, objects, active_lc)
	scene.camera = cam_a
	scene.render.filepath = settings_render_filepath

	# ---- Image-batch material/node world ----
	original_image = fake_bpy.FakeImage('original_tex.png', os.path.join(base, 'original_tex.png'))
	node = fake_bpy.FakeNode('ImageNode', 'TEX_IMAGE', original_image)
	tree = fake_bpy.FakeNodeTree([node])
	material = fake_bpy.FakeMaterial('TargetMaterial', tree)
	materials = fake_bpy.MaterialCollection()
	materials.register(material)

	images = fake_bpy.ImageCollection()
	images._images[original_image.name] = original_image

	data = FakeData(materials, images, filepath=os.path.join(base, 'project.blend'))
	fb.data = data
	sys.modules['bpy.data'] = data

	prefs = fake_bpy.FakeAddonPrefs()
	selected = [obj for obj in objects]
	context = fake_bpy.FakeContext(scene, selected, prefs)
	fb.context = context

	# Image batch settings
	if batch_type == 'imgs':
		folder = image_folder or os.path.join(base, 'textures')
		os.makedirs(folder, exist_ok=True)
		for name in ('tex_a.png', 'tex_b.png', 'tex_c.png'):
			with open(os.path.join(folder, name), 'w') as handle:
				handle.write('img')
		settings.batch_images_location = folder
		settings.batch_images_material = 'TargetMaterial'
		settings.batch_images_node = 'ImageNode'

	# Reset render scripting / handler registrations between worlds
	fake_bpy.RENDER_SCRIPT.clear()
	fake_bpy.RENDER_CALLS.clear()
	fb.app.handlers.render_init.clear()
	fb.app.handlers.render_pre.clear()
	fb.app.handlers.render_post.clear()
	fb.app.handlers.render_cancel.clear()
	fb.app.handlers.render_complete.clear()

	world = types.SimpleNamespace(
		bpy=fb,
		scene=scene,
		settings=settings,
		context=context,
		prefs=prefs,
		objects=objects,
		cameras=[cam_a, cam_b],
		items=[item, light],
		layer_collections=[lc_x, lc_y],
		active_layer_collection=active_lc,
		material=material,
		node=node,
		original_image=original_image,
		output_dir=output_dir,
	)
	return world


def register_addon_handlers():
	"""Import the add-on package modules and attach the real render handlers.

	The package __init__ imports screenshot/numpy-heavy modules at load; instead we
	import the specific modules under test and wire their handlers manually, which
	is exactly what __init__.register() does for the render lifecycle.
	"""
	import importlib

	# Ensure the repo root (parent of the Launch_RenderKit package) is importable
	repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
	if repo_root not in sys.path:
		sys.path.insert(0, repo_root)

	# Reload only the lifecycle modules; the render_variables stub and the
	# namespace package stand-in must remain in sys.modules. Re-importing every
	# module under test together keeps their `from . import utility_data` bindings
	# pointing at one fresh module instance (so latches reset per test).
	for name in (
		'Launch_RenderKit.utility_data',
		'Launch_RenderKit.render_0_start',
		'Launch_RenderKit.render_1_frame',
		'Launch_RenderKit.render_2_end',
		'Launch_RenderKit.render_batch_session',
		'Launch_RenderKit.render_batch',
	):
		sys.modules.pop(name, None)

	pkg_init = importlib.import_module('Launch_RenderKit.render_0_start')
	frame = importlib.import_module('Launch_RenderKit.render_1_frame')
	end = importlib.import_module('Launch_RenderKit.render_2_end')

	fb = fake_bpy.bpy
	fb.app.handlers.render_init.append(pkg_init.render_kit_start)
	fb.app.handlers.render_pre.append(frame.render_kit_frame_pre)
	fb.app.handlers.render_post.append(frame.render_kit_frame_post)
	fb.app.handlers.render_cancel.append(end.render_kit_cancel)
	fb.app.handlers.render_complete.append(end.render_kit_end)

	return {
		'render_kit_start': pkg_init.render_kit_start,
		'render_kit_cancel': end.render_kit_cancel,
		'render_kit_end': end.render_kit_end,
	}
