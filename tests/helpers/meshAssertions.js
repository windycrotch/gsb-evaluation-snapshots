import * as THREE from 'three';

// Newell normal of a face in a MeshData-like structure.
export function faceNormal(meshData, face) {
  const n = new THREE.Vector3();
  const ids = face.vertexIds;
  for (let i = 0; i < ids.length; i++) {
    const a = meshData.vertices.get(ids[i]).position;
    const b = meshData.vertices.get(ids[(i + 1) % ids.length]).position;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

// Count how many faces use each undirected edge: Map<'a,b', count>.
export function edgeUseCounts(meshData) {
  const counts = new Map();
  for (const face of meshData.faces.values()) {
    const ids = face.vertexIds;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function boundaryEdgeCount(meshData) {
  let n = 0;
  for (const c of edgeUseCounts(meshData).values()) if (c === 1) n++;
  return n;
}

export function nonManifoldEdgeCount(meshData) {
  let n = 0;
  for (const c of edgeUseCounts(meshData).values()) if (c > 2) n++;
  return n;
}

// Every reference between faces/edges/vertices must point at something that
// exists — no dangling indices to deleted elements.
export function assertNoDanglingRefs(meshData) {
  const problems = [];

  for (const face of meshData.faces.values()) {
    for (const vId of face.vertexIds) {
      if (!meshData.vertices.has(vId)) problems.push(`face ${face.id} -> missing vertex ${vId}`);
    }
    for (const eId of face.edgeIds) {
      if (!meshData.edges.has(eId)) problems.push(`face ${face.id} -> missing edge ${eId}`);
    }
    const keyed = meshData.faceKeyMap.get(meshData._getFaceKey(face.vertexIds));
    // Note: a mesh with duplicate faces (valid pre-repair input) can only
    // resolve a shared face key to one of the duplicates; what must never
    // happen is the key resolving to a face that no longer exists.
    if (!keyed || meshData.faces.get(keyed.id) !== keyed) {
      problems.push(`faceKeyMap does not resolve face ${face.id} to a live face`);
    }
  }

  for (const edge of meshData.edges.values()) {
    for (const fId of edge.faceIds) {
      if (!meshData.faces.has(fId)) problems.push(`edge ${edge.id} -> deleted face ${fId}`);
    }
    const keyed = meshData.edgeKeyMap.get(meshData._getEdgeKey(edge.v1Id, edge.v2Id));
    if (keyed?.id !== edge.id) problems.push(`edgeKeyMap does not resolve edge ${edge.id}`);
  }

  for (const vertex of meshData.vertices.values()) {
    for (const fId of vertex.faceIds) {
      if (!meshData.faces.has(fId)) problems.push(`vertex ${vertex.id} -> deleted face ${fId}`);
    }
    for (const eId of vertex.edgeIds) {
      if (!meshData.edges.has(eId)) problems.push(`vertex ${vertex.id} -> missing edge ${eId}`);
    }
  }

  return problems;
}

// The report's counters must reconcile exactly with the actual mesh changes.
export function assertReportConsistent(report, input, result) {
  const problems = [];

  if (report.inputFaceCount !== input.faces.size)
    problems.push(`inputFaceCount ${report.inputFaceCount} != ${input.faces.size}`);
  if (report.inputVertexCount !== input.vertices.size)
    problems.push(`inputVertexCount ${report.inputVertexCount} != ${input.vertices.size}`);
  if (report.outputFaceCount !== result.faces.size)
    problems.push(`outputFaceCount ${report.outputFaceCount} != result faces ${result.faces.size}`);
  if (report.outputVertexCount !== result.vertices.size)
    problems.push(`outputVertexCount ${report.outputVertexCount} != result vertices ${result.vertices.size}`);

  if (report.outputFaceCount !== report.inputFaceCount - report.removedFaces + report.addedFaces)
    problems.push(`face counts do not reconcile: ${report.outputFaceCount} != ${report.inputFaceCount} - ${report.removedFaces} + ${report.addedFaces}`);

  if (report.outputVertexCount !== report.inputVertexCount + report.splitVerts - report.removedUnusedVerts)
    problems.push(`vertex counts do not reconcile: ${report.outputVertexCount} != ${report.inputVertexCount} + ${report.splitVerts} - ${report.removedUnusedVerts}`);

  const actualRepairFaces = [...result.faces.values()].filter(f => f.isRepairFace).length;
  if (report.addedFaces !== actualRepairFaces)
    problems.push(`addedFaces ${report.addedFaces} != actual repair faces ${actualRepairFaces}`);

  const survived = [...result.faces.keys()].filter(id => input.faces.has(id)).length;
  if (report.removedFaces !== report.inputFaceCount - survived)
    problems.push(`removedFaces ${report.removedFaces} != ${report.inputFaceCount} - survived ${survived}`);

  return problems;
}
