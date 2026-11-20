import test from 'node:test';
import assert from 'node:assert/strict';

import { MeshData } from '../js/core/MeshData.js';
import { toManifold } from '../js/geometry/MeshDataManifold.js';
import { UnionOps } from '../js/operations/UnionOps.js';
import { DifferenceOps } from '../js/operations/DifferenceOps.js';
import { IntersectOps } from '../js/operations/IntersectOps.js';
import {
  CUBE_FACES,
  cubeVertexPositions,
  makeCubeMeshData,
  makeRawMeshData,
  makeObject,
  assertMeshDataConsistent,
} from './helpers.js';

// Open box (missing top) with a duplicated bottom face: cannot become a
// manifold without repair.
function makeDirtyOpenBox() {
  const positions = cubeVertexPositions();
  const faces = CUBE_FACES.filter((_, i) => i !== 1).map(vids => [...vids]);
  faces.push([1, 2, 3, 0]); // duplicate of the bottom face, reversed
  return makeRawMeshData(positions, faces);
}

test('toManifold repairs a dirty mesh and flags repair faces in the face id map', async () => {
  const object = makeObject(makeDirtyOpenBox());

  const { manifold, faceIdMap, nextFaceId } = await toManifold(object, 0);
  try {
    assert.equal(manifold.status(), 'NoError');
  } finally {
    manifold.delete();
  }

  const repairEntries = [...faceIdMap.values()].filter(v => v === 'repair');
  assert.ok(repairEntries.length >= 1, 'hole-fill faces flagged as repair');
  assert.ok(nextFaceId > Math.max(...object.userData.meshData.faces.keys()),
    'nextFaceId accounts for repair faces');
});

test('toManifold throws when a mesh cannot be repaired into a manifold', async () => {
  // A single triangle: the hole fill can only recreate the same face, which
  // collapses during rebuild, leaving the mesh open and non-manifold.
  const broken = makeRawMeshData(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[0, 1, 2]],
  );
  await assert.rejects(() => toManifold(makeObject(broken), 0));
});

test('union of two clean cubes succeeds and restores boundary faces', async () => {
  const primary = makeObject(makeCubeMeshData());
  const secondary = makeObject(makeCubeMeshData({ center: [1, 0, 0] }));

  const result = await UnionOps.computeUnion(primary, secondary);
  assert.ok(result instanceof MeshData);
  assert.ok(result.faces.size > 6, 'overlapping union produces split faces');
  assertMeshDataConsistent(result);

  // Face restoration: triangles from one source face are stitched back into
  // polygons, so at least one result face has more than 3 vertices.
  assert.ok([...result.faces.values()].some(f => f.vertexIds.length > 3),
    'boundary loops restored as polygonal faces');
});

test('union with a dirty primary repairs first and excludes repair faces from restoration', async () => {
  const primary = makeObject(makeDirtyOpenBox());
  const secondary = makeObject(makeCubeMeshData({ size: 1, center: [10, 0, 0] }));

  const result = await UnionOps.computeUnion(primary, secondary);
  assertMeshDataConsistent(result);

  // Disjoint union: 5 original box quads + 6 cube quads. The hole-fill cap
  // triangles are flagged 'repair' and must not be restored as faces.
  assert.equal(result.faces.size, 11);
  for (const face of result.faces.values()) {
    assert.equal(face.vertexIds.length, 4, 'original quads restored as quads');
  }
});

test('difference with a dirty secondary repairs first', async () => {
  const primary = makeObject(makeCubeMeshData({ size: 4 }));
  const secondary = makeObject(makeDirtyOpenBox());

  const result = await DifferenceOps.computeDifference(primary, secondary);
  assert.ok(result.faces.size > 0);
  assertMeshDataConsistent(result);
});

test('intersection with a dirty primary repairs first', async () => {
  const primary = makeObject(makeDirtyOpenBox());
  const secondary = makeObject(makeCubeMeshData({ size: 4 }));

  const result = await IntersectOps.computeIntersection(primary, secondary);
  assert.ok(result.faces.size > 0);
  assertMeshDataConsistent(result);
});

test('boolean result survives the undo serialization roundtrip', async () => {
  const primary = makeObject(makeCubeMeshData());
  const secondary = makeObject(makeCubeMeshData({ center: [1, 0, 0] }));

  const result = await UnionOps.computeUnion(primary, secondary);

  // Commands store mesh data via structuredClone and JSON serialization.
  const cloned = MeshData.getRehydratedMeshData(structuredClone(result));
  assertMeshDataConsistent(cloned);

  const rehydrated = MeshData.getRehydratedMeshData(
    JSON.parse(JSON.stringify(result.toJSON()))
  );
  assertMeshDataConsistent(rehydrated);
  assert.equal(rehydrated.faces.size, result.faces.size);
});
