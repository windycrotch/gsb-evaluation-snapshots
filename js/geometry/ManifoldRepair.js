import * as THREE from 'three';
import { MeshData, Face } from '../core/MeshData.js';

export const DEFAULT_REPAIR_OPTIONS = {
  weldEpsilon: 1e-6,
  fixWinding: true,
  fillHoles: true,
  maxHoleFillEdges: 128,
};

/**
 * Repair a (possibly non-manifold) MeshData so the Manifold WASM library can ingest it.
 *
 * Pipeline (order is part of the contract):
 *   1. weld coincident vertices within `weldEpsilon`
 *   2. remove degenerate faces (repeated verts / <3 verts) and duplicate faces
 *   3. resolve non-manifold edges (edge shared by 3+ faces)
 *   4. resolve non-manifold vertices (disjoint face fans are split into new vertices)
 *   5. unify face winding
 *   6. fill boundary loops; loops with more than maxHoleFillEdges edges are skipped + warned
 *
 * The returned MeshData preserves every original face id and gives brand-new repair faces
 * non-colliding ids (maxOriginalId + 1, ...) flagged with `isRepairFace = true`.
 *
 * The returned report is also stored on `result.repairReport`.
 */
export function repairMeshData(meshData, options = {}) {
  const opts = { ...DEFAULT_REPAIR_OPTIONS, ...options };

  const report = {
    weldedVerts: 0,
    removedFaces: 0,
    splitVerts: 0,
    flippedFaces: 0,
    filledHoles: 0,
    skippedHoles: 0,
    warnings: [],
    // Checkability: which faces are brand new vs. survivors of the input mesh.
    repairFaceIds: [],
    originalFaceIds: [],
  };

  let verts = [];
  let faces = [];

  const vidToIdx = new Map();
  for (const [id, v] of meshData.vertices) {
    vidToIdx.set(id, verts.length);
    verts.push({ x: v.position.x, y: v.position.y, z: v.position.z });
  }
  for (const [faceId, face] of meshData.faces) {
    faces.push({ id: faceId, vids: face.vertexIds.map(id => vidToIdx.get(id)) });
  }

  // 1. Weld
  const remap = weldVertices(verts, opts.weldEpsilon);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== i) report.weldedVerts++;
  faces = faces.map(f => ({ id: f.id, vids: f.vids.map(i => remap[i]) }));

  // 2. Degenerate / duplicate faces
  const beforeDedup = faces.length;
  faces = removeDegenerateFaces(faces);
  faces = removeDuplicateFaces(faces);
  report.removedFaces += beforeDedup - faces.length;

  // 3. Non-manifold edges
  const beforeNME = faces.length;
  faces = resolveNonManifoldEdges(faces, report);
  report.removedFaces += beforeNME - faces.length;

  // 4. Non-manifold vertices
  ({ verts, faces } = resolveNonManifoldVertices(verts, faces, report));

  // 5. Winding
  if (opts.fixWinding) faces = fixWindingConsistency(verts, faces, report);

  // 6. Hole fill
  if (opts.fillHoles) faces = fillHoles(verts, faces, opts.maxHoleFillEdges, report);

  if (faces.length === 0) {
    report.warnings.push('Repair produced no faces; the mesh is empty.');
  }

  // Compact unused vertices while preserving the per-face id/repair flag.
  const usedSet = new Set(faces.flatMap(f => f.vids));
  const compact = new Map();
  const finalVerts = [];
  for (const idx of usedSet) {
    compact.set(idx, finalVerts.length);
    finalVerts.push(verts[idx]);
  }
  faces = faces.map(f => ({
    id: f.id,
    isRepairFace: !!f.isRepairFace,
    vids: f.vids.map(i => compact.get(i)),
  }));

  // Rebuild a MeshData with explicit face ids: original faces keep their ids, repair
  // faces get fresh ids above every original id so they can never collide.
  let maxOriginalId = -1;
  for (const f of faces) {
    if (!f.isRepairFace && f.id !== -1 && f.id > maxOriginalId) maxOriginalId = f.id;
  }
  let nextRepairId = maxOriginalId + 1;

  const result = new MeshData();
  const vertObjs = finalVerts.map(v =>
    result.addVertex(new THREE.Vector3(v.x, v.y, v.z))
  );

  for (const f of faces) {
    const faceId = f.isRepairFace ? nextRepairId++ : f.id;
    buildFaceWithId(result, faceId, f.vids.map(i => vertObjs[i]));
    if (f.isRepairFace) {
      result.faces.get(faceId).isRepairFace = true;
      report.repairFaceIds.push(faceId);
    } else {
      report.originalFaceIds.push(faceId);
    }
  }

  result.syncIdCounters();
  result.repairReport = report;
  return result;
}

// Mirror of MeshData.addFace bookkeeping, but with an explicit id instead of nextFaceId++.
function buildFaceWithId(meshData, faceId, vertices) {
  const vIds = vertices.map(v => v.id);
  const face = new Face(faceId, vIds);

  meshData.faces.set(faceId, face);
  meshData.faceKeyMap.set(meshData._getFaceKey(vIds), face);

  const len = vIds.length;
  for (let i = 0; i < len; i++) {
    const v1 = vertices[i];
    const v2 = vertices[(i + 1) % len];
    const edge = meshData.addEdge(v1, v2);
    face.edgeIds.add(edge.id);
    edge.faceIds.add(faceId);
  }
  for (const v of vertices) v.faceIds.add(faceId);
  return face;
}

/**
 * WASM-free topological manifold check. Used to report repair failures honestly when
 * the WASM module is unavailable, and as a fast precondition. It verifies the properties
 * a 2-manifold triangle/polygon soup must satisfy:
 *   - at least one face and every face has >=3 unique vertices
 *   - every edge is used by exactly 2 faces
 *   - every vertex's incident faces form a single connected fan (one link component)
 * Self-intersection is NOT detectable here; WASM remains the final authority.
 *
 * Returns { valid: true } or { valid: false, reasons: string[] }.
 */
export function validateManifoldTopology(meshData) {
  const reasons = [];

  if (!meshData || meshData.faces.size === 0) {
    return { valid: false, reasons: ['mesh has no faces'] };
  }

  for (const face of meshData.faces.values()) {
    const ids = face.vertexIds;
    if (ids.length < 3 || new Set(ids).size !== ids.length) {
      reasons.push(`face ${face.id} is degenerate`);
    }
  }

  const edgeFaces = new Map();
  for (const face of meshData.faces.values()) {
    const ids = face.vertexIds;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(face.id);
    }
  }

  let boundary = 0;
  for (const [key, faceIds] of edgeFaces) {
    if (faceIds.length === 1) boundary++;
    else if (faceIds.length > 2) reasons.push(`edge (${key}) is shared by ${faceIds.length} faces`);
  }
  if (boundary > 0) reasons.push(`mesh is open: ${boundary} boundary edge(s)`);

  // Non-manifold vertex: the faces incident to one vertex split into several fans that still
  // share that vertex but share no edge through it (a "pinch"). Separate closed components
  // that were already split into distinct vertices are valid and are not flagged.
  const vertFaces = new Map();
  for (const face of meshData.faces.values()) {
    for (const vi of face.vertexIds) {
      if (!vertFaces.has(vi)) vertFaces.set(vi, []);
      vertFaces.get(vi).push(face);
    }
  }
  for (const [vi, fan] of vertFaces) {
    if (fan.length < 2) continue;
    if (countVertexFanComponents(vi, fan) > 1) {
      reasons.push(`vertex ${vi} is a non-manifold pinch (disjoint face fans share the vertex)`);
    }
  }

  return { valid: reasons.length === 0, reasons };
}

// Connected components of the faces incident to `vi`, where two faces are linked when they
// share another vertex (i.e. an edge through vi). Self-contained so it works with real face ids.
function countVertexFanComponents(vi, fanFaces) {
  const neighborsOf = (face) => {
    const around = new Set();
    for (let i = 0; i < face.vertexIds.length; i++) {
      if (face.vertexIds[i] !== vi) continue;
      const n = face.vertexIds.length;
      around.add(face.vertexIds[(i - 1 + n) % n]);
      around.add(face.vertexIds[(i + 1) % n]);
    }
    return around;
  };

  const adj = new Map(fanFaces.map((f) => [f.id, []]));
  for (let i = 0; i < fanFaces.length; i++) {
    const aroundI = neighborsOf(fanFaces[i]);
    for (let j = i + 1; j < fanFaces.length; j++) {
      const aroundJ = neighborsOf(fanFaces[j]);
      const linked = [...aroundJ].some((v) => aroundI.has(v));
      if (linked) {
        adj.get(fanFaces[i].id).push(fanFaces[j].id);
        adj.get(fanFaces[j].id).push(fanFaces[i].id);
      }
    }
  }

  const visited = new Set();
  let components = 0;
  for (const face of fanFaces) {
    if (visited.has(face.id)) continue;
    components++;
    const q = [face.id];
    visited.add(face.id);
    while (q.length) {
      const cur = q.shift();
      for (const nb of adj.get(cur)) {
        if (!visited.has(nb)) {
          visited.add(nb);
          q.push(nb);
        }
      }
    }
  }
  return components;
}

/** Human-readable one-line summary for UI / agent surfacing. */
export function formatRepairReport(report) {
  if (!report) return '';
  const parts = [
    `welded ${report.weldedVerts} vertex${report.weldedVerts === 1 ? '' : 's'}`,
    `removed ${report.removedFaces} face${report.removedFaces === 1 ? '' : 's'}`,
    `split ${report.splitVerts} vertex${report.splitVerts === 1 ? '' : 's'}`,
    `flipped ${report.flippedFaces} face${report.flippedFaces === 1 ? '' : 's'}`,
    `filled ${report.filledHoles} hole${report.filledHoles === 1 ? '' : 's'}`,
    `skipped ${report.skippedHoles} hole${report.skippedHoles === 1 ? '' : 's'}`,
  ];
  return parts.join(', ');
}

function weldVertices(verts, epsilon) {
  const remap = verts.map((_, i) => i);
  const inv = 1 / epsilon;
  const grid = new Map();

  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const gx = Math.round(v.x * inv);
    const gy = Math.round(v.y * inv);
    const gz = Math.round(v.z * inv);

    let found = -1;
    outer: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${gx+dx},${gy+dy},${gz+dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            const u = verts[j];
            if ((v.x-u.x)**2 + (v.y-u.y)**2 + (v.z-u.z)**2 <= epsilon * epsilon) {
              found = j; break outer;
            }
          }
        }
      }
    }

    if (found >= 0) {
      remap[i] = remap[found];
    } else {
      const key = `${gx},${gy},${gz}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
  }

  for (let i = 0; i < remap.length; i++) {
    let r = remap[i];
    while (remap[r] !== r) r = remap[r];
    remap[i] = r;
  }

  return remap;
}

function removeDegenerateFaces(faces) {
  return faces.filter(f => {
    if (f.vids.length < 3) return false;
    return new Set(f.vids).size === f.vids.length;
  });
}

function canonicalFaceKey(vids) {
  const n = vids.length;
  let mi = 0;
  for (let i = 1; i < n; i++) if (vids[i] < vids[mi]) mi = i;
  const fwd = [...vids.slice(mi), ...vids.slice(0, mi)];
  const rev = [fwd[0], ...fwd.slice(1).reverse()];
  const kf = fwd.join(','), kr = rev.join(',');
  return kf < kr ? kf : kr;
}

function removeDuplicateFaces(faces) {
  const seen = new Set();
  return faces.filter(f => {
    const k = canonicalFaceKey(f.vids);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function resolveNonManifoldEdges(faces, report) {
  const edgeMap = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const vids = faces[fi].vids, n = vids.length;
    for (let i = 0; i < n; i++) {
      const a = vids[i], b = vids[(i+1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, fwd: a < b });
    }
  }

  const remove = new Set();

  for (const [, entries] of edgeMap) {
    if (entries.length <= 2) continue;

    const fwd = entries.filter(e => e.fwd);
    const bwd = entries.filter(e => !e.fwd);

    for (let i = 1; i < fwd.length; i++) remove.add(fwd[i].fi);
    for (let i = 1; i < bwd.length; i++) remove.add(bwd[i].fi);

    if (fwd.length === 0) for (let i = 1; i < bwd.length; i++) remove.add(bwd[i].fi);
    if (bwd.length === 0) for (let i = 1; i < fwd.length; i++) remove.add(fwd[i].fi);
  }

  if (remove.size > 0)
    report.warnings.push(`Removed ${remove.size} faces to fix non-manifold edges`);

  return faces.filter((_, i) => !remove.has(i));
}

function resolveNonManifoldVertices(verts, faces, report) {
  const vertFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++)
    for (const vi of faces[fi].vids) {
      if (!vertFaces.has(vi)) vertFaces.set(vi, []);
      vertFaces.get(vi).push(fi);
    }

  const newVerts = [...verts];

  const newFaces = faces.map(f => ({ id: f.id, isRepairFace: !!f.isRepairFace, vids: [...f.vids] }));

  for (const [vi, fis] of vertFaces) {
    if (fis.length < 2) continue;
    const comps = vertexFanComponents(vi, fis, newFaces);
    if (comps.length <= 1) continue;

    for (let c = 1; c < comps.length; c++) {
      const newIdx = newVerts.length;
      newVerts.push({ ...newVerts[vi] });
      for (const fi of comps[c])
        newFaces[fi].vids = newFaces[fi].vids.map(v => v === vi ? newIdx : v);
      report.splitVerts++;
    }
  }

  return { verts: newVerts, faces: newFaces };
}

function vertexFanComponents(vi, fis, faces) {
  const adj = new Map(fis.map(fi => [fi, []]));

  for (let i = 0; i < fis.length; i++) {
    for (let j = i + 1; j < fis.length; j++) {
      if (shareEdgeThroughVert(vi, fis[i], fis[j], faces)) {
        adj.get(fis[i]).push(fis[j]);
        adj.get(fis[j]).push(fis[i]);
      }
    }
  }

  const visited = new Set();
  const comps = [];
  for (const fi of fis) {
    if (visited.has(fi)) continue;
    const comp = [], q = [fi];
    visited.add(fi);
    while (q.length) {
      const cur = q.shift();
      comp.push(cur);
      for (const nb of adj.get(cur)) {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function shareEdgeThroughVert(vi, fiA, fiB, faces) {
  const va = faces[fiA].vids, vb = faces[fiB].vids;
  const nbA = new Set();
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vi) continue;
    nbA.add(va[(i - 1 + va.length) % va.length]);
    nbA.add(va[(i + 1) % va.length]);
  }

  for (let i = 0; i < vb.length; i++) {
    if (vb[i] !== vi) continue;
    if (nbA.has(vb[(i - 1 + vb.length) % vb.length])) return true;
    if (nbA.has(vb[(i + 1) % vb.length])) return true;
  }
  return false;
}

function fixWindingConsistency(verts, faces, report) {
  const edgeAdj = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const vids = faces[fi].vids, n = vids.length;
    for (let i = 0; i < n; i++) {
      const a = vids[i], b = vids[(i+1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeAdj.has(key)) edgeAdj.set(key, []);
      edgeAdj.get(key).push({ fi, fwd: a < b });
    }
  }

  const faceNb = Array.from({ length: faces.length }, () => []);
  for (const [, entries] of edgeAdj) {
    if (entries.length !== 2) continue;
    const [e0, e1] = entries;
    const shouldFlip = (e0.fwd === e1.fwd);
    faceNb[e0.fi].push({ nb: e1.fi, shouldFlip });
    faceNb[e1.fi].push({ nb: e0.fi, shouldFlip });
  }

  const visited = new Set();
  const toFlip = new Set();

  for (let seed = 0; seed < faces.length; seed++) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const componentFaces = [seed];
    const q = [seed];

    while (q.length) {
      const fi = q.shift();
      const fiFlipped = toFlip.has(fi);
      for (const { nb, shouldFlip } of faceNb[fi]) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        componentFaces.push(nb);
        if (fiFlipped ? !shouldFlip : shouldFlip) toFlip.add(nb);
        q.push(nb);
      }
    }

    const meshCentroid = componentCentroid(verts, faces, componentFaces);
    let score = 0;
    for (const fi of componentFaces) {
      const n = faceNormal(verts, faces[fi].vids);
      const fc = faceCentroid(verts, faces[fi].vids);
      const toFace = new THREE.Vector3(
        fc.x - meshCentroid.x,
        fc.y - meshCentroid.y,
        fc.z - meshCentroid.z
      );
      score += (toFlip.has(fi) ? -1 : 1) * n.dot(toFace);
    }

    if (score < 0) {
      for (const fi of componentFaces) {
        if (toFlip.has(fi)) toFlip.delete(fi); else toFlip.add(fi);
      }
    }
  }

  report.flippedFaces = toFlip.size;
  return faces.map((f, i) =>
    toFlip.has(i)
      ? { id: f.id, isRepairFace: !!f.isRepairFace, vids: [...f.vids].reverse() }
      : f
  );
}

function fillHoles(verts, faces, maxEdges, report) {
  // Collect directed boundary half-edges. A manifold edge shared by two opposite-wound
  // faces appears once in each direction; a boundary edge appears in one direction only.
  const directed = new Map(); // "a,b" -> count
  for (let fi = 0; fi < faces.length; fi++) {
    const vids = faces[fi].vids, n = vids.length;
    for (let i = 0; i < n; i++) {
      const a = vids[i], b = vids[(i + 1) % n];
      const key = `${a},${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }

  // Boundary half-edge: its directed occurrence has no opposite counterpart.
  const next = new Map();
  for (const [key, count] of directed) {
    const [a, b] = key.split(',').map(Number);
    const opposite = directed.get(`${b},${a}`) ?? 0;
    if (count > opposite) {
      // Boundary edge oriented a -> b in the surviving face's winding.
      next.set(a, b);
    }
  }

  // Walk boundary loops. The loop collected follows the face winding (outward normal);
  // the cap must use the reversed order to wind oppositely.
  const holes = [];
  const visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    let cur = start;
    while (!visited.has(cur) && next.has(cur)) {
      visited.add(cur);
      loop.push(cur);
      cur = next.get(cur);
    }
    if (cur === start && loop.length >= 3) holes.push(loop);
  }

  const extra = [];
  for (const loop of holes) {
    if (loop.length > maxEdges) {
      report.skippedHoles++;
      report.warnings.push(
        `Skipped hole with ${loop.length} boundary edges (limit: ${maxEdges})`
      );
      continue;
    }
    // Reverse so the cap normal points opposite the surrounding faces.
    const cap = [...loop].reverse();
    const tris = earClip(verts, cap);
    for (const tri of tris) extra.push({ id: -1, isRepairFace: true, vids: tri });
    report.filledHoles++;
  }

  return [...faces, ...extra];
}

function earClip(verts, loop) {
  if (loop.length === 3) return [[loop[0], loop[1], loop[2]]];
  if (loop.length === 4) return [[loop[0], loop[1], loop[2]], [loop[0], loop[2], loop[3]]];

  const normal = loopNormal(verts, loop);
  const { uAxis, vAxis } = orthoBasis(normal);

  const pts = loop.map(vi => {
    const { x, y, z } = verts[vi];
    return { u: x * uAxis.x + y * uAxis.y + z * uAxis.z,
             v: x * vAxis.x + y * vAxis.y + z * vAxis.z };
  });

  const result = [];
  const rem = loop.map((_, i) => i);

  let guard = rem.length * rem.length;
  while (rem.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < rem.length; i++) {
      const ip = (i - 1 + rem.length) % rem.length;
      const in_ = (i + 1) % rem.length;
      const [a, b, c] = [pts[rem[ip]], pts[rem[i]], pts[rem[in_]]];

      if (cross2d(a, b, c) <= 0) continue;

      let blocked = false;
      for (let j = 0; j < rem.length; j++) {
        if (j === ip || j === i || j === in_) continue;
        if (pointInTri2d(pts[rem[j]], a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;

      result.push([loop[rem[ip]], loop[rem[i]], loop[rem[in_]]]);
      rem.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }

  for (let i = 1; i < rem.length - 1; i++)
    result.push([loop[rem[0]], loop[rem[i]], loop[rem[i + 1]]]);

  return result;
}

// Geometry Helper
function faceNormal(verts, vids) {
  const n = new THREE.Vector3();
  const a = v3(verts[vids[0]]);
  for (let i = 1; i < vids.length - 1; i++) {
    const ab = v3(verts[vids[i]]).sub(a);
    const ac = v3(verts[vids[i+1]]).sub(a);
    n.add(new THREE.Vector3().crossVectors(ab, ac));
  }
  return n.normalize();
}

function faceCentroid(verts, vids) {
  const c = new THREE.Vector3();
  for (const vi of vids) c.add(v3(verts[vi]));
  return c.divideScalar(vids.length);
}

function componentCentroid(verts, faces, fis) {
  const c = new THREE.Vector3();
  let count = 0;
  for (const fi of fis) { c.add(faceCentroid(verts, faces[fi].vids)); count++; }
  return count > 0 ? c.divideScalar(count) : c;
}

function loopNormal(verts, loop) {
  const n = new THREE.Vector3();
  const o = v3(verts[loop[0]]);
  for (let i = 1; i < loop.length - 1; i++) {
    const ab = v3(verts[loop[i]]).sub(o);
    const ac = v3(verts[loop[i+1]]).sub(o);
    n.add(new THREE.Vector3().crossVectors(ab, ac));
  }
  return n.normalize();
}

function orthoBasis(normal) {
  const uAxis = new THREE.Vector3();
  const ref = Math.abs(normal.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  uAxis.crossVectors(normal, ref).normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
  return { uAxis, vAxis };
}

function cross2d(a, b, c) {
  return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function pointInTri2d(p, a, b, c) {
  const d1 = cross2d(p, a, b);
  const d2 = cross2d(p, b, c);
  const d3 = cross2d(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function v3({ x, y, z }) { return new THREE.Vector3(x, y, z); }
