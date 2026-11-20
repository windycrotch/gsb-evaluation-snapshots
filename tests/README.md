# UV to Mesh batch verification

`uv_mesh_batch_test.py` verifies the batch behaviour of the **UV to Mesh**
operator (`object.uv_mesh`) inside a real Blender instance. It covers:

| Case | Expectation |
| --- | --- |
| `all-success` | every selected object produces one `<object><separator><uv>` mesh object, each with a UV map; `FINISHED`; only the new objects are selected |
| `partial-skip` | objects that are missing the UV map, have no faces, or have only degenerate UV faces are skipped; the rest still convert; `WARNING` with the skip count, `INFO` with success + skip counts; `FINISHED` |
| `skip-reasons-and-repeat` | the batch helper reports the correct skip reason per object, and a second run creates fresh meshes/objects instead of reusing or overwriting the first run's data |
| `all-skipped` | `CANCELLED`; no empty or half-built objects are left behind; the previous selection and active object are restored |
| `no-mesh-selected` | `CANCELLED` without touching the scene |

## Running in Blender

From the repository root:

```sh
blender --background --python tests/uv_mesh_batch_test.py --python-exit-code 1
```

A summary is printed and the process exits non-zero if any check fails, which
makes it usable in CI. The script can also be opened in Blender's Text Editor and
run directly (it then prints the summary without terminating Blender); it does not
delete the user's own scene data, only objects it created itself.

If the extension is already installed and enabled, the script reuses the running
add-on classes; otherwise it registers the settings property group it needs.

## Offline logic check (no Blender required)

`sim/run_offline.py` executes the very same test module against a small
`bpy`/`bmesh` mock (`sim/mock_bpy.py`) so the batch logic can be sanity-checked on
a machine without Blender:

```sh
python -I tests/sim/run_offline.py
```

The mock is a development convenience only — it models datablock naming,
selection, mesh users and bmesh welding, but it is **not** Blender. Always run the
Blender command above for a real verification.
