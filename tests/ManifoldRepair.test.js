import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repairMeshData, analyzeMeshData } from '../js/geometry/ManifoldRepair.js';
import {
  openCube,
  closedCube,
  cubeWithDuplicateFace,
  flippedFaceCube,
  nonManifoldEdgeMesh,
  brokenImportMesh,
  CUBE_FACES,
} from './helpers/brokenMeshes.js';
import {
  faceNormal,
  boundaryEdgeCount,
  nonManifoldEdgeCount,
  assertNoDanglingRefs,
  assertReportConsistent,
} from './helpers/meshAssertions.js';

test('analyze: detects holes, duplicates, non-manifold edges; clean mesh passes', () => {
  assert.equal(analyzeMeshData(openCube()).needsRepair, true);
  assert.equal(analyzeMeshData(openCube()).boundaryEdges, 4);
  assert.equal(analyzeMeshData(cubeWithDuplicateFace()).duplicateFaces, 1);
  assert.equal(analyzeMeshData(nonManifoldEdgeMesh()).nonManifoldEdges, 1);
  assert.equal(analyzeMeshData(closedCube()).needsRepair, false);

  const broken = analyzeMeshData(brokenImportMesh());
  assert.equal(broken.needsRepair, true);
  assert.ok(broken.boundaryEdges > 0);
  assert.equal(broken.duplicateFaces, 1);
  // The duplicated bottom face doubles all 4 of its edges.
  assert.equal(broken.nonManifoldEdges, 4);
});

test('normal repair: hole is filled, new face ids are stable and collision-free', () => {
  const input = openCube();
  const inputFaceIds = [...input.faces.keys()];
  const result = repairMeshData(input);

  // Hole filled: closed mesh; the 4-edge hole is triangulated into 2 faces.
  assert.equal(result.faces.size, 7);
  assert.equal(boundaryEdgeCount(result), 0);
  assert.equal(nonManifoldEdgeCount(result), 0);

  // Every original face survived with its original id.
  for (const id of inputFaceIds) assert.ok(result.faces.has(id), `original face ${id} kept`);

  // The new repair faces all have ids above every original id.
  const repairFaces = [...result.faces.values()].filter(f => f.isRepairFace);
  assert.equal(repairFaces.length, 2);
  for (const f of repairFaces) {
    assert.ok(inputFaceIds.every(id => f.id > id), 'repair id does not collide with originals');
    assert.ok(!input.faces.has(f.id));
  }

  // Id counter is synced: future faces cannot collide with preserved ids.
  const maxId = Math.max(...result.faces.keys());
  assert.ok(result.nextFaceId > maxId);

  // No dangling references anywhere.
  assert.deepEqual(assertNoDanglingRefs(result), []);

  // Report reconciles with the actual mesh changes.
  assert.deepEqual(assertReportConsistent(result.repairReport, input, result), []);
  assert.equal(result.repairReport.filledHoles, 1);
  assert.equal(result.repairReport.addedFaces, 2);

  // Input untouched (repair is atomic/pure).
  assert.equal(input.faces.size, 5);
});

test('normal repair: orientation is preserved, no global flip', () => {
  const input = openCube();
  const beforeNormals = new Map();
  for (const [id, face] of input.faces) beforeNormals.set(id, faceNormal(input, face));

  const result = repairMeshData(input);

  for (const [id, before] of beforeNormals) {
    const after = faceNormal(result, result.faces.get(id));
    assert.ok(after.dot(before) > 0.99, `face ${id} kept its orientation`);
  }

  // The fill faces point outward (+z), consistent with their neighbours.
  const fills = [...result.faces.values()].filter(f => f.isRepairFace);
  assert.ok(fills.length > 0);
  for (const fill of fills) {
    const fillNormal = faceNormal(result, fill);
    assert.ok(fillNormal.z > 0.99, `fill normal ${fillNormal.toArray()} should be +z`);
  }
});

test('normal repair: flipped face is fixed without flipping the correct ones', () => {
  const input = flippedFaceCube();
  const topId = 1; // faces were created in CUBE_FACES order, top is index 1
  const before = new Map();
  for (const [id, face] of input.faces) before.set(id, faceNormal(input, face));

  const result = repairMeshData(input);

  assert.equal(result.repairReport.flippedFaces, 1);

  for (const [id, face] of result.faces) {
    const n = faceNormal(result, face);
    if (id === topId) {
      assert.ok(n.z > 0.99, 'flipped top face now points outward');
    } else {
      assert.ok(n.dot(before.get(id)) > 0.99, `face ${id} was not flipped`);
    }
  }
  assert.deepEqual(assertReportConsistent(result.repairReport, input, result), []);
});

test('normal repair: duplicate faces and non-manifold edges are resolved', () => {
  const dup = cubeWithDuplicateFace();
  const r1 = repairMeshData(dup);
  assert.equal(r1.faces.size, 6);
  assert.equal(r1.repairReport.removedFaces, 1);
  assert.deepEqual(assertNoDanglingRefs(r1), []);
  assert.deepEqual(assertReportConsistent(r1.repairReport, dup, r1), []);

  const nm = nonManifoldEdgeMesh();
  const r2 = repairMeshData(nm);
  assert.equal(nonManifoldEdgeCount(r2), 0);
  assert.ok(r2.repairReport.removedFaces >= 1);
  assert.deepEqual(assertNoDanglingRefs(r2), []);
  assert.deepEqual(assertReportConsistent(r2.repairReport, nm, r2), []);
});

test('normal repair: combined broken import becomes closed and consistent', () => {
  const input = brokenImportMesh();
  const result = repairMeshData(input);

  assert.equal(boundaryEdgeCount(result), 0);
  assert.equal(nonManifoldEdgeCount(result), 0);
  assert.deepEqual(assertNoDanglingRefs(result), []);

  // Repair face ids are all above every original id and unique.
  const maxOriginalId = Math.max(...input.faces.keys());
  for (const [id, face] of result.faces) {
    if (face.isRepairFace) assert.ok(id > maxOriginalId);
  }
  assert.equal(new Set(result.faces.keys()).size, result.faces.size);

  assert.deepEqual(assertReportConsistent(result.repairReport, input, result), []);
});

test('repeated trigger: repairing a repaired mesh is an idempotent no-op', () => {
  const input = brokenImportMesh();

  const once = repairMeshData(input);
  assert.equal(analyzeMeshData(once).needsRepair, false, 'repaired mesh is clean');

  const twice = repairMeshData(once);

  // Same faces, same ids, same vertices — nothing changed.
  assert.deepEqual([...twice.faces.keys()].sort((a, b) => a - b), [...once.faces.keys()].sort((a, b) => a - b));
  assert.deepEqual([...twice.vertices.keys()].sort((a, b) => a - b), [...once.vertices.keys()].sort((a, b) => a - b));
  for (const [id, face] of twice.faces) {
    assert.deepEqual(face.vertexIds, once.faces.get(id).vertexIds);
  }

  const r = twice.repairReport;
  assert.equal(r.weldedVerts, 0);
  assert.equal(r.removedFaces, 0);
  assert.equal(r.splitVerts, 0);
  assert.equal(r.flippedFaces, 0);
  assert.equal(r.filledHoles, 0);
  assert.equal(r.addedFaces, 0);
  assert.deepEqual(assertReportConsistent(r, once, twice), []);
});

test('repair preserves UVs of surviving original faces', () => {
  const input = openCube();
  input.uvs.set(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  input.uvs.set(2, [[0, 0], [1, 0], [1, 1], [0, 1]]);

  const result = repairMeshData(input);
  assert.deepEqual(result.uvs.get(0), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.deepEqual(result.uvs.get(2), [[0, 0], [1, 0], [1, 1], [0, 1]]);
});
