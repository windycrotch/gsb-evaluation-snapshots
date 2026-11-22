import { MeshData } from '../../js/core/MeshData.js';

/**
 * Build a MeshData from raw positions + face vertex-index lists, bypassing
 * MeshData.addFace (which would silently deduplicate). This mirrors what a
 * broken import looks like: duplicate faces, non-manifold edges and holes are
 * all representable. Adjacency (edge map, vertex/edge faceIds) is kept
 * consistent so the result is a fully valid MeshData instance.
 */
export function makeRawMeshData(positions, faceVertexIds) {
  const vertices = positions.map((p, id) => [
    id,
    { id, position: { x: p[0], y: p[1], z: p[2] }, edgeIds: [], faceIds: [] },
  ]);

  const edgeByKey = new Map();
  const faces = [];
  let nextEdgeId = 0;

  faceVertexIds.forEach((vids, fid) => {
    const edgeIds = [];
    for (let i = 0; i < vids.length; i++) {
      const a = vids[i], b = vids[(i + 1) % vids.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let e = edgeByKey.get(key);
      if (!e) {
        e = { id: nextEdgeId, v1Id: Math.min(a, b), v2Id: Math.max(a, b), faceIds: [] };
        edgeByKey.set(key, e);
        vertices[a][1].edgeIds.push(nextEdgeId);
        vertices[b][1].edgeIds.push(nextEdgeId);
        nextEdgeId++;
      }
      e.faceIds.push(fid);
      edgeIds.push(e.id);
    }
    for (const v of vids) vertices[v][1].faceIds.push(fid);
    faces.push([fid, { id: fid, vertexIds: [...vids], edgeIds }]);
  });

  return MeshData.getRehydratedMeshData({
    vertices,
    edges: [...edgeByKey.values()].map(e => [e.id, e]),
    faces,
    uvs: [],
    nextVertexId: positions.length,
    nextEdgeId,
    nextFaceId: faceVertexIds.length,
  });
}

// Unit cube corners. Faces below wind counter-clockwise seen from outside.
export const CUBE_POSITIONS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

export const CUBE_FACES = {
  bottom: [0, 3, 2, 1], // -z
  top: [4, 5, 6, 7],    // +z
  front: [0, 1, 5, 4],  // -y
  right: [1, 2, 6, 5],  // +x
  back: [2, 3, 7, 6],   // +y
  left: [3, 0, 4, 7],   // -x
};

// Cube missing its top face: one 4-edge hole.
export function openCube() {
  const { bottom, front, right, back, left } = CUBE_FACES;
  return makeRawMeshData(CUBE_POSITIONS, [bottom, front, right, back, left]);
}

// Closed, consistently outward-oriented cube.
export function closedCube() {
  const { bottom, top, front, right, back, left } = CUBE_FACES;
  return makeRawMeshData(CUBE_POSITIONS, [bottom, top, front, right, back, left]);
}

// Closed cube with the bottom face present twice (exact duplicate).
export function cubeWithDuplicateFace() {
  const { bottom, top, front, right, back, left } = CUBE_FACES;
  return makeRawMeshData(CUBE_POSITIONS, [bottom, top, front, right, back, left, [...bottom]]);
}

// Closed cube with the top face wound the wrong way.
export function flippedFaceCube() {
  const { bottom, top, front, right, back, left } = CUBE_FACES;
  return makeRawMeshData(CUBE_POSITIONS, [bottom, [...top].reverse(), front, right, back, left]);
}

// Three faces sharing edge (0,2): non-manifold edge.
export function nonManifoldEdgeMesh() {
  const positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1],
  ];
  return makeRawMeshData(positions, [
    [0, 1, 2],
    [0, 2, 3],
    [0, 2, 4], // third face on edge (0,2)
  ]);
}

// A "broken import": hole (missing top) + duplicated bottom face + a third
// face hinged on edge (0,3) making it non-manifold.
export function brokenImportMesh() {
  const positions = [...CUBE_POSITIONS, [-0.5, 0.5, -1]];
  const { bottom, front, right, back, left } = CUBE_FACES;
  return makeRawMeshData(positions, [
    bottom, front, right, back, left,
    [...bottom],   // duplicate face
    [0, 3, 8],     // non-manifold: edge (0,3) now has 3 faces
  ]);
}

// Mesh whose faces reference vertices that do not exist: makes repairMeshData
// throw (face.vertexIds is null), used to exercise the failure path.
export function corruptMesh() {
  const meshData = closedCube();
  for (const face of meshData.faces.values()) face.vertexIds = null;
  return meshData;
}
