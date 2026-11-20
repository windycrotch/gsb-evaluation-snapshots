# Smoke test: import the complete add-on package against a minimal bpy stub.
#
# This catches wiring mistakes (bad names, broken imports, missing properties)
# across every module without needing a real Blender installation. It does not
# execute operators or render anything; the behavioural coverage lives in
# run_batch_tests.py, which drives the real batch_engine directly.
#
# Run with: python -I tests/run_import_smoke.py

import importlib.util
import os
import sys
import types


def build_bpy_stub():
	bpy = types.ModuleType('bpy')

	class _Types:
		class Operator:
			bl_options = set()

		class Panel:
			bl_options = set()

		class AddonPreferences:
			pass

		class PropertyGroup:
			pass

		class CompositorNodeOutputFile:
			pass

	bpy.types = _Types()

	props = types.ModuleType('bpy.props')
	for name in ('BoolProperty', 'EnumProperty', 'FloatProperty',
				 'IntProperty', 'StringProperty', 'PointerProperty'):
		setattr(props, name, lambda **kwargs: None)
	bpy.props = props

	handlers = types.ModuleType('bpy.app.handlers')
	handlers.persistent = lambda func: func
	for name in ('render_init', 'render_pre', 'render_post',
				 'render_cancel', 'render_complete'):
		setattr(handlers, name, [])
	app = types.ModuleType('bpy.app')
	app.handlers = handlers
	app.version = (4, 5, 0)
	app.version_string = '4.5.0'
	app.version_cycle = 'release'
	bpy.app = app

	path = types.ModuleType('bpy.path')
	path.abspath = lambda value: value
	path.extensions_image = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.exr')
	bpy.path = path

	bpy.utils = types.SimpleNamespace(
		register_class=lambda cls: None,
		unregister_class=lambda cls: None,
	)
	bpy.data = types.SimpleNamespace(
		materials=types.SimpleNamespace(get=lambda name: None),
		filepath='',
	)
	bpy.context = types.SimpleNamespace(
		preferences=types.SimpleNamespace(addons={}),
		scene=None,
		view_layer=None,
	)
	bpy.ops = types.SimpleNamespace(
		render=types.SimpleNamespace(render=lambda **kwargs: {'FINISHED'})
	)

	# Blender ships a few C-only modules alongside bpy; empty stubs are enough
	# for import-time wiring checks (nothing is executed during import).
	sys.modules['imbuf'] = types.ModuleType('imbuf')

	sys.modules['bpy'] = bpy
	sys.modules['bpy.props'] = props
	sys.modules['bpy.app'] = app
	sys.modules['bpy.app.handlers'] = handlers
	sys.modules['bpy.path'] = path
	return bpy


def main():
	build_bpy_stub()
	repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
	pkg_dir = os.path.join(repo_root, 'Launch_RenderKit')
	spec = importlib.util.spec_from_file_location(
		'Launch_RenderKit',
		os.path.join(pkg_dir, '__init__.py'),
		submodule_search_locations=[pkg_dir],
	)
	pkg = importlib.util.module_from_spec(spec)
	sys.modules['Launch_RenderKit'] = pkg
	spec.loader.exec_module(pkg)

	errors = []

	def check(condition, message):
		if not condition:
			errors.append(message)

	engine = pkg.render_batch.batch_engine
	check(all(hasattr(engine, name) for name in (
		'BatchRunner', 'BatchContext', 'BatchAdapter', 'ADAPTERS',
		'is_batch_active', 'BatchCancelled', 'BatchReentryError',
		'CameraAdapter', 'CollectionAdapter', 'ItemAdapter', 'ImageAdapter',
	)), 'batch_engine exports missing')
	check(sorted(engine.ADAPTERS.keys()) == ['cams', 'cols', 'imgs', 'itms'],
		  'all four batch adapters registered')

	check([cls.__name__ for cls in pkg.render_batch.classes] ==
		  ['batch_render_start', 'batch_image_target',
		   'batch_camera_update', 'BATCH_PT_batch_render'],
		  'operator/panel class list changed unexpectedly')

	# RNA property annotations only materialise as class attributes inside real
	# Blender; verify the new fields exist as declared PropertyGroup members.
	init_file = os.path.join(pkg_dir, '__init__.py')
	with open(init_file, 'r', encoding='utf-8') as handle:
		init_source = handle.read()
	for name in ('batch_report_total', 'batch_report_success',
				 'batch_report_failed', 'batch_report_cancelled',
				 'batch_report_failures', 'batch_active', 'batch_index',
				 'batch_factor', 'batch_random'):
		check(f'{name}:' in init_source,
			  f'RenderKitSettings missing declared property {name}')

	# render_batch must not import bpy at engine layer
	engine_file = os.path.join(pkg_dir, 'batch_engine.py')
	with open(engine_file, 'r', encoding='utf-8') as handle:
		source = handle.read()
	check('import bpy' not in source, 'batch_engine must stay bpy-free')

	if errors:
		for message in errors:
			print(f'FAIL  {message}')
		return 1
	print('PASS  full add-on package imports against bpy stub')
	print('PASS  batch_engine is bpy-free and exports all adapters/reports')
	return 0


if __name__ == '__main__':
	sys.exit(main())
