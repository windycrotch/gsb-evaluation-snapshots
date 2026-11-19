// Streaming checks without a browser: build a small model, serve it through a controllable fetch stub
// (Range -> 206, non-206 failure, delayed responses, repeated calls) and drive loadClodStream /
// updateStreaming / ClodSelector the way a frame loop does.
//
// Guarantees under test:
//  - a failed load leaves the last good (coarser) level drawable and its geometry untouched
//  - the next selection asks for that level again and the retry succeeds
//  - one asset has at most one in-flight request; repeated loadTo/updateStreaming share it
//  - fetched geometry is swapped in only after a selection, so no draw list outlives its buffers
//  - the selector draws a coarser cut while a finer level is missing, records the level it needs,
//    and stops requesting levels that are already resident
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';
import { loadClodStream, loadClod, updateStreaming, ClodBatch, ClodSelector } from '../src/clod.js';
import { cutStats } from '../src/inspect.js';

const quiet = () => {};
const BASE = 'https://clod.test/data';
const NAME = 'small';
const VIEWPORT = 720;

// ------------------------------------------------------------------ a fake HTTP host with an honest Range implementation
function makeServer(jsonPath, binPath) {
  const files = new Map([
    [`${BASE}/${NAME}.json`, fs.readFileSync(jsonPath)],
    [`${BASE}/${NAME}.bin`, fs.readFileSync(binPath)],
  ]);
  const s = {
    calls: [],        // one entry per .bin request: { range, from, to }
    failNext: 0,      // answer this many upcoming .bin requests with HTTP 503
    ignoreRange: 0,   // answer this many upcoming .bin requests with 200 + the whole file
    delayMs: 0,       // latency before answering any request
    async fetch(url, init = {}) {
      if (s.delayMs) await new Promise((res) => setTimeout(res, s.delayMs));
      const body = files.get(url);
      if (!body) return reply(404, Buffer.alloc(0));
      if (url.endsWith('.json')) return reply(200, body);
      const header = (init.headers || {}).Range;
      if (!header) return reply(200, body); // plain whole-file GET (loadClod)
      const m = /bytes=(\d+)-(\d+)/.exec(header);
      if (!m) return reply(400, Buffer.alloc(0));
      const from = +m[1], to = +m[2];
      s.calls.push({ range: header, from, to });
      if (s.failNext > 0) { s.failNext--; return reply(503, Buffer.alloc(0)); }
      if (s.ignoreRange > 0) { s.ignoreRange--; return reply(200, body); }
      return reply(206, body.subarray(from, to + 1));
    },
  };
  return s;
}
function reply(status, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// what the batch would hand to the GPU this frame
function drawList(batch, asset) {
  const out = { tris: 0, calls: 0, levels: new Set(), minLevel: 255, maxLevel: -1 };
  for (let n = 0; n < batch._multiDrawCount; n++) {
    const c = batch.indirect[n * 2 + 1] & 0xffffff;
    const level = asset.clusterU[c * 4 + 3];
    out.tris += batch._multiDrawCounts[n] / 3; out.calls++;
    out.levels.add(level); out.minLevel = Math.min(out.minLevel, level); out.maxLevel = Math.max(out.maxLevel, level);
  }
  return out;
}
// every index the current draw list can touch must exist in the geometry the batch points at.
// _multiDrawStarts holds the byte offset of each range (32-bit indices, so 4 bytes per index).
function assertDrawListResident(batch, asset, label) {
  const indexLength = batch.geometry.index.count, vertexCount = batch.geometry.attributes.position.count;
  assert.equal(batch.geometry.index.array.length, asset.idx.length, `${label}: geometry index buffer is the asset prefix`);
  for (let n = 0; n < batch._multiDrawCount; n++) {
    const start = batch._multiDrawStarts[n] / 4, count = batch._multiDrawCounts[n];
    assert.ok(start + count <= indexLength, `${label}: draw range ${start}+${count} outside geometry (${indexLength})`);
    for (let k = start; k < start + count; k++) assert.ok(asset.idx[k] < vertexCount, `${label}: index ${asset.idx[k]} outside vertex prefix (${vertexCount})`);
  }
}
// brute-force reference cut: cluster c is drawn iff err(src) <= t < err(dst), with everything resident
function referenceCut(meta, sections, cam, K, t) {
  const cU = sections.clusterU, gF = sections.groupF, mOff = sections.memberOff, mIds = sections.memberIds;
  const dst = new Int32Array(meta.clusters).fill(-1);
  for (let g = 0; g < meta.groups; g++) for (let k = mOff[g]; k < mOff[g + 1]; k++) dst[mIds[k]] = g;
  const err = (g) => {
    if (g < 0) return 0; const o = g * 5;
    const d = Math.hypot(gF[o] - cam.x, gF[o + 1] - cam.y, gF[o + 2] - cam.z) - gF[o + 3];
    return d <= 1e-6 ? Infinity : gF[o + 4] * K / d;
  };
  let tris = 0; const levels = new Set();
  for (let c = 0; c < meta.clusters; c++) {
    if (err(cU[c * 4 + 2]) <= t && err(dst[c]) > t) { tris += cU[c * 4 + 1] / 3; levels.add(cU[c * 4 + 3]); }
  }
  return { tris, levels };
}

// brute-force cut for a *partially resident* asset, matching the selector's cut definition:
//  - a group is "enterable" when its consumer group was entered, that consumer could be refined, and the
//    group's members are all resident (`minMemberLevel >= loaded`). Group 0 (the virtual root) is entered.
//  - a cluster c is drawn when its consumer group is entered and c is not replaced by a refinement, i.e.
//    src(c) < 0 or src(c) is not enterable-and-refinable.
// The DAG is not a tree (a group's products can be consumed by several groups), so entered-ness is a BFS
// over src edges, not a parent lookup.
function referenceCutRestricted(meta, sections, cam, K, t, loaded) {
  const cU = sections.clusterU, gF = sections.groupF, mOff = sections.memberOff, mIds = sections.memberIds;
  const C = meta.clusters, G = meta.groups;
  const dst = new Int32Array(C).fill(-1), minMember = new Uint8Array(G).fill(255);
  for (let g = 0; g < G; g++) for (let k = mOff[g]; k < mOff[g + 1]; k++) { dst[mIds[k]] = g; minMember[g] = Math.min(minMember[g], cU[mIds[k] * 4 + 3]); }
  const err = (g) => {
    const o = g * 5;
    const d = Math.hypot(gF[o] - cam.x, gF[o + 1] - cam.y, gF[o + 2] - cam.z) - gF[o + 3];
    return d <= 1e-6 ? Infinity : gF[o + 4] * K / d;
  };
  const refinable = (g) => g >= 0 && minMember[g] >= loaded && err(g) > t;
  const entered = new Uint8Array(G); entered[0] = 1;
  const queue = [0];
  while (queue.length) {
    const g = queue.pop();
    if (!refinable(g)) continue;
    for (let k = mOff[g]; k < mOff[g + 1]; k++) {
      const s = cU[mIds[k] * 4 + 2];
      if (s >= 0 && !entered[s]) { entered[s] = 1; queue.push(s); }
    }
  }
  let tris = 0; const levels = new Set();
  for (let c = 0; c < C; c++) {
    const g = dst[c]; if (g < 0 || !entered[g]) continue;
    if (refinable(cU[c * 4 + 2])) continue; // replaced by finer, resident clusters
    if (cU[c * 4 + 3] < loaded) continue;   // not resident, cannot be drawn
    tris += cU[c * 4 + 1] / 3; levels.add(cU[c * 4 + 3]);
  }
  return { tris, levels };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));
const realFetch = globalThis.fetch;
try {
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 32 }));
  const built = await buildClod({ input: glb, outDir: tmp, name: NAME, maxTriangles: 20000, lods: false, log: quiet });
  const meta = JSON.parse(fs.readFileSync(built.json, 'utf8'));
  assert.ok(meta.levels >= 4, `expected a few levels to stream, got ${meta.levels}`);
  const bin = fs.readFileSync(built.bin);
  const T = { Float32Array, Int8Array, Uint32Array, Int32Array };
  const sec = (k) => { const s = meta.sections[k]; const C = T[s.type]; return new C(bin.buffer.slice(bin.byteOffset + s.offset, bin.byteOffset + s.offset + s.bytes)); };
  const sections = { clusterU: sec('clusterU'), groupF: sec('groupF'), memberOff: sec('memberOff'), memberIds: sec('memberIds') };
  const ROOT_BYTES = meta.levelRanges[0].bytes;

  const server = makeServer(built.json, built.bin);
  globalThis.fetch = (url, init) => server.fetch(url, init);

  // a camera close enough that 1 px wants the finest level
  const centre = new THREE.Vector3().fromArray(meta.bbMin).add(new THREE.Vector3().fromArray(meta.bbMax)).multiplyScalar(0.5);
  const radius = new THREE.Vector3().fromArray(meta.bbMax).sub(new THREE.Vector3().fromArray(meta.bbMin)).length() * 0.5;
  const cameraAt = (scale) => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.001, 1000);
    cam.position.copy(centre).add(new THREE.Vector3(radius * scale, radius * scale * 0.65, radius * scale));
    cam.lookAt(centre);
    return cam;
  };
  const K = VIEWPORT / (2 * Math.tan(THREE.MathUtils.degToRad(60) / 2));
  // a view between the root and the finest level, so a failed request still has a finer level above it
  const midCamera = (() => {
    for (const scale of [1, 1.5, 2, 3, 4]) {
      const cam = cameraAt(scale), r = referenceCut(meta, sections, cam.position, K, 1);
      const finest = Math.min(...r.levels);
      if (r.tris > meta.coarsestTris && finest > 0 && finest >= Math.ceil(meta.levels / 2)) return cam;
    }
    return cameraAt(2);
  })();
  const camera = midCamera;
  const material = new THREE.MeshBasicMaterial();
  const matrix = new THREE.Matrix4();
  // one frame of a streamed asset: select, then pump the loader; returns what select recorded and the promises
  const frame = (selector, asset, errorPx = 1) => {
    const stats = selector.select(camera, VIEWPORT, { errorPx });
    const want = asset.wantLevel;
    return { stats, want, pending: updateStreaming([asset]) };
  };
  const levelOf = (level) => meta.levelRanges.find((l) => l.level === level);

  console.log(`built ${meta.sourceTris} tris, ${meta.clusters} clusters, ${meta.levels} levels`);
  console.log(`level bytes ${meta.levelRanges.map((l) => `${l.level}:${l.bytes}`).join(' ')}`);

  // ---------------------------------------------------------------- 1. root page; the next selection wants more
  const asset = await loadClodStream(BASE, NAME, { rootBytes: ROOT_BYTES });
  assert.equal(asset.loadedLevel, meta.levelRanges[0].level, 'root page is the coarsest level');
  assert.equal(asset.pending, null, 'nothing pending after the root page');
  assert.equal(asset.geometry.index.count, meta.levelRanges[0].indexEnd, 'root geometry is the coarsest index prefix');
  const geometryBefore = asset.geometry;
  const batch = new ClodBatch(asset, material, [matrix]);
  const selector = new ClodSelector([batch]);
  selector.frustumCull = false; // measure the cut itself, not the frustum
  assert.equal(asset.batches.length, 1, 'the batch registers with the asset');

  // ---------------------------------------------------------------- 2. a failed load keeps the coarse level drawable
  server.failNext = 4; // all four section ranges of the next fetch
  let callsBefore = server.calls.length;
  let st = frame(selector, asset);
  const rootDraw = drawList(batch, asset);
  assert.ok(rootDraw.tris <= meta.coarsestTris + 1e-6, `root cut draws the coarsest clusters (${rootDraw.tris} <= ${meta.coarsestTris})`);
  assert.equal(st.stats.tris, rootDraw.tris, 'stats count the draw list');
  assert.ok(st.want < asset.loadedLevel, `selection asks for a finer level (${st.want} < ${asset.loadedLevel})`);
  assert.equal(st.pending.length, 1, 'updateStreaming returns one promise');
  assertDrawListResident(batch, asset, 'root page');
  await Promise.all(st.pending);
  assert.equal(server.calls.length - callsBefore, 4, 'one Range request per section, no retry storm within a frame');
  assert.ok(asset.loadError instanceof Error, 'the failure is recorded on asset.loadError');
  assert.equal(asset.loadedLevel, meta.levelRanges[0].level, 'loadedLevel did not move on failure');
  assert.equal(asset.geometry, geometryBefore, 'a failed load did not replace the geometry');
  assert.equal(asset.pending, null, 'no partial prefix is committed after a failure');
  selector.select(camera, VIEWPORT, { errorPx: 1 }); // a plain selection: records the wanted level again
  const afterFail = drawList(batch, asset);
  assert.equal(afterFail.tris, rootDraw.tris, 'the failed load did not change the drawing');
  assert.deepEqual([...afterFail.levels], [...rootDraw.levels], 'still the same clusters');
  assertDrawListResident(batch, asset, 'after failure');
  assert.ok(asset.wantLevel < asset.loadedLevel, 'the next selection asks for the missing level again');

  // ---------------------------------------------------------------- 3. the retry succeeds; the swap is deferred to after a selection
  callsBefore = server.calls.length;
  const retry = asset.loadTo(asset.wantLevel);
  assert.equal(asset.loading, retry, 'loadTo exposes its single in-flight promise');
  assert.equal(asset.loadTo(asset.wantLevel), retry, 'a repeated loadTo returns the same Promise');
  const streamed = updateStreaming([asset]);
  assert.equal(streamed.length, 1, 'updateStreaming returns the in-flight request once');
  assert.equal(asset.loading, retry, 'and leaves the single-flight request in place');
  await Promise.all([retry, ...streamed]);
  assert.equal(asset.loadError, null, 'the retry cleared the error');
  assert.equal(server.calls.length - callsBefore, 4, 'the retry issued exactly one set of Range requests');
  const fetched = asset.pending;
  assert.ok(fetched, 'the fetched prefix is held back');
  assert.equal(asset.loadedLevel, meta.levelRanges[0].level, 'loadedLevel is unchanged until the swap');
  assert.equal(asset.geometry, geometryBefore, 'the batch still points at the old geometry');
  assert.ok(fetched.level < asset.loadedLevel, 'the fetched prefix is finer');
  let disposed = 0; geometryBefore.addEventListener('dispose', () => disposed++);

  st = frame(selector, asset);
  assert.equal(asset.pending, null, 'the selection swapped the fetched prefix in');
  assert.equal(asset.loadedLevel, fetched.level, 'loadedLevel advanced after the swap');
  assert.notEqual(asset.geometry, geometryBefore, 'the batch now points at the new geometry');
  assert.equal(batch.geometry, asset.geometry, 'batch geometry was switched over');
  assert.equal(disposed, 1, 'the old geometry was disposed exactly once, at the swap');
  assert.ok(asset.geometry.index.count >= geometryBefore.index.count, 'the new geometry holds the old prefix plus more');
  assertDrawListResident(batch, asset, 'after the swap');
  // ---------------------------------------------------------------- 4. non-206 responses fail without disturbing the prefix
  {
    const midCam = cameraAt(12);
    const refMid = referenceCut(meta, sections, midCam.position, K, 2);
    assert.ok(refMid.tris > meta.coarsestTris, 'the mid camera wants more than the root');
    assert.ok(Math.min(...refMid.levels) > 0, 'the mid camera still leaves a finer level to fetch');
    const a5 = await loadClodStream(BASE, NAME, { rootBytes: ROOT_BYTES });
    const b5 = new ClodBatch(a5, material, [matrix]);
    const s5 = new ClodSelector([b5]); s5.frustumCull = false;
    s5.select(midCam, VIEWPORT, { errorPx: 2 });
    const finer = levelOf(a5.wantLevel);
    assert.ok(finer && finer.level < a5.loadedLevel && finer.level > 0, `the mid camera wants an intermediate level (${a5.wantLevel})`);
    const goodGeometry = a5.geometry, goodLevel = a5.loadedLevel;
    server.ignoreRange = 4;
    callsBefore = server.calls.length;
    await assert.rejects(a5.loadTo(finer.level), /Range/);
    assert.equal(server.calls.length - callsBefore, 4, 'the whole set was attempted once');
    assert.equal(a5.geometry, goodGeometry, 'a non-206 response does not disturb the usable geometry');
    assert.equal(a5.loadedLevel, goodLevel, 'nor the resident level');
    assert.equal(a5.pending, null);
    const st5 = s5.select(midCam, VIEWPORT, { errorPx: 2 });
    assert.equal(drawList(b5, a5).tris, st5.tris, 'the frame after the failure is still consistent');
    assertDrawListResident(b5, a5, 'after non-206');
    // the retry works
    await a5.loadTo(finer.level);
    assert.ok(a5.pending, 'the retry after a 200-instead-of-206 response fetched the prefix');
    s5.select(midCam, VIEWPORT, { errorPx: 2 });
    assert.equal(a5.loadedLevel, finer.level, 'the retried prefix was committed');
    assert.ok(a5.loadedLevel < goodLevel);
    assertDrawListResident(b5, a5, 'after retried commit');
  }

  // ---------------------------------------------------------------- 5. delayed responses: single flight, coalesced callers
  {
    const a2 = await loadClodStream(BASE, NAME, { rootBytes: ROOT_BYTES });
    const b2 = new ClodBatch(a2, material, [matrix]);
    const s2 = new ClodSelector([b2]); s2.frustumCull = false;
    s2.select(camera, VIEWPORT, { errorPx: 1 });
    const want = a2.wantLevel;
    assert.ok(want < a2.loadedLevel, 'the close camera wants a finer level');
    const callsBeforeDelay = server.calls.length;
    const geoBeforeDelay = a2.geometry;
    server.delayMs = 40;
    const p1 = a2.loadTo(want);
    const p2 = a2.loadTo(want);
    const p3 = updateStreaming([a2]);
    assert.equal(p2, p1, 'a repeated loadTo shares the delayed request');
    assert.equal(p3.length, 1, 'updateStreaming reports the delayed request too');
    assert.equal(a2.loading, p1, 'the asset keeps a single in-flight request');
    // a frame while the bytes are in flight: still drawing the old geometry, nothing half-applied
    s2.select(camera, VIEWPORT, { errorPx: 1 });
    assert.equal(a2.loading, p1, 'still in flight');
    assert.equal(a2.geometry, geoBeforeDelay, 'the old geometry is still in use mid-flight');
    assert.equal(updateStreaming([a2]).length, 1, 'the frame waits on the same request');
    await Promise.all([p1, p2, ...p3]);
    server.delayMs = 0;
    assert.equal(server.calls.length - callsBeforeDelay, 4, 'a delayed response still costs exactly one Range set');
    assert.ok(a2.pending && a2.pending.level === want, 'the fetched prefix is pending, not committed');
    // asking for a pending level again must not fetch it twice
    callsBefore = server.calls.length;
    await a2.loadTo(want);
    assert.equal(server.calls.length, callsBefore, 'a pending level is not requested again');
    s2.select(camera, VIEWPORT, { errorPx: 1 });
    assert.equal(a2.pending, null, 'committed after a selection');
    assert.equal(updateStreaming([a2]).length <= 1, true);
  }

  // ---------------------------------------------------------------- 6. selector on a partially resident asset
  {
    const close = new THREE.PerspectiveCamera(60, 16 / 9, 0.001, 1000);
    close.position.copy(centre).add(new THREE.Vector3(radius * 0.3, radius * 0.2, radius * 0.3));
    close.lookAt(centre);
    const refClose = referenceCut(meta, sections, close.position, K, 1);
    assert.ok(refClose.tris > meta.coarsestTris + 1e-6, 'the close camera wants more than the root');
    const a3 = await loadClodStream(BASE, NAME, { rootBytes: ROOT_BYTES });
    const b3 = new ClodBatch(a3, material, [matrix]);
    const s3 = new ClodSelector([b3]); s3.frustumCull = false;

    // partially resident: a valid coarser cut, and the needed level recorded. The triangle count and the
    // levels must match the cut restricted to what is resident (same DAG walk, residency-gated refinement).
    s3.select(close, VIEWPORT, { errorPx: 1 });
    const partial = drawList(b3, a3);
    const refPartial = referenceCutRestricted(meta, sections, close.position, K, 1, a3.loadedLevel);
    assert.ok(partial.tris < refClose.tris, `partial residency draws fewer triangles (${partial.tris} < ${refClose.tris})`);
    assert.equal(Math.round(partial.tris), Math.round(refPartial.tris), 'partial cut matches the residency-restricted brute force');
    assert.deepEqual([...partial.levels].sort((a, b) => a - b), [...refPartial.levels].sort((a, b) => a - b), 'partial cut levels match');
    assert.ok(partial.minLevel >= a3.loadedLevel, 'only resident clusters are drawn');
    assertDrawListResident(b3, a3, 'partially resident');
    assert.ok(a3.wantLevel < a3.loadedLevel, 'the selector recorded the level it needs');
    assert.equal(updateStreaming([a3]).length, 1, 'updateStreaming acts on it');
    // what the cut looked like at every residency step: each committed level may only make it finer, and
    // each step must be exactly the cut the restricted brute force predicts for that residency
    const steps = [{ loadedLevel: a3.loadedLevel, tris: partial.tris, minLevel: partial.minLevel }];

    // drive frames until everything is resident; every frame must stay drawable
    for (let i = 0; i < 64; i++) {
      const wasLoaded = a3.loadedLevel;
      const f = frame(s3, a3);
      assertDrawListResident(b3, a3, `streaming frame ${i}`);
      // this frame's draw list was built against `wasLoaded`; the swap for the next level happens at its end
      if (a3.loadedLevel !== wasLoaded) { const d = drawList(b3, a3); if (steps.at(-1).loadedLevel !== wasLoaded) steps.push({ loadedLevel: wasLoaded, tris: d.tris, minLevel: d.minLevel }); }
      if (!f.pending.length && !a3.pending) break;
      await Promise.all(f.pending);
    }
    assert.equal(a3.loadedLevel, 0, `everything is resident (loadedLevel ${a3.loadedLevel})`);
    for (let k = 1; k < steps.length; k++) {
      const before = steps[k - 1], after = steps[k];
      assert.ok(after.loadedLevel < before.loadedLevel, 'each step really loaded a finer level');
      assert.ok(after.tris >= before.tris, `triangles do not shrink as detail arrives (${before.tris} -> ${after.tris})`);
      assert.ok(after.minLevel <= before.minLevel, `the cut gets at least as fine (${before.minLevel} -> ${after.minLevel})`);
      const ref = referenceCutRestricted(meta, sections, close.position, K, 1, before.loadedLevel);
      assert.ok(Math.abs(before.tris - ref.tris) < 1e-6, `step at loaded level ${before.loadedLevel}: ${before.tris} vs reference ${ref.tris}`);
    }
    callsBefore = server.calls.length;
    const stFull = s3.select(close, VIEWPORT, { errorPx: 1 });
    const full = drawList(b3, a3);
    assert.equal(updateStreaming([a3]).length, 0, 'nothing more to request once fully resident');
    assert.equal(server.calls.length, callsBefore, 'no repeated Range requests for resident levels');
    // the selector's cut equals the brute-force cut, in triangles and level range
    assert.equal(Math.round(stFull.tris), Math.round(refClose.tris), 'selector cut matches brute force when resident');
    assert.deepEqual([...full.levels].sort((a, b) => a - b), [...refClose.levels].sort((a, b) => a - b), 'same levels as brute force');
    assert.equal(full.tris, stFull.tris);
    // a coarser view draws fewer triangles from coarser levels, still matching brute force
    const far = new THREE.PerspectiveCamera(60, 16 / 9, 0.001, 1000);
    far.position.copy(centre).add(new THREE.Vector3(radius * 8, radius * 5, radius * 8)); far.lookAt(centre);
    const stFar = s3.select(far, VIEWPORT, { errorPx: 1 });
    const farDraw = drawList(b3, a3);
    const refFar = referenceCut(meta, sections, far.position, K, 1);
    assert.ok(farDraw.tris < full.tris, 'a far camera draws fewer triangles');
    assert.equal(Math.round(stFar.tris), Math.round(refFar.tris), 'far cut matches brute force');
    assert.deepEqual([...farDraw.levels].sort((a, b) => a - b), [...refFar.levels].sort((a, b) => a - b), 'far cut levels match brute force');
  }

  // ---------------------------------------------------------------- 7. budget mode on a partially resident asset
  {
    const close = cameraAt(0.6);
    const a6 = await loadClodStream(BASE, NAME, { rootBytes: ROOT_BYTES });
    const b6 = new ClodBatch(a6, material, [matrix]);
    const s6 = new ClodSelector([b6]); s6.frustumCull = false;
    const st6 = s6.select(close, VIEWPORT, { errorPx: 0.5, budget: 6000 });
    const draw6 = drawList(b6, a6);
    assert.ok(draw6.minLevel >= a6.loadedLevel, 'budget mode never draws a non-resident cluster');
    assertDrawListResident(b6, a6, 'budget, partial');
    assert.equal(st6.tris, draw6.tris, 'budget mode stats agree with the draw list');
    // a group that was skipped for residency is remembered and requested
    if (a6.wantLevel < a6.loadedLevel) {
      const pending = updateStreaming([a6]);
      assert.equal(pending.length, 1);
      await Promise.all(pending);
      s6.select(close, VIEWPORT, { errorPx: 0.5, budget: 6000 });
      assert.equal(a6.pending, null, 'budget mode commit happens through the same deferred swap');
      assertDrawListResident(b6, a6, 'budget, after commit');
    }
    // drive the budget selection until it stops wanting anything; each committed level can reveal a finer
    // one, so keep selecting until two consecutive selections want nothing
    const calls = server.calls.length;
    let quiet = 0;
    for (let i = 0; i < 128 && quiet < 2; i++) {
      s6.select(close, VIEWPORT, { errorPx: 0.5, budget: 6000 });
      assertDrawListResident(b6, a6, `budget settle ${i}`);
      const p = updateStreaming([a6]);
      quiet = p.length ? 0 : quiet + 1;
      await Promise.all(p);
    }
    s6.select(close, VIEWPORT, { errorPx: 0.5, budget: 6000 });
    assert.equal(updateStreaming([a6]).length, 0, 'fully settled budget selection requests nothing');
    assert.equal(a6.wantLevel, 255, 'nothing is wanted once settled');
    assert.ok(server.calls.length >= calls);
  }

  // ---------------------------------------------------------------- 8. non-streaming loadClod, threshold and budget mode unchanged
  {
    const a4 = await loadClod(BASE, NAME);
    assert.equal(a4.stream, undefined, 'loadClod stays non-streaming');
    const b4 = new ClodBatch(a4, material, [matrix]);
    const s4 = new ClodSelector([b4]); s4.frustumCull = false;
    const st4 = s4.select(camera, VIEWPORT, { errorPx: 1 });
    assert.equal(st4.tris, referenceCut(meta, sections, camera.position, K, 1).tris, 'loadClod threshold selection is unchanged');
    assert.equal(updateStreaming([a4]).length, 0, 'non-streaming assets are ignored by updateStreaming');
    // budget mode: refining is all-or-nothing per group, so the cut may overshoot by at most one group's
    // worth of triangles; a smaller budget must not draw more, and the threshold reports what it bought
    const big = s4.select(camera, VIEWPORT, { errorPx: 0.5, budget: Infinity });
    const small = s4.select(camera, VIEWPORT, { errorPx: 0.5, budget: 3000 });
    assert.ok(small.tris <= big.tris, 'a smaller budget does not draw more');
    assert.ok(small.threshold >= big.threshold, 'a smaller budget buys no more quality than a large one');
    assert.ok(small.clusters > 0);
  }

  const rows = cutStats(tmp, NAME, 1, quiet);
  assert.ok(rows[0].px1 > rows.at(-1).px1, 'smaller cuts far away');
  console.log('ok: streaming failure/retry, single flight, deferred swap, selector residency and cut parity');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
}
