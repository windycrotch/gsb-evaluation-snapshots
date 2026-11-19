// Offline checks on built data (Node): crack test and triangle counts by distance.
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier as MS } from 'meshoptimizer';

const T = { Float32Array, Int8Array, Uint32Array, Int32Array };
function read(dir, name) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')), bin = fs.readFileSync(path.join(dir, `${name}.bin`));
  const sec = (k) => { const s = meta.sections[k]; return new T[s.type](bin.buffer.slice(bin.byteOffset + s.offset, bin.byteOffset + s.offset + s.bytes)); };
  const cU = sec('clusterU'), gF = sec('groupF'), mOff = sec('memberOff'), mIds = sec('memberIds');
  const C = meta.clusters, G = meta.groups, dst = new Int32Array(C);
  for (let g = 0; g < G; g++) for (let k = mOff[g]; k < mOff[g + 1]; k++) dst[mIds[k]] = g;
  // projected error in pixels of group g seen from cam (mesh-local units), 1080p, 60 degree vertical fov
  const K = 1080 / (2 * Math.tan(Math.PI / 6));
  const err = (g, cam) => { const o = g * 5, d = Math.hypot(gF[o] - cam[0], gF[o + 1] - cam[1], gF[o + 2] - cam[2]) - gF[o + 3]; return d <= 1e-6 ? Infinity : gF[o + 4] * K / d; };
  const c0 = [0, 1, 2].map((a) => (meta.bbMin[a] + meta.bbMax[a]) / 2), R = Math.hypot(...[0, 1, 2].map((a) => meta.bbMax[a] - meta.bbMin[a])) / 2;
  return { meta, sec, cU, C, G, dst, K, err, c0, R };
}

/**
 * Crack test: for several camera positions and thresholds, select the cut by brute force
 * (cluster drawn iff err(src group) <= t < err(dst group)) and count open edges by vertex position.
 * A crack-free cut has exactly the open edges of the source mesh.
 * @returns {Promise<{ ok: boolean, extraOpenEdges: number, monotonicityViolations: number }>}
 */
export async function verifyClod(dir, name, log = console.log) {
  await MS.ready;
  const { meta, sec, cU, C, dst, err, c0, R } = read(dir, name);
  const pos = sec('positions'), idx = sec('indices'), V = meta.dagVertices || meta.vertices;
  const remap = MS.generatePositionRemap(pos.subarray(0, V * 3), 3);
  const openEdges = (clusters) => {
    const m = new Map(); let tris = 0;
    for (const c of clusters) for (let k = cU[c * 4], e = k + cU[c * 4 + 1]; k < e; k += 3) {
      tris++;
      const a = remap[idx[k]], b = remap[idx[k + 1]], d = remap[idx[k + 2]];
      for (const [x, y] of [[a, b], [b, d], [d, a]]) { if (x === y) continue; const key = x < y ? x * 4194304 + y : y * 4194304 + x; m.set(key, (m.get(key) || 0) + 1); }
    }
    let open = 0, multi = 0; for (const n of m.values()) { if (n === 1) open++; else if (n > 2) multi++; }
    return { tris, open, multi };
  };
  const leaves = []; for (let c = 0; c < C; c++) if (cU[c * 4 + 2] < 0) leaves.push(c);
  const base = openEdges(leaves);
  log(`${name}: source ${base.tris} tris, open edges ${base.open}, non-manifold edges ${base.multi}`);
  // camera offsets from the centre in bounding-sphere diameters, so the test does not depend on the model's units
  const cams = [[0.6, 0.2, 0.3], [0.9, 0.5, 0.9], [2, 1, 2], [6, 2, 4], [25, 8, 10], [0.2, 0.05, 0.31], [-0.5, 0.25, 0.0]].map((v) => v.map((x, a) => c0[a] + x * R * 2));
  let worst = 0, mono = 0;
  for (const cam of cams) for (let c = 0; c < C; c++) { const s = cU[c * 4 + 2]; if (s >= 0 && dst[c] > 0 && err(s, cam) > err(dst[c], cam) * 1.0001) mono++; }
  log(`monotonicity violations (src error > dst error): ${mono}`);
  cams.forEach((cam, ci) => {
    for (const t of [0.5, 1, 2, 4, 16]) {
      const cut = [];
      for (let c = 0; c < C; c++) { const s = cU[c * 4 + 2], es = s < 0 ? 0 : err(s, cam), ed = dst[c] === 0 ? Infinity : err(dst[c], cam); if (es <= t && ed > t) cut.push(c); }
      let lo = 255, hi = 0; for (const c of cut) { const l = cU[c * 4 + 3]; if (l < lo) lo = l; if (l > hi) hi = l; }
      const r = openEdges(cut), extra = r.open - base.open; worst = Math.max(worst, extra);
      log(`cam ${ci} t=${String(t).padEnd(4)} clusters ${String(cut.length).padEnd(6)} tris ${String(r.tris).padEnd(8)} levels ${lo}-${hi}  open edges ${r.open} (${extra >= 0 ? '+' : ''}${extra} vs source)  edges with >2 tris ${r.multi}`);
    }
  });
  log(worst > 0 ? `RESULT: up to ${worst} extra open edges` : 'RESULT: no extra open edges in any cut');
  return { ok: worst <= 0 && mono === 0, extraOpenEdges: worst, monotonicityViolations: mono };
}

/**
 * Triangles in the cut versus distance (no frustum culling) at 1, 2 and 4 px on a 1080p, 60 degree view,
 * for the asset scaled so that its bounding sphere has the given radius in metres.
 */
export function cutStats(dir, name, radius = 1, log = console.log) {
  const { meta, cU, C, dst, err, c0, R } = read(dir, name);
  const scale = radius / R;
  log(`${name}: ${meta.sourceTris} source tris, ${meta.clusters} clusters, ${meta.groups} groups, ${meta.levels} levels, ${(meta.binBytes / 1048576).toFixed(1)} MB`);
  const rows = [];
  for (const D of [1.5, 3, 6, 12, 25, 50, 100, 200]) {
    const d = D / scale, cam = [c0[0] + 0.48 * d, c0[1] + 0.34 * d, c0[2] + 0.81 * d], out = [];
    for (const t of [1, 2, 4]) { let tris = 0; for (let c = 0; c < C; c++) { const s = cU[c * 4 + 2]; if ((s < 0 || err(s, cam) <= t) && (dst[c] === 0 || err(dst[c], cam) > t)) tris += cU[c * 4 + 1] / 3; } out.push(tris); }
    rows.push({ distance: D, px1: out[0], px2: out[1], px4: out[2] });
    log(`${String(D).padStart(6)} m   1 px ${String(out[0]).padStart(8)}   2 px ${String(out[1]).padStart(8)}   4 px ${String(out[2]).padStart(8)}`);
  }
  return rows;
}
