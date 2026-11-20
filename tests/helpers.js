import * as THREE from 'three';
import assert from 'node:assert/strict';
import { MeshData } from '../js/core/MeshData.js';

// Corner offsets of an axis-aligned cube, shared by the builders below.
const CORNERS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

// Outward-wound quad faces over CORNERS: bottom, top, front, back, left, right.
export const CUBE_FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
];

export function cubeVertexPositions({ size = 2, center = [0, 0, 0] } = {}) {
  const h = size / 2;
  return CORNERS.map(([x, y, z]) => [
    center[0] + x * h,
    center[1] + y * h,
    center[2] + z * h,
  ]);
}

// Builds a MeshData directly from raw positions / vertex-index faces, bypassing
// addFace so genuinely dirty inputs (duplicate faces, non-manifold edges, ...)
// can be constructed. Edges and association sets are left empty on purpose:
// the repair pipeline only reads vertices and face vertex ids.
export function makeRawMeshData(positions, facesVids) {
  const raw = {
    vertices: positions.map((p, i) => [i, {
      id: i,
      position: { x: p[0], y: p[1], z: p[2] },
      edgeIds: [],
      faceIds: [],
    }]),
    edges: [],
    faces: facesVids.map((vids, i) => [i, {
      id: i,
      vertexIds: [...vids],
      edgeIds: [],
    }]),
    uvs: [],
    nextVertexId: positions.length,
    nextEdgeId: 0,
    nextFaceId: facesVids.length,
  };
  return MeshData.getRehydratedMeshData(raw);
}

export function makeCubeMeshData({ size = 2, center = [0, 0, 0], skipFaces = [] } = {}) {
  const meshData = new MeshData();
  const verts = cubeVertexPositions({ size, center }).map(p =>
    meshData.addVertex(new THREE.Vector3(p[0], p[1], p[2]))
  );
  for (let i = 0; i < CUBE_FACES.length; i++) {
    if (skipFaces.includes(i)) continue;
    meshData.addFace(CUBE_FACES[i].map(vi => verts[vi]));
  }
  return meshData;
}

// Minimal stand-in for a scene object as used by the boolean ops.
export function makeObject(meshData) {
  return {
    matrixWorld: new THREE.Matrix4(),
    userData: { meshData },
  };
}

// Asserts the vertex/edge/face association sets, the key indexes and the id
// counters of a MeshData are all mutually consistent.
export function assertMeshDataConsistent(meshData) {
  // Vertices
  for (const [id, v] of meshData.vertices) {
    assert.equal(v.id, id, `vertex map key matches id (${id})`);
    for (const edgeId of v.edgeIds) {
      const e = meshData.edges.get(edgeId);
      assert.ok(e, `vertex ${id} references existing edge ${edgeId}`);
      assert.ok(e.v1Id === id || e.v2Id === id, `edge ${edgeId} incident to vertex ${id}`);
    }
    for (const faceId of v.faceIds) {
      const f = meshData.faces.get(faceId);
      assert.ok(f, `vertex ${id} references existing face ${faceId}`);
      assert.ok(f.vertexIds.includes(id), `face ${faceId} contains vertex ${id}`);
    }
  }

  // Edges
  for (const [id, e] of meshData.edges) {
    assert.equal(e.id, id, `edge map key matches id (${id})`);
    assert.equal(meshData.edgeKeyMap.get(meshData._getEdgeKey(e.v1Id, e.v2Id)), e,
      `edgeKeyMap resolves edge ${id}`);
    assert.ok(meshData.vertices.has(e.v1Id), `edge ${id} v1 exists`);
    assert.ok(meshData.vertices.has(e.v2Id), `edge ${id} v2 exists`);
    assert.ok(meshData.vertices.get(e.v1Id).edgeIds.has(id), `v1 back-references edge ${id}`);
    assert.ok(meshData.vertices.get(e.v2Id).edgeIds.has(id), `v2 back-references edge ${id}`);
    for (const faceId of e.faceIds) {
      const f = meshData.faces.get(faceId);
      assert.ok(f, `edge ${id} references existing face ${faceId}`);
      assert.ok(f.edgeIds.has(id), `face ${faceId} back-references edge ${id}`);
    }
  }

  // Faces
  for (const [id, f] of meshData.faces) {
    assert.equal(f.id, id, `face map key matches id (${id})`);
    assert.equal(meshData.faceKeyMap.get(meshData._getFaceKey(f.vertexIds)), f,
      `faceKeyMap resolves face ${id}`);
    assert.ok(f.vertexIds.length >= 3, `face ${id} has at least 3 vertices`);
    assert.equal(new Set(f.vertexIds).size, f.vertexIds.length, `face ${id} has no repeated vertices`);
    for (let i = 0; i < f.vertexIds.length; i++) {
      const v1 = f.vertexIds[i];
      const v2 = f.vertexIds[(i + 1) % f.vertexIds.length];
      const e = meshData.getEdge(v1, v2);
      assert.ok(e, `face ${id} boundary edge ${v1}-${v2} exists`);
      assert.ok(e.faceIds.has(id), `edge ${e.id} back-references face ${id}`);
      assert.ok(f.edgeIds.has(e.id), `face ${id} lists edge ${e.id}`);
      assert.ok(meshData.vertices.get(v1).faceIds.has(id), `vertex ${v1} back-references face ${id}`);
    }
    assert.equal(f.edgeIds.size, f.vertexIds.length, `face ${id} edge count matches vertex count`);
  }

  // Index maps contain nothing stale
  assert.equal(meshData.edgeKeyMap.size, meshData.edges.size, 'edgeKeyMap has no stale entries');
  assert.equal(meshData.faceKeyMap.size, meshData.faces.size, 'faceKeyMap has no stale entries');

  // Id counters are ahead of every id in use
  const maxId = (map) => Math.max(-1, ...map.keys());
  assert.ok(meshData.nextVertexId > maxId(meshData.vertices), 'nextVertexId ahead of vertices');
  assert.ok(meshData.nextEdgeId > maxId(meshData.edges), 'nextEdgeId ahead of edges');
  assert.ok(meshData.nextFaceId > maxId(meshData.faces), 'nextFaceId ahead of faces');
}

// Asserts every edge shared by two faces is traversed in opposite directions.
export function assertConsistentWinding(meshData) {
  const directed = new Map();
  for (const face of meshData.faces.values()) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertexIds[i];
      const b = face.vertexIds[(i + 1) % n];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!directed.has(key)) directed.set(key, []);
      directed.get(key).push(a < b ? 'fwd' : 'bwd');
    }
  }
  for (const [key, dirs] of directed) {
    if (dirs.length !== 2) continue;
    assert.notEqual(dirs[0], dirs[1], `edge ${key} traversed in opposite directions`);
  }
}

export function maxEdgeFaceCount(meshData) {
  let max = 0;
  for (const e of meshData.edges.values()) max = Math.max(max, e.faceIds.size);
  return max;
}
