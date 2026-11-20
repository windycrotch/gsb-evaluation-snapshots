import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { repairMeshData } from '../js/geometry/ManifoldRepair.js';
import {
  CUBE_FACES,
  cubeVertexPositions,
  makeCubeMeshData,
  makeRawMeshData,
  assertMeshDataConsistent,
  assertConsistentWinding,
  maxEdgeFaceCount,
} from './helpers.js';

test('clean closed cube passes through unchanged', () => {
  const cube = makeCubeMeshData();
  const repaired = repairMeshData(cube);
  const report = repaired.repairReport;

  assert.equal(report.weldedVerts, 0);
  assert.equal(report.removedFaces, 0);
  assert.equal(report.splitVerts, 0);
  assert.equal(report.flippedFaces, 0);
  assert.equal(report.filledHoles, 0);
  assert.equal(report.skippedHoles, 0);
  assert.deepEqual(report.warnings, []);

  assert.equal(repaired.faces.size, 6);
  assert.equal(repaired.vertices.size, 8);
  for (const id of cube.faces.keys()) {
    assert.ok(repaired.faces.has(id), `original face id ${id} preserved`);
  }
  assertMeshDataConsistent(repaired);
  assertConsistentWinding(repaired);
});

test('welds coincident vertices within tolerance', () => {
  const positions = [...cubeVertexPositions(), [-1 + 1e-7, -1, 1]]; // dup of corner 4
  const faces = CUBE_FACES.map(vids => [...vids]);
  faces[4] = faces[4].map(v => (v === 4 ? 8 : v)); // left face uses the duplicate

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  assert.ok(repaired.repairReport.weldedVerts >= 1, 'duplicate vertex welded');
  assert.equal(repaired.vertices.size, 8);
  assert.equal(repaired.faces.size, 6);
  assertMeshDataConsistent(repaired);
});

test('removes duplicate faces ignoring vertex order and winding', () => {
  const positions = cubeVertexPositions();
  // Extra copy of the bottom face [0,3,2,1], rotated and reversed.
  const faces = [...CUBE_FACES, [1, 2, 3, 0]];

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  assert.equal(repaired.repairReport.removedFaces, 1);
  assert.equal(repaired.faces.size, 6);
  assertMeshDataConsistent(repaired);
});

test('removes degenerate faces', () => {
  const positions = [...cubeVertexPositions(), [0, -1, -1]]; // midpoint of edge 0-1
  const faces = [
    ...CUBE_FACES,
    [0, 8, 1],   // zero-area collinear sliver
    [2, 3, 3],   // repeated vertex index
  ];

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  assert.equal(repaired.repairReport.removedFaces, 2);
  assert.equal(repaired.faces.size, 6);
  assertMeshDataConsistent(repaired);
});

test('resolves non-manifold edges down to at most two faces per edge', () => {
  const cube = makeCubeMeshData();
  const verts = [...cube.vertices.values()];
  // Extra fin face sharing edge 0-1 with the bottom and front faces.
  const tip = cube.addVertex(new THREE.Vector3(0, -2, -0.5));
  cube.addFace([verts[0], verts[1], tip]);

  assert.equal(maxEdgeFaceCount(cube), 3);

  const repaired = repairMeshData(cube);
  assert.ok(maxEdgeFaceCount(repaired) <= 2, 'no edge has more than two faces');
  assert.ok(repaired.repairReport.removedFaces >= 1, 'offending face removed');
  assert.ok(
    repaired.repairReport.warnings.some(w => w.includes('non-manifold edges')),
    'warning recorded',
  );
  assertMeshDataConsistent(repaired);
});

test('splits non-manifold vertices', () => {
  // Two cubes touching at exactly one shared corner vertex (cube A corner 7).
  const positions = [
    ...cubeVertexPositions({ center: [0, 0, 0] }),
    ...cubeVertexPositions({ center: [2, 2, 2] }).filter(
      p => !(p[0] === 1 && p[1] === 1 && p[2] === 1)
    ),
  ];
  // Cube B's vertex order matches CORNERS minus its (-1,-1,-1) corner, which is
  // replaced by cube A's corner 7 at (1,1,1).
  const bIndex = [7, 8, 9, 10, 11, 12, 13, 14];
  const faces = [
    ...CUBE_FACES,
    ...CUBE_FACES.map(vids => vids.map(v => bIndex[v])),
  ];

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  assert.ok(repaired.repairReport.splitVerts >= 1, 'shared corner vertex split');
  assertMeshDataConsistent(repaired);
});

test('unifies winding of inconsistently oriented faces', () => {
  const positions = cubeVertexPositions();
  const faces = CUBE_FACES.map(vids => [...vids]);
  faces[1].reverse(); // top face wound the wrong way

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  assert.ok(repaired.repairReport.flippedFaces >= 1, 'mis-wound face flipped');
  assertConsistentWinding(repaired);
  assertMeshDataConsistent(repaired);
});

test('fills holes and flags the new faces as repair faces with fresh ids', () => {
  const positions = cubeVertexPositions();
  const faces = CUBE_FACES.filter((_, i) => i !== 1); // missing top
  const openBox = makeRawMeshData(positions, faces);
  const originalIds = new Set(openBox.faces.keys());
  const maxOriginalId = Math.max(...originalIds);

  const repaired = repairMeshData(openBox);
  const report = repaired.repairReport;

  assert.equal(report.filledHoles, 1);
  assert.equal(report.skippedHoles, 0);

  const repairFaces = [...repaired.faces.values()].filter(f => f.isRepairFace);
  assert.ok(repairFaces.length >= 1, 'hole fill produced repair faces');
  for (const f of repairFaces) {
    assert.ok(!originalIds.has(f.id), `repair face id ${f.id} does not collide with an original id`);
    assert.ok(f.id > maxOriginalId, `repair face id ${f.id} allocated above original ids`);
  }

  for (const id of originalIds) {
    assert.ok(repaired.faces.has(id), `original face id ${id} preserved`);
    assert.ok(!repaired.faces.get(id).isRepairFace, `original face ${id} not flagged as repair`);
  }

  assertMeshDataConsistent(repaired);
  assertConsistentWinding(repaired);
});

test('skips holes over the edge limit and records a warning', () => {
  const positions = cubeVertexPositions();
  const faces = CUBE_FACES.filter((_, i) => i !== 1); // 4-edge hole on top
  const openBox = makeRawMeshData(positions, faces);

  const repaired = repairMeshData(openBox, { maxHoleFillEdges: 3 });
  const report = repaired.repairReport;

  assert.equal(report.filledHoles, 0);
  assert.equal(report.skippedHoles, 1);
  assert.ok(
    report.warnings.some(w => w.includes('Skipped hole')),
    'skip warning recorded',
  );
  assert.equal([...repaired.faces.values()].filter(f => f.isRepairFace).length, 0,
    'no repair faces created for a skipped hole');
  assertMeshDataConsistent(repaired);
});

test('dirty mesh with holes, duplicates and coincident vertices is fully repaired', () => {
  const positions = [...cubeVertexPositions(), [-1 + 1e-7, -1, 1]]; // dup of corner 4
  const faces = CUBE_FACES
    .filter((_, i) => i !== 1)           // hole on top
    .map(vids => [...vids]);
  faces[3] = faces[3].map(v => (v === 4 ? 8 : v)); // left face uses the duplicate vertex
  faces.push([1, 2, 3, 0]);              // duplicate of the bottom face, reversed
  faces[0].reverse();                    // bottom face wound the wrong way

  const repaired = repairMeshData(makeRawMeshData(positions, faces));
  const report = repaired.repairReport;

  assert.ok(report.weldedVerts >= 1, 'coincident vertex welded');
  assert.ok(report.removedFaces >= 1, 'duplicate face removed');
  assert.equal(report.filledHoles, 1, 'hole filled');
  assert.equal(report.skippedHoles, 0);

  assertMeshDataConsistent(repaired);
  assertConsistentWinding(repaired);
});
