import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBrokenOpenCube,
  makeLargeHoleTube,
  makeUnrepairableOpenMesh,
  makePinchedTetrahedra,
  makeAllDegenerateMesh,
  makeCubeMeshData,
} from './helpers/meshSamples.js';
import { repairMeshData, validateManifoldTopology } from '../js/geometry/ManifoldRepair.js';
import { MeshData } from '../js/core/MeshData.js';

describe('repairMeshData — sample A: broken open cube (2 coincident verts + degenerate tri)', () => {
  test('welds, removes the degenerate face, fills the open hole and becomes manifold', () => {
    const broken = makeBrokenOpenCube();
    const beforeVerts = broken.vertices.size;
    const beforeFaces = broken.faces.size;
    const originalFaceIds = [...broken.faces.keys()];

    const repaired = repairMeshData(broken);
    const report = repaired.repairReport;

    assert.equal(report.weldedVerts, 2, 'weldedVerts should be 2');
    assert.ok(repaired.vertices.size < beforeVerts, 'vertex count shrinks after weld');

    assert.ok(report.removedFaces >= 1, 'the degenerate triangle is removed');
    assert.ok(repaired.faces.size <= beforeFaces, 'removed degenerate/duplicate faces, no runaway growth');

    assert.ok(report.filledHoles >= 1, 'the open cube hole is filled');
    assert.equal(report.skippedHoles, 0);

    // Surviving original faces keep their exact original ids.
    for (const face of repaired.faces.values()) {
      if (!face.isRepairFace) {
        assert.ok(originalFaceIds.includes(face.id), `original face id ${face.id} preserved`);
      }
    }

    // Repair-added faces get ids above every original id and carry the marker.
    const maxOriginal = Math.max(...originalFaceIds);
    for (const id of report.repairFaceIds) {
      assert.ok(id > maxOriginal, `repair face id ${id} must exceed max original id ${maxOriginal}`);
      assert.equal(repaired.faces.get(id).isRepairFace, true);
    }
    const liveRepairIds = [...repaired.faces.values()]
      .filter((f) => f.isRepairFace).map((f) => f.id).sort((a, b) => a - b);
    assert.deepEqual([...report.repairFaceIds].sort((a, b) => a - b), liveRepairIds);

    // Unique face ids and consistent counters.
    assert.equal(new Set([...repaired.faces.keys()]).size, repaired.faces.size);
    assert.ok(repaired.nextFaceId > Math.max(...repaired.faces.keys()));

    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, true, `repaired cube should be manifold, got: ${check.reasons.join('; ')}`);
  });

  test('report contains every required field', () => {
    const report = repairMeshData(makeBrokenOpenCube()).repairReport;
    for (const key of [
      'weldedVerts', 'removedFaces', 'splitVerts', 'flippedFaces',
      'filledHoles', 'skippedHoles', 'warnings', 'repairFaceIds', 'originalFaceIds',
    ]) {
      assert.ok(key in report, `report.${key} present`);
    }
    assert.ok(Array.isArray(report.warnings));
    assert.ok(Array.isArray(report.repairFaceIds));
  });

  test('does not mutate the input mesh', () => {
    const broken = makeBrokenOpenCube();
    const vertCount = broken.vertices.size;
    const faceCount = broken.faces.size;
    repairMeshData(broken);
    assert.equal(broken.vertices.size, vertCount);
    assert.equal(broken.faces.size, faceCount);
  });

  test('repair marker survives the history save/rehydrate round-trip', () => {
    const repaired = repairMeshData(makeBrokenOpenCube());
    const marked = [...repaired.faces.values()].filter((f) => f.isRepairFace);
    assert.ok(marked.length >= 1);

    // History/persistence serializes via toJSON and revives via getRehydratedMeshData.
    const json = repaired.toJSON();
    const revived = MeshData.getRehydratedMeshData(json);

    for (const face of marked) {
      const revivedFace = revived.faces.get(face.id);
      assert.ok(revivedFace, `repair face ${face.id} present after rehydrate`);
      assert.equal(revivedFace.isRepairFace, true);
    }

    // structuredClone (used by MeshDataCommand snapshots) keeps Map entries too.
    const cloned = structuredClone(repaired);
    for (const face of marked) {
      assert.equal(cloned.faces.get(face.id).isRepairFace, true);
    }
  });
});

describe('repairMeshData — sample B: large hole over the edge limit', () => {
  test('skips filling and records warnings with the boundary edge count', () => {
    const limit = 128;
    const repaired = repairMeshData(makeLargeHoleTube(140), { maxHoleFillEdges: limit });
    const report = repaired.repairReport;

    assert.equal(report.filledHoles, 0, 'no hole filled');
    assert.equal(report.skippedHoles, 2, 'both oversized boundary loops skipped');

    const warnings = report.warnings.filter((w) => w.includes('Skipped hole'));
    assert.equal(warnings.length, 2);
    for (const w of warnings) {
      assert.ok(w.includes('140 boundary edges'));
      assert.ok(w.includes(`limit: ${limit}`));
    }
    assert.deepEqual(report.repairFaceIds, []);

    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, false);
    assert.ok(check.reasons.some((r) => r.includes('boundary edge')));
  });

  test('same topology fills fully once the limit covers its loops', () => {
    const repaired = repairMeshData(makeLargeHoleTube(20), { maxHoleFillEdges: 128 });
    assert.equal(repaired.repairReport.skippedHoles, 0);
    assert.equal(repaired.repairReport.filledHoles, 2);
    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, true, check.reasons.join('; '));
  });
});

describe('repairMeshData — sample C: still non-manifold after repair', () => {
  test('repair runs but cannot close oversized holes; validator reports it instead of faking success', () => {
    const repaired = repairMeshData(makeUnrepairableOpenMesh(140), { maxHoleFillEdges: 128 });
    const report = repaired.repairReport;

    // Repair did run and cleaned the degenerate face.
    assert.ok(report.removedFaces >= 1, 'degenerate face removed');
    assert.equal(report.skippedHoles, 2, 'both un-closeable holes skipped with warnings');
    assert.ok(report.warnings.some((w) => w.includes('Skipped hole')));

    // But the mesh remains open and therefore not a valid manifold.
    assert.ok(repaired.faces.size > 0, 'it is NOT an empty mesh — real faces remain');
    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, false);
    assert.ok(check.reasons.some((r) => r.includes('boundary edge')));
  });

  test('pinched tetrahedra: vertex split produces two valid closed components', () => {
    const repaired = repairMeshData(makePinchedTetrahedra());
    assert.ok(repaired.repairReport.splitVerts >= 1, 'pinch vertex split');
    assert.ok(repaired.faces.size > 0);
    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, true, check.reasons.join('; '));
  });

  test('all-degenerate input: empty result carries a warning and fails validation, never silent success', () => {
    const repaired = repairMeshData(makeAllDegenerateMesh());
    assert.equal(repaired.faces.size, 0);
    assert.ok(repaired.repairReport.removedFaces >= 2);
    assert.ok(repaired.repairReport.warnings.some((w) => w.includes('no faces')));

    const check = validateManifoldTopology(repaired);
    assert.equal(check.valid, false);
    assert.ok(check.reasons.some((r) => r.includes('no faces')));
  });
});

describe('validateManifoldTopology', () => {
  test('accepts a clean closed cube', () => {
    const { meshData } = makeCubeMeshData();
    assert.equal(validateManifoldTopology(meshData).valid, true);
  });

  test('accepts a fully repaired cube', () => {
    const closed = repairMeshData(makeBrokenOpenCube());
    assert.equal(validateManifoldTopology(closed).valid, true);
  });

  test('rejects an empty mesh', () => {
    const check = validateManifoldTopology(new MeshData());
    assert.equal(check.valid, false);
    assert.ok(check.reasons.some((r) => r.includes('no faces')));
  });
});
