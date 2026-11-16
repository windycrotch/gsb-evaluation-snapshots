import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { UnionOps } from '../js/operations/UnionOps.js';
import { DifferenceOps } from '../js/operations/DifferenceOps.js';
import { repairMeshData } from '../js/geometry/ManifoldRepair.js';
import { ManifoldRepairError } from '../js/geometry/MeshDataManifold.js';
import { makeHeadlessEditor, makeHeadlessObject, register } from './helpers/headlessEditor.js';
import { makeBrokenOpenCube, makeUnrepairableOpenMesh, makeAllDegenerateMesh } from './helpers/meshSamples.js';

function faceIdSet(object) {
  return new Set([...object.userData.meshData.faces.keys()]);
}

// A clean, closed solid cube mesh to use as a well-formed boolean operand.
function closedCubeMesh() {
  return repairMeshData(makeBrokenOpenCube());
}

function makeOperand(editor, name, meshData, offset) {
  const object = makeHeadlessObject(meshData, name);
  if (offset) object.position.copy(offset);
  object.updateMatrixWorld(true);
  return register(editor, object);
}

describe('boolean + repair integration — sample A: broken open cube is repaired and undoable', () => {
  test('union repairs the broken primary, succeeds, and the whole step undoes to the original mesh', async () => {
    const editor = makeHeadlessEditor();

    const primaryRaw = makeBrokenOpenCube();
    const primary = makeOperand(editor, 'primary', primaryRaw);
    const originalFaceIds = faceIdSet(primary);
    const originalVerts = primary.userData.meshData.vertices.size;

    const secondary = makeOperand(editor, 'secondary', closedCubeMesh(), new THREE.Vector3(0.4, 0.4, 0.4));

    const computed = await UnionOps.computeUnion(primary, secondary);
    assert.ok(computed.repairs.length >= 1, 'a repair descriptor is produced');
    const repair = computed.repairs.find((r) => r.objectUuid === primary.uuid);
    assert.ok(repair, 'the primary was repaired');
    assert.equal(repair.report.weldedVerts, 2);
    assert.ok(repair.report.repairFaceIds.length >= 1);
    assert.ok(computed.resultMeshData.faces.size > 0);

    // Commit as one undoable composite command.
    editor.execute(
      UnionOps.createCommand(editor, primary, secondary, computed.beforeMeshData, computed.resultMeshData, computed.repairs)
    );

    // Secondary removed by the boolean.
    assert.equal(editor.objectByUuid(secondary.uuid), null);

    // Primary now holds the boolean result; the composite contains a RepairMeshCommand.
    const top = editor.history.undos[0];
    const commandTypes = top.commands.map((c) => c.constructor.type);
    assert.ok(commandTypes.includes('RepairMeshCommand'), 'repair is part of the undoable step');
    assert.ok(commandTypes.includes('UnionCommand'));
    assert.ok(commandTypes.includes('RemoveObjectCommand'));

    // Undo the entire step: secondary returns, primary is restored to its ORIGINAL raw mesh
    // (original face ids, original vertex count — before any welding/filling).
    editor.undo();
    assert.ok(editor.objectByUuid(secondary.uuid), 'secondary restored on undo');
    assert.deepEqual(faceIdSet(primary), originalFaceIds, 'original face ids restored after undo');
    assert.equal(primary.userData.meshData.vertices.size, originalVerts, 'original vertex count restored');
    assert.ok(
      [...primary.userData.meshData.faces.values()].every((f) => !f.isRepairFace),
      'no repair markers remain after undo',
    );

    // Redo: back to the post-boolean repaired result; secondary removed again.
    editor.redo();
    assert.equal(editor.objectByUuid(secondary.uuid), null);
    const live = primary.userData.meshData;
    assert.ok(live.faces.size > 0);
  });

  test('repair report is embedded in the history command and remains queryable after redo', async () => {
    const editor = makeHeadlessEditor();
    const primary = makeOperand(editor, 'primary', makeBrokenOpenCube());
    const secondary = makeOperand(editor, 'secondary', closedCubeMesh(), new THREE.Vector3(0.2, 0.2, 0.2));

    const computed = await UnionOps.computeUnion(primary, secondary);
    editor.execute(
      UnionOps.createCommand(editor, primary, secondary, computed.beforeMeshData, computed.resultMeshData, computed.repairs)
    );

    const repairCmd = editor.history.undos[0].commands.find((c) => c.constructor.type === 'RepairMeshCommand');
    assert.ok(repairCmd.repairReport);
    for (const key of ['weldedVerts', 'removedFaces', 'splitVerts', 'flippedFaces', 'filledHoles', 'skippedHoles', 'warnings', 'repairFaceIds']) {
      assert.ok(key in repairCmd.repairReport, `report.${key} stored on the command`);
    }
    assert.ok(repairCmd.repairReport.repairFaceIds.length >= 1);

    // Serialized history carries the report too.
    const json = editor.history.toJSON();
    const serializedRepair = json.undos[0].commands.find((c) => c.type === 'RepairMeshCommand');
    assert.ok(serializedRepair.repairReport);
    assert.equal(serializedRepair.repairReport.weldedVerts, 2);
  });
});

describe('boolean + repair integration — sample C: still non-manifold after repair errors honestly', () => {
  test('union throws ManifoldRepairError (never an empty result) when repair cannot close the mesh', async () => {
    const editor = makeHeadlessEditor();
    const primary = makeOperand(editor, 'openPrimary', makeUnrepairableOpenMesh(140));
    const secondary = makeOperand(editor, 'secondary', closedCubeMesh(), new THREE.Vector3(0.2, 0.2, 0.2));

    await assert.rejects(
      () => UnionOps.computeUnion(primary, secondary),
      (err) => {
        assert.ok(err instanceof ManifoldRepairError, `expected ManifoldRepairError, got ${err?.name}`);
        assert.ok(Array.isArray(err.reasons) && err.reasons.length > 0);
        assert.ok(err.reasons.some((r) => r.includes('boundary edge')));
        assert.ok(err.report, 'the attempted repair report is attached for inspection');
        return true;
      },
    );

    // Nothing was committed to history and the scene meshes were left untouched.
    assert.equal(editor.history.undos.length, 0);
    assert.ok(primary.userData.meshData.faces.size > 0, 'original non-empty mesh preserved');
    assert.ok(editor.objectByUuid(secondary.uuid), 'operand untouched after failure');
  });

  test('all-degenerate mesh fails with ManifoldRepairError rather than a silent empty manifold', async () => {
    const editor = makeHeadlessEditor();
    const primary = makeOperand(editor, 'degeneratePrimary', makeAllDegenerateMesh());
    const secondary = makeOperand(editor, 'secondary', closedCubeMesh());

    await assert.rejects(
      () => DifferenceOps.computeDifference(primary, secondary),
      (err) => {
        assert.ok(err instanceof ManifoldRepairError);
        assert.ok(err.reasons.some((r) => r.includes('no faces')));
        return true;
      },
    );
    assert.equal(editor.history.undos.length, 0);
  });

  test('difference on a repairable broken primary also folds the repair into one undoable step', async () => {
    const editor = makeHeadlessEditor();
    const primaryRaw = makeBrokenOpenCube();
    const primary = makeOperand(editor, 'diffPrimary', primaryRaw);
    const originalFaceIds = faceIdSet(primary);
    // Small cutter fully inside the cube so the difference leaves a valid shell.
    const cutter = makeOperand(editor, 'cutter', closedCubeMesh(), new THREE.Vector3(0.25, 0.25, 0.25));

    const computed = await DifferenceOps.computeDifference(primary, cutter);
    assert.ok(computed.repairs.some((r) => r.objectUuid === primary.uuid), 'primary repaired before difference');

    editor.execute(
      DifferenceOps.createCommand(editor, primary, cutter, computed.beforeMeshData, computed.resultMeshData, computed.repairs),
    );
    const types = editor.history.undos[0].commands.map((c) => c.constructor.type);
    assert.ok(types.includes('RepairMeshCommand'));
    assert.ok(types.includes('DifferenceCommand'));

    editor.undo();
    assert.deepEqual(faceIdSet(primary), originalFaceIds, 'difference undo restores original face ids');
    assert.ok(editor.objectByUuid(cutter.uuid), 'cutter restored on undo');
  });
});
