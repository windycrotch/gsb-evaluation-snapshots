/* Unit tests for the share-restore transaction that need no audio engine:
   link parsing/validation, queueing, last-link-wins, coalescing and rollback,
   driven through a scripted fake port. Engine-level (real graph/limiter/stretch)
   coverage lives in engine.restore.test.mjs. Run: node --test test/  */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShareHash, createRestoreController, RestoreError } from '../js/share-restore.js';
import { MANIFEST } from './fixtures.mjs';

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const BOUNDS = { BPM_MIN: 80, BPM_MAX: 140 };
const parse = (raw) => parseShareHash(raw, { manifest: MANIFEST, NOTE, ...BOUNDS });
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('parse: full link yields songs, gains, mutes, tempo and key', () => {
  const out = parse('g=T1&l=T2&t=T3&vg=40&vl=72.5&mg=1&bpm=124&lock=1&key=A&a=gl t'.replace(' ', ''));
  assert.deepEqual(out.order, ['groove', 'lead', 'texture']);
  assert.equal(out.layers.groove.song, 'Alpha Song');
  assert.equal(out.layers.lead.song, 'Beta Song');
  assert.equal(out.layers.texture.song, 'Gamma Song');
  assert.equal(out.layers.groove.volume, 0.4);
  assert.equal(out.layers.lead.volume, 0.725);
  assert.equal(out.layers.groove.muted, true);
  assert.equal(out.layers.lead.muted, false);
  assert.equal(out.bpm, 124);
  assert.equal(out.masterKey, 'A');
});

test('parse: unknown song code is rejected before any state change', () => {
  assert.throws(() => parse('g=NOPE&l=T2'), (e) => e instanceof RestoreError && e.code === 'unknown-song');
});

test('parse: out-of-range and non-numeric volumes are rejected', () => {
  assert.throws(() => parse('g=T1&vg=101'), (e) => e.code === 'volume');
  assert.throws(() => parse('g=T1&vg=-5'), (e) => e.code === 'volume');
  assert.throws(() => parse('g=T1&vg=abc'), (e) => e.code === 'volume');
});

test('parse: boundary volumes 0 and 100 accepted', () => {
  const out = parse('g=T1&vg=0&vl=100');
  assert.equal(out.layers.groove.volume, 0);
  assert.equal(out.layers.lead.volume, 100 / 100);
});

test('parse: out-of-range tempo and unknown key rejected', () => {
  assert.throws(() => parse('g=T1&bpm=200'), (e) => e.code === 'tempo');
  assert.throws(() => parse('g=T1&bpm=70'), (e) => e.code === 'tempo');
  assert.throws(() => parse('g=T1&key=Z'), (e) => e.code === 'key');
});

test('parse: link with no songs is rejected', () => {
  assert.throws(() => parse('vg=50'), (e) => e.code === 'empty');
});

test('parse: prototype-ish codes cannot touch object properties', () => {
  assert.throws(() => parse('g=constructor'), (e) => e.code === 'unknown-song');
  assert.throws(() => parse('g=toString'), (e) => e.code === 'unknown-song');
});

// A scripted port recording the calls a transaction makes, with controllable failures.
function makePort({ failAt = null, delay = 1 } = {}) {
  const calls = [];
  const gate = { graph: 0, picks: 0 };
  const port = {
    _calls: calls, _gate: gate,
    parse,
    snapshot() { calls.push('snapshot'); return { snap: true }; },
    async restoreSnapshot(s) { calls.push(['rollback', s]); },
    async rebuildGraph(o) {
      calls.push(['rebuildGraph', o.strict]);
      if (failAt === 'limiter') throw new RestoreError('limiter down', { code: 'limiter' });
      if (delay) await tick();
      gate.graph++;
    },
    applyMixSettings(d) { calls.push('settings'); },
    setVolume(id, v) { calls.push(['vol', id, v]); },
    setMuted(id, m) { calls.push(['mute', id, m]); },
    async selectStem(id, song) {
      calls.push(['pick', id, song]);
      if (delay) await tick();
      gate.picks++;
      if (failAt === `stretch:${id}` || failAt === 'stretch') throw Object.assign(new Error(`stretch ${id} failed`), { code: 'stretch' });
    },
    afterCommit(d) { calls.push('committed'); },
  };
  return port;
}

test('transaction: happy path calls graph rebuild, settings, levels, picks, one commit', async () => {
  const port = makePort();
  const ctl = createRestoreController(port);
  const r = await ctl.requestRestore('g=T1&l=T2&vg=30&mg=1&bpm=120');
  assert.equal(r.ok, true);
  const flat = port._calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.ok(flat.includes('rebuildGraph'));
  assert.deepEqual(flat.slice(-1), ['committed']);
  assert.equal(flat.filter((x) => x === 'committed').length, 1);
  assert.ok(port._calls.find((c) => Array.isArray(c) && c[0] === 'rebuildGraph' && c[1] === true)); // strict
});

test('transaction: stretch failure rolls back and reports, no commit', async () => {
  const port = makePort({ failAt: 'stretch:lead' });
  const ctl = createRestoreController(port);
  const r = await ctl.requestRestore('g=T1&l=T2&t=T3');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'stretch');
  assert.ok(port._calls.some((c) => Array.isArray(c) && c[0] === 'rollback'));
  assert.ok(!port._calls.includes('committed'));
});

test('transaction: limiter rebuild failure aborts before any pick and rolls back', async () => {
  const port = makePort({ failAt: 'limiter' });
  const ctl = createRestoreController(port);
  const r = await ctl.requestRestore('g=T1&l=T2');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limiter');
  assert.ok(!port._calls.some((c) => Array.isArray(c) && c[0] === 'pick'));
  assert.ok(port._calls.some((c) => Array.isArray(c) && c[0] === 'rollback'));
});

test('transaction: validation failure never touches the engine and rolls back', async () => {
  const port = makePort();
  const ctl = createRestoreController(port);
  const r = await ctl.requestRestore('g=NOPE');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unknown-song');
  // snapshot still captured, but graph rebuild and picks never ran
  assert.ok(!port._calls.some((c) => Array.isArray(c) && c[0] === 'rebuildGraph'));
  assert.ok(!port._calls.some((c) => Array.isArray(c) && c[0] === 'pick'));
  assert.ok(port._calls.some((c) => Array.isArray(c) && c[0] === 'rollback'));
});

test('queue: mutations during restore wait and replay in order after it', async () => {
  const order = [];
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  port.rebuildGraph = async () => { order.push('graph-start'); await block; order.push('graph-end'); };
  const ctl = createRestoreController(port);
  const done = ctl.requestRestore('g=T1&l=T2');
  await tick();
  assert.equal(ctl.isRestoring(), true);
  const m1 = ctl.mutate(async () => { order.push('op1'); });
  const m2 = ctl.mutate(async () => { order.push('op2'); });
  release();
  await Promise.all([done, m1, m2]);
  assert.deepEqual(order, ['graph-start', 'graph-end', 'op1', 'op2']);
  assert.equal(ctl.isRestoring(), false);
});

test('queue: a mutation cannot change the restore result', async () => {
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  const seen = [];
  port.selectStem = async (id, song) => { seen.push(song); await block; };
  const ctl = createRestoreController(port);
  const done = ctl.requestRestore('g=T1');
  await tick();
  // a "pick on the same layer" made while the transaction runs
  const op = ctl.mutate(async () => { port._calls.push(['late-pick', 'Beta Song']); });
  release();
  const r = await done;
  await op;
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['Alpha Song']); // the restore's pick, untouched
  assert.ok(port._calls.some((c) => Array.isArray(c) && c[0] === 'late-pick')); // queued op still ran after
});

test('last-link-wins: two links pasted while queued only run the second', async () => {
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  port.rebuildGraph = async () => { await block; };
  const ctl = createRestoreController(port);
  const first = ctl.requestRestore('g=T1');
  const second = ctl.requestRestore('l=T2'); // queued while first runs -> runs next, not dropped
  await tick();
  const third = ctl.requestRestore('t=T3'); // queued while second waits -> supersedes second
  release();
  const [r1, r2, r3] = await Promise.all([first, second, third]);
  assert.equal(r1.ok, true);
  assert.equal(r2.superseded, true);
  assert.equal(r3.ok, true);
  const picks = port._calls.filter((c) => Array.isArray(c) && c[0] === 'pick').map((c) => c[1]);
  assert.deepEqual(picks, ['groove', 'texture']); // lead link never ran
});

test('coalesce: the same link submitted twice is one transaction', async () => {
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  let graphs = 0;
  port.rebuildGraph = async () => { graphs++; await block; };
  const ctl = createRestoreController(port);
  const a = ctl.requestRestore('g=T1');
  await wait(1); // let the drainer reach the blocking rebuildGraph and set active
  const b = ctl.requestRestore('g=T1'); // identical, in flight
  assert.equal(a, b);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(graphs, 1); // the graph was rebuilt once, not once per submission
});

test('idle mutations run immediately without a restore', async () => {
  const port = makePort();
  const ctl = createRestoreController(port);
  let ran = false;
  await ctl.mutate(async () => { ran = true; });
  assert.equal(ran, true);
});

test('coalesce: re-submitting after completion is a fresh, independent transaction', async () => {
  const port = makePort({ delay: 0 });
  const ctl = createRestoreController(port);
  const r1 = await ctl.requestRestore('g=T1');
  assert.equal(r1.ok, true);
  // Nothing in flight now: the same link is legitimately run again (e.g. a real re-open),
  // not swallowed by stale coalescing state.
  const r2 = await ctl.requestRestore('g=T1');
  assert.equal(r2.ok, true);
  assert.notEqual(r1, r2);
  assert.equal(port._calls.filter((c) => Array.isArray(c) && c[0] === 'rebuildGraph').length, 2);
});

test('coalesce: many duplicate submissions during one restore all share its result', async () => {
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  port.rebuildGraph = async () => { await block; };
  const ctl = createRestoreController(port);
  const first = ctl.requestRestore('l=T2');
  await wait(1);
  // Simulate a background/foreground round trip firing several identical submissions.
  const dupes = [ctl.requestRestore('l=T2'), ctl.requestRestore('l=T2'), ctl.requestRestore('l=T2')];
  assert.ok(dupes.every((p) => p === first));
  release();
  const results = await Promise.all([first, ...dupes]);
  assert.ok(results.every((r) => r.ok === true));
});

test('isRestoring reflects queued and active phases then clears', async () => {
  let release;
  const block = new Promise((res) => { release = res; });
  const port = makePort({ delay: 0 });
  port.rebuildGraph = async () => { await block; };
  const ctl = createRestoreController(port);
  const done = ctl.requestRestore('g=T1');
  await wait(1);
  assert.equal(ctl.isRestoring(), true);
  release();
  await done;
  assert.equal(ctl.isRestoring(), false);
});

test('parse: anchor order from the a= parameter is preserved', () => {
  const out = parse('g=T1&l=T2&t=T3&a=tlg');
  assert.deepEqual(out.order, ['texture', 'lead', 'groove']);
});
