/* Engine-level tests for the share-restore transaction, run against the real
   js/engine.js with no real audio: browser-mock.mjs stands in for Web Audio, workers
   and network; fixtures.mjs serves a synthetic stems.json and a silent decoder.

   These prove the acceptance criteria that need the actual engine machinery:
   - a restored three-layer mix really lands songs/gains/mutes/key/tempo and can play;
   - an unknown code / out-of-range volume is refused with the engine untouched;
   - an injected stretch failure and an injected limiter rebuild failure each fail the
     whole restore and roll every layer back to its pre-restore snapshot;
   - the limiter worklet is rebuilt with the master graph and its failure is observed,
     not silently degraded;
   - repeated submissions coalesce and queued UI mutations replay in order. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install as installBrowser, resetFaults, AudioBuffer } from './browser-mock.mjs';
import { MANIFEST, installFetch, installDecoder } from './fixtures.mjs';

installBrowser();
installFetch();

const E = await import('../js/engine.js');
const { parseShareHash, createRestoreController } = await import('../js/share-restore.js');
installDecoder(AudioBuffer);

const NOTE = E.NOTE;
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Build a controller wired to the real engine, mirroring main.js's port.
function makeController() {
  return createRestoreController({
    parse: (raw) => parseShareHash(raw, { manifest: E.MANIFEST, NOTE, BPM_MIN: E.BPM_MIN, BPM_MAX: E.BPM_MAX }),
    snapshot: () => E.snapshotMix(),
    restoreSnapshot: (s) => E.restoreMixSnapshot(s),
    rebuildGraph: (o) => E.rebuildMixGraph(o),
    selectStem: (id, song, o) => E.selectStem(id, song, { ...o, transactional: true }),
    setVolume: (id, v) => E.setVolume(id, v),
    setMuted: (id, m) => E.setMuted(id, m),
    applyMixSettings: (d) => {
      if (d.bpm !== undefined) { E.state.bpm = d.bpm; E.state.tempoTouched = true; }
      if (d.keyLock !== undefined) E.state.keyLock = d.keyLock;
      if (d.masterKey !== undefined) E.state.masterKey = E.NOTE_NAMES[NOTE[d.masterKey]];
    },
    afterCommit: () => E.state, // main.js would render(); nothing DOM-side here
  });
}

async function loadEngine() {
  await E.loadManifest('stems.json');
  E.ensureCtx();
  E.warmUp();
}

test.beforeEach(async () => {
  resetFaults();
  E.setTestHook('beforeRebuildGraph', null);
  E.__resetCachesForTest(); // a fault must be able to fail a render an earlier test cached
  // Reset layers to a clean slate between tests.
  for (const id of E.LAYERS.map((l) => l.id)) {
    if (E.state.layers[id].song) E.clearLayer(id);
    const s = E.state.layers[id];
    s.volume = 0.85; s.muted = false; s.error = null;
  }
  E.state.bpm = 116; E.state.keyLock = true; E.state.masterKey = 'auto'; E.state.anchorOrder = [];
});

test('engine: manifest loads and all three synthetic songs are available', async () => {
  await loadEngine();
  assert.ok(E.MANIFEST['Alpha Song']);
  assert.equal(E.stemTypeFor('groove', 'Alpha Song'), 'groove');
  assert.equal(E.stemTypeFor('texture', 'Gamma Song'), 'texture');
});

test('restore: full link restores songs, gains, mute, key and tempo and is playable', async () => {
  await loadEngine();
  const ctl = makeController();
  const link = 'g=T1&l=T2&t=T3&vg=40&vl=25&vt=90&ml=1&bpm=124&lock=1&key=A';
  const r = await ctl.requestRestore(link);
  assert.equal(r.ok, true, r.error && r.error.message);
  await settle(5);

  const g = E.state.layers.groove, l = E.state.layers.lead, t = E.state.layers.texture;
  assert.equal(g.song, 'Alpha Song');
  assert.equal(l.song, 'Beta Song');
  assert.equal(t.song, 'Gamma Song');
  assert.ok(g.buffer && l.buffer && t.buffer, 'every layer holds a rendered buffer');
  assert.ok(Math.abs(g.volume - 0.4) < 1e-9);
  assert.ok(Math.abs(l.volume - 0.25) < 1e-9);
  assert.ok(Math.abs(t.volume - 0.9) < 1e-9);
  assert.equal(l.muted, true);
  assert.equal(g.muted, false);
  assert.equal(E.state.bpm, 124);
  assert.equal(E.state.masterKey, 'A');
  assert.equal(E.state.keyLock, true);

  // Playable: all three layers are current at the clock tempo, and play() starts them.
  for (const id of ['groove', 'lead', 'texture']) {
    const s = E.state.layers[id];
    assert.equal(s.bufferBpm, E.state.bpm, `${id} rendered at restored tempo`);
  }
  await E.play();
  assert.equal(E.state.playing, true);
  E.stop();
});

test('restore: unknown song code is rejected and the prior mix is untouched', async () => {
  await loadEngine();
  // Establish a known prior mix.
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1');
  await settle(5);
  const before = E.snapshotMix();

  const ctl = makeController();
  const r = await ctl.requestRestore('g=ZZ9&l=T2');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unknown-song');
  await settle(2);
  assert.equal(E.state.layers.groove.song, before.layers.groove.song);
  assert.equal(E.state.layers.groove.song, 'Alpha Song');
  assert.equal(E.state.layers.lead.song, null); // never half-loaded
});

test('restore: out-of-range volume is rejected and the prior mix is untouched', async () => {
  await loadEngine();
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1&vg=50');
  await settle(5);
  assert.ok(Math.abs(E.state.layers.groove.volume - 0.5) < 1e-9);

  const ctl = makeController();
  const r = await ctl.requestRestore('g=T2&vg=140');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'volume');
  assert.equal(E.state.layers.groove.song, 'Alpha Song'); // rolled back
  assert.ok(Math.abs(E.state.layers.groove.volume - 0.5) < 1e-9);
});

test('restore: injected stretch failure fails the transaction and rolls all layers back', async () => {
  await loadEngine();
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1');
  await settle(5);
  const beforeSong = E.state.layers.groove.song;

  // Make the lead layer's render reject.
  E.setTestFault('stretch:Beta Song');
  const ctl = makeController();
  const r = await ctl.requestRestore('g=T1&l=T2&t=T3');
  E.clearTestFaults();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'stretch');
  await settle(5);

  // No half-loaded layer: groove restored to its prior song, lead/texture empty.
  assert.equal(E.state.layers.groove.song, beforeSong);
  assert.equal(E.state.layers.lead.song, null);
  assert.equal(E.state.layers.texture.song, null);
  for (const id of ['lead', 'texture']) assert.equal(E.state.layers[id].loading, false);
  // The rolled-back groove still has a playable buffer.
  assert.ok(E.state.layers.groove.buffer);
});

test('restore: injected limiter rebuild failure fails the whole restore with no picks', async () => {
  await loadEngine();
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1');
  await settle(5);
  const before = E.snapshotMix();

  E.setTestFault('limiter');
  const ctl = makeController();
  const r = await ctl.requestRestore('g=T2&l=T1');
  E.clearTestFaults();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limiter');
  await settle(5);

  // The transaction rolled back to the prior mix; nothing new was selected.
  assert.equal(E.state.layers.groove.song, before.layers.groove.song);
  assert.equal(E.state.layers.lead.song, before.layers.lead.song);
});

test('restore: strict graph rebuild actually replaced the audio context', async () => {
  await loadEngine();
  const firstCtx = E.ctx;
  const ctl = makeController();
  const r = await ctl.requestRestore('g=T1&l=T2');
  assert.equal(r.ok, true);
  assert.ok(E.ctx, 'a context exists after rebuild');
  assert.notEqual(E.ctx, firstCtx, 'the master graph was rebuilt on a fresh context');
  assert.equal(E.ctx.closed, false);
});

test('restore: after a limiter failure the next healthy restore still succeeds', async () => {
  await loadEngine();
  const ctl = makeController();
  E.setTestFault('limiter');
  const bad = await ctl.requestRestore('g=T2');
  E.clearTestFaults();
  assert.equal(bad.ok, false);
  await settle(2);

  const good = await ctl.requestRestore('g=T1&l=T2');
  assert.equal(good.ok, true, good.error && good.error.message);
  await settle(5);
  assert.equal(E.state.layers.groove.song, 'Alpha Song');
  assert.equal(E.state.layers.lead.song, 'Beta Song');
});

test('restore: a link without mute/volume for a layer leaves those settings as they were', async () => {
  await loadEngine();
  // Existing mix with a custom texture level and mute.
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1&l=T2&t=T3&vt=33&mt=1');
  await settle(5);
  assert.ok(Math.abs(E.state.layers.texture.volume - 0.33) < 1e-9);
  assert.equal(E.state.layers.texture.muted, true);

  // New link only re-picks groove/lead and says nothing about texture: texture keeps its level+mute.
  const ctl = makeController();
  const r = await ctl.requestRestore('g=T2&l=T1');
  assert.equal(r.ok, true, r.error && r.error.message);
  await settle(5);
  assert.equal(E.state.layers.groove.song, 'Beta Song');
  assert.equal(E.state.layers.lead.song, 'Alpha Song');
  assert.ok(Math.abs(E.state.layers.texture.volume - 0.33) < 1e-9);
  assert.equal(E.state.layers.texture.muted, true);
});

test('restore: rolled-back mix is still playable after a failed transaction', async () => {
  await loadEngine();
  const ctl0 = makeController();
  await ctl0.requestRestore('g=T1&l=T2');
  await settle(5);
  E.setTestFault('stretch:Gamma Song');
  const ctl = makeController();
  const r = await ctl.requestRestore('g=T1&l=T2&t=T3');
  E.clearTestFaults();
  assert.equal(r.ok, false);
  await settle(5);
  // Pre-restore layers are back and current, so play starts cleanly.
  assert.equal(E.state.layers.groove.song, 'Alpha Song');
  assert.equal(E.state.layers.lead.song, 'Beta Song');
  assert.ok(E.state.layers.groove.buffer && E.state.layers.lead.buffer);
  await E.play();
  assert.equal(E.state.playing, true);
  E.stop();
});

test('restore: queued UI mutations cannot cross-write a layer and replay in order after', async () => {
  await loadEngine();
  const ctl = makeController();
  let release;
  const gate = new Promise((res) => { release = res; });
  E.setTestHook('beforeRebuildGraph', () => gate); // hold the transaction observably in flight

  const done = ctl.requestRestore('g=T1&l=T2&t=T3');
  await settle(2);
  assert.equal(ctl.isRestoring(), true);

  // UI mutations while restoring: they must queue, not touch layers yet.
  const order = [];
  const m1 = ctl.mutate(async () => { order.push('mute'); E.setMuted('groove', true); });
  const m2 = ctl.mutate(async () => { order.push('clear'); E.clearLayer('lead'); });
  await settle(2);
  // Restore still owns the layers: its picks are what's present.
  assert.equal(order.length, 0, 'mutations held back until the transaction ends');
  assert.equal(E.state.layers.groove.muted, false);

  release();
  const r = await done;
  await Promise.all([m1, m2]);
  E.setTestHook('beforeRebuildGraph', null);
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['mute', 'clear']); // call order preserved
  assert.equal(E.state.layers.groove.muted, true); // replayed after restore
  assert.equal(E.state.layers.lead.song, null);
});

test('restore: two links submitted while one is queued honour only the last', async () => {
  await loadEngine();
  const ctl = makeController();
  let release;
  const gate = new Promise((res) => { release = res; });
  E.setTestHook('beforeRebuildGraph', () => gate);

  const first = ctl.requestRestore('g=T1');
  await settle(2);
  const second = ctl.requestRestore('l=T2'); // queued
  const third = ctl.requestRestore('t=T3'); // supersedes second
  release();
  const [r1, r2, r3] = await Promise.all([first, second, third]);
  E.setTestHook('beforeRebuildGraph', null);
  assert.equal(r1.ok, true);
  assert.equal(r2.superseded, true);
  assert.equal(r3.ok, true);
  assert.equal(E.state.layers.texture.song, 'Gamma Song'); // last link applied
  assert.equal(E.state.layers.lead.song, null); // superseded link never applied
});
