// ╔══════════════════════════════════════════════════════════════════╗
// ║  Offline tests for the harvest session manager (src/harvest-      ║
// ║  session.js). No Chrome, no YouTube account, no network: every    ║
// ║  browser API is a fake injected via createHarvestManager(deps).  ║
// ╚══════════════════════════════════════════════════════════════════╝

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHarvestManager,
  isValid774Url,
  isHarvesterSender,
  isNo774Confirmed,
  HARVEST_OUTCOME,
} from '../src/harvest-session.js';

const EXT_ID = 'ext-id-1234567890abcdef';
const HARVESTER_URL = `chrome-extension://${EXT_ID}/src/harvester.html`;
const VID_A = 'aaaaaaaaaaa';
const VID_B = 'bbbbbbbbbbb';

const GOOD_774_URL = 'https://rr3---sn-fake.googlevideo.com/videoplayback?itag=774&docid=' + VID_A + '&clen=320000&dur=10&c=WEB_REMIX';

// ─── Fakes ────────────────────────────────────────────────────────────

// Deterministic manual timer: nothing fires unless the test says so.
class FakeTimers {
  constructor() { this.queue = []; this.id = 0; }
  setTimeout(fn, ms) {
    const t = { id: ++this.id, fn, ms, fired: false };
    this.queue.push(t);
    return t.id;
  }
  clearTimeout(id) {
    const t = this.queue.find(x => x.id === id);
    if (t) t.cancelled = true;
  }
  // Fire every still-pending timer (the manager only ever arms one at a
  // time, so this is effectively "expire the active timeout").
  runAll() {
    for (const t of this.queue) {
      if (!t.fired && !t.cancelled) {
        t.fired = true;
        t.fn();
      }
    }
  }
  get pendingCount() {
    return this.queue.filter(t => !t.fired && !t.cancelled).length;
  }
}

function makeDeps(overrides = {}) {
  const timers = new FakeTimers();
  const sentToOffscreen = [];
  const idleCloseCalls = [];
  const deps = {
    timers,
    timeoutMs: 8000,
    runtimeId: EXT_ID,
    harvesterUrl: HARVESTER_URL,
    log: () => {},
    ensureOffscreen: async () => { deps.offscreenReadyCount++; },
    sendToOffscreen: async (msg) => { sentToOffscreen.push(msg); },
    scheduleIdleClose: () => { idleCloseCalls.push(1); },
    offscreenReadyCount: 0,
    sentToOffscreen,
    idleCloseCalls,
    ...overrides,
  };
  return deps;
}

const harvesterSender = { id: EXT_ID, tab: undefined, url: HARVESTER_URL };
const forgedTabSender = { id: EXT_ID, tab: { id: 7 }, url: 'https://www.youtube.com/' };
const otherExtSender = { id: 'some-other-extension', tab: undefined, url: HARVESTER_URL };

const flushMicrotasks = () => new Promise(r => setImmediate(r));

// ─── Pure validator tests ─────────────────────────────────────────────

test('isValid774Url accepts only https googlevideo videoplayback with itag 774', () => {
  assert.equal(isValid774Url(GOOD_774_URL), true);
  assert.equal(isValid774Url(GOOD_774_URL.replace('https://', 'http://')), false, 'http must be rejected');
  assert.equal(isValid774Url(GOOD_774_URL.replace('googlevideo.com', 'googlevideo.evil.com')), false, 'look-alike host rejected');
  assert.equal(isValid774Url(GOOD_774_URL.replace('googlevideo.com', 'evilgooglevideo.com')), false, 'suffix-spoof host rejected');
  assert.equal(isValid774Url(GOOD_774_URL.replace('itag=774', 'itag=251')), false, 'wrong itag rejected');
  assert.equal(isValid774Url(GOOD_774_URL.replace('/videoplayback', '/initplayback')), false, 'wrong path rejected');
  assert.equal(isValid774Url('not a url'), false);
  assert.equal(isValid774Url(''), false);
  assert.equal(isValid774Url(null), false);
  // Path-style itag is also accepted.
  assert.equal(
    isValid774Url('https://rr1.googlevideo.com/videoplayback/itag/774/foo?c=WEB_REMIX'),
    true
  );
});

test('isHarvesterSender requires same extension id, no tab, and harvester URL', () => {
  assert.equal(isHarvesterSender(harvesterSender, EXT_ID, HARVESTER_URL), true);
  assert.equal(isHarvesterSender(forgedTabSender, EXT_ID, HARVESTER_URL), false);
  assert.equal(isHarvesterSender(otherExtSender, EXT_ID, HARVESTER_URL), false);
  assert.equal(isHarvesterSender({ id: EXT_ID, tab: undefined, url: HARVESTER_URL + '/../popup.html' }, EXT_ID, HARVESTER_URL), true);
  assert.equal(isHarvesterSender(null, EXT_ID, HARVESTER_URL), false);
});

test('isNo774Confirmed requires every applicable source to positively report no774', () => {
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'no774' },
    { provider: 'TVHTML5', status: 'no774' },
  ]), true);
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'no774' },
    { provider: 'TVHTML5', status: 'skipped' },
  ]), true, 'a skipped (inapplicable) source is ignored');
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'timeout' },
    { provider: 'TVHTML5', status: 'no774' },
  ]), false, 'timeout blocks confirmation');
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'cancelled' },
    { provider: 'TVHTML5', status: 'no774' },
  ]), false, 'cancellation blocks confirmation');
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'failed' },
  ]), false, 'inconclusive failure blocks confirmation');
  assert.equal(isNo774Confirmed([
    { provider: 'YTM_HARVESTER', status: 'skipped' },
    { provider: 'TVHTML5', status: 'skipped' },
  ]), false, 'nothing actually ran -> never confirmed');
  assert.equal(isNo774Confirmed([]), false);
});

// ─── Path 1: normal success via offscreen success message ─────────────

test('path 1: valid offscreen success delivers a verified 774 format and tears the frame down', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);

  const p = mgr.start(VID_A);
  await flushMicrotasks();
  assert.equal(mgr.isActive(), true);
  assert.equal(mgr.getActiveVideoId(), VID_A);
  assert.deepEqual(
    deps.sentToOffscreen.map(m => m.type),
    ['OFFSCREEN_HARVEST_YTM'],
    'a harvest frame is started exactly once'
  );

  const receipt = mgr.handleHarvestSuccess(
    { type: 'OFFSCREEN_HARVEST_SUCCESS', videoId: VID_A, url: GOOD_774_URL },
    harvesterSender
  );
  assert.equal(receipt, true);

  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(result.videoId, VID_A);
  assert.equal(result.formats.length, 1);
  assert.equal(result.formats[0].itag, 774);
  assert.equal(result.formats[0].url.includes('itag=774'), true);
  assert.equal(result.formats[0].url.includes('range='), false, 'chunking params are stripped');
  assert.equal(result.formats[0].bitrate, 256000, 'bitrate derived from clen/dur = 320000*8/10');

  assert.equal(mgr.isActive(), false);
  assert.ok(deps.sentToOffscreen.some(m => m.type === 'OFFSCREEN_STOP_HARVEST'), 'iframe is stopped on settlement');
  assert.ok(deps.idleCloseCalls.length >= 1, 'idle offscreen close is scheduled');
  assert.equal(deps.timers.pendingCount, 0, 'timeout timer is cleared');
});

test('path 1b: webRequest delivery also settles success and ignores a mismatched docid', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);

  const p = mgr.start(VID_A);
  await flushMicrotasks();

  const wrongDoc = GOOD_774_URL.replace(`docid=${VID_A}`, `docid=${VID_B}`);
  assert.equal(mgr.deliverWebRequest(wrongDoc), false);
  assert.equal(mgr.isActive(), true, 'foreign-docid stream must not settle the session');

  assert.equal(mgr.deliverWebRequest(GOOD_774_URL), true);
  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(result.formats[0].itag, 774);
});

// ─── Path 2: forged sender is rejected with received:false ────────────

test('path 2: forged senders are refused (received:false) and never settle the session', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);
  const p = mgr.start(VID_A);
  await flushMicrotasks();

  const msg = { type: 'OFFSCREEN_HARVEST_SUCCESS', videoId: VID_A, url: GOOD_774_URL };
  assert.equal(mgr.handleHarvestSuccess(msg, forgedTabSender), false, 'youtube tab sender rejected');
  assert.equal(mgr.handleHarvestSuccess(msg, otherExtSender), false, 'foreign extension rejected');
  assert.equal(mgr.handleHarvestSuccess(msg, null), false, 'missing sender rejected');
  assert.equal(mgr.handleHarvestAbort({ videoId: VID_A, reason: 'NO_774_STREAM' }, forgedTabSender), false);

  assert.equal(mgr.isActive(), true, 'forged messages cannot end the session');

  // The rejected count is surfaced on the eventual outcome so the upper
  // layer can tell illegal data was received.
  deps.timers.runAll();
  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.TIMEOUT);
  assert.ok(result.rejectedMessages >= 4);
});

// ─── Path 3: illegal URL is rejected with received:false ──────────────

test('path 3: illegal URLs are refused even when the sender is our own offscreen document', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);
  const p = mgr.start(VID_A);
  await flushMicrotasks();

  const badUrls = [
    'http://rr3.googlevideo.com/videoplayback?itag=774',                 // not https
    'https://evil.example.com/videoplayback?itag=774',                    // wrong host
    'https://rr3.googlevideo.com/videoplayback?itag=251',                 // wrong itag
    'https://rr3.googlevideo.com/initplayback?itag=774',                  // wrong path
    'javascript:alert(1)',                                                // unparseable
  ];
  for (const url of badUrls) {
    const receipt = mgr.handleHarvestSuccess({ videoId: VID_A, url }, harvesterSender);
    assert.equal(receipt, false, `expected rejection for ${url}`);
  }
  assert.equal(mgr.isActive(), true);

  // A later legal message still works — rejection did not poison the session.
  assert.equal(mgr.handleHarvestSuccess({ videoId: VID_A, url: GOOD_774_URL }, harvesterSender), true);
  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(result.rejectedMessages, badUrls.length);
});

// ─── Path 4: track switch cancels the old session (single ending) ─────

test('path 4: starting a new video cancels the old session with CANCELLED and old results cannot land on it', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);

  const oldP = mgr.start(VID_A);
  await flushMicrotasks();
  assert.equal(mgr.getActiveVideoId(), VID_A);

  const newP = mgr.start(VID_B);
  await flushMicrotasks();

  const oldResult = await oldP;
  assert.equal(oldResult.outcome, HARVEST_OUTCOME.CANCELLED);
  assert.equal(oldResult.videoId, VID_A);
  assert.equal(mgr.getActiveVideoId(), VID_B);
  assert.equal(mgr.isActive(), true);

  // A late success message carrying the OLD video id must be ignored by the
  // new session — old results can never be handed to the new track.
  const receipt = mgr.handleHarvestSuccess(
    { videoId: VID_A, url: GOOD_774_URL },
    harvesterSender
  );
  assert.equal(receipt, true, 'legal message is acknowledged, but not routed');
  assert.equal(mgr.getActiveVideoId(), VID_B);
  assert.equal(mgr.isActive(), true, 'new session stays open');

  mgr.handleHarvestSuccess(
    { videoId: VID_B, url: GOOD_774_URL.replace(`docid=${VID_A}`, `docid=${VID_B}`) },
    harvesterSender
  );
  const newResult = await newP;
  assert.equal(newResult.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(newResult.videoId, VID_B);

  // Idempotency: settling twice is impossible.
  assert.equal(mgr.deliverWebRequest(GOOD_774_URL), false);
});

test('path 4b: duplicate requests for the SAME video reuse the in-flight session', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);

  const p1 = mgr.start(VID_A);
  const p2 = mgr.start(VID_A);
  assert.equal(p1, p2, 'same video joins the existing promise instead of opening a second session');
  await flushMicrotasks();
  assert.equal(
    deps.sentToOffscreen.filter(m => m.type === 'OFFSCREEN_HARVEST_YTM').length,
    1,
    'only one harvester frame is started'
  );

  mgr.handleHarvestSuccess({ videoId: VID_A, url: GOOD_774_URL }, harvesterSender);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(r2.outcome, HARVEST_OUTCOME.SUCCESS);
  assert.equal(mgr.pendingCount, 0, 'pending entry is cleaned up after settlement');
});

// ─── Path 5: 8s timeout only marks TIMEOUT, never no774 ──────────────

test('path 5: the 8s timeout settles TIMEOUT (not no774) and tears the frame down', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);

  const start = process.hrtime.bigint();
  const p = mgr.start(VID_A);
  await flushMicrotasks();
  assert.equal(deps.timers.queue[0].ms, 8000, 'timeout is armed at exactly 8000ms');

  deps.timers.runAll();
  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.TIMEOUT);
  assert.notEqual(result.outcome, HARVEST_OUTCOME.NO_774);
  assert.equal(mgr.isActive(), false);
  assert.ok(deps.sentToOffscreen.some(m => m.type === 'OFFSCREEN_STOP_HARVEST'));
  assert.ok(deps.idleCloseCalls.length >= 1);
  assert.equal(deps.timers.pendingCount, 0);
  assert.ok(process.hrtime.bigint() - start > 0n);
});

test('path 5b: a success arriving after the timeout cannot re-settle the session', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);
  const p = mgr.start(VID_A);
  await flushMicrotasks();

  deps.timers.runAll();
  const timedOut = await p;
  assert.equal(timedOut.outcome, HARVEST_OUTCOME.TIMEOUT);

  const receipt = mgr.handleHarvestSuccess({ videoId: VID_A, url: GOOD_774_URL }, harvesterSender);
  assert.equal(receipt, true, 'still acknowledged at transport level');
  assert.equal(timedOut.outcome, HARVEST_OUTCOME.TIMEOUT, 'the single ending does not change');
});

// ─── Abort semantics: conclusive no774 vs inconclusive failure ───────

test('NO_774_STREAM / UNPLAYABLE aborts settle NO_774; other reasons settle FAILED', async () => {
  const depsA = makeDeps();
  const mgrA = createHarvestManager(depsA);
  const pA = mgrA.start(VID_A);
  await flushMicrotasks();
  mgrA.handleHarvestAbort({ videoId: VID_A, reason: 'NO_774_STREAM' }, harvesterSender);
  const rA = await pA;
  assert.equal(rA.outcome, HARVEST_OUTCOME.NO_774);
  assert.equal(rA.reason, 'NO_774_STREAM');

  const depsB = makeDeps();
  const mgrB = createHarvestManager(depsB);
  const pB = mgrB.start(VID_A);
  await flushMicrotasks();
  mgrB.handleHarvestAbort({ videoId: VID_A, reason: 'UNPLAYABLE: Video unavailable' }, harvesterSender);
  const rB = await pB;
  assert.equal(rB.outcome, HARVEST_OUTCOME.NO_774);

  const depsC = makeDeps();
  const mgrC = createHarvestManager(depsC);
  const pC = mgrC.start(VID_A);
  await flushMicrotasks();
  mgrC.handleHarvestAbort({ videoId: VID_A, reason: 'TRACK_MISMATCH: YTM skipped to xyz' }, harvesterSender);
  const rC = await pC;
  assert.equal(rC.outcome, HARVEST_OUTCOME.FAILED, 'mismatch is inconclusive, not a no774 verdict');
});

test('offscreen document creation failure settles FAILED instead of looking like no774', async () => {
  const deps = makeDeps({
    ensureOffscreen: async () => { throw new Error('offscreen boom'); },
  });
  const mgr = createHarvestManager(deps);
  const result = await mgr.start(VID_A);
  assert.equal(result.outcome, HARVEST_OUTCOME.FAILED);
  assert.match(result.reason, /offscreen boom/);
  assert.equal(mgr.isActive(), false);
});

test('cancelActive settles the running session CANCELLED and is a no-op when idle', async () => {
  const deps = makeDeps();
  const mgr = createHarvestManager(deps);
  const p = mgr.start(VID_A);
  await flushMicrotasks();
  mgr.cancelActive('MANUAL_STOP');
  const result = await p;
  assert.equal(result.outcome, HARVEST_OUTCOME.CANCELLED);
  assert.equal(result.reason, 'MANUAL_STOP');
  assert.doesNotThrow(() => mgr.cancelActive('NOTHING_RUNNING'));
});
