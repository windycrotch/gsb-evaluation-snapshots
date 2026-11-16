import * as THREE from 'three';
import { MeshData } from '../../js/core/MeshData.js';

// Add a polygon face to a MeshData from raw vertex ids (vertices created first in order).
export function addFaceByIds(meshData, ids) {
  return meshData.addFace(ids.map((id) => meshData.vertices.get(id)));
}

export function vec(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

// Standard 8-vertex cube (unit cube at origin). Returns { meshData, faceVertexIds }
// where faces are wound outward.
export function makeCubeMeshData() {
  const md = new MeshData();
  const p = [
    md.addVertex(vec(0, 0, 0)), // 0
    md.addVertex(vec(1, 0, 0)), // 1
    md.addVertex(vec(1, 1, 0)), // 2
    md.addVertex(vec(0, 1, 0)), // 3
    md.addVertex(vec(0, 0, 1)), // 4
    md.addVertex(vec(1, 0, 1)), // 5
    md.addVertex(vec(1, 1, 1)), // 6
    md.addVertex(vec(0, 1, 1)), // 7
  ];
  const f = (ids) => md.addFace(ids.map((i) => p[i]));
  const faces = [
    [0, 3, 2, 1], // bottom (-z)
    [4, 5, 6, 7], // top (+z)
    [0, 1, 5, 4], // front (-y)
    [2, 3, 7, 6], // back (+y)
    [1, 2, 6, 5], // right (+x)
    [0, 4, 7, 3], // left (-x)
  ];
  faces.forEach((ids) => f(ids));
  return { meshData: md, faceVertexIds: faces };
}

/**
 * Sample A — open cube with two coincident vertices and one degenerate triangle.
 *
 * Built from the standard cube, then:
 *   - the top face (4,5,6,7) is removed -> open boundary loop of 4 edges,
 *   - two extra vertices are added at positions identical to top corners 4 and 6
 *     (coincident -> welded by repair),
 *   - one degenerate triangle referencing the same vertex twice is appended (dropped by repair),
 *   - one valid triangle using the duplicate vertices covers half of the top opening; after
 *     welding it becomes face (4,5,6), shrinking the remaining hole to the triangle (4,6,7).
 */
export function makeBrokenOpenCube() {
  const { meshData: md } = makeCubeMeshData();

  // Remove the top face so the mesh is open (hole to fill).
  const topFace = [...md.faces.values()].find((face) =>
    face.vertexIds.length === 4 && face.vertexIds.includes(4) && face.vertexIds.includes(7)
  );
  md.deleteFace(topFace);

  // Two coincident vertices (duplicates of top corners 4 and 6).
  const dupAt4 = md.addVertex(vec(0, 0, 1));
  const dupAt6 = md.addVertex(vec(1, 1, 1));

  // Degenerate triangle: repeated vertex -> removed by repair.
  md.addFace([md.vertices.get(0), md.vertices.get(1), md.vertices.get(1)]);

  // Valid triangle covering half of the opening; only becomes meaningful after welding.
  md.addFace([dupAt4, md.vertices.get(5), dupAt6]);

  return md;
}

/**
 * Sample B — a mesh with one large hole whose boundary loop exceeds the fill limit.
 * An open "tube" (open cylinder) made of `segments` quads between two rings:
 * the two boundary loops each have `segments` edges, which is > the default limit of 128
 * when segments is large enough.
 */
export function makeLargeHoleTube(segments = 140) {
  const md = new MeshData();
  const bottom = [];
  const top = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    bottom.push(md.addVertex(vec(x, y, 0)));
    top.push(md.addVertex(vec(x, y, 1)));
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    md.addFace([bottom[i], bottom[j], top[j], top[i]]);
  }
  return md;
}

/**
 * Sample C — a mesh that remains non-manifold AFTER the full repair pipeline.
 *
 * An open tube whose two boundary loops are larger than the hole-fill limit, combined with a
 * degenerate face. Repair welds/cleans what it can and skips both oversized holes (recording
 * warnings), but cannot close the mesh, so it still has boundary edges. The topology validator
 * rejects it and toManifold must throw a ManifoldRepairError instead of silently returning an
 * empty or open manifold.
 */
export function makeUnrepairableOpenMesh(segments = 140) {
  const md = makeLargeHoleTube(segments);
  // Extra damage the pipeline can clean, proving repair actually ran but could not finish.
  const v0 = [...md.vertices.values()][0];
  md.addFace([v0, v0, v0]); // degenerate -> removed
  return md;
}

/**
 * Two tetrahedra touching at exactly one vertex: a classic non-manifold vertex ("pinch").
 * Repair's vertex-split separates the fans into two disjoint closed tetrahedra, which then
 * form a valid manifold — kept to demonstrate the split step and the splitVerts counter.
 */
export function makePinchedTetrahedra() {
  const md = new MeshData();
  // Shared pinch vertex.
  const shared = md.addVertex(vec(0, 0, 0));

  // Tetrahedron A around +x.
  const a1 = md.addVertex(vec(1, 0, 0));
  const a2 = md.addVertex(vec(0, 1, 0));
  const a3 = md.addVertex(vec(0, 0, 1));

  // Tetrahedron B around -x/-y.
  const b1 = md.addVertex(vec(-1, 0, 0));
  const b2 = md.addVertex(vec(0, -1, 0));
  const b3 = md.addVertex(vec(0, 0, -1));

  const tet = (verts) => {
    const [o, x, y, z] = verts;
    md.addFace([o, x, y]);
    md.addFace([o, y, z]);
    md.addFace([o, z, x]);
    md.addFace([x, z, y]);
  };
  tet([shared, a1, a2, a3]);
  tet([shared, b1, b2, b3]);

  return md;
}

/**
 * A mesh consisting solely of degenerate faces -> repair removes everything -> empty result,
 * which must be reported as an error rather than an empty mesh.
 */
export function makeAllDegenerateMesh() {
  const md = new MeshData();
  const v0 = md.addVertex(vec(0, 0, 0));
  const v1 = md.addVertex(vec(1, 0, 0));
  md.addFace([v0, v1, v1]);
  md.addFace([v0, v0, v1]);
  return md;
}

// Minimal object3D-like wrapper holding meshData, matching what toManifold expects.
export function makeObject(meshData, name = 'test-mesh') {
  return {
    name,
    uuid: `uuid-${name}-${Math.abs(hashName(name))}`,
    isMesh: true,
    userData: { meshData },
    matrixWorld: new THREE.Matrix4().identity(),
  };
}

function hashName(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
