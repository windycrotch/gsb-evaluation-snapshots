// Lifecycle tests for the browser-facing journey orchestration. Every
// ambient API (timers, frames, history events, loading screen, navigation)
// is injected as a fake, so the three required scenarios run deterministically
// under Node with no browser:
//
//   1. concurrent repeated initiations are ignored, not queued
//   2. a failed journey fully restores and a new attempt can start
//   3. a BFCache (pageshow persisted) restore is mutually exclusive with any
//      in-flight journey, including its stale callbacks
//
//   node --test tools/journey-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJourney } from '../engine/journey-run.js';
import { RESTORE_HISTORY, RESTORE_FAILURE } from '../engine/journey.js';

function makeHost(overrides = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const loading = [];
  const navigations = [];
  const events = { pageshow: [], pagehide: [] };
  // Frames auto-flush on timer ticks, like a real browser, so a run() that
  // awaits two frames can settle on its own. The failure watchdog uses the
  // fake timer map and only fires when a test explicitly triggers it.
  const frameQueue = [];
  const host = {
    returnLabel: () => 'Loading the world…',
    showLoading: (label, fraction, image) => loading.push({ label, fraction, image }),
    finishLoading: () => loading.push({ done: true }),
    makeLink: async next => `https://destination.test/${next?.id ?? ''}`,
    navigate: href => navigations.push(href),
    requestFrame: cb => { frameQueue.push(cb); setTimeout(() => { const fn = frameQueue.shift(); if (fn) fn(); }, 0); },
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
    addPageShow: fn => events.pageshow.push(fn),
    addPageHide: fn => events.pagehide.push(fn),
    markDeparted() { host.departed = true; },
    clearDeparted() { host.departed = false; },
    markHistory() { host.historyMarked = true; },
    clearHistory() { host.historyMarked = false; },
    onRestore: reason => host.restored.push(reason),
    ...overrides,
  };
  host.timers = timers;
  host.loading = loading;
  host.navigations = navigations;
  host.events = events;
  host.frameQueue = frameQueue;
  host.restored = [];
  host.departed = false;
  host.historyMarked = false;
  return host;
}

// Let the two auto-flushing frame callbacks run.
const drainFrames = () => new Promise(resolve => setTimeout(resolve, 5));

function fireFailureWatchdog(host) {
  for (const [id, entry] of [...host.timers]) {
    host.timers.delete(id);
    entry.fn();
  }
}

const world = id => ({ id, url: `https://destination.test/${id}`, name: `World ${id}`, preview: null });

test('scenario 1: concurrent repeated initiations run one journey and ignore the rest', async () => {
  const host = makeHost();
  const journey = createJourney(host);

  const first = journey.begin();
  assert.notEqual(first, null);
  // Repeated clicks / Esc / Back while the first journey is starting.
  assert.equal(journey.begin(), null);
  assert.equal(journey.begin(), null);

  const ok = await journey.run(first, { label: 'go', next: world('a') });
  await drainFrames();
  assert.equal(ok, true);
  assert.equal(host.navigations.length, 1, 'exactly one navigation happens');
  assert.equal(host.navigations[0], 'https://destination.test/a');
  assert.equal(journey.isActive(), true, 'the slot stays held until navigation resolves or restores');

  // A second run with a bogus ticket cannot navigate.
  const bogus = await journey.run(999, { label: 'go', next: world('b') });
  assert.equal(bogus, false);
  assert.equal(host.navigations.length, 1);
});

test('scenario 1b: a second begin while the first runs can never build a link', async () => {
  let links = 0;
  const host = makeHost({ makeLink: async next => { links++; return `https://destination.test/${next.id}`; } });
  const journey = createJourney(host);
  const ticket = journey.begin();
  // Every repeat initiation during the in-flight window is refused up front.
  assert.equal(journey.begin(), null);
  const ok = await journey.run(ticket, { label: 'a', next: world('a') });
  await drainFrames();
  assert.equal(ok, true);
  assert.equal(links, 1, 'the door link is built once');
  assert.equal(host.navigations.length, 1);
  assert.equal(journey.begin(), null, 'the slot remains held after navigating');
});

test('scenario 2: a navigation failure restores everything and a retry succeeds', async () => {
  // The first navigation is swallowed (a blocked/dropped link); flipping the
  // flag lets the retry navigate. The indirection stays on `host` because the
  // orchestration binds its callbacks once at creation.
  const host = makeHost({ navigate: href => { if (host.allowNavigation) host.navigations.push(href); } });
  host.allowNavigation = false;
  const journey = createJourney(host);

  const first = journey.begin();
  const ok = await journey.run(first, { label: 'go', next: world('a') });
  await drainFrames();
  assert.equal(ok, true, 'navigation was triggered (then failed to leave the document)');
  assert.equal(journey.isActive(), true);
  assert.equal(host.timers.size, 1, 'the failure watchdog is armed');

  fireFailureWatchdog(host);
  assert.equal(journey.isActive(), false, 'the failed journey releases the slot');
  assert.deepEqual(host.restored, [RESTORE_FAILURE]);
  assert.equal(host.loading.at(-1).done, true, 'the loading screen is dismissed on failure');
  assert.equal(host.departed, false, 'departed markers are cleaned up');
  assert.equal(host.historyMarked, false, 'the history marker is removed');

  // The old ticket is dead: its late continuation cannot navigate.
  assert.equal(journey.isCurrent(first), false);

  // A fresh attempt is accepted and now navigates.
  host.allowNavigation = true;
  const second = journey.begin();
  assert.notEqual(second, null);
  assert.ok(second > first);
  const retry = await journey.run(second, { label: 'retry', next: world('b') });
  await drainFrames();
  assert.equal(retry, true);
  assert.equal(host.navigations.length, 1);
  assert.equal(host.navigations[0], 'https://destination.test/b');
});

test('scenario 2b: a rejected makeLink fails the journey and restores', async () => {
  const host = makeHost({ makeLink: async () => { throw new Error('skin storage blocked'); } });
  const journey = createJourney(host);
  const ticket = journey.begin();
  const ok = await journey.run(ticket, { label: 'go', next: world('a') });
  await drainFrames();
  assert.equal(ok, false);
  assert.equal(journey.isActive(), false);
  assert.deepEqual(host.restored, [RESTORE_FAILURE]);
  assert.equal(host.navigations.length, 0);
});

test('scenario 2c: pagehide disarms the failure watchdog (a real navigation)', async () => {
  const host = makeHost();
  const journey = createJourney(host);
  const ticket = journey.begin();
  await journey.run(ticket, { label: 'go', next: world('a') });
  await drainFrames();
  assert.equal(host.timers.size, 1);
  host.events.pagehide.forEach(fn => fn());
  assert.equal(host.timers.size, 0, 'navigating away cancels the watchdog');
  // No timer fires later, so no failure restore happens.
  fireFailureWatchdog(host);
  assert.deepEqual(host.restored, []);
});

test('scenario 3: a persisted pageshow restores and kills the in-flight journey', () => {
  const host = makeHost();
  const journey = createJourney(host);
  const ticket = journey.begin();
  assert.equal(journey.isActive(), true);

  host.events.pageshow.forEach(fn => fn(new EventStub(true)));

  assert.equal(journey.isActive(), false);
  assert.deepEqual(host.restored, [RESTORE_HISTORY]);
  assert.equal(journey.isCurrent(ticket), false, 'the old journey cannot continue after restore');
  assert.equal(host.departed, false);
  assert.equal(host.historyMarked, false);
  // The returning-loading screen is shown, then dismissed after two frames.
  assert.equal(host.loading[0].fraction, 1);
});

test('scenario 3b: stale in-flight callbacks after history restore do not navigate', async () => {
  // Simulate the exact reported race: run() is awaiting its link while the
  // page is restored from BFCache. The awaited continuation resumes later
  // and must find its ticket dead.
  let resolveLink;
  const host = makeHost({ makeLink: () => new Promise(resolve => { resolveLink = resolve; }) });
  const journey = createJourney(host);
  const ticket = journey.begin();
  const pending = journey.run(ticket, { label: 'go', next: world('a') });
  // BFCache restore happens while the link promise is still pending.
  host.events.pageshow.forEach(fn => fn(new EventStub(true)));
  assert.equal(journey.isActive(), false);
  resolveLink('https://destination.test/a');
  const ok = await pending;
  assert.equal(ok, false, 'the stale continuation is suppressed');
  assert.equal(host.navigations.length, 0, 'no navigation fires from the dead journey');
  assert.deepEqual(host.restored, [RESTORE_HISTORY]);

  // And a brand new journey works on the restored page.
  const fresh = journey.begin();
  assert.notEqual(fresh, null);
});

test('scenario 3c: a non-persisted pageshow is ignored', () => {
  const host = makeHost();
  const journey = createJourney(host);
  journey.begin();
  host.events.pageshow.forEach(fn => fn(new EventStub(false)));
  assert.equal(journey.isActive(), true, 'an ordinary load does not end the journey');
  assert.deepEqual(host.restored, []);
});

// Minimal stand-in for PageTransitionEvent({ persisted }).
class EventStub {
  constructor(persisted) { this.persisted = persisted; }
}
