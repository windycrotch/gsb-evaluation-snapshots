import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RepairMeshCommand } from '../js/commands/RepairMeshCommand.js';
import { repairMeshData } from '../js/geometry/ManifoldRepair.js';
import { makeHeadlessEditor, makeHeadlessObject, register } from './helpers/headlessEditor.js';
import { makeBrokenOpenCube } from './helpers/meshSamples.js';

function faceIdSet(object) {
  return new Set([...object.userData.meshData.faces.keys()]);
}

describe('RepairMeshCommand — undo / redo', () => {
  test('execute applies the repaired mesh; undo restores original mesh and face ids; redo returns to repair', () => {
    const editor = makeHeadlessEditor();
    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'brokenCube'));

    const originalFaceIds = faceIdSet(object);
    const originalVertCount = object.userData.meshData.vertices.size;

    const repaired = repairMeshData(raw);
    const report = repaired.repairReport;

    const cmd = new RepairMeshCommand(editor, object, raw, repaired, report);
    editor.execute(cmd);

    // After execute: repaired mesh is live, with repair-added faces flagged.
    const afterExecute = object.userData.meshData;
    assert.ok(afterExecute.faces.size > 0);
    const repairFaces = [...afterExecute.faces.values()].filter((f) => f.isRepairFace);
    assert.ok(repairFaces.length >= 1, 'repair faces present after execute');
    for (const id of report.repairFaceIds) {
      assert.ok(afterExecute.faces.has(id));
      assert.equal(afterExecute.faces.get(id).isRepairFace, true);
    }
    // Original face ids are still present for surviving faces.
    for (const id of report.originalFaceIds) assert.ok(afterExecute.faces.has(id));
    // The latest report is queryable on the object.
    assert.deepEqual(object.userData.lastRepairReport, report);

    // Undo: original mesh and original face ids restored exactly.
    editor.undo();
    const afterUndo = object.userData.meshData;
    assert.deepEqual(faceIdSet(object), originalFaceIds, 'undo restores original face ids');
    assert.equal(afterUndo.vertices.size, originalVertCount, 'undo restores original vertex count');
    assert.ok([...afterUndo.faces.values()].every((f) => !f.isRepairFace), 'no repair markers after undo');

    // Redo: back to the repaired result, markers and ids restored.
    editor.redo();
    const afterRedo = object.userData.meshData;
    assert.deepEqual(
      [...afterRedo.faces.values()].filter((f) => f.isRepairFace).map((f) => f.id).sort((a, b) => a - b),
      [...report.repairFaceIds].sort((a, b) => a - b),
      'redo restores repair faces',
    );
    for (const id of report.originalFaceIds) assert.ok(afterRedo.faces.has(id));
  });

  test('dispatches repairApplied with the report on execute and an undone flag on undo', () => {
    const editor = makeHeadlessEditor();
    const events = [];
    editor.signals.repairApplied.add((p) => events.push(p));

    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'signaled'));
    const repaired = repairMeshData(raw);

    editor.execute(new RepairMeshCommand(editor, object, raw, repaired, repaired.repairReport));
    editor.undo();

    assert.equal(events.length, 2);
    assert.equal(events[0].undone, false);
    assert.equal(events[0].objectUuid, object.uuid);
    assert.ok(events[0].report.weldedVerts === 2);
    assert.equal(events[1].undone, true);
    assert.ok(events[1].report);
  });

  test('survives history serialization (toJSON/fromJSON) keeping report and both snapshots', async () => {
    const editor = makeHeadlessEditor();
    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'serialized'));
    const repaired = repairMeshData(raw);
    const cmd = new RepairMeshCommand(editor, object, raw, repaired, repaired.repairReport);
    editor.execute(cmd);

    const json = editor.history.toJSON();
    assert.ok(json.undos.length === 1);
    const serialized = json.undos[0];
    assert.equal(serialized.type, 'RepairMeshCommand');
    assert.ok(serialized.repairReport);
    assert.equal(serialized.repairReport.weldedVerts, 2);
    assert.ok(serialized.beforeMeshData);
    assert.ok(serialized.afterMeshData);

    // Revive through the command's own fromJSON, exactly the path History.fromJSON uses
    // after resolving the type via the command registry.
    const revived = RepairMeshCommand.fromJSON(editor, serialized);
    assert.ok(revived);
    assert.equal(revived.objectUuid, object.uuid);
    assert.equal(revived.repairReport.weldedVerts, 2);

    // The revived command still undoes to the original face ids.
    revived.undo();
    const originalIds = new Set([...raw.faces.keys()]);
    assert.deepEqual(new Set([...object.userData.meshData.faces.keys()]), originalIds);
  });
});
