"use strict";

/**
 * Integration coverage for index.js itself: loads the real main process with a
 * fake `electron` module, then drives the registered IPC handlers and the
 * window events with a controllable fake BrowserWindow.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { EventEmitter } = require("node:events");
const Module = require("module");

const INDEX_PATH = path.resolve(__dirname, "..", "index.js");

function createFakeElectron() {
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  const windows = [];

  class FakeWebContents extends EventEmitter {
    constructor(owner) {
      super();
      this.owner = owner;
      this.id = windows.length * 10 + 1;
      this.destroyed = false;
      this.mainFrame = { url: "file:///index.html", routingId: 1 };
      this.sent = [];
      this.zoomFactor = 1;
      this.userAgent = null;
      this.session = {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: () => {},
      };
    }

    setUserAgent(ua) {
      this.userAgent = ua;
    }

    send(channel, payload) {
      this.sent.push({ channel, payload });
    }

    sendInputEvent() {}

    setZoomFactor(value) {
      this.zoomFactor = value;
    }

    setWindowOpenHandler() {}

    loadFile() {}

    isDestroyed() {
      return this.destroyed;
    }

    capturePage() {
      return Promise.resolve({ toPNG: () => Buffer.alloc(0) });
    }

    reloadIgnoringCache() {}
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents(this);
      this.bounds = { x: 0, y: 0, width: 1280, height: 720 };
      this.contentBounds = null;
      this.fullScreen = false;
      this.maximized = false;
      this.alwaysOnTop = false;
      this.minimumSize = null;
      this.destroyed = false;
      this.mutations = [];
      windows.push(this);
      FakeBrowserWindow.lastInstance = this;
    }

    static fromWebContents(wc) {
      return windows.find((w) => w.webContents === wc) || null;
    }

    static getAllWindows() {
      return windows.slice();
    }

    isDestroyed() {
      return this.destroyed;
    }

    getBounds() {
      return this.contentBounds || Object.assign({}, this.bounds);
    }

    getContentBounds() {
      return this.contentBounds || Object.assign({}, this.bounds);
    }

    setBounds(next) {
      this.contentBounds = Object.assign({}, next);
      this.bounds = Object.assign({}, next);
      this.mutations.push({ type: "setBounds", bounds: this.getBounds() });
    }

    isFullScreen() {
      return this.fullScreen;
    }

    setFullScreen(value) {
      this.fullScreen = Boolean(value);
      this.mutations.push({ type: "setFullScreen", value: this.fullScreen });
    }

    isMaximized() {
      return this.maximized;
    }

    maximize() {
      this.maximized = true;
    }

    unmaximize() {
      this.maximized = false;
    }

    isAlwaysOnTop() {
      return this.alwaysOnTop;
    }

    setAlwaysOnTop(value) {
      this.alwaysOnTop = Boolean(value);
      this.mutations.push({ type: "setAlwaysOnTop", value: this.alwaysOnTop });
    }

    setVisibleOnAllWorkspaces() {}

    setFullScreenable() {}

    setResizable() {}

    setMovable() {}

    setMinimumSize(w, h) {
      this.minimumSize = [w, h];
    }

    setOpacity() {}

    loadFile() {
      this.loaded = true;
      return Promise.resolve();
    }
  }

  const display = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };

  const electron = {
    app: {
      commandLine: {
        getSwitchValue: () => "",
        appendSwitch: () => {},
      },
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getPath: () => "/tmp",
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, fn) => ipcHandlers.set(channel, fn),
      on: (channel, fn) => ipcListeners.set(channel, fn),
    },
    screen: {
      getDisplayMatching: () => display,
      getPrimaryDisplay: () => display,
    },
    clipboard: { writeImage: () => {} },
    shell: { openExternal: () => Promise.resolve() },
    powerSaveBlocker: { isStarted: () => false, start: () => 1, stop: () => {} },
  };

  return { electron, ipcHandlers, ipcListeners, windows, display };
}

let harness;
let mainWin;

function loadIndex() {
  harness = createFakeElectron();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return harness.electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(INDEX_PATH)];
    require(INDEX_PATH);
  } finally {
    Module._load = originalLoad;
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      if (harness.windows.length > 0) {
        mainWin = harness.windows[0];
        resolve(mainWin);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("createWindow() did not run"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function snapshotEvent(extra) {
  const wc = mainWin.webContents;
  return Object.assign(
    { sender: wc, senderFrame: wc.mainFrame },
    extra || {}
  );
}

function lastModeBroadcast(win) {
  const events = win.webContents.sent.filter(
    (e) => e.channel === "windowModeChanged"
  );
  return events.length ? events[events.length - 1].payload : null;
}

before(async () => {
  await loadIndex();
});

after(() => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.emit("closed");
  }
});

test("snapshot handler is registered", () => {
  assert.equal(typeof harness.ipcHandlers.get("getWindowModeSnapshot"), "function");
});

test("authorized main-window sender gets all five snapshot fields", async () => {
  const handler = harness.ipcHandlers.get("getWindowModeSnapshot");
  const snap = await handler(snapshotEvent());
  assert.deepEqual(Object.keys(snap).sort(), [
    "isCompact",
    "isFullScreen",
    "isMiniPlayer",
    "isPinned",
    "scale",
  ]);
  assert.equal(snap.isMiniPlayer, false);
  assert.equal(snap.isPinned, false);
  assert.equal(snap.isFullScreen, false);
  assert.equal(snap.isCompact, false);
  assert.equal(snap.scale, 720 / 1080);
});

test("foreign webContents and sub-frames are rejected", async () => {
  const handler = harness.ipcHandlers.get("getWindowModeSnapshot");
  const foreign = { mainFrame: { url: "https://evil.example" }, isDestroyed: () => false };
  assert.equal(await handler({ sender: foreign, senderFrame: foreign.mainFrame }), null);

  const subFrame = { url: "file:///iframe.html" };
  assert.equal(
    await handler({ sender: mainWin.webContents, senderFrame: subFrame }),
    null
  );

  const destroyedSender = {
    isDestroyed: () => true,
    mainFrame: { url: "file:///index.html" },
  };
  assert.equal(await handler({ sender: destroyedSender }), null);
  assert.equal(await handler({}), null);
});

test("pin toggle is reflected by both the broadcast and the query", async () => {
  const pinHandler = harness.ipcHandlers.get("toggleAlwaysOnTop");
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");

  const pinnedResult = await pinHandler(snapshotEvent());
  assert.equal(pinnedResult.isPinned, true);
  assert.equal(lastModeBroadcast(mainWin).isPinned, true);

  let snap = await snapHandler(snapshotEvent());
  assert.equal(snap.isPinned, true);
  assert.equal(snap.isMiniPlayer, false);

  const unpinnedResult = await pinHandler(snapshotEvent());
  assert.equal(unpinnedResult.isPinned, false);
  assert.equal(lastModeBroadcast(mainWin).isPinned, false);

  snap = await snapHandler(snapshotEvent());
  assert.equal(snap.isPinned, false);
  assert.equal(mainWin.isAlwaysOnTop(), false);
});

test("blur only shrinks a pinned, non-mini window", async () => {
  const pinHandler = harness.ipcHandlers.get("toggleAlwaysOnTop");
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");

  mainWin.setBounds({ x: 100, y: 100, width: 1280, height: 720 });
  mainWin.setAlwaysOnTop(false);
  await pinHandler(snapshotEvent());

  const before = mainWin.getBounds();
  mainWin.emit("blur");
  const after = mainWin.getBounds();
  assert.notDeepEqual(after, before);
  assert.equal(after.width, 560);
  assert.equal(after.height, 315);

  const snap = await snapHandler(snapshotEvent());
  assert.equal(snap.isMiniPlayer, true);
  assert.equal(snap.isPinned, true);
  assert.equal(snap.isCompact, true);
});

test("blur on an existing mini player repins without resizing", async () => {
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");
  mainWin.setAlwaysOnTop(false);
  const before = mainWin.getBounds();
  mainWin.mutations.length = 0;

  mainWin.emit("blur");
  assert.deepEqual(mainWin.getBounds(), before);
  assert.equal(mainWin.isAlwaysOnTop(), true);
  assert.deepEqual(
    mainWin.mutations.filter((m) => m.type === "setBounds"),
    []
  );
  const snap = await snapHandler(snapshotEvent());
  assert.equal(snap.isMiniPlayer, true);
});

test("blur after unpin does not shrink or repin", async () => {
  const pinHandler = harness.ipcHandlers.get("toggleAlwaysOnTop");
  const unpinResult = await pinHandler(snapshotEvent());
  assert.equal(unpinResult.isPinned, false);

  const before = mainWin.getBounds();
  mainWin.mutations.length = 0;
  mainWin.emit("blur");
  assert.deepEqual(mainWin.getBounds(), before);
  assert.deepEqual(mainWin.mutations, []);
});

test("resize refreshes both the zoom and the broadcast snapshot", () => {
  mainWin.webContents.sent.length = 0;
  mainWin.setBounds({ x: 60, y: 40, width: 900, height: 600 });
  mainWin.emit("resize");

  const payload = lastModeBroadcast(mainWin);
  assert.ok(payload, "resize must broadcast windowModeChanged");
  assert.equal(payload.scale, 900 / 1920);
  assert.equal(payload.isCompact, false);
  assert.equal(mainWin.webContents.zoomFactor, 900 / 1920);
});

test("fullscreen enter/leave re-broadcasts the snapshot", async () => {
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");
  mainWin.setBounds({ x: 60, y: 40, width: 1280, height: 720 });
  mainWin.webContents.sent.length = 0;

  mainWin.setFullScreen(true);
  mainWin.emit("enter-full-screen");
  const enterPayload = lastModeBroadcast(mainWin);
  assert.ok(enterPayload, "enter-full-screen must broadcast");
  assert.equal(enterPayload.isFullScreen, true);
  assert.equal((await snapHandler(snapshotEvent())).isFullScreen, true);

  mainWin.setFullScreen(false);
  mainWin.emit("leave-full-screen");
  const leavePayload = lastModeBroadcast(mainWin);
  assert.ok(leavePayload, "leave-full-screen must broadcast");
  assert.equal(leavePayload.isFullScreen, false);
  assert.equal((await snapHandler(snapshotEvent())).isFullScreen, false);
});

test("translucent fullscreen bypass is reported as fullscreen", async () => {
  const opacityHandler = harness.ipcHandlers.get("setWindowOpacity");
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");
  mainWin.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  mainWin.setFullScreen(true);
  mainWin.emit("enter-full-screen");

  await opacityHandler(snapshotEvent(), 0.8);
  const snap = await snapHandler(snapshotEvent());
  // setFullScreen(false) is called synchronously inside the handler.
  assert.equal(snap.isFullScreen, true);
});

test("mini toggle from the query path reports a consistent snapshot", async () => {
  const miniHandler = harness.ipcHandlers.get("toggleMiniPlayer");
  const snapHandler = harness.ipcHandlers.get("getWindowModeSnapshot");

  const entering = await miniHandler(snapshotEvent());
  assert.equal(entering.isMiniPlayer, true);
  const enteredSnap = await snapHandler(snapshotEvent());
  assert.equal(enteredSnap.isMiniPlayer, true);
  assert.equal(enteredSnap.isCompact, true);

  const leaving = await miniHandler(snapshotEvent());
  assert.equal(leaving.isMiniPlayer, false);
  assert.equal(leaving.isPinned, false);
  const leftSnap = await snapHandler(snapshotEvent());
  assert.equal(leftSnap.isMiniPlayer, false);
  assert.equal(leftSnap.isPinned, false);
});
