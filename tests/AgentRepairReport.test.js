import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RepairMeshCommand } from '../js/commands/RepairMeshCommand.js';
import { repairMeshData } from '../js/geometry/ManifoldRepair.js';
import { meshRepairReportSpec } from '../js/agent/commands/AgentMeshRepairReport.js';
import { meshInspectSpec } from '../js/agent/commands/AgentMeshInspect.js';
import { makeHeadlessEditor, makeHeadlessObject, register } from './helpers/headlessEditor.js';
import { makeBrokenOpenCube } from './helpers/meshSamples.js';

describe('agent mesh.repairReport — querying the observable repair', () => {
  test('returns null-ish repaired=false when no repair ever ran', () => {
    const editor = makeHeadlessEditor();
    const object = register(editor, makeHeadlessObject(makeBrokenOpenCube(), 'fresh'));
    const result = meshRepairReportSpec.run({ target: object.uuid }, editor);
    assert.equal(result.repaired, false);
    assert.equal(result.latestReport, null);
    assert.deepEqual(result.markedRepairFaceIds, []);
    assert.deepEqual(result.history, []);
  });

  test('after a RepairMeshCommand: exposes counts, warnings, repair face ids and history entry', () => {
    const editor = makeHeadlessEditor();
    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'repaired'));
    const repaired = repairMeshData(raw);

    editor.execute(new RepairMeshCommand(editor, object, raw, repaired, repaired.repairReport));

    const result = meshRepairReportSpec.run({ target: object.uuid }, editor);
    assert.equal(result.repaired, true);
    assert.ok(result.latestReport);
    assert.equal(result.latestReport.weldedVerts, 2);
    assert.ok(result.latestReport.filledHoles >= 1);

    // Marked faces on the live mesh match the report's repair face ids.
    assert.deepEqual(
      [...result.markedRepairFaceIds].sort((a, b) => a - b),
      [...repaired.repairReport.repairFaceIds].sort((a, b) => a - b),
    );

    // The history scan finds the command on the undo stack with its full report.
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].state, 'undo');
    assert.equal(result.history[0].report.weldedVerts, 2);
  });

  test('the history entry moves to the redo stack after undo', () => {
    const editor = makeHeadlessEditor();
    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'undoable'));
    const repaired = repairMeshData(raw);
    editor.execute(new RepairMeshCommand(editor, object, raw, repaired, repaired.repairReport));
    editor.undo();

    const result = meshRepairReportSpec.run({ target: object.uuid }, editor);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].state, 'redo');
  });
});

describe('agent mesh.inspect — repair include + face marker', () => {
  test('repair include lists repair face ids; face tuples carry the isRepairFace flag', () => {
    const editor = makeHeadlessEditor();
    const raw = makeBrokenOpenCube();
    const object = register(editor, makeHeadlessObject(raw, 'inspected'));
    const repaired = repairMeshData(raw);
    editor.execute(new RepairMeshCommand(editor, object, raw, repaired, repaired.repairReport));

    const baseParams = {
      target: object.uuid,
      space: 'local',
      selected: false,
      grow: 0,
      offset: 0,
      limit: 500,
      precision: 4,
    };

    const repairView = meshInspectSpec.run(
      { ...baseParams, include: ['repair'] },
      editor,
    );
    assert.ok(repairView.repair);
    assert.ok(repairView.repair.repairFaceIds.length >= 1);
    assert.ok(repairView.repair.lastReport);

    const faceView = meshInspectSpec.run(
      { ...baseParams, include: ['faces'] },
      editor,
    );
    const flagged = faceView.faces.items.filter((tuple) => tuple[4] === 1).map((t) => t[0]);
    assert.deepEqual(
      [...flagged].sort((a, b) => a - b),
      [...repaired.repairReport.repairFaceIds].sort((a, b) => a - b),
    );
    // Every non-repair face tuple carries flag 0.
    assert.ok(faceView.faces.items.every((t) => t[4] === 0 || t[4] === 1));
  });
});
