// Streaming consistency checks, no browser: a fetch stub serves the built asset from disk with
// HTTP Range support, controllable latency and failure injection. Covers:
//   normal     - level-by-level loads: loadedLevel strictly finer, residentBytes tracks levelRanges
//   concurrent - many requests per frame merge into ONE in-flight load, which chains to the finest
//   failure    - network errors and ignored Range requests commit nothing and are retried
//   rebuild    - a late completion never writes another asset, and dispose() drops in-flight results
//   baselines  - loadClod and DiscreteLodSet behave as before
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { loadClod, loadClodStream, updateStreaming, ClodBatch, ClodSelector, DiscreteLodSet } from '../src/clod.js';
import { makeSample } from '../examples/make-sample.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));

// A "Range server" in front of the temp directory. Knobs: delayMs (latency per range request),
// ignoreRange (answer 200 to Range requests, like a server that does not support them),
// failNext (the next N range requests throw), failFrom (every request from the Nth on throws).
function makeServer(dir, meta) {
  const secs = Object.entries(meta.sections).map(([k, s]) => ({ k, from: s.offset, to: s.offset + s.bytes }));
  const srv = {
    delayMs: 0, ignoreRange: false, failNext: 0, failFrom: Infinity,
    requests: 0, posRequests: 0, inFlight: 0, maxInFlight: 0, posInFlight: 0, maxPosInFlight: 0,
    reset() { Object.assign(srv, { requests: 0, posRequests: 0, inFlight: 0, maxInFlight: 0, posInFlight: 0, maxPosInFlight: 0 }); },
  };
  srv.fetch = async (url, init = {}) => {
    const data = await fsp.readFile(String(url));
    const h = init.headers || {};
    const range = h.Range || h.range;
    if (!range) return new Response(data, { status: 200 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(m, `well-formed Range header: ${range}`);
    const start = +m[1], end = +m[2];
    const sec = secs.find((s) => start >= s.from && start < s.to);
    assert.ok(sec, `range ${start} inside a section`);
    assert.ok(end < sec.to, `range ${start}-${end} within section ${sec.k}`);
    const isPos = sec.k === 'positions';
    srv.requests++; if (isPos) srv.posRequests++;
    srv.inFlight++; if (isPos) srv.posInFlight++;
    srv.maxInFlight = Math.max(srv.maxInFlight, srv.inFlight);
    srv.maxPosInFlight = Math.max(srv.maxPosInFlight, srv.posInFlight);
    try {
      if (srv.requests >= srv.failFrom || srv.failNext > 0) { if (srv.failNext > 0) srv.failNext--; throw new TypeError('simulated network failure'); }
      if (srv.delayMs) await new Promise((r) => setTimeout(r, srv.delayMs));
      if (srv.ignoreRange) return new Response(data, { status: 200 }); // Range ignored
      return new Response(data.subarray(start, end + 1), { status: 206 });
    } finally {
      srv.inFlight--; if (isPos) srv.posInFlight--;
    }
  };
  return srv;
}

const cameraFor = (a) => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 1e7);
  const c = a.sphere.center, r = a.sphere.radius;
  cam.position.set(c.x, c.y, c.z + r * 4);
  cam.lookAt(c.x, c.y, c.z);
  cam.updateMatrixWorld();
  return cam;
};

try {
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 64 }));
  const quiet = () => {};
  const built = await buildClod({ input: glb, outDir: tmp, name: 'rock', maxTriangles: 30000, log: quiet });
  const meta = built.meta, LR = meta.levelRanges;
  assert.ok(LR.length >= 3, `need several streaming levels, got ${LR.length}`);
  assert.equal(LR[LR.length - 1].level, 0, 'finest level is 0');

  // ---------------------------------------------------------------- normal path
  {
    const srv = makeServer(tmp, meta);
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    assert.ok(a.rootLevel > 0, 'root page should be coarser than the finest level');
    assert.equal(a.loadedLevel, a.rootLevel);
    assert.ok(a.residentBytes > 0 && a.residentBytes <= a.fullBytes);
    let prev = a.loadedLevel, prevBytes = a.residentBytes;
    for (let k = LR.findIndex((l) => l.level === a.rootLevel) + 1; k < LR.length; k++) {
      a.wantLevel = LR[k].level;
      assert.deepEqual(await Promise.all(updateStreaming([a])), [true]);
      assert.equal(a.loadedLevel, LR[k].level);
      assert.ok(a.loadedLevel < prev, 'loadedLevel monotonically finer');
      assert.equal(a.residentBytes, LR[k].bytes, 'residentBytes tracks the level prefix');
      assert.ok(a.residentBytes > prevBytes && a.residentBytes <= a.fullBytes);
      assert.equal(a.geometry.index.count, LR[k].indexEnd);
      prev = a.loadedLevel; prevBytes = a.residentBytes;
    }
    assert.equal(a.loadedLevel, 0);
    assert.equal(a.residentBytes, a.fullBytes);
    // selection runs against the fully resident hierarchy
    const b = new ClodBatch(a, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
    const st = new ClodSelector([b]).select(cameraFor(a), 1080, { errorPx: 1 });
    assert.ok(st.tris > 0, 'selector draws the streamed asset');
    console.log('ok: normal path - monotonic levels, residentBytes/fullBytes consistent');
  }

  // ---------------------------------------------------------------- concurrency: merge, never stack
  {
    const srv = makeServer(tmp, meta);
    srv.delayMs = 30;
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    srv.reset();
    const mid = LR[LR.findIndex((l) => l.level === a.rootLevel) + 1].level;
    a.wantLevel = mid;
    const f1 = updateStreaming([a]);
    assert.equal(f1.length, 1);
    assert.ok(a.loading, 'a load is in flight');
    // several more frames ask for finer while the first load is still flying
    for (let k = 0; k < 5; k++) {
      a.wantLevel = 0;
      const f = updateStreaming([a]);
      assert.strictEqual(f[0], f1[0], 'requests merge into the in-flight load');
    }
    assert.strictEqual(a.loadTo(0), f1[0], 'loadTo merges too');
    assert.equal(await f1[0], true);
    assert.equal(a.loadedLevel, 0, 'the merged request chained to the finest level');
    assert.equal(a.residentBytes, a.fullBytes);
    assert.equal(srv.maxPosInFlight, 1, 'never two level loads in flight at once');
    assert.equal(srv.posRequests, 2, 'one fetch per level actually loaded (mid, then finest)');
    assert.equal(a.requests, 12, 'root + two level loads, 4 range requests each');
    console.log('ok: concurrency - 7 requests merged into one in-flight load that chained');
  }

  // ---------------------------------------------------------------- failure: network error, then retry
  {
    const srv = makeServer(tmp, meta);
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    const lvl = a.loadedLevel, res = a.residentBytes, geo = a.geometry;
    srv.failNext = 4; // kill every request of the next load
    a.wantLevel = 0;
    assert.deepEqual(await Promise.all(updateStreaming([a])), [false], 'failed load resolves false');
    assert.equal(a.loadedLevel, lvl, 'failure does not fake a finer loadedLevel');
    assert.equal(a.residentBytes, res, 'failure does not fake residentBytes');
    assert.strictEqual(a.geometry, geo, 'failure does not swap geometry');
    assert.equal(a.loading, null, 'not stuck: the next updateStreaming may retry');
    assert.ok(a.lastError, 'the failure is recorded');
    assert.deepEqual(await Promise.all(updateStreaming([a])), [true], 'retry re-issues the load');
    assert.equal(a.loadedLevel, 0);
    assert.equal(a.residentBytes, a.fullBytes);
    console.log('ok: failure - network error commits nothing, next updateStreaming retries');
  }

  // ---------------------------------------------------------------- failure: server ignores Range
  {
    const srv = makeServer(tmp, meta);
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    srv.ignoreRange = true;
    a.wantLevel = 0;
    assert.deepEqual(await Promise.all(updateStreaming([a])), [false]);
    assert.match(String(a.lastError), /ignored the HTTP Range/);
    assert.equal(a.loadedLevel, a.rootLevel);
    srv.ignoreRange = false;
    a.wantLevel = 0;
    assert.deepEqual(await Promise.all(updateStreaming([a])), [true]);
    assert.equal(a.loadedLevel, 0);
    // and when the root page itself cannot be fetched, the loader rejects
    const srvDead = makeServer(tmp, meta);
    srvDead.failFrom = 6; // hierarchy is 5 range requests; the root level load fails
    await assert.rejects(loadClodStream(tmp, 'rock', { fetch: srvDead.fetch, rootBytes: 4096 }));
    console.log('ok: failure - ignored Range commits nothing, unloadable root rejects');
  }

  // ---------------------------------------------------------------- rebuild: independent assets stay independent
  {
    const srv = makeServer(tmp, meta);
    srv.delayMs = 20;
    const a1 = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    const a2 = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    a1.wantLevel = 0;
    const p1 = updateStreaming([a1])[0]; // in flight while the "new scene" loads its own asset
    a2.wantLevel = 0;
    assert.deepEqual(await Promise.all(updateStreaming([a2])), [true]);
    const g2 = a2.geometry, lv2 = a2.loadedLevel, res2 = a2.residentBytes;
    let g2Disposed = false;
    g2.addEventListener('dispose', () => { g2Disposed = true; });
    assert.equal(await p1, true, 'the old asset completes normally');
    assert.equal(a1.loadedLevel, 0);
    assert.strictEqual(a2.geometry, g2, 'a late completion on the old asset does not touch the new one');
    assert.equal(a2.loadedLevel, lv2);
    assert.equal(a2.residentBytes, res2);
    assert.ok(!g2Disposed, 'the old asset never disposes the new geometry');
    console.log('ok: rebuild - two assets of the same name do not interfere');
  }

  // ---------------------------------------------------------------- rebuild: new batches on the same asset (the demo's buildScene)
  {
    const srv = makeServer(tmp, meta);
    srv.delayMs = 20;
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    const mat = new THREE.MeshBasicMaterial(), M = new THREE.Matrix4();
    const b1 = new ClodBatch(a, mat, [M]);
    const oldGeo = a.geometry;
    let oldDisposed = false;
    oldGeo.addEventListener('dispose', () => { oldDisposed = true; });
    a.wantLevel = 0;
    const p = updateStreaming([a])[0];
    a.batches.length = 0; // buildScene drops the old batches...
    const b2 = new ClodBatch(a, mat, [M]); // ...and creates new ones from the same asset
    assert.strictEqual(b2.geometry, oldGeo, 'old geometry serves while the load is flying');
    assert.equal(await p, true);
    assert.equal(a.loadedLevel, 0);
    assert.strictEqual(b2.geometry, a.geometry, 'the commit re-points the live batches');
    assert.notStrictEqual(a.geometry, oldGeo);
    assert.ok(oldDisposed, 'the replaced geometry is released');
    assert.strictEqual(b1.geometry, oldGeo, 'the detached batch keeps its (disposed) geometry; it is out of the scene');
    const st = new ClodSelector([b2]).select(cameraFor(a), 1080, { errorPx: 1 });
    assert.ok(st.tris > 0, 'the rebuilt scene selects against the new geometry');
    console.log('ok: rebuild - a commit mid-buildScene reaches the new batches, disposes only the old geometry');
  }

  // ---------------------------------------------------------------- rebuild: dispose() drops in-flight results
  {
    const srv = makeServer(tmp, meta);
    srv.delayMs = 20;
    const a = await loadClodStream(tmp, 'rock', { fetch: srv.fetch, rootBytes: 4096 });
    const geo = a.geometry, lvl = a.loadedLevel, res = a.residentBytes;
    let geoDisposed = false;
    geo.addEventListener('dispose', () => { geoDisposed = true; });
    a.wantLevel = 0;
    const p = updateStreaming([a])[0];
    a.dispose();
    assert.equal(await p, false, 'the late completion is dropped');
    assert.equal(a.loadedLevel, lvl, 'a stale completion does not write loadedLevel');
    assert.equal(a.residentBytes, res, 'a stale completion does not write residentBytes');
    assert.equal(a.geometry, null);
    assert.ok(geoDisposed, 'dispose() released the resident geometry exactly once');
    assert.equal(await a.loadTo(0), false, 'a disposed asset stays inert');
    assert.equal(a.loadedLevel, lvl);
    assert.deepEqual(updateStreaming([a]), [], 'updateStreaming skips disposed assets');
    console.log('ok: rebuild - dispose() makes a late completion a no-op');
  }

  // ---------------------------------------------------------------- baselines unchanged
  {
    const srv = makeServer(tmp, meta);
    const realFetch = globalThis.fetch;
    globalThis.fetch = srv.fetch; // loadClod uses the global fetch
    try {
      const full = await loadClod(tmp, 'rock');
      assert.equal(full.loadedLevel, 0);
      assert.ok(full.geometry.index.count > 0);
      assert.equal(full.stream, undefined);
      const set = new DiscreteLodSet(full, new THREE.MeshBasicMaterial(), [new THREE.Matrix4()]);
      const cam = cameraFor(full);
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const K = 1080 / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      const r = set.select(cam.position, frustum, K, 1, true);
      assert.equal(r.drawn, 1);
      assert.equal(r.tris, full.meta.sourceTris, 'forceFull picks level 0');
      const r2 = set.select(cam.position, frustum, K, 1, false);
      assert.equal(r2.drawn, 1);
      console.log('ok: baselines - loadClod and DiscreteLodSet unchanged');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log('stream tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
