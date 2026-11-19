# Planar UV tests

Two complementary test layers for the hardened Planar UV projection chain in
`Launch_MeshKit/planar_uv.py`.

## 1. Stub-based unit tests (no Blender required)

`test_planar_uv.py` runs on stock CPython using the lightweight in-memory
bpy/bmesh/mathutils stubs in `blender_stubs.py`.

```bash
python tests/test_planar_uv.py
```

The stubs implement only the API surface used by `planar_uv.py` (objects,
meshes, bmesh faces/loops/UV layers, mode switching and the view layer).
They make failure injection trivial — e.g. forcing a mid-projection
exception or a failed mode switch — so rollback paths are testable without
a running Blender.

Coverage:

- normal projection of selected faces into an existing UV layer
- objects without a UV layer: explicit `UVMap` creation and rollback
- existing-layer UV values restored after a mid-batch failure
- empty face selection / non-mesh active object: `CANCELLED`, no exception
- mode-switch failure and bmesh failure: mode and selection restored
- multi-object mixed batch: independent success / skip / failure accounting
- Load Selection bounding box, including zero-size axes written as `1.0`
- world-space projection and bounding boxes via `matrix_world`

## 2. Blender-headless integration tests

`test_planar_uv_blender.py` exercises the registered operators against the
real Blender API. It needs a Blender installation:

```bash
blender --background --python tests/test_planar_uv_blender.py
```

The script registers the add-on directly from the repository, runs the same
scenario matrix with real `bpy`/`bmesh` data, prints a PASS/FAIL line per
check and exits non-zero on any failure.
