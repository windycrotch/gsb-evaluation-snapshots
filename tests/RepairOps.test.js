import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RepairOps } from '../js/operations/RepairOps.js';
import { RepairMeshCommand } from '../js/commands/RepairMeshCommand.js';
import { repairMeshData } from '../js/geometry/ManifoldRepair.js';
import { brokenImportMesh, openCube, closedCube, corruptMesh } from './helpers/brokenMeshes.js';
import { MockEditor, makeMeshObject, meshSnapshot } from './helpers/mockEditor.js';
import { boundaryEdgeCount, nonManifoldEdgeCount, assertNoDanglingRefs } from './helpers/meshAssertions.js';

function setup(meshData) {
  const editor = new MockEditor();
  const object = editor.addObject(makeMeshObject(meshData));
  const repairOps = new RepairOps(editor);
  return { editor, object, repairOps };
}

test('repair is one undoable command that fully swaps the mesh', () => {
  const { editor, object, repairOps } = setup(brokenImportMesh());

  const result = repairOps.repairObject(object);
  assert.equal(result.repaired, true);
  assert.equal(editor.undos.length, 1);
  assert.ok(editor.undos[0] instanceof RepairMeshCommand);

  const meshData = object.userData.meshData;
  assert.equal(boundaryEdgeCount(meshData), 0);
  assert.equal(nonManifoldEdgeCount(meshData), 0);
  assert.deepEqual(assertNoDanglingRefs(meshData), []);

  // Observable: the report is on the command and the result.
  assert.ok(editor.undos[0].report);
  assert.equal(editor.undos[0].report.outputFaceCount, meshData.faces.size);
});

test('clean mesh is left untouched (no command pushed)', () => {
  const { editor, object, repairOps } = setup(closedCube());
  const result = repairOps.repairObject(object);
  assert.equal(result.repaired, false);
  assert.equal(editor.undos.length, 0);
});

test('undo restores the complete pre-repair state, redo reapplies it', () => {
  const { editor, object, repairOps } = setup(brokenImportMesh());
  const before = meshSnapshot(object.userData.meshData);

  repairOps.repairObject(object);
  const repaired = meshSnapshot(object.userData.meshData);
  assert.notDeepEqual(repaired, before);

  editor.undo();
  const restored = object.userData.meshData;
  assert.deepEqual(meshSnapshot(restored), before, 'undo brings back the exact pre-repair mesh');
  assert.deepEqual(assertNoDanglingRefs(restored), []);
  assert.ok(boundaryEdgeCount(restored) > 0, 'pre-repair defects are back, nothing half-repaired');

  editor.redo();
  assert.deepEqual(meshSnapshot(object.userData.meshData), repaired, 'redo reapplies the full repair');
});

test('undo mid-history: no dangling indices to deleted faces remain', () => {
  const { editor, object, repairOps } = setup(brokenImportMesh());
  const originalFaceIds = [...object.userData.meshData.faces.keys()];

  repairOps.repairObject(object);
  editor.undo();

  const meshData = object.userData.meshData;
  assert.deepEqual([...meshData.faces.keys()].sort((a, b) => a - b), originalFaceIds.sort((a, b) => a - b));
  assert.deepEqual(assertNoDanglingRefs(meshData), []);
});

test('failed repair leaves the object in its exact pre-repair state', () => {
  const { editor, object, repairOps } = setup(corruptMesh());
  const meshDataBefore = object.userData.meshData;

  const result = repairOps.repairObject(object);

  assert.equal(result.repaired, false);
  assert.ok(result.error);
  assert.equal(object.userData.meshData, meshDataBefore, 'same meshData instance, untouched');
  assert.equal(editor.undos.length, 0, 'no half-applied command in history');
});

test('reentrant repair during commit is queued, then runs sequentially', () => {
  const { editor, object, repairOps } = setup(brokenImportMesh());

  const events = [];
  let reentrantResult = null;
  let fired = 0;

  // A second repair is requested from inside the first one's commit
  // (meshRepaired fires while the first repair is still in progress).
  editor.signals.meshRepaired.add(() => {
    events.push('meshRepaired');
    if (fired++ === 0) {
      reentrantResult = repairOps.repairObject(object, { force: true });
      events.push('reentrant-returned');
    }
  });

  const first = repairOps.repairObject(object);

  assert.equal(first.repaired, true);
  assert.deepEqual(events, ['meshRepaired', 'reentrant-returned', 'meshRepaired'],
    'queued repair committed (and signalled) only after the first one finished');
  assert.equal(reentrantResult.queued, true, 'reentrant request was queued, not interleaved');

  // Two commands, executed strictly in order: the queued repair ran after
  // the first one fully committed — equivalent to sequential execution.
  assert.equal(editor.undos.length, 2);
  const [cmd1, cmd2] = editor.undos;
  assert.ok(cmd1.report.filledHoles >= 1 || cmd1.report.removedFaces >= 1, 'first repair did the work');
  assert.equal(cmd2.report.addedFaces, 0, 'second repair found a clean mesh');
  assert.equal(cmd2.report.removedFaces, 0);

  // Final state equals running repairMeshData twice in sequence by hand.
  const manualOnce = repairMeshData(brokenImportMesh());
  const manualTwice = repairMeshData(manualOnce);
  assert.deepEqual(
    meshSnapshot(object.userData.meshData).faces,
    meshSnapshot(manualTwice).faces,
  );

  // And both steps undo cleanly, newest first.
  editor.undo();
  editor.undo();
  assert.ok(boundaryEdgeCount(object.userData.meshData) > 0, 'back to the broken import');
});

test('queued reentrant repair on an already-clean mesh is a no-op', () => {
  const { editor, object, repairOps } = setup(openCube());

  let calls = 0;
  editor.signals.meshRepaired.add(() => {
    calls++;
    if (calls === 1) repairOps.repairObject(object); // queued; mesh is clean by then
  });

  repairOps.repairObject(object);
  assert.equal(editor.undos.length, 1, 'no second command for a clean mesh');
});

test('meshRepaired signal reports counts matching the committed mesh', () => {
  const { editor, object, repairOps } = setup(brokenImportMesh());

  let seen = null;
  editor.signals.meshRepaired.add(({ object: o, report }) => {
    seen = { report, faceCount: o.userData.meshData.faces.size };
  });

  repairOps.repairObject(object);

  assert.ok(seen);
  assert.equal(seen.report.outputFaceCount, seen.faceCount, 'report matches the mesh at observation time');
});
