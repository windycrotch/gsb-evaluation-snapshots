// Cluster-LOD runtime for three.js (WebGLRenderer; also runs under WebGPURenderer, see README).
//
// Drawing: one ClodBatch per mesh asset. It poses as a THREE.BatchedMesh so that the stock
// renderer issues ONE WEBGL_multi_draw call per asset and stock materials pick the instance
// matrix through gl_DrawID -> indirect texture -> matrices texture. Every selected
// (instance, cluster) pair is one entry in the multi-draw list (an index range).
//
// Selection (CPU, per frame): walk the group DAG from the root. A cluster is drawn when the
// group that produced it has projected error <= threshold while the group that consumes it
// has projected error > threshold. Errors and spheres are monotonic, so neighbours agree.
import * as THREE from 'three';

const get = async (url, init) => { const r = await fetch(url, init); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; };

/**
 * Load a whole asset written by the preprocessor: <base>/<name>.json and <base>/<name>.bin.
 * Returns the asset object that ClodBatch and DiscreteLodSet take.
 */
export async function loadClod(base, name) {
  base = String(base).replace(/\/$/, '');
  const meta = await (await get(`${base}/${name}.json`)).json();
  const buf = await (await get(`${base}/${name}.bin`)).arrayBuffer();
  const T = { Float32Array, Int8Array, Uint32Array, Int32Array };
  const sec = (k) => { const s = meta.sections[k]; const C = T[s.type]; return new C(buf, s.offset, s.bytes / C.BYTES_PER_ELEMENT); };
  const a = { meta, name };
  for (const k of Object.keys(meta.sections)) a[k] = sec(k);
  finishHierarchy(a);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(a.normals, 4, true));
  geo.setAttribute('uv', new THREE.BufferAttribute(a.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(a.indices, 1));
  const c = new THREE.Vector3().fromArray(meta.bbMin).add(new THREE.Vector3().fromArray(meta.bbMax)).multiplyScalar(0.5);
  const r = new THREE.Vector3().fromArray(meta.bbMax).sub(new THREE.Vector3().fromArray(meta.bbMin)).length() * 0.5;
  geo.boundingSphere = new THREE.Sphere(c, r);
  a.geometry = geo; a.sphere = geo.boundingSphere;
  // geometry "views" sharing the same GPU buffers, for the baselines
  a.view = (start, count) => {
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, geo.attributes[k]);
    g.setIndex(geo.index); g.setDrawRange(start, count); g.boundingSphere = geo.boundingSphere;
    return g;
  };
  return a;
}

// hierarchy-only data derived at load: products per group, finest member level per group
function finishHierarchy(a) {
  const G = a.meta.groups, C = a.meta.clusters;
  a.productOff = new Uint32Array(G + 1);
  for (let c = 0; c < C; c++) { const s = a.clusterU[c * 4 + 2]; if (s >= 0) a.productOff[s + 1]++; }
  for (let g = 0; g < G; g++) a.productOff[g + 1] += a.productOff[g];
  a.productIds = new Uint32Array(a.productOff[G]);
  const fill = a.productOff.slice(0, G);
  for (let c = 0; c < C; c++) { const s = a.clusterU[c * 4 + 2]; if (s >= 0) a.productIds[fill[s]++] = c; }
  // a group can be refined only when ALL its member clusters are resident (Nanite: the group is the streaming unit)
  a.minMemberLevel = new Uint8Array(G).fill(255);
  for (let g = 0; g < G; g++) for (let k = a.memberOff[g]; k < a.memberOff[g + 1]; k++) { const l = a.clusterU[a.memberIds[k] * 4 + 3]; if (l < a.minMemberLevel[g]) a.minMemberLevel[g] = l; }
  a.loadedLevel = 0; a.wantLevel = 255; a.residentBytes = 0; a.fullBytes = 0; a.batches = [];
}

// Streaming loader. The hierarchy (errors, spheres, group membership) is always resident; geometry is
// fetched as a growing prefix of the file with HTTP Range requests: "everything down to level L".
// This is level granularity per asset, far coarser than Nanite's 128 KB pages of cluster groups.
// options: { rootBytes = 96 KB: geometry loaded up front, delayMs = 0: artificial latency per request, for testing }
export async function loadClodStream(base, name, options = {}) {
  const { rootBytes = 96 * 1024, delayMs = 0 } = typeof options === 'number' ? { rootBytes: options } : options;
  base = String(base).replace(/\/$/, '');
  const meta = await (await get(base + '/' + name + '.json')).json();
  const url = base + '/' + name + '.bin';
  const T = { Float32Array, Int8Array, Uint32Array, Int32Array };
  const range = async (k, from, to) => { // elements [from, to) of section k
    const s = meta.sections[k], C = T[s.type], b = C.BYTES_PER_ELEMENT;
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    const r = await get(url, { headers: { Range: 'bytes=' + (s.offset + from * b) + '-' + (s.offset + to * b - 1) } });
    if (r.status !== 206) throw new Error(url + ': the server ignored the HTTP Range request, which streaming needs');
    return new C(await r.arrayBuffer());
  };
  const a = { meta, name, stream: true };
  let hBytes = 0;
  for (const k of ['clusterF', 'clusterU', 'groupF', 'memberOff', 'memberIds']) { const s = meta.sections[k]; a[k] = await range(k, 0, s.bytes / T[s.type].BYTES_PER_ELEMENT); hBytes += s.bytes; }
  finishHierarchy(a);
  a.hierarchyBytes = hBytes;
  const LR = meta.levelRanges; // coarsest first
  a.fullBytes = LR[LR.length - 1].bytes;
  const c = new THREE.Vector3().fromArray(meta.bbMin).add(new THREE.Vector3().fromArray(meta.bbMax)).multiplyScalar(0.5);
  a.sphere = new THREE.Sphere(c, new THREE.Vector3().fromArray(meta.bbMax).sub(new THREE.Vector3().fromArray(meta.bbMin)).length() * 0.5);
  a.pos = new Float32Array(0); a.nrm = new Int8Array(0); a.uv = new Float32Array(0); a.idx = new Uint32Array(0);
  let vEnd = 0, iEnd = 0;
  const grow = (old, add) => { const n = new old.constructor(old.length + add.length); n.set(old); n.set(add, old.length); return n; };
  a.loading = null; a.requests = 0;
  // fetch geometry down to `level` and swap in a bigger geometry
  a.loadTo = (level) => {
    if (a.loading) return a.loading;
    const r = LR.find((l) => l.level === level) || LR[LR.length - 1];
    if (r.vertexEnd <= vEnd && r.indexEnd <= iEnd) { a.loadedLevel = Math.min(a.loadedLevel, r.level); return Promise.resolve(); }
    a.loading = (async () => {
      const [p, n, u, i] = await Promise.all([range('positions', vEnd * 3, r.vertexEnd * 3), range('normals', vEnd * 4, r.vertexEnd * 4), range('uvs', vEnd * 2, r.vertexEnd * 2), range('indices', iEnd, r.indexEnd)]);
      a.requests += 4;
      a.pos = grow(a.pos, p); a.nrm = grow(a.nrm, n); a.uv = grow(a.uv, u); a.idx = grow(a.idx, i);
      vEnd = r.vertexEnd; iEnd = r.indexEnd;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(a.nrm, 4, true));
      geo.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(a.idx, 1));
      geo.boundingSphere = a.sphere;
      const old = a.geometry; a.geometry = geo;
      for (const b of a.batches) b.geometry = geo;
      if (old) old.dispose();
      a.loadedLevel = r.level; a.residentBytes = r.bytes; a.loading = null;
    })();
    return a.loading;
  };
  // root "page": as many top levels as fit in rootBytes, but always every cluster of the virtual root group
  let rootLevel = LR[0].level;
  for (const l of LR) if (l.bytes <= rootBytes) rootLevel = l.level;
  rootLevel = Math.min(rootLevel, a.minMemberLevel[0]);
  a.loadedLevel = 255;
  await a.loadTo(rootLevel);
  a.rootLevel = rootLevel;
  return a;
}

/**
 * Call once per frame after ClodSelector.select() for assets from loadClodStream: starts a fetch for
 * every asset whose last selection wanted finer levels than are loaded. Returns the pending promises.
 */
export function updateStreaming(assets) {
  const pending = [];
  for (const a of assets) {
    if (!a.stream) continue;
    if (a.wantLevel < a.loadedLevel && !a.loading) pending.push(a.loadTo(a.wantLevel));
    a.wantLevel = 255;
  }
  return pending;
}

/**
 * Convenience: a MeshStandardMaterial from the textures and factors the preprocessor copied out of the GLB.
 * Any stock three.js material works with ClodBatch; this only saves the wiring.
 */
export function loadClodMaterial(base, asset, params = {}) {
  base = String(base).replace(/\/$/, '');
  const t = asset.meta.textures || {}, m = asset.meta.material || {}, loader = new THREE.TextureLoader();
  const tex = (file, srgb) => { const x = loader.load(`${base}/${file}`); x.flipY = false; x.wrapS = x.wrapT = THREE.RepeatWrapping; x.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; x.anisotropy = 4; return x; };
  const orm = t.orm ? tex(t.orm) : null, c = m.baseColorFactor || [1, 1, 1];
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(c[0], c[1], c[2]),
    map: t.basecolor ? tex(t.basecolor, true) : null,
    normalMap: t.normal ? tex(t.normal) : null,
    roughnessMap: orm, metalnessMap: orm,
    roughness: m.roughnessFactor ?? 1, metalness: m.metallicFactor ?? (orm ? 1 : 0),
    side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    ...params,
  });
}

// debug colouring: cluster id / DAG level arrive through the second channel of the indirect texture
export const debugUniform = { value: 0 };
export function patchDebug(material) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uDebugMode = debugUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <batching_pars_vertex>', '#include <batching_pars_vertex>\nuniform int uDebugMode;\nflat varying vec3 vDbg;')
      .replace('#include <batching_vertex>', `#include <batching_vertex>
        vDbg = vec3( 1.0 );
        #ifdef USE_BATCHING
        if ( uDebugMode > 0 ) {
          int dsz = textureSize( batchingIdTexture, 0 ).x;
          uvec4 dt = texelFetch( batchingIdTexture, ivec2( gl_DrawID % dsz, gl_DrawID / dsz ), 0 );
          if ( uDebugMode == 1 ) { uint h = ( dt.g & 0xffffffu ) * 2654435761u + dt.r * 40503u; vDbg = vec3( float( h & 255u ), float( ( h >> 8 ) & 255u ), float( ( h >> 16 ) & 255u ) ) / 255.0 * 0.92 + 0.04; }
          else { float lv = float( dt.g >> 24 ); vDbg = 0.5 + 0.5 * cos( 6.28318 * ( lv * 0.09 + vec3( 0.0, 0.33, 0.67 ) ) ); }
        }
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform int uDebugMode;\nflat varying vec3 vDbg;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nif ( uDebugMode > 0 ) diffuseColor.rgb = vDbg;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif ( uDebugMode > 0 ) metalnessFactor = 0.0;');
  };
  material.customProgramCacheKey = () => 'clod-debug';
  return material;
}

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _p = new THREE.Plane(), _s = new THREE.Sphere();

export class ClodBatch extends THREE.Mesh {
  constructor(asset, material, matrices) {
    super(asset.geometry, material);
    this.isBatchedMesh = true; this.frustumCulled = false;
    this._multiDrawBytesPerElement = 4; // 32-bit indices; read by the WebGPU backend only
    this.asset = asset; this.count = matrices.length; if (asset.batches) asset.batches.push(this);
    const n = this.count;
    let size = Math.max(4, Math.ceil(Math.sqrt(n * 4) / 4) * 4);
    const md = new Float32Array(size * size * 4);
    this.inv = []; this.worldSphere = new Float32Array(n * 4);
    matrices.forEach((m, i) => {
      m.toArray(md, i * 16); this.inv.push(m.clone().invert());
      _s.copy(asset.sphere).applyMatrix4(m);
      this.worldSphere.set([_s.center.x, _s.center.y, _s.center.z, _s.radius], i * 4);
    });
    this.matrices = matrices;
    this._matricesTexture = new THREE.DataTexture(md, size, size, THREE.RGBAFormat, THREE.FloatType);
    this._matricesTexture.needsUpdate = true;
    this._colorsTexture = null; this._multiDrawInstances = null; this._previousMatricesTexture = null;
    this._multiDrawCount = 0;
    this._alloc(8192);
    // per-frame instance data in mesh-local space
    this.camL = new Float64Array(n * 3); this.planesL = new Float64Array(n * 24); this.visible_ = new Uint8Array(n);
    this.order = new Int32Array(n); this.dist = new Float32Array(n);
    this.stamp = new Int32Array(asset.meta.groups); this.stampId = 0;
    this.refined = null; this.pushed = null; // budget mode, allocated lazily
  }
  _alloc(cap) {
    const size = Math.ceil(Math.sqrt(cap)); cap = size * size;
    const starts = new Int32Array(cap), counts = new Int32Array(cap), ind = new Uint32Array(cap * 2);
    if (this._multiDrawStarts) { starts.set(this._multiDrawStarts); counts.set(this._multiDrawCounts); ind.set(this.indirect); }
    this._multiDrawStarts = starts; this._multiDrawCounts = counts; this.indirect = ind; this.cap = cap;
    this._mergedDrawInstanceCounts = new Int32Array(cap).fill(1);
    this._indirectTexture?.dispose();
    this._indirectTexture = new THREE.DataTexture(ind, size, size, THREE.RGIntegerFormat, THREE.UnsignedIntType);
    this._indirectTexture.needsUpdate = true;
  }
  // three r187+ WebGPU backend: BatchedMesh draws come as "merged" ranges with an instance count each, and the
  // instance index looks up the indirect texture. One instance per range keeps that identical to the multi-draw list.
  get _mergedDrawStarts() { return this._multiDrawStarts; }
  get _mergedDrawCounts() { return this._multiDrawCounts; }
  get _mergedDrawCount() { return this._multiDrawCount; }
  _updateDrawParameters() {} // the draw list is written by ClodSelector.select(), not per render call
  // camera position and frustum planes in the local space of every instance
  prepare(camPos, frustum, hzb) {
    let occluded = 0;
    const n = this.count, ws = this.worldSphere, cl = this.camL, pl = this.planesL;
    for (let i = 0; i < n; i++) {
      _s.center.set(ws[i * 4], ws[i * 4 + 1], ws[i * 4 + 2]); _s.radius = ws[i * 4 + 3];
      this.dist[i] = _s.center.distanceTo(camPos);
      if (!(this.visible_[i] = frustum.intersectsSphere(_s) ? 1 : 0)) continue;
      if (hzb && sphereOccluded(hzb, ws[i * 4], ws[i * 4 + 1], ws[i * 4 + 2], ws[i * 4 + 3])) { this.visible_[i] = 0; occluded++; continue; }
      const inv = this.inv[i];
      _v.copy(camPos).applyMatrix4(inv); cl[i * 3] = _v.x; cl[i * 3 + 1] = _v.y; cl[i * 3 + 2] = _v.z;
      for (let k = 0; k < 6; k++) {
        _p.copy(frustum.planes[k]).applyMatrix4(inv); // plane into local space
        const o = i * 24 + k * 4; pl[o] = _p.normal.x; pl[o + 1] = _p.normal.y; pl[o + 2] = _p.normal.z; pl[o + 3] = _p.constant;
      }
    }
    return occluded;
  }
}

// ------------------------------------------------------------------ occlusion (previous-frame HZB, CPU side)
// Imitation of the first half of Nanite's two-pass occlusion culling: test bounds against the depth
// of an EARLIER frame, using that frame's view-projection. There is no second pass, so something that
// becomes visible shows up a few frames late. hzb = { data: Float32Array (farthest depth per texel, RGBA),
// w, h, vp: Float32Array(16) of that frame, near, far, px, py (projection scale) }.
export function sphereOccluded(hzb, x, y, z, r) {
  const m = hzb.vp;
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  const zv = cw - r; // view distance of the nearest point of the sphere
  if (zv <= hzb.near * 2) return false;
  const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw, cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
  const rx = r * hzb.px / zv, ry = r * hzb.py / zv;
  if (cx + rx > 1 || cx - rx < -1 || cy + ry > 1 || cy - ry < -1) return false; // partly off screen: no depth to test against
  const x0 = Math.floor((cx - rx) * 0.5 * hzb.w + hzb.w * 0.5), x1 = Math.min(hzb.w - 1, Math.floor((cx + rx) * 0.5 * hzb.w + hzb.w * 0.5));
  const y0 = Math.floor((cy - ry) * 0.5 * hzb.h + hzb.h * 0.5), y1 = Math.min(hzb.h - 1, Math.floor((cy + ry) * 0.5 * hzb.h + hzb.h * 0.5));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return false; // large on screen: not worth testing
  const f = hzb.far, n = hzb.near, depth = ((f + n) / (f - n) - (2 * f * n) / ((f - n) * zv)) * 0.5 + 0.5;
  const d = hzb.data, w = hzb.w;
  for (let yy = Math.max(0, y0); yy <= y1; yy++) for (let xx = Math.max(0, x0); xx <= x1; xx++) if (d[(yy * w + xx) * 4] >= depth) return false;
  return true;
}

// ------------------------------------------------------------------ selection
export class ClodSelector {
  constructor(batches) {
    this.batches = batches; this.frame = 0;
    this.hKey = new Float64Array(1024); this.hRef = new Int32Array(1024 * 3); this.hN = 0;
    this.rList = new Int32Array(4096 * 3); this.rN = 0;
    this.frustum = new THREE.Frustum(); this.stats = { tris: 0, clusters: 0, visited: 0, ms: 0, threshold: 0 };
    this.frustumCull = true;
  }

  // opts: { errorPx, budget (0 = off) }
  select(camera, viewportHeight, opts) {
    const t0 = performance.now();
    camera.updateMatrixWorld();
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    this.K = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    let occ = 0;
    for (const b of this.batches) { occ += b.prepare(camPos, this.frustum, this.hzb || null); b._n = 0; }
    this.stats.occluded = occ;
    this.frame++;
    const st = this.stats; st.tris = 0; st.clusters = 0; st.visited = 0;
    if (opts.budget > 0) this._selectBudget(opts.errorPx, opts.budget);
    else { for (const b of this.batches) this._selectThreshold(b, opts.errorPx); st.threshold = opts.errorPx; }
    for (const b of this.batches) { b._multiDrawCount = b._n; b._indirectTexture.needsUpdate = true; st.clusters += b._n; }
    st.ms = performance.now() - t0;
    return st;
  }

  _selectThreshold(b, t) {
    const a = b.asset, gF = a.groupF, cF = a.clusterF, cU = a.clusterU, mOff = a.memberOff, mIds = a.memberIds;
    const minLv = a.minMemberLevel, loaded = a.loadedLevel; let want = a.wantLevel;
    const dstack = this._dstack || (this._dstack = new Int32Array(8192));
    const K = this.K, cull = this.frustumCull, stamp = b.stamp, stack = this._stack || (this._stack = new Int32Array(8192));
    let n = b._n, tris = 0, visited = 0;
    // near instances first: cheap early-z
    let m = 0; for (let i = 0; i < b.count; i++) if (b.visible_[i]) b.order[m++] = i;
    const ord = b.order.subarray(0, m).sort((x, y) => b.dist[x] - b.dist[y]);
    for (let oi = 0; oi < m; oi++) {
      const i = ord[oi], cx = b.camL[i * 3], cy = b.camL[i * 3 + 1], cz = b.camL[i * 3 + 2], pl = b.planesL, po = i * 24;
      const sid = ++b.stampId; let sp = 0; stack[sp++] = 0;
      while (sp > 0) {
        const g = stack[--sp]; visited++;
        for (let k = mOff[g], e = mOff[g + 1]; k < e; k++) {
          const c = mIds[k], s = cU[c * 4 + 2];
          if (s >= 0) {
            const o = s * 5, dx = gF[o] - cx, dy = gF[o + 1] - cy, dz = gF[o + 2] - cz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - gF[o + 3];
            if (d <= 1e-6 || gF[o + 4] * K > t * d) { // source group still too coarse: refine
              if (minLv[s] < loaded) { // finer data not resident: draw this cluster as a leaf and ask for more
                if (minLv[s] < want) want = minLv[s];
                if (stamp[s] !== sid && !a.loading) {
                  stamp[s] = sid; let dp = 0; dstack[dp++] = s;
                  while (dp > 0) {
                    const dg = dstack[--dp];
                    for (let dk = mOff[dg], de = mOff[dg + 1]; dk < de; dk++) {
                      const s2 = cU[mIds[dk] * 4 + 2]; if (s2 < 0 || stamp[s2] === sid) continue;
                      const o2 = s2 * 5, ex = gF[o2] - cx, ey = gF[o2 + 1] - cy, ez = gF[o2 + 2] - cz, d2 = Math.sqrt(ex * ex + ey * ey + ez * ez) - gF[o2 + 3];
                      if (!(d2 <= 1e-6 || gF[o2 + 4] * K > t * d2)) continue;
                      stamp[s2] = sid;
                      if (cull) { let vis = true; const x = gF[o2], y = gF[o2 + 1], z = gF[o2 + 2], r = gF[o2 + 3]; for (let q = po; q < po + 24; q += 4) if (pl[q] * x + pl[q + 1] * y + pl[q + 2] * z + pl[q + 3] < -r) { vis = false; break; } if (!vis) continue; }
                      if (minLv[s2] < want) want = minLv[s2];
                      dstack[dp++] = s2;
                    }
                  }
                }
              }
              else {
              if (stamp[s] !== sid) {
                stamp[s] = sid;
                let vis = true;
                if (cull) { const x = gF[o], y = gF[o + 1], z = gF[o + 2], r = gF[o + 3]; for (let q = po; q < po + 24; q += 4) if (pl[q] * x + pl[q + 1] * y + pl[q + 2] * z + pl[q + 3] < -r) { vis = false; break; } }
                if (vis) stack[sp++] = s;
              }
              continue;
              }
            }
          }
          if (cull) { const o = c * 4, x = cF[o], y = cF[o + 1], z = cF[o + 2], r = cF[o + 3]; let vis = true; for (let q = po; q < po + 24; q += 4) if (pl[q] * x + pl[q + 1] * y + pl[q + 2] * z + pl[q + 3] < -r) { vis = false; break; } if (!vis) continue; }
          if (n >= b.cap) b._alloc(b.cap * 2);
          b._multiDrawStarts[n] = cU[c * 4] * 4; b._multiDrawCounts[n] = cU[c * 4 + 1];
          b.indirect[n * 2] = i; b.indirect[n * 2 + 1] = c | (cU[c * 4 + 3] << 24); n++;
          tris += cU[c * 4 + 1];
        }
      }
    }
    b._n = n; this.stats.tris += tris / 3; this.stats.visited += visited; a.wantLevel = want;
  }

  // ---- budget mode: refine the globally worst group first until the triangle budget is spent
  _push(key, bi, i, g) {
    if (this.hN >= this.hKey.length) { const k = new Float64Array(this.hN * 2); k.set(this.hKey); this.hKey = k; const r = new Int32Array(this.hN * 6); r.set(this.hRef); this.hRef = r; }
    const hK = this.hKey, hR = this.hRef; let p = this.hN++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (hK[q] > key || (hK[q] === key && hR[q * 3 + 2] >= g)) break;
      hK[p] = hK[q]; hR[p * 3] = hR[q * 3]; hR[p * 3 + 1] = hR[q * 3 + 1]; hR[p * 3 + 2] = hR[q * 3 + 2]; p = q;
    }
    hK[p] = key; hR[p * 3] = bi; hR[p * 3 + 1] = i; hR[p * 3 + 2] = g;
  }
  _pop(out) {
    const hK = this.hKey, hR = this.hRef;
    out[0] = hR[0]; out[1] = hR[1]; out[2] = hR[2]; const topKey = hK[0];
    const n = --this.hN; if (n === 0) return topKey;
    const key = hK[n], b0 = hR[n * 3], b1 = hR[n * 3 + 1], b2 = hR[n * 3 + 2];
    let p = 0;
    for (;;) {
      let c = p * 2 + 1; if (c >= n) break;
      if (c + 1 < n && (hK[c + 1] > hK[c] || (hK[c + 1] === hK[c] && hR[(c + 1) * 3 + 2] > hR[c * 3 + 2]))) c++;
      if (key > hK[c] || (key === hK[c] && b2 >= hR[c * 3 + 2])) break;
      hK[p] = hK[c]; hR[p * 3] = hR[c * 3]; hR[p * 3 + 1] = hR[c * 3 + 1]; hR[p * 3 + 2] = hR[c * 3 + 2]; p = c;
    }
    hK[p] = key; hR[p * 3] = b0; hR[p * 3 + 1] = b1; hR[p * 3 + 2] = b2;
    return topKey;
  }
  _vis(b, i, F, o) { // sphere at F[o..o+3] against the instance's local frustum
    if (!this.frustumCull) return true;
    const pl = b.planesL, x = F[o], y = F[o + 1], z = F[o + 2], r = F[o + 3];
    for (let q = i * 24, e = q + 24; q < e; q += 4) if (pl[q] * x + pl[q + 1] * y + pl[q + 2] * z + pl[q + 3] < -r) return false;
    return true;
  }
  // mark (instance, group) refined: its member clusters enter the cut, their source groups become candidates
  _refine(bi, i, g, floorPx) {
    const b = this.batches[bi], a = b.asset, G = a.meta.groups, cU = a.clusterU, gF = a.groupF, frame = this.frame;
    b.refined[i * G + g] = frame;
    if (this.rN * 3 >= this.rList.length) { const r = new Int32Array(this.rList.length * 2); r.set(this.rList); this.rList = r; }
    this.rList[this.rN * 3] = bi; this.rList[this.rN * 3 + 1] = i; this.rList[this.rN * 3 + 2] = g; this.rN++;
    let add = 0;
    const cx = b.camL[i * 3], cy = b.camL[i * 3 + 1], cz = b.camL[i * 3 + 2];
    for (let k = a.memberOff[g], e = a.memberOff[g + 1]; k < e; k++) {
      const c = a.memberIds[k], s = cU[c * 4 + 2];
      if (this._vis(b, i, a.clusterF, c * 4)) add += cU[c * 4 + 1];
      if (s >= 0 && b.pushed[i * G + s] !== frame) {
        b.pushed[i * G + s] = frame;
        if (!this._vis(b, i, gF, s * 5)) continue;
        const o = s * 5, dx = gF[o] - cx, dy = gF[o + 1] - cy, dz = gF[o + 2] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - gF[o + 3];
        const err = d <= 1e-6 ? Infinity : gF[o + 4] * this.K / d;
        if (err > floorPx) this._push(err, bi, i, s);
      }
    }
    return add / 3;
  }
  _selectBudget(floorPx, budget) {
    const frame = this.frame; this.hN = 0; this.rN = 0;
    let count = 0, lastKey = Infinity;
    this.batches.forEach((b, bi) => {
      const G = b.asset.meta.groups;
      if (!b.refined) { b.refined = new Int32Array(b.count * G); b.pushed = new Int32Array(b.count * G); }
      for (let i = 0; i < b.count; i++) if (b.visible_[i]) count += this._refine(bi, i, 0, floorPx);
    });
    const top = [0, 0, 0];
    while (this.hN > 0 && count < budget) {
      lastKey = this._pop(top);
      const b = this.batches[top[0]], a = b.asset, i = top[1], g = top[2];
      if (a.minMemberLevel[g] < a.loadedLevel && a.minMemberLevel[g] < a.wantLevel) a.wantLevel = a.minMemberLevel[g]; // wanted but not resident
      // the clusters this group produced are all in the cut right now; they leave it
      let rem = 0;
      for (let k = a.productOff[g], e = a.productOff[g + 1]; k < e; k++) { const c = a.productIds[k]; if (this._vis(b, i, a.clusterF, c * 4)) rem += a.clusterU[c * 4 + 1]; }
      count += this._refine(top[0], i, g, floorPx) - rem / 3;
    }
    // effective pixel error = the worst candidate that was left unrefined
    this.stats.threshold = this.hN > 0 ? this.hKey[0] : floorPx;
    this.stats.visited = this.rN;
    // emit: members of refined groups whose own source group is not refined
    let tris = 0;
    for (let r = 0; r < this.rN; r++) {
      const b = this.batches[this.rList[r * 3]], a = b.asset, i = this.rList[r * 3 + 1], g = this.rList[r * 3 + 2];
      const G = a.meta.groups, cU = a.clusterU, minLv = a.minMemberLevel, loaded = a.loadedLevel;
      if (minLv[g] < loaded) continue; // members not resident: the group above draws its product instead
      for (let k = a.memberOff[g], e = a.memberOff[g + 1]; k < e; k++) {
        const c = a.memberIds[k], s = cU[c * 4 + 2];
        if (s >= 0 && b.refined[i * G + s] === frame && minLv[s] >= loaded) continue;
        if (!this._vis(b, i, a.clusterF, c * 4)) continue;
        let n = b._n; if (n >= b.cap) b._alloc(b.cap * 2);
        b._multiDrawStarts[n] = cU[c * 4] * 4; b._multiDrawCounts[n] = cU[c * 4 + 1];
        b.indirect[n * 2] = i; b.indirect[n * 2 + 1] = c | (cU[c * 4 + 3] << 24); b._n = n + 1;
        tris += cU[c * 4 + 1];
      }
    }
    this.stats.tris = tris / 3;
  }
}

// ------------------------------------------------------------------ baselines
// Discrete LODs: one InstancedMesh per (asset, level); level picked per instance with the same
// projected-error metric. "full" = level 0 forced for everything.
export class DiscreteLodSet extends THREE.Group {
  constructor(asset, material, matrices) {
    super();
    this.asset = asset; this.matrices = matrices; this.levels = [];
    this.worldSphere = matrices.map((m) => asset.sphere.clone().applyMatrix4(m));
    this.scales = matrices.map((m) => m.getMaxScaleOnAxis());
    for (const l of asset.meta.lods) {
      const im = new THREE.InstancedMesh(asset.view(l.start, l.count), material, matrices.length);
      im.frustumCulled = false; im.count = 0; im.userData.lod = l;
      this.levels.push(im); this.add(im);
    }
  }
  select(camPos, frustum, K, errorPx, forceFull) {
    const L = this.levels; for (const im of L) im.count = 0;
    let tris = 0, drawn = 0;
    for (let i = 0; i < this.matrices.length; i++) {
      const s = this.worldSphere[i];
      if (!frustum.intersectsSphere(s)) continue;
      let lv = 0;
      if (!forceFull) {
        const d = Math.max(s.center.distanceTo(camPos) - s.radius, 1e-6);
        for (let k = L.length - 1; k > 0; k--) if (L[k].userData.lod.error * this.scales[i] * K / d <= errorPx) { lv = k; break; }
      }
      const im = L[lv]; this.matrices[i].toArray(im.instanceMatrix.array, im.count * 16); im.count++;
      tris += im.userData.lod.tris; drawn++;
    }
    for (const im of L) { im.visible = im.count > 0; im.instanceMatrix.needsUpdate = true; }
    return { tris, drawn };
  }
}
