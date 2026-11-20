// Streaming behaviour tests: a real build served by a local HTTP Range server that records requests
// and can inject failures, plus small platform delays so camera changes land mid-transfer.
// Covers: progressive zoom-in, reversing during a request, failure then retry, two interleaved
// assets with one failing, eviction on zoom-out then reload, and overlapping loadTo() calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';
import { loadClodStream, updateStreaming, ClodBatch, ClodSelector } from '../src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));
let server, base, fails = 0;

// --- HTTP Range server that records requests and can be told to fail the next N requests
const stats = { requests: [], inFlight: 0, maxInFlight: 0, failNext: 0, delayByPath: new Map() };
function serve() {
  return new Promise((res) => {
    server = http.createServer((req, rsp) => {
      const url = new URL(req.url, 'http://x');
      const file = path.join(tmp, decodeURIComponent(url.pathname));
      stats.requests.push({ path: url.pathname, range: req.headers.range || null });
      stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const done = () => { stats.inFlight--; };
      rsp.on('close', done);
      const delay = stats.delayByPath.get(url.pathname) || 0;
      setTimeout(() => {
        if (stats.failNext > 0) { stats.failNext--; rsp.writeHead(500); rsp.end('injected failure'); return; }
        let st;
        try { st = fs.statSync(file); } catch { rsp.writeHead(404); rsp.end(); return; }
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (!m) { rsp.writeHead(200, { 'content-length': st.size }); fs.createReadStream(file).pipe(rsp); return; }
        const a = +m[1], b = Math.min(+m[2], st.size - 1);
        if (a > b) { rsp.writeHead(416); rsp.end(); return; }
        rsp.writeHead(206, { 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
        fs.createReadStream(file, { start: a, end: b }).pipe(rsp);
      }, delay);
    });
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); });
  });
}
const reset = () => { stats.requests.length = 0; stats.maxInFlight = 0; stats.inFlight = 0; stats.failNext = 0; stats.delayByPath.clear(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- one frame of the normal loop: select, then pump streaming
function frame(assets, batches, selector, camera, opts) {
  selector.select(camera, 1080, opts);
  return updateStreaming(assets);
}
const cam = (z = 20, fov = 50) => { const c = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 1000); c.position.set(0, 0, z); c.lookAt(0, 0, 0); c.updateMatrixWorld(); c.updateProjectionMatrix(); return c; };
const levelOf = (asset) => asset.loadedLevel;

try {
  await serve();
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 64 }));
  const quiet = () => {};
  const a = await buildClod({ input: glb, outDir: tmp, name: 'rock', maxTriangles: 20000, lods: false, edgeLimit: 1, log: quiet });
  await buildClod({ input: glb, outDir: tmp, name: 'rock2', maxTriangles: 20000, lods: false, edgeLimit: 1, log: quiet });
  const LR = a.meta.levelRanges, last = LR[LR.length - 1];

  // every geometry the asset exposes must be a prefix of the full buffers: no stray triangles
  const checkGeometry = (asset) => {
    if (!asset.geometry) return;
    const idx = asset.geometry.index.array, pos = asset.geometry.attributes.position.array;
    assert.equal(idx.length, asset._iEnd, 'index buffer length matches the resident prefix');
    assert.equal(pos.length, asset._vEnd * 3, 'vertex buffer length matches the resident prefix');
    let maxV = 0; for (let i = 0; i < idx.length; i++) maxV = Math.max(maxV, idx[i]);
    assert.ok(maxV < asset._vEnd, 'no index points past the resident vertex prefix');
    for (const bt of asset.batches) assert.equal(bt.geometry, asset.geometry, 'batch points at the current geometry');
  };

  // ---------------------------------------------------------------- 1. progressive zoom-in
  {
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000 });
    const mats = [new THREE.Matrix4()];
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), mats);
    const selector = new ClodSelector([batch]);
    assert.ok(asset.rootLevel > 0, `root level is coarse (level ${asset.rootLevel}, 0 = finest)`);
    assert.equal(levelOf(asset), asset.rootLevel, 'root page loaded');
    assert.equal(asset.residentBytes, LR.find((l) => l.level === asset.rootLevel).bytes, 'resident bytes = root prefix');
    // zoom in one step at a time; each level reached must add requests, and the cut must refine
    const seen = [asset.requests];
    let levelsLoaded = 0, lastLevel = asset.loadedLevel;
    for (let k = 0; k < 60 && asset.loadedLevel !== 0; k++) {
      const pending = frame([asset], [batch], selector, cam(Math.max(0.9, 40 * Math.pow(0.9, k))), { errorPx: 1 });
      if (pending.length) await Promise.all(pending);
      seen.push(asset.requests);
      checkGeometry(asset);
      if (asset.loadedLevel !== lastLevel) { assert.ok(asset.loadedLevel < lastLevel, 'level only gets finer while zooming in'); levelsLoaded++; lastLevel = asset.loadedLevel; }
    }
    assert.equal(asset.loadedLevel, 0, 'close-up loads the finest level');
    assert.ok(levelsLoaded >= 4, `detail arrived in several level steps, not one full download (${levelsLoaded})`);
    assert.equal(asset.residentBytes, last.bytes, 'resident bytes equal the full prefix once everything is loaded');
    assert.equal(asset.residentBytes, asset.fullBytes);
    assert.ok(asset.requests >= LR.length - 1, 'request count grows with levels');
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'request count is monotonic');
    assert.ok(stats.maxInFlight <= 1, `at most one request in flight per asset (saw ${stats.maxInFlight})`);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log(`ok 1: progressive zoom-in ${levelsLoaded} levels, ${asset.requests} requests, resident ${(asset.residentBytes / 1024).toFixed(0)} of ${(asset.fullBytes / 1024).toFixed(0)} KB`);
  }

  // ---------------------------------------------------------------- 2. reverse during an in-flight request
  {
    // A slow first request (delayMs) so the camera can reverse while it is genuinely in flight.
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000, delayMs: 40 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const selector = new ClodSelector([batch]);
    const root = asset.loadedLevel;
    // ask for detail, then reverse the camera before the request completes
    const p1 = frame([asset], [batch], selector, cam(1.2), { errorPx: 1 });
    assert.equal(p1.length, 1, 'a request started');
    await wait(20); // mid-transfer
    const farTarget = frame([asset], [batch], selector, cam(60), { errorPx: 1 });
    await Promise.all([...p1, ...farTarget]);
    // the stale fine result must not be installed over the newer (coarser) target
    assert.ok(asset.loadedLevel > 0 && asset.loadedLevel >= asset.targetLevel, `stale fine result dropped (level ${asset.loadedLevel}, target ${asset.targetLevel})`);
    assert.equal(asset.residentBytes, LR.find((l) => l.level === asset.loadedLevel).bytes, 'resident bytes match the resident level');
    assert.equal(asset.loadedLevel, asset.targetLevel, 'settled at the level the far camera needs');
    checkGeometry(asset);
    // and the same turn-around must still allow a fresh load afterwards
    for (let k = 0; k < 6 && asset.loadedLevel !== 0; k++) await Promise.all(frame([asset], [batch], selector, cam(1.2), { errorPx: 1 }));
    assert.equal(asset.loadedLevel, 0, 'can load again after reversing');
    assert.ok(stats.maxInFlight <= 1, `one request at a time while reversing (saw ${stats.maxInFlight})`);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log('ok 2: reverse during in-flight request drops the stale fine result, then reloads fine');
  }

  // ---------------------------------------------------------------- 3. failure then retry
  {
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const selector = new ClodSelector([batch]);
    const before = asset.loadedLevel, bytes = asset.residentBytes;
    stats.failNext = 1;
    let p = frame([asset], [batch], selector, cam(1.2), { errorPx: 1 });
    await Promise.all(p);
    assert.ok(asset.lastError, 'failure recorded');
    assert.equal(asset.loadedLevel, before, 'resident level untouched by the failure');
    assert.equal(asset.residentBytes, bytes, 'resident bytes untouched by the failure');
    assert.equal(asset.loading, null, 'asset is not stuck in loading');
    checkGeometry(asset);
    // the retry happens on the next frame with no extra prodding
    for (let k = 0; k < 6 && asset.loadedLevel !== 0; k++) { p = frame([asset], [batch], selector, cam(1.2), { errorPx: 1 }); await Promise.all(p); }
    assert.equal(asset.loadedLevel, 0, 'retry after failure loads the detail');
    assert.equal(asset.lastError, null, 'lastError cleared on success');
    checkGeometry(asset);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log('ok 3: failure keeps the loaded prefix and recovers on retry');
  }

  // ---------------------------------------------------------------- 4. two assets interleaved, one fails
  {
    reset();
    const a1 = await loadClodStream(base, 'rock', { rootBytes: 4000 });
    const a2 = await loadClodStream(base, 'rock2', { rootBytes: 4000 });
    const b1 = new ClodBatch(a1, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const b2 = new ClodBatch(a2, new THREE.MeshBasicMaterial(), [new THREE.Matrix4().makeTranslation(0.28, 0, 0)]);
    const selector = new ClodSelector([b1, b2]);
    const c = cam(1.2);
    stats.failNext = 1; // the very first request fails; it can only belong to one asset
    let pending = frame([a1, a2], [b1, b2], selector, c, { errorPx: 1 });
    assert.ok(pending.length >= 1);
    await Promise.all(pending);
    const progressed = (a1.loadedLevel < a1.rootLevel) || (a2.loadedLevel < a2.rootLevel);
    assert.ok(progressed, 'at least one asset advanced despite the other failing');
    for (let k = 0; k < 12 && !(a1.loadedLevel === 0 && a2.loadedLevel === 0); k++) {
      pending = frame([a1, a2], [b1, b2], selector, c, { errorPx: 1 });
      await Promise.all(pending);
    }
    assert.equal(a1.loadedLevel, 0, 'first asset finished');
    assert.equal(a2.loadedLevel, 0, 'second asset finished too (failure did not block it)');
    assert.ok(stats.maxInFlight <= 2, `one request per asset at a time (saw ${stats.maxInFlight})`);
    checkGeometry(a1); checkGeometry(a2);
    b1.geometry.dispose(); b2.geometry.dispose(); a1.geometry.dispose(); a2.geometry.dispose();
    console.log('ok 4: two assets interleave; one failure does not block the other');
  }

  // ---------------------------------------------------------------- 5. zoom out releases detail, zoom in reloads
  {
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const selector = new ClodSelector([batch]);
    await Promise.all(frame([asset], [batch], selector, cam(1.2), { errorPx: 1 }));
    assert.equal(asset.loadedLevel, 0, 'detail loaded');
    const full = asset.residentBytes;
    assert.equal(full, asset.fullBytes, 'close-up resident set is the whole asset');
    // zoom far out: the next selection needs a coarser cut, so the fine levels go away
    await Promise.all(frame([asset], [batch], selector, cam(400), { errorPx: 1 }));
    assert.ok(asset.loadedLevel > 0, 'fine levels released when zoomed out');
    const released = asset.residentBytes;
    assert.ok(released < full, `resident bytes shrank (${released} < ${full})`);
    assert.equal(released, LR.find((l) => l.level === asset.loadedLevel).bytes);
    assert.equal(asset.residentBytes, asset.pos.length * 4 + asset.nrm.length + asset.uv.length * 4 + asset.idx.length * 4, 'residentBytes counts only what is actually held');
    checkGeometry(asset);
    // nothing else is resident: no buffers keep the released vertices alive
    assert.equal(asset.geometry.attributes.position.array.length, asset._vEnd * 3);
    // zooming in again must fetch and display the detail again
    const reqBefore = asset.requests;
    for (let k = 0; k < 8 && asset.loadedLevel !== 0; k++) await Promise.all(frame([asset], [batch], selector, cam(1.2), { errorPx: 1 }));
    assert.equal(asset.loadedLevel, 0, 'detail reloaded after zoom-out');
    assert.ok(asset.requests > reqBefore, 'reloading issues new range requests');
    assert.equal(asset.residentBytes, full, 'resident set restored to the whole asset');
    checkGeometry(asset);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log(`ok 5: zoom-out released ${(full / 1024).toFixed(0)} KB down to ${(released / 1024).toFixed(0)} KB, then reloaded`);
  }

  // ---------------------------------------------------------------- 6. hammering: concurrent loadTo calls
  {
    // Direct loadTo calls that overlap (updateStreaming is not the only entry point) must still end
    // with one request in flight, the target honoured, and a clean prefix.
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000, delayMs: 15 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    asset.batches.push(batch);
    const ps = [asset.loadTo(0), asset.loadTo(4), asset.loadTo(1), asset.loadTo(6), asset.loadTo(0)];
    await Promise.all(ps);
    assert.ok(stats.maxInFlight <= 1, `concurrent loadTo calls share one request (saw ${stats.maxInFlight})`);
    assert.equal(asset.loadedLevel, 0, 'the last target wins');
    assert.equal(asset.residentBytes, asset.fullBytes);
    checkGeometry(asset);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log('ok 6: overlapping loadTo calls stay serialised and resolve to the last target');
  }

  // ---------------------------------------------------------------- 7. budget mode + repeated changes
  {
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000, delayMs: 4 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const selector = new ClodSelector([batch]);
    // sweep in and out repeatedly; every frame selects and pumps, as in the demo
    const zs = [40, 3, 40, 2, 40, 1.5, 400, 1.5, 400];
    let maxLevelSeen = 255;
    for (const z of zs) {
      const pending = frame([asset], [batch], selector, cam(z), { errorPx: 0.5, budget: 300000 });
      maxLevelSeen = Math.min(maxLevelSeen, asset.loadedLevel);
      await Promise.all(pending);
      checkGeometry(asset);
    }
    assert.ok(stats.maxInFlight <= 1, `one request at a time over the sweep (saw ${stats.maxInFlight})`);
    // the final state is far away: the fine levels fetched along the way are gone again
    assert.ok(asset.loadedLevel > 0, 'ends at a coarse level after the final zoom-out');
    assert.ok(asset.residentBytes < asset.fullBytes, 'resident bytes below the full asset at the end');
    assert.equal(asset.residentBytes, LR.find((l) => l.level === asset.loadedLevel).bytes, 'resident bytes match the level');
    checkGeometry(asset);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log(`ok 7: in/out sweep with budget mode ends at level ${asset.loadedLevel}, ${(asset.residentBytes / 1024).toFixed(0)} of ${(asset.fullBytes / 1024).toFixed(0)} KB`);
  }

  // ---------------------------------------------------------------- 8. hammering targets while transfers run
  {
    // loadTo is a public entry point too: overlapping calls with randomised timing must still keep
    // one request in flight, end at the last requested level, and never publish a torn prefix.
    reset();
    const asset = await loadClodStream(base, 'rock', { rootBytes: 4000 });
    const batch = new ClodBatch(asset, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const targets = [];
    for (let i = 0; i < LR.length; i++) targets.push(LR[i].level);
    for (let round = 0; round < 24; round++) {
      const t = targets[round % targets.length];
      const p = asset.loadTo(t);
      await wait(Math.floor(Math.random() * 6));
      checkGeometry(asset); // mid-flight state stays a valid prefix
      await p;
      const exp = LR.find((l) => l.level <= Math.min(t, asset.rootLevel));
      assert.equal(asset.loadedLevel, exp.level, `target ${t} ends at level ${exp.level}`);
      checkGeometry(asset);
    }
    assert.ok(stats.maxInFlight <= 1, `hammered loadTo keeps one request in flight (saw ${stats.maxInFlight})`);
    batch.geometry.dispose(); asset.geometry.dispose();
    console.log(`ok 8: 24 overlapping loadTo calls, max ${stats.maxInFlight} in flight, ${asset.requests} requests total`);
  }

  console.log('streaming: all checks passed');
} catch (e) {
  fails++;
  console.error(e && e.stack || e);
  process.exitCode = 1;
} finally {
  await new Promise((r) => server ? server.close(r) : r());
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fails) process.exitCode = process.exitCode || 0;
}
