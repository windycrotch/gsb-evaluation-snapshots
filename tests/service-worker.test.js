import test from "node:test";
import assert from "node:assert/strict";
import { idleState, CHANNEL } from "../shared.js";

const event = () => {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn) };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await turn(); }

async function fixture({ beforeStart = async () => {}, onCapture = () => {} } = {}) {
  const local = { delay: 30 }, session = {};
  let offscreen = false, engine = idleState(), captures = 0, starts = 0, closes = 0;
  let captureStatus = "active";
  const tab = { id: 8, title: "Local test", url: "https://example.test/", active: true, windowId: 1 };
  const viewers = new Map();
  const removed = [];
  const storage = data => ({
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async update => Object.assign(data, structuredClone(update)),
    remove: async key => { delete data[key]; },
  });
  const api = {
    runtime: {
      id: "test-id", getURL: name => `chrome-extension://test-id/${name}`,
      getContexts: async filter => filter.contextTypes.includes("OFFSCREEN_DOCUMENT") && offscreen ? [{}] : [],
      onMessage: event(), onInstalled: event(), onStartup: event(),
      sendMessage: async message => {
        if (message.target === "control") return;
        if (!offscreen) throw new Error("No document");
        if (message.type === "START") { starts++; await beforeStart(); engine = { ...idleState(message.data.delay), ...message.data, active: true, phase: "running" }; }
        if (message.type === "STOP") engine = idleState(engine.delay);
        if (message.type === "INTERRUPT") engine = { ...engine, active: false, phase: "interrupted", error: message.reason };
        if (message.type === "DELAY") engine.delay = message.delay;
        return { ok: true, state: structuredClone(engine) };
      },
    },
    offscreen: { createDocument: async options => { assert.deepEqual(options.reasons, ["USER_MEDIA"]); offscreen = true; }, closeDocument: async () => { offscreen = false; closes++; } },
    tabCapture: {
      getMediaStreamId: async options => { assert.deepEqual(options, { targetTabId: 8 }); onCapture(viewers); captures++; return "id"; },
      getCapturedTabs: async () => captureStatus ? [{ tabId: 8, status: captureStatus }] : [],
      onStatusChanged: event(),
    },
    action: { onClicked: event(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    storage: { local: storage(local), session: storage(session) },
    scripting: { executeScript: async options => {
      assert.deepEqual(options.target, { tabId: 8, frameIds: [0] });
      assert.match(options.func.name, /^(locatePlayer|releaseLocator)$/);
      return [{ result: options.func.name === "releaseLocator" ? undefined : {
        viewport: { width: 1600, height: 1000 }, rect: { x: 0.1, y: 0.1, width: 0.75, height: 0.675 } } }];
    } },
    tabs: { get: async id => { if (viewers.has(id)) return viewers.get(id); assert.equal(id, tab.id); return tab; },
      query: async () => [tab],
      create: async options => { const viewer = { id: 9, ...options }; viewers.set(9, viewer); return viewer; },
      update: async (id, options) => Object.assign(id === tab.id ? tab : viewers.get(id), options),
      captureVisibleTab: async () => "data:image/jpeg;base64,test",
      remove: async id => { removed.push(id); viewers.delete(id); }, onRemoved: event() },
    windows: { create: async () => { throw new Error("Must not create a standalone window"); } },
  };
  globalThis.chrome = api;
  const load = () => import(`../service-worker.js?instance=${crypto.randomUUID()}`);
  await load();
  async function message(type, data = {}) {
    return new Promise(resolve => {
      const fn = api.runtime.onMessage.listeners.at(-1);
      fn({ channel: CHANNEL, target: "worker", type, ...data }, { id: "test-id", url: api.runtime.getURL("control.html") }, resolve);
    });
  }
  return { api, local, session, tab, viewers, removed, load, message, captures: () => captures, starts: () => starts, closes: () => closes, setCaptureStatus: value => { captureStatus = value; } };
}

test("popup starts its pinned tab; duplicate Start and worker restart keep the same capture", async () => {
  const f = await fixture();
  assert.equal(f.api.action.onClicked.listeners.length, 0);
  await Promise.all([f.message("START", { tabId: 8 }), f.message("START", { tabId: 8 })]);
  assert.equal(f.captures(), 1); assert.equal(f.starts(), 1);
  await f.load(); // Fresh worker globals, same browser contexts/session storage.
  const reply = await f.message("STATE");
  assert.equal(reply.state.active, true); assert.equal(reply.state.tabId, 8);
  assert.equal(f.captures(), 1);
  const stopped = await f.message("STOP");
  assert.equal(stopped.state.active, false); assert.equal(f.closes(), 1);
});

test("A/V mode creates one viewer, survives worker restart, and closing viewer releases capture", async () => {
  const f = await fixture();
  await f.message("MODE", { mode: "av" });
  const started = await f.message("START", { tabId: 8, mode: "av" });
  assert.equal(started.state.mode, "av");
  assert.equal(started.state.delay, 30);
  assert.equal(f.viewers.size, 1);
  assert.equal(f.viewers.get(9).active, true);
  assert.equal((await f.message("MODE", { mode: "audio" })).ok, false);
  await f.load();
  await f.message("START", { tabId: 8, mode: "av" });
  assert.equal(f.captures(), 1);
  f.viewers.delete(9);
  f.api.tabs.onRemoved.listeners.at(-1)(9);
  await settle();
  assert.equal((await f.message("STATE")).state.active, false);
  assert.equal(f.closes(), 1);
});

test("A/V viewer becomes visible after capture authorization but before waiting for media readiness", async () => {
  let release, entered;
  const ready = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({
    onCapture: viewers => assert.equal(viewers.get(9).active, false),
    beforeStart: async () => { entered(); await ready; },
  });
  const pending = f.message("START", { tabId: 8, mode: "av" });
  try {
    await starting;
    await settle();
    // A never-visible Chrome tab can defer media loading. START cannot finish
    // until its consumer opens MediaSource, so visibility must not await START.
    assert.equal(f.viewers.get(9).active, true);
  } finally {
    release();
    await pending;
    await f.message("STOP");
  }
});

test("late stopped event does not end a new active capture; real closure releases document", async () => {
  const f = await fixture();
  await f.message("START", { tabId: 8 });
  f.api.tabCapture.onStatusChanged.listeners[0]({ tabId: 8, status: "stopped" }); await settle();
  assert.equal((await f.message("STATE")).state.active, true);
  f.setCaptureStatus(null);
  f.api.tabs.onRemoved.listeners[0](8); await settle();
  const ended = await f.message("STATE");
  assert.equal(ended.state.phase, "interrupted"); assert.equal(ended.state.active, false);
  assert.equal(f.closes(), 1);
});

test("settings survive worker restart; internal pages do not start capture", async () => {
  const f = await fixture();
  assert.equal((await f.message("DELAY", { delay: 1.24 })).state.delay, 1.2);
  await f.load();
  f.api.runtime.onStartup.listeners.at(-1)(); await settle();
  assert.equal((await f.message("STATE")).state.delay, 1.2);
  assert.equal((await f.message("START")).ok, false);
  f.tab.url = "chrome://extensions/";
  await f.message("START", { tabId: 8 });
  assert.equal(f.captures(), 0);
  assert.equal((await f.message("STATE")).state.phase, "error");
});

test("video choices persist; running capture rejects changes; manual selection binds to its source tab", async () => {
  const f = await fixture();
  await f.message("VIDEO_OPTIONS", { options: { quality: "1080p60", region: "player" } });
  f.tab.mutedInfo = { muted: true };
  await f.load();
  assert.equal((await f.message("STATE")).state.quality, "1080p60");
  const started = await f.message("START", { tabId: 8, mode: "av" });
  assert.equal(started.state.geometry.viewport.width, 1600);
  assert.equal(f.viewers.get(9).muted, true);
  assert.equal((await f.message("VIDEO_OPTIONS", { options: { quality: "720p30" } })).ok, false);
  await f.message("STOP");
  await f.message("CROP_PICKER", { tabId: 8 });
  const picker = f.session.cropPicker;
  const sender = { id: "test-id", url: f.api.runtime.getURL("crop.html") };
  const cropMessage = rect => new Promise(resolve => f.api.runtime.onMessage.listeners.at(-1)(
    { channel: CHANNEL, target: "worker", type: "CROP_SAVE", key: picker.key, rect }, sender, resolve));
  assert.equal((await cropMessage({ x: -1, y: 0, width: 1, height: 1 })).ok, false);
  const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.7 };
  assert.equal((await cropMessage(rect)).ok, true);
  assert.equal(f.session.manualCrop.tabId, 8);
  assert.deepEqual(f.session.manualCrop.rect, rect);
  assert.equal(f.session.cropPicker, undefined);
});
