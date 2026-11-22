# Render Kit — Batch Render lifecycle tests

These tests validate the recoverable Batch Render lifecycle without requiring a
Blender installation. They run against lightweight in-memory fakes of the subset
of `bpy` the add-on uses (`tests/fakes/`), so they execute with ordinary CPython
and `pytest`.

## What is covered

| Requirement | Test class / test |
| --- | --- |
| Normal completion restores all changed state | `TestNormalCompletion.test_all_targets_render_and_state_restored` |
| Serial increments only after each successful render | `TestNormalCompletion.test_serial_advances_only_after_each_success` |
| Mid-batch cancellation rolls back state and serial | `TestCancellation.*` |
| Cancelled/failed target leaves no partial output, earlier outputs kept | `TestCancellation`, `TestFailureAndRetry` |
| Single-target failure then retry reproduces clean-run numbering | `TestFailureAndRetry.test_retry_reproduces_clean_run_numbering` |
| Re-entrant batch trigger is rejected | `TestReentrancy.*` |
| Target list and output path are snapshotted at start and don't drift | `TestSnapshotAndProgression.test_target_list_and_path_frozen_at_start` |
| After rollback, a later normal render still increments serials | `TestSnapshotAndProgression.test_normal_batch_after_rollback_still_increments` |
| Per-type state restoration (cameras/collections/items/images) | `TestStateRestorationByType.*` |

## Running

From the repository root (the directory containing `Launch_RenderKit/`):

```bash
python -m pytest tests/ -v
```

No Blender binary or third-party package beyond `pytest` is required. The fakes
implement just enough RNA-like behaviour (objects, collections, selection,
render handlers and a scriptable `bpy.ops.render.render`) to exercise the real
`render_batch_session`, `render_2_end`, `render_0_start`, `render_1_frame` and
`utility_data` modules.

## How cancellation/failure is simulated

`tests/fakes/fake_bpy.py` reads a per-test render script (`RENDER_SCRIPT`). Each
entry describes one `bpy.ops.render.render` call: a normal finish (writing files
and firing the `render_complete` handler), a cancellation (writing a partial file
and firing `render_cancel`, returning `{'CANCELLED'}`), or a hard exception. This
lets the tests deterministically reproduce every lifecycle branch.
