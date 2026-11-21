// Offline preprocessor: GLB -> cluster LOD DAG ("Nanite-style" virtual geometry). Node only.
//
// Pipeline (follows meshoptimizer demo/clusterlod.h, re-implemented in JS because the
// JS build has no meshopt_partitionClusters):
//   1. split the mesh into meshlets of <=128 triangles
//   2. group adjacent meshlets (~16 per group), lock vertices shared between groups
//   3. simplify each group to 50% with the boundary locked, record absolute error
//   4. re-split the simplified group into meshlets; they become the next level
//   5. repeat until nothing merges
// Every cluster stores the group that produced it (src) and is listed as member of the
// group that consumes it. Group error and bounding sphere are monotonic going up, so the
// runtime test  proj(src) <= t < proj(dst)  gives a crack-free cut.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MeshoptClusterizer as MC, MeshoptSimplifier as MS, MeshoptEncoder as ME } from 'meshoptimizer';

const MAX_TRIS = 128, MAX_VERTS = 192, GROUP = 16, RATIO = 0.5, STUCK = 0.85;

// area-weighted vertex normals for primitives that have none
function faceNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] += x; n[v + 1] += y; n[v + 2] += z; }
  }
  for (let v = 0; v < n.length; v += 3) { const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1; n[v] /= l; n[v + 1] /= l; n[v + 2] /= l; }
  return n;
}

// ---------------------------------------------------------------- GLB load
function loadGLB(p) {
  const buf = fs.readFileSync(p);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${p} is not a binary glTF (.glb) file`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  for (const ext of gltf.extensionsRequired || []) if (/draco|meshopt_compression/i.test(ext)) throw new Error(`${p} uses ${ext}; decompress it first (for example: npx @gltf-transform/cli copy in.glb out.glb)`);
  const view = (i) => { const v = gltf.bufferViews[i]; return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength); };
  const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function accessor(i) {
    if (gltf.accessors[i].bufferView == null || gltf.accessors[i].sparse) throw new Error('sparse accessors and accessors without a buffer view are not supported');
    const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type];
    const stride = bv.byteStride || T.BYTES_PER_ELEMENT * n;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new T(a.count * n);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    if (stride === T.BYTES_PER_ELEMENT * n) {
      out.set(new T(bin.buffer.slice(bin.byteOffset + base, bin.byteOffset + base + out.byteLength)));
    } else {
      const get = { 5126: 'getFloat32', 5125: 'getUint32', 5123: 'getUint16', 5121: 'getUint8', 5122: 'getInt16', 5120: 'getInt8' }[a.componentType];
      for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](base + k * stride + c * T.BYTES_PER_ELEMENT, true);
    }
    if (a.normalized && T !== Float32Array) {
      const f = new Float32Array(out.length), m = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType];
      for (let k = 0; k < out.length; k++) f[k] = Math.max(out[k] / m, -1);
      return f;
    }
    return out;
  }
  // every mesh instance in the default scene, with its world matrix (column-major 4x4)
  const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], inst = [];
  const visit = (ni, parent) => { const n = gltf.nodes[ni], m = mul(parent, local(n)); if (n.mesh != null) inst.push({ mesh: n.mesh, m }); for (const c of n.children || []) visit(c, m); };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (scene?.nodes) for (const r of scene.nodes) visit(r, I4); else (gltf.meshes || []).forEach((_, i) => inst.push({ mesh: i, m: I4 }));
  // merge all triangle primitives into one mesh, in world space. Only the first material is kept.
  const P = [], N = [], U = [], I = []; let base = 0, material = null;
  for (const { mesh, m } of inst) for (const pr of gltf.meshes[mesh].primitives) {
    if ((pr.mode ?? 4) !== 4) continue; // triangles only
    const pos = new Float32Array(accessor(pr.attributes.POSITION)), cnt = pos.length / 3;
    const nrm = pr.attributes.NORMAL != null ? new Float32Array(accessor(pr.attributes.NORMAL)) : null;
    const uv = pr.attributes.TEXCOORD_0 != null ? new Float32Array(accessor(pr.attributes.TEXCOORD_0)) : new Float32Array(cnt * 2);
    const idx = pr.indices != null ? accessor(pr.indices) : Uint32Array.from({ length: cnt }, (_, k) => k);
    // normals go through the cofactor matrix (= det * inverse transpose); a mirroring matrix flips the winding
    const c = [m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8], m[9] * m[2] - m[10] * m[1], m[10] * m[0] - m[8] * m[2], m[8] * m[1] - m[9] * m[0], m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4]];
    const flip = m[0] * c[0] + m[1] * c[1] + m[2] * c[2] < 0;
    if (m !== I4) for (let k = 0; k < cnt; k++) {
      const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
      pos[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; pos[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; pos[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (!nrm) continue;
      const a = nrm[k * 3], b = nrm[k * 3 + 1], d = nrm[k * 3 + 2];
      let nx = c[0] * a + c[3] * b + c[6] * d, ny = c[1] * a + c[4] * b + c[7] * d, nz = c[2] * a + c[5] * b + c[8] * d; if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1; nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    }
    const gi = new Uint32Array(idx.length); for (let k = 0; k < idx.length; k++) gi[k] = idx[k] + base;
    if (flip) for (let k = 0; k < gi.length; k += 3) { const t = gi[k + 1]; gi[k + 1] = gi[k + 2]; gi[k + 2] = t; }
    P.push(pos); N.push(nrm || faceNormals(pos, idx)); U.push(uv); I.push(gi); base += cnt;
    if (material == null && pr.material != null) material = gltf.materials[pr.material];
  }
  if (!base) throw new Error(`${p} contains no triangle meshes`);
  const cat = (T, arrs) => { const o = new T(arrs.reduce((s, a) => s + a.length, 0)); let off = 0; for (const a of arrs) { o.set(a, off); off += a.length; } return o; };
  const imageBytes = (texIndex) => {
    if (texIndex == null) return null;
    const img = gltf.images[gltf.textures[texIndex].source];
    if (img?.bufferView == null) return null; // external image files are not followed
    return { bytes: view(img.bufferView), mime: img.mimeType };
  };
  const pbr = material?.pbrMetallicRoughness || {};
  return {
    positions: cat(Float32Array, P), normals: cat(Float32Array, N), uvs: cat(Float32Array, U), indices: cat(Uint32Array, I),
    material: { baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1], metallicFactor: pbr.metallicFactor ?? 1, roughnessFactor: pbr.roughnessFactor ?? 1, doubleSided: !!material?.doubleSided },
    textures: {
      basecolor: imageBytes(pbr.baseColorTexture?.index),
      orm: imageBytes(pbr.metallicRoughnessTexture?.index),
      normal: imageBytes(material?.normalTexture?.index),
    },
  };
}

/**
 * Build <outDir>/<name>.bin + <name>.json (+ textures) from a binary glTF file.
 * @param {object} o
 * @param {string} o.input            path of the .glb
 * @param {string} o.outDir           output folder (created if missing)
 * @param {string} [o.name]           asset name = output file stem; default: the input file name without extension
 * @param {number} [o.textureSize=0]  resize textures to N x N JPEG with ffmpeg; 0 copies them unchanged
 * @param {number} [o.maxTriangles=0] simplify the source to at most this many triangles first; 0 = keep all
 * @param {number} [o.edgeLimit=0]    clusterlod.h-style cap of group error at N x longest edge; 0 = off
 * @param {boolean} [o.lods=true]     also write four discrete LODs (needed by DiscreteLodSet only)
 * @param {number} [o.normalWeight=0.5] [o.uvWeight=0.1] attribute weights for the simplifier
 * @param {number} [o.sloppyAt=0.7]   fall back to vertex clustering when edge collapse leaves more than this fraction
 * @param {number} [o.errorCap=0.15]  cap of the edge-collapse error, as a fraction of the group radius
 * @param {(msg: string) => void} [o.log] progress output; default console.log, pass () => {} to silence
 * @returns {Promise<{ name: string, bin: string, json: string, meta: object }>}
 */
export async function buildClod({ input, outDir, name = path.basename(input).replace(/.[^.]+$/, ''), textureSize: TEX = 0, maxTriangles: MAX_SRC_TRIS = 0, edgeLimit: EDGE_LIMIT = 0, lods: LODS = true, normalWeight: WN = 0.5, uvWeight: WUV = 0.1, sloppyAt: SLOPPY_AT = 0.7, errorCap: ERR_CAP = 0.15, log: print = console.log } = {}) {
  if (!input || !outDir) throw new Error('buildClod: input and outDir are required');
  await Promise.all([MC.ready, MS.ready, ME.ready]);
  const T0 = performance.now();
  const log = (...a) => print(`[${((performance.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`);

  const src = loadGLB(input);
  let { positions, normals, uvs, indices } = src;
  let V = positions.length / 3;
  log(`loaded ${path.basename(input)}: ${V} verts, ${indices.length / 3} tris`);

  if (MAX_SRC_TRIS && indices.length / 3 > MAX_SRC_TRIS) {
    const [r] = MS.simplifyWithAttributes(indices, positions, 3, normals, 3, [0.5, 0.5, 0.5], null, MAX_SRC_TRIS * 3, 1, []);
    indices = r; log(`pre-reduced source to ${indices.length / 3} tris`);
  }

  // drop degenerate triangles, compact unused vertices
  {
    const keep = new Uint32Array(indices.length); let n = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (a !== b && b !== c && a !== c) { keep[n++] = a; keep[n++] = b; keep[n++] = c; }
    }
    indices = keep.slice(0, n);
    const map = new Int32Array(V).fill(-1); let nv = 0;
    for (let i = 0; i < indices.length; i++) { const v = indices[i]; if (map[v] < 0) map[v] = nv++; indices[i] = map[v]; }
    {
      const p2 = new Float32Array(nv * 3), n2 = new Float32Array(nv * 3), u2 = new Float32Array(nv * 2);
      for (let v = 0; v < V; v++) { const m = map[v]; if (m < 0) continue; p2.set(positions.subarray(v * 3, v * 3 + 3), m * 3); n2.set(normals.subarray(v * 3, v * 3 + 3), m * 3); u2.set(uvs.subarray(v * 2, v * 2 + 2), m * 2); }
      positions = p2; normals = n2; uvs = u2; V = nv;
    }
  }
  const SRC_TRIS = indices.length / 3;

  // position-only remap: connectivity across UV/normal seams
  const remap = MS.generatePositionRemap(positions, 3);
  // protect attribute seams (same position, different uv) for permissive simplification
  const protect = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    const r = remap[i];
    if (r !== i && (uvs[i * 2] !== uvs[r * 2] || uvs[i * 2 + 1] !== uvs[r * 2 + 1])) { protect[i] = 2; protect[r] = 2; }
  }
  for (let i = 0; i < V; i++) if (protect[remap[i]]) protect[i] = 2;

  // ---------------------------------------------------------------- helpers
  function mergeSpheres(list) { // list of [x,y,z,r]; conservative enclosing sphere
    let [x, y, z, r] = list[0];
    for (let i = 1; i < list.length; i++) {
      const [bx, by, bz, br] = list[i];
      const dx = bx - x, dy = by - y, dz = bz - z, d = Math.hypot(dx, dy, dz);
      if (d + br <= r) continue;
      if (d + r <= br) { x = bx; y = by; z = bz; r = br; continue; }
      const nr = (d + r + br) / 2, k = (nr - r) / d;
      x += dx * k; y += dy * k; z += dz * k; r = nr;
    }
    return [x, y, z, r * 1.0001];
  }

  // split an indexed (local) mesh into meshlets; returns clusters with *global* indices
  function clusterize(idx, pos, toGlobal) {
    const mb = MC.buildMeshlets(idx, pos, 3, MAX_VERTS, MAX_TRIS, 0);
    const bounds = MC.computeMeshletBounds(mb, pos, 3);
    const out = [];
    for (let i = 0; i < mb.meshletCount; i++) {
      const vo = mb.meshlets[i * 4], to = mb.meshlets[i * 4 + 1], tc = mb.meshlets[i * 4 + 3];
      const g = new Uint32Array(tc * 3);
      for (let k = 0; k < tc * 3; k++) { const lv = mb.vertices[vo + mb.triangles[to + k]]; g[k] = toGlobal ? toGlobal[lv] : lv; }
      const b = Array.isArray(bounds) ? bounds[i] : bounds;
      out.push({ idx: g, sphere: [b.centerX, b.centerY, b.centerZ, b.radius] });
    }
    return out;
  }

  // group clusters by shared boundary vertices (heavy-edge matching), spatial fallback
  function partition(clusters) {
    const n = clusters.length;
    if (n <= GROUP) return [clusters.map((_, i) => i)];
    const owner = new Int32Array(V).fill(-1), adj = Array.from({ length: n }, () => new Map());
    const stamp = new Int32Array(V).fill(-1);
    for (let c = 0; c < n; c++) {
      const idx = clusters[c].idx;
      for (let k = 0; k < idx.length; k++) {
        const r = remap[idx[k]];
        if (stamp[r] === c) continue; stamp[r] = c;
        const o = owner[r];
        if (o < 0) owner[r] = c;
        else { adj[c].set(o, (adj[c].get(o) || 0) + 1); adj[o].set(c, (adj[o].get(c) || 0) + 1); }
      }
    }
    let groups = clusters.map((_, i) => [i]);
    let gOf = Int32Array.from({ length: n }, (_, i) => i);
    for (let round = 0; round < 5; round++) {
      const gn = groups.length;
      const gadj = Array.from({ length: gn }, () => new Map());
      for (let c = 0; c < n; c++) for (const [o, w] of adj[c]) { const a = gOf[c], b = gOf[o]; if (a !== b) gadj[a].set(b, (gadj[a].get(b) || 0) + w); }
      const order = Array.from({ length: gn }, (_, i) => i).sort((a, b) => groups[a].length - groups[b].length);
      const matched = new Uint8Array(gn), next = [];
      for (const a of order) {
        if (matched[a]) continue; matched[a] = 1;
        let best = -1, bw = 0;
        for (const [b, w] of gadj[a]) {
          if (matched[b] || groups[a].length + groups[b].length > GROUP) continue;
          const score = w / Math.sqrt(groups[b].length);
          if (score > bw) { bw = score; best = b; }
        }
        if (best >= 0) { matched[best] = 1; next.push(groups[a].concat(groups[best])); } else next.push(groups[a]);
      }
      if (next.length === gn) break;
      groups = next;
      groups.forEach((g, gi) => { for (const c of g) gOf[c] = gi; });
    }
    // spatial fallback: tiny groups (islands, leftovers) are chained in Morton order
    const small = [], big = [];
    for (const g of groups) (g.length < GROUP / 4 ? small : big).push(g);
    if (small.length > 1) {
      const key = (g) => {
        const s = clusters[g[0]].sphere; let k = 0;
        const q = [0, 1, 2].map((a) => Math.min(1023, Math.max(0, Math.floor(((s[a] - bbMin[a]) / (bbMax[a] - bbMin[a] + 1e-9)) * 1024))));
        for (let b = 9; b >= 0; b--) for (let a = 0; a < 3; a++) k = k * 2 + ((q[a] >> b) & 1);
        return k;
      };
      small.sort((a, b) => key(a) - key(b));
      let cur = [];
      for (const g of small) { if (cur.length + g.length > GROUP) { big.push(cur); cur = []; } cur = cur.concat(g); }
      if (cur.length) big.push(cur);
    } else big.push(...small);
    return big;
  }

  const bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) for (let a = 0; a < 3; a++) { const v = positions[i * 3 + a]; if (v < bbMin[a]) bbMin[a] = v; if (v > bbMax[a]) bbMax[a] = v; }

  // ---------------------------------------------------------------- build DAG
  // groups[0] is a virtual root with infinite error holding all terminal clusters
  const groups = [{ sphere: [0, 0, 0, 0], error: Infinity, members: [], level: 99 }];
  const allClusters = []; // {idx, sphere, src, level}
  let pool = clusterize(indices, positions, null).map((c) => ({ ...c, src: 0, gsphere: c.sphere, gerror: 0, level: 0, fails: 0 }));
  // src 0 for leaves means "no source group": handled as error 0 in the file (srcGroup = -1)
  for (const c of pool) c.src = -1;
  log(`level 0: ${pool.length} clusters`);

  const localId = new Int32Array(V).fill(-1);
  const levelStats = [{ level: 0, clusters: pool.length, tris: SRC_TRIS }];
  let simplifyMs = 0, level = 0;
  while (pool.length > 1) {
    level++;
    const parts = partition(pool);
    // lock vertices shared by more than one group
    const seenBy = new Int32Array(V).fill(-1), locked = new Uint8Array(V);
    parts.forEach((g, gi) => { for (const c of g) { const idx = pool[c].idx; for (let k = 0; k < idx.length; k++) { const r = remap[idx[k]]; if (seenBy[r] < 0) seenBy[r] = gi; else if (seenBy[r] !== gi) locked[r] = 1; } } });

    const next = []; let progressed = 0, stuck = 0, trisIn = 0, trisOut = 0, sloppy = 0; const errs = [];
    for (const g of parts) {
      const members = g.map((c) => pool[c]);
      let total = 0; for (const m of members) total += m.idx.length;
      // local sub-mesh
      const lidx = new Uint32Array(total), toGlobal = []; let o = 0;
      for (const m of members) for (let k = 0; k < m.idx.length; k++) {
        const v = m.idx[k]; let l = localId[v];
        if (l < 0) { l = localId[v] = toGlobal.length; toGlobal.push(v); }
        lidx[o++] = l;
      }
      const lv = toGlobal.length, lpos = new Float32Array(lv * 3), lattr = new Float32Array(lv * 5), llock = new Uint8Array(lv);
      for (let l = 0; l < lv; l++) {
        const v = toGlobal[l]; localId[v] = -1;
        lpos[l * 3] = positions[v * 3]; lpos[l * 3 + 1] = positions[v * 3 + 1]; lpos[l * 3 + 2] = positions[v * 3 + 2];
        lattr[l * 5] = normals[v * 3]; lattr[l * 5 + 1] = normals[v * 3 + 1]; lattr[l * 5 + 2] = normals[v * 3 + 2];
        lattr[l * 5 + 3] = uvs[v * 2]; lattr[l * 5 + 4] = uvs[v * 2 + 1];
        llock[l] = locked[remap[v]] | protect[v];
      }
      const target = Math.floor((total / 3) * RATIO) * 3;
      const t = performance.now();
      const gsphere = mergeSpheres(members.map((m) => m.gsphere));
      // edge-collapse pass, error capped so that it never makes absurd collapses just to hit the count
      const errCap = Math.max(gsphere[3] * ERR_CAP, 1e-6);
      let [simp, err] = MS.simplifyWithAttributes(lidx, lpos, 3, lattr, 5, [WN, WN, WN, WUV, WUV], llock, target, errCap, ['ErrorAbsolute', 'Permissive', 'ErrorClamped']);
      if (simp.length > total * SLOPPY_AT) {
        // stuck on seams / non-manifold junk (typical for generated meshes): vertex-clustering fallback.
        // it ignores topology and UV charts, so its error is doubled (as in clusterlod.h)
        for (let l = 0; l < lv; l++) llock[l] &= 1;
        const [s2, e2] = MS.simplifySloppy(lidx, lpos, 3, llock, target, 1);
        if (s2.length > 0 && s2.length < simp.length) { simp = s2; err = e2 * MS.getScale(lpos, 3) * 2; sloppy++; }
      }
      if (EDGE_LIMIT > 0) {
        // clusterlod.h simplify_error_edge_limit: a group of triangles with edges this short cannot be
        // wrong by more than about an edge length, whatever the attribute-weighted error says.
        let maxEdgeSq = 0;
        for (let k = 0; k < total; k += 3) {
          const a = lidx[k] * 3, b = lidx[k + 1] * 3, c = lidx[k + 2] * 3;
          const ab = (lpos[a] - lpos[b]) ** 2 + (lpos[a + 1] - lpos[b + 1]) ** 2 + (lpos[a + 2] - lpos[b + 2]) ** 2;
          const ac = (lpos[a] - lpos[c]) ** 2 + (lpos[a + 1] - lpos[c + 1]) ** 2 + (lpos[a + 2] - lpos[c + 2]) ** 2;
          const bc = (lpos[b] - lpos[c]) ** 2 + (lpos[b + 1] - lpos[c + 1]) ** 2 + (lpos[b + 2] - lpos[c + 2]) ** 2;
          const emax = Math.max(ab, ac, bc), emin = Math.min(ab, ac, bc);
          maxEdgeSq = Math.max(maxEdgeSq, Math.max(emin, emax / 4));
        }
        err = Math.min(err, Math.sqrt(maxEdgeSq) * EDGE_LIMIT);
      }
      simplifyMs += performance.now() - t;
      trisIn += total / 3;
      if (simp.length > total * STUCK || simp.length === 0) {
        stuck++;
        for (const m of members) { m.fails++; if (m.fails >= 2 || parts.length === 1) { finish(m, 0); } else next.push(m); }
        trisOut += total / 3;
        continue;
      }
      progressed++;
      let gerror = err; for (const m of members) if (m.gerror > gerror) gerror = m.gerror;
      const gid = groups.length;
      groups.push({ sphere: gsphere, error: gerror, members: [], level }); errs.push(err / gsphere[3]);
      for (const m of members) finish(m, gid);
      for (const c of clusterize(simp, lpos, toGlobal)) next.push({ ...c, src: gid, gsphere, gerror, level, fails: 0 });
      trisOut += simp.length / 3;
    }
    errs.sort((a, b) => a - b);
    log(`level ${level}: ${parts.length} groups (${stuck} stuck, ${sloppy} sloppy) ${trisIn} -> ${trisOut} tris, ${next.length} clusters, err/radius median ${(errs[errs.length >> 1] || 0).toExponential(1)} max ${(errs[errs.length - 1] || 0).toExponential(1)}`);
    levelStats.push({ level, groups: parts.length, stuck, sloppy, clusters: next.length, tris: trisOut });
    pool = next;
    if (!progressed) break;
  }
  for (const m of pool) finish(m, 0);
  function finish(c, dstGroup) { const id = allClusters.length; allClusters.push(c); groups[dstGroup].members.push(id); }
  const rootTris = groups[0].members.reduce((s, id) => s + allClusters[id].idx.length / 3, 0);
  log(`DAG: ${allClusters.length} clusters, ${groups.length} groups, ${level} levels, coarsest cut ${rootTris} tris, simplify ${(simplifyMs / 1000).toFixed(1)}s`);
  const dagMs = performance.now() - T0;

  // ---------------------------------------------------------------- discrete LODs (baseline)
  const lods = [{ tris: SRC_TRIS, error: 0, idx: indices }];
  {
    const scale = MS.getScale(positions, 3); let prev = indices, accErr = 0;
    for (const ratio of LODS ? [0.25, 0.0625, 0.015625, 0.004] : []) {
      const target = Math.floor(SRC_TRIS * ratio) * 3;
      let [r, e] = MS.simplifyWithAttributes(prev, positions, 3, normals, 3, [0.5, 0.5, 0.5], protect, target, 0.01, ['Permissive']);
      let how = 'collapse';
      if (r.length > target * 1.3) { [r, e] = MS.simplifySloppy(prev, positions, 3, null, target, 1); e *= 2; how = 'sloppy'; }
      accErr += e * scale;
      lods.push({ tris: r.length / 3, error: accErr, idx: r, how }); prev = r;
      log(`discrete LOD ${ratio}: ${r.length / 3} tris (${how}), abs error ${accErr.toExponential(2)}`);
    }
  }

  // ---------------------------------------------------------------- write
  fs.mkdirSync(outDir, { recursive: true });
  // Streaming layout (Nanite keeps the top of the DAG always resident and streams the rest):
  // clusters are stored coarsest level first, so "everything down to level L" is a PREFIX of the
  // index buffer and, because vertices are numbered by first use in that order, of the vertex buffers.
  {
    const order = allClusters.map((_, i) => i).sort((x, y) => allClusters[y].level - allClusters[x].level || x - y);
    const newId = new Uint32Array(allClusters.length); order.forEach((old, n) => { newId[old] = n; });
    const sorted = order.map((i) => allClusters[i]);
    allClusters.length = 0; allClusters.push(...sorted);
    for (const g of groups) g.members = g.members.map((m) => newId[m]);
  }
  // Vertex order = coarse levels first: the vertices of level k form a compact prefix, so coarse
  // clusters do not fetch sparsely from the full-detail vertex buffer (matters a lot on integrated GPUs).
  // Discrete LODs get their own compact vertex blocks appended after the DAG vertices.
  let VT = V;
  {
    const newV = new Int32Array(V).fill(-1); let nv = 0;
    for (let i = 0; i < allClusters.length; i++) { const idx = allClusters[i].idx; for (let k = 0; k < idx.length; k++) if (newV[idx[k]] < 0) newV[idx[k]] = nv++; }
    const lodBlocks = [];
    for (const l of lods.slice(1)) {
      const m = new Map(), src = [];
      l.idx = Uint32Array.from(l.idx, (v) => { let n = m.get(v); if (n === undefined) { n = m.size; m.set(v, n); src.push(v); } return n; });
      lodBlocks.push(src);
    }
    VT = V + lodBlocks.reduce((a, b) => a + b.length, 0);
    const p2 = new Float32Array(VT * 3), n2 = new Float32Array(VT * 3), u2 = new Float32Array(VT * 2);
    const put = (from, to) => { p2[to * 3] = positions[from * 3]; p2[to * 3 + 1] = positions[from * 3 + 1]; p2[to * 3 + 2] = positions[from * 3 + 2]; n2[to * 3] = normals[from * 3]; n2[to * 3 + 1] = normals[from * 3 + 1]; n2[to * 3 + 2] = normals[from * 3 + 2]; u2[to * 2] = uvs[from * 2]; u2[to * 2 + 1] = uvs[from * 2 + 1]; };
    for (let v = 0; v < V; v++) put(v, newV[v]);
    let base = V;
    lodBlocks.forEach((src, li) => { src.forEach((v, k) => put(v, base + k)); const idx = lods[li + 1].idx; for (let k = 0; k < idx.length; k++) idx[k] += base; base += src.length; });
    for (const c of allClusters) { const idx = c.idx; for (let k = 0; k < idx.length; k++) idx[k] = newV[idx[k]]; }
    positions = p2; normals = n2; uvs = u2;
  }
  let totalIdx = 0; for (const c of allClusters) totalIdx += c.idx.length;
  const clusterIndexCount = totalIdx; for (const l of lods.slice(1)) totalIdx += l.idx.length;
  const indexBuf = new Uint32Array(totalIdx);
  const C = allClusters.length, G = groups.length;

  const clusterF = new Float32Array(C * 4), clusterU = new Int32Array(C * 4);
  let io = 0;
  allClusters.forEach((c, i) => {
    indexBuf.set(c.idx, io);
    clusterF.set(c.sphere, i * 4);
    clusterU[i * 4] = io; clusterU[i * 4 + 1] = c.idx.length; clusterU[i * 4 + 2] = c.src; clusterU[i * 4 + 3] = c.level; io += c.idx.length;
  });
  const lodMeta = [{ start: clusterIndexCount - SRC_TRIS * 3, count: SRC_TRIS * 3, tris: SRC_TRIS, error: 0 }];
  for (const l of lods.slice(1)) { indexBuf.set(l.idx, io); lodMeta.push({ start: io, count: l.idx.length, tris: l.tris, error: l.error, how: l.how }); io += l.idx.length; }
  // prefix sizes per level: loading levels >= L needs indices [0, indexEnd) and vertices [0, vertexEnd)
  const levelRanges = [];
  {
    let iEnd = 0, vEnd = 0, tris = 0;
    for (let i = 0; i < C; i++) {
      const c = allClusters[i];
      iEnd += c.idx.length; tris += c.idx.length / 3;
      for (let k = 0; k < c.idx.length; k++) if (c.idx[k] >= vEnd) vEnd = c.idx[k] + 1;
      if (i === C - 1 || allClusters[i + 1].level !== c.level) levelRanges.push({ level: c.level, indexEnd: iEnd, vertexEnd: vEnd, trisAtLevel: tris - (levelRanges.length ? levelRanges.reduce((a, l) => a + l.trisAtLevel, 0) : 0), bytes: iEnd * 4 + vEnd * 24 });
    }
  }
  const groupF = new Float32Array(G * 5), memberOff = new Uint32Array(G + 1), memberIds = new Uint32Array(C);
  let mo = 0;
  groups.forEach((g, i) => {
    groupF.set(g.sphere, i * 5); groupF[i * 5 + 4] = g.error === Infinity ? 3.0e38 : g.error;
    memberOff[i] = mo; memberIds.set(g.members, mo); mo += g.members.length;
  });
  memberOff[G] = mo;
  const nrm8 = new Int8Array(VT * 4);
  for (let i = 0; i < VT; i++) for (let a = 0; a < 3; a++) nrm8[i * 4 + a] = Math.round(Math.max(-1, Math.min(1, normals[i * 3 + a])) * 127);

  const sections = { positions, normals: nrm8, uvs, indices: indexBuf, clusterF, clusterU, groupF, memberOff, memberIds };
  const meta = { name, version: 3, levelRanges, vertices: VT, dagVertices: V, sourceTris: SRC_TRIS, clusters: C, groups: G, levels: level, coarsestTris: rootTris, clusterIndexCount, lods: lodMeta, bbMin, bbMax, levelStats, sections: {}, textures: {}, material: src.material };
  let off = 0; const chunks = [];
  for (const [k, a] of Object.entries(sections)) {
    const bytes = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    meta.sections[k] = { offset: off, bytes: bytes.length, type: a.constructor.name };
    chunks.push(bytes); off += bytes.length;
    const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  }
  fs.writeFileSync(path.join(outDir, `${name}.bin`), Buffer.concat(chunks));

  // what the same payload would cost with meshopt codecs (measured, decoder not wired in the runtime)
  {
    const encV = ME.encodeVertexBuffer(new Uint8Array(positions.buffer, positions.byteOffset, V * 12), V, 12).length
      + ME.encodeVertexBuffer(new Uint8Array(nrm8.buffer, 0, V * 4), V, 4).length
      + ME.encodeVertexBuffer(new Uint8Array(uvs.buffer, uvs.byteOffset, V * 8), V, 8).length;
    const encI = ME.encodeIndexSequence(new Uint8Array(indexBuf.buffer, 0, clusterIndexCount * 4), clusterIndexCount, 4).length;
    meta.encodedEstimate = { vertexBytes: encV, clusterIndexBytes: encI };
  }

  // textures: copied out of the GLB as they are, or downscaled with ffmpeg when textureSize is set
  for (const [slot, img] of Object.entries(src.textures)) {
    if (!img) continue;
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[img.mime] || 'bin';
    if (!TEX) {
      const out = `${name}_${slot}.${ext}`;
      fs.writeFileSync(path.join(outDir, out), img.bytes);
      meta.textures[slot] = out;
      continue;
    }
    const tmp = path.join(outDir, `_${name}_${slot}.${ext}`), out = `${name}_${slot}.jpg`;
    fs.writeFileSync(tmp, img.bytes);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-vf', `scale=${TEX}:${TEX}:flags=lanczos`, '-q:v', '3', path.join(outDir, out)]);
    } catch (e) {
      throw new Error(`resizing textures (textureSize / --tex) needs ffmpeg on the PATH: ${e.message}`);
    } finally { fs.unlinkSync(tmp); }
    meta.textures[slot] = out;
  }
  meta.buildSeconds = { dag: +(dagMs / 1000).toFixed(1), total: +((performance.now() - T0) / 1000).toFixed(1) };
  meta.binBytes = off;
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(meta));
  log(`wrote ${name}.bin ${(off / 1048576).toFixed(1)} MB (clusters idx ${(clusterIndexCount * 4 / 1048576).toFixed(1)} MB, meshopt-coded estimate ${((meta.encodedEstimate.vertexBytes + meta.encodedEstimate.clusterIndexBytes) / 1048576).toFixed(1)} MB)`);
  return { name, bin: path.join(outDir, `${name}.bin`), json: path.join(outDir, `${name}.json`), meta };
}

export { verifyClod, cutStats } from './inspect.js';
