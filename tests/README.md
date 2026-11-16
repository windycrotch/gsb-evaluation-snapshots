# Tests

Headless Node test suite for the manifold-repair fallback and its undoable boolean integration.
No browser or DOM is required; the Manifold WASM module runs under Node directly.

## Run

```bash
npm install   # installs three + manifold-3d used only by the tests
npm test
```

## What is covered

| File | Focus |
| --- | --- |
| `ManifoldRepair.test.js` | The repair pipeline itself: welding, degenerate/duplicate removal, non-manifold handling, winding, hole filling + over-limit skip, the repair report and non-colliding repair face ids. |
| `RepairMeshCommand.test.js` | The undoable command: execute/undo/redo restores original vs. repaired mesh and face ids, the `repairApplied` signal, and history `toJSON`/`fromJSON` round-trips. |
| `BooleanRepairIntegration.test.js` | Real union/difference through `manifold-3d`: repair is folded into one composite undoable step, full undo restores the original mesh and removed operand, and unfixable meshes throw `ManifoldRepairError` instead of silently returning empty. |
| `AgentRepairReport.test.js` | The `mesh.repairReport` and `mesh.inspect` agent commands used to query repair reports and identify repair-added faces. |

## The three required self-made samples (`helpers/meshSamples.js`)

1. **Broken open cube** — two coincident vertices plus one degenerate triangle on an open cube.
   A boolean rejects the raw mesh; repair welds the duplicates, drops the degenerate face, fills
   the hole, and the whole thing is one undoable command.
2. **Large-hole tube** — an open tube whose boundary loops have more edges than
   `maxHoleFillEdges`. Repair skips both holes and records warnings instead of filling them.
3. **Still-non-manifold mesh** — damage repair can clean, but whose oversized holes keep it open.
   `toManifold` throws `ManifoldRepairError` (with report + reasons); it never returns an empty
   mesh. An all-degenerate mesh covers the same honest-failure contract for the empty case.
