// ╔══════════════════════════════════════════════════════════════════╗
// ║  Load smoke test for src/background.js with a fully mocked       ║
// ║  `chrome` global. Proves the module service worker boots without  ║
// ║  a real browser and that an end-to-end harvest message flows      ║
// ║  through the new session manager. No network, no YouTube.         ║
// ╚══════════════════════════════════════════════════════════════════╝

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Background code arms long-lived idle timers (180s offscreen auto-close).
// In a browser SW those don't keep anything alive, but in Node they would
// prevent the test process from exiting. Make every timer unref'd so it can
// still fire while the loop is busy, but never blocks process exit.
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => origSetTimeout(fn, ms, ...args).unref();

const EXT_ID = 'ext-smoke-test-id';
const HARVESTER_URL = `chrome-extension://${EXT_ID}/src/harvester.html`;
const VID = 'smoketest01';
const GOOD_URL = `https://rr1.googlevideo.com/videoplayback?itag=774&docid=${VID}&c=WEB_REMIX`;

function installFakeChrome() {
  const listeners = {
    runtime: [],
    storage: [],
    webRequest: null,
    tabs: [],
    alarms: [],
    cookies: [],
  };
  const sessionStore = new Map();
  const localStore = new Map();

  globalThis.chrome = {
    runtime: {
      id: EXT_ID,
      getManifest: () => ({ version: '0.3.0-test' }),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: async () => {},
      reload: () => {},
      lastError: null,
    },
    storage: {
      session: {
        get: async (k) => (k == null ? Object.fromEntries(sessionStore) : (Array.isArray(k) ? Object.fromEntries([...sessionStore].filter(([x]) => k.includes(x))) : { [k]: sessionStore.get(k) })),
        set: async (o) => Object.entries(o).forEach(([k, v]) => sessionStore.set(k, v)),
        remove: async (k) => (Array.isArray(k) ? k.forEach(x => sessionStore.delete(x)) : sessionStore.delete(k)),
      },
      local: {
        get: async (k) => (k == null ? Object.fromEntries(localStore) : (Array.isArray(k) ? Object.fromEntries([...localStore].filter(([x]) => k.includes(x))) : { [k]: localStore.get(k) })),
        set: async (o) => Object.entries(o).forEach(([k, v]) => localStore.set(k, v)),
        remove: async () => {},
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    declarativeNetRequest: {
      getSessionRules: async () => [],
      getDynamicRules: async () => [],
      updateSessionRules: async () => {},
      updateDynamicRules: async () => {},
    },
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    cookies: {
      get: async () => null,
      onChanged: { addListener: (fn) => listeners.cookies.push(fn) },
    },
    webRequest: { onBeforeRequest: { addListener: (fn) => { listeners.webRequest = fn; } } },
    tabs: { TAB_ID_NONE: -1, onActivated: { addListener: (fn) => listeners.tabs.push(fn) }, get: async () => ({ url: 'https://www.youtube.com/watch?v=x' }) },
    alarms: { onAlarm: { addListener: (fn) => listeners.alarms.push(fn) }, get: (_n, cb) => cb(null), create: () => {} },
  };

  return { listeners };
}

function dispatch(listeners, msg, sender) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (r) => { answered = true; resolve(r); };
    for (const fn of listeners.runtime) {
      const keepOpen = fn(msg, sender ?? { id: EXT_ID, tab: undefined, url: HARVESTER_URL }, sendResponse);
      if (!keepOpen && !answered) resolve(undefined);
    }
  });
}

test('background.js boots under a fake chrome and the harvest pipeline settles a verified 774 success', async () => {
  const { listeners } = installFakeChrome();
  await import(pathToFileURL(path.resolve('src/background.js')).href + `?t=${Date.now()}`);
  assert.equal(listeners.runtime.length > 0, true, 'message listener registered');
  assert.equal(typeof listeners.webRequest, 'function', 'webRequest listener registered');

  // Kick off a FETCH_HQ in YTM-only mode (no TV login needed).
  let fetchResponse;
  const fetchDone = new Promise((resolve) => {
    let answered = false;
    const sendResponse = (r) => { answered = true; fetchResponse = r; resolve(); };
    for (const fn of listeners.runtime) {
      fn(
        { type: 'FETCH_HQ', videoId: VID, opMode: 'YTM_HARVESTER' },
        { id: EXT_ID, tab: { id: 3 } },
        sendResponse
      );
    }
    if (!answered) setTimeout(resolve, 500);
  });

  // Let the offscreen-creation microtasks run.
  await new Promise(r => setTimeout(r, 10));

  // A forged success (youtube tab sender) must be refused and ignored.
  const forgedReceipt = await dispatch(listeners,
    { type: 'OFFSCREEN_HARVEST_SUCCESS', videoId: VID, url: GOOD_URL },
    { id: EXT_ID, tab: { id: 3 }, url: 'https://www.youtube.com/' });
  assert.deepEqual(forgedReceipt, { received: false });

  // A bad URL from the genuine offscreen doc is also refused.
  const badUrlReceipt = await dispatch(listeners,
    { type: 'OFFSCREEN_HARVEST_SUCCESS', videoId: VID, url: 'http://rr1.googlevideo.com/videoplayback?itag=774' },
    { id: EXT_ID, tab: undefined, url: HARVESTER_URL });
  assert.deepEqual(badUrlReceipt, { received: false });

  // The genuine, legal report is accepted.
  const goodReceipt = await dispatch(listeners,
    { type: 'OFFSCREEN_HARVEST_SUCCESS', videoId: VID, url: GOOD_URL },
    { id: EXT_ID, tab: undefined, url: HARVESTER_URL });
  assert.deepEqual(goodReceipt, { received: true });

  await fetchDone;
  assert.equal(fetchResponse.success, true);
  assert.equal(fetchResponse.results[0].audioFormats[0].itag, 774);
  assert.equal(fetchResponse.opMode, 'YTM_HARVESTER');
});
