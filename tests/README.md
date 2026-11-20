# Render Kit local tests

These tests run without Blender and without rendering anything. They exercise
the real batch engine (`Launch_RenderKit/batch_engine.py`, deliberately written
with no `bpy` dependency) through in-memory fakes of the Blender data model.

## Run

From the repository root, with any standard Python 3 installation:

```bash
python -I tests/run_all.py
```

`-I` (isolated mode) keeps the interpreter from importing stray modules from the
working directory. Individual suites also run standalone:

```bash
python -I tests/run_batch_tests.py    # engine behaviour (17 tests)
python -I tests/run_import_smoke.py   # full add-on import against a bpy stub
```

## What is covered

`run_batch_tests.py` covers the four required execution paths, each asserting
that the scene state and the manually entered `batch_index` / `batch_factor` /
`batch_random` match the pre-batch values after the run:

1. **All items succeed** — cameras (including the temporary camera-name and
   resolution suffix handling), with full state restoration.
2. **Single item fails, batch continues** — the failed item is rolled back on
   its own; camera, collection, item, and image paths each verify restoration of
   visibility, selection, active object, and texture assignments.
3. **User cancellation** — both a render op returning cancellation and a
   cancellation flag raised between items stop the batch cleanly.
4. **Repeated trigger** — starting a second batch while one is running raises
   `BatchReentryError`; the rejected batch never mutates the scene, and the
   guard is released so later batches run normally. Cancelling the confirmation
   dialog never reaches the engine.

Additional edge cases: a target image node deleted mid-batch fails only that
item (subsequent items do not crash) and successful output files on disk are
never deleted; an empty selection / missing folder releases the guard; the
single-item batch no longer divides by zero; rollback without captured state is
a safe no-op; and a partially failing restoration still restores the batch
variables and releases the re-entrancy guard.
