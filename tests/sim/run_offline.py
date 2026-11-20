"""Offline runner for tests/uv_mesh_batch_test.py.

This executes the same test module that runs inside Blender, but against the
bpy/bmesh mock in tests/sim/mock_bpy.py, so the batch logic can be verified on a
machine that has no Blender installation. It is a development convenience and
does not replace running the real test inside Blender.

    python -I tests/sim/run_offline.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
ADDON_ROOT = os.path.join(REPO_ROOT, "Launch_MeshKit")
TEST_FILE = os.path.join(REPO_ROOT, "tests", "uv_mesh_batch_test.py")

sys.path.insert(0, HERE)

import mock_bpy


def main():
	bpy, _bmesh, _package = mock_bpy.install(ADDON_ROOT)

	spec = importlib.util.spec_from_file_location("uv_mesh_batch_test", TEST_FILE)
	module = importlib.util.module_from_spec(spec)
	sys.modules["uv_mesh_batch_test"] = module
	spec.loader.exec_module(module)

	# The real test module imports `Launch_MeshKit` and expects the add-on
	# package to expose MeshKitSettings; the mock package already does.
	try:
		module.main()
	except SystemExit as exc:
		return int(exc.code or 0)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
