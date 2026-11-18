"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const windowMode = require("../window-mode");

/**
 * Minimal controllable stand-in for BrowserWindow. Only the surface used by the
 * window-mode helpers is implemented; every mutation is recorded so tests can
 * assert the window bounds/always-on-top did or did not change.
 */
class FakeWindow {
  constructor(bounds, opts) {
    const options = opts || {};
    this.bounds = Object.assign({ x: 0, y: 0, width: 1280, height: 720 }, bounds);
    this.fullScreen = Boolean(options.fullScreen);
    this.alwaysOnTop = Boolean(options.alwaysOnTop);
    this.maximized = Boolean(options.maximized);
    this.destroyed = false;
    this.zoomFactor = 1;
    this.mutations = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  getBounds() {
    return Object.assign({}, this.bounds);
  }

  getContentBounds() {
    return Object.assign({}, this.bounds);
  }

  setBounds(next) {
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

  isAlwaysOnTop() {
    return this.alwaysOnTop;
  }

  setAlwaysOnTop(value) {
    this.alwaysOnTop = Boolean(value);
    this.mutations.push({ type: "setAlwaysOnTop", value: this.alwaysOnTop });
  }

  setZoomFactor(value) {
    this.zoomFactor = value;
  }

  destroy() {
    this.destroyed = true;
  }

  resizeTo(width, height) {
    this.setBounds(Object.assign({}, this.bounds, { width, height }));
  }
}

const MINI_BOUNDS = { x: 1360, y: 741, width: 560, height: 315 };

/**
 * Mirrors the main-process glue around window-mode.js: a mutable mode record,
 * the same snapshot function, and the same blur policy with a fake shrink.
 */
class ModeController {
  constructor(win) {
    this.win = win;
    this.mode = {
      isMiniPlayer: false,
      isPinned: false,
      translucentFullscreenBypass: false,
    };
    this.lastShrinkTime = 0;
    this.shrinkCalls = 0;
  }

  snapshot() {
    return windowMode.getWindowModeSnapshot(this.mode, this.win);
  }

  pin() {
    this.mode.isPinned = true;
    this.win.setAlwaysOnTop(true);
  }

  unpin() {
    this.mode.isPinned = false;
    this.mode.isMiniPlayer = false;
    this.win.setAlwaysOnTop(false);
  }

  /** Exactly what index.js does inside the win.on("blur") handler. */
  blur(now) {
    this.now = now;
    const result = windowMode.applyBlurPolicy({
      mode: this.mode,
      win: this.win,
      now,
      lastShrinkTime: this.lastShrinkTime,
      isAlwaysOnTop: () => this.win.isAlwaysOnTop(),
      applyAlwaysOnTop: () => this.win.setAlwaysOnTop(true),
      shrink: () => {
        this.shrinkCalls += 1;
        this.mode.isMiniPlayer = true;
        this.win.setBounds(Object.assign({}, MINI_BOUNDS));
        this.win.setAlwaysOnTop(true);
        this.lastShrinkTime = now;
      },
    });
    return result.action;
  }
}

describe("computeScale", () => {
  test("uses the smaller of width/1920 and height/1080", () => {
    assert.equal(windowMode.computeScale(1280, 720), 720 / 1080);
    assert.equal(windowMode.computeScale(1920, 1080), 1);
    assert.equal(windowMode.computeScale(3840, 1080), 1);
  });

  test("clamps to the 0.15 floor", () => {
    assert.equal(windowMode.computeScale(100, 100), 0.15);
  });

  test("falls back to 1 for degenerate sizes", () => {
    assert.equal(windowMode.computeScale(0, 0), 1);
    assert.equal(windowMode.computeScale(NaN, 720), 1);
    assert.equal(windowMode.computeScale(1280, -1), 1);
  });
});

describe("getWindowModeSnapshot", () => {
  test("normal window: not compact, not fullscreen, scale from bounds", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const snap = windowMode.getWindowModeSnapshot(
      { isMiniPlayer: false, isPinned: false },
      win
    );
    assert.deepEqual(snap, {
      isMiniPlayer: false,
      isPinned: false,
      isFullScreen: false,
      isCompact: false,
      scale: 720 / 1080,
    });
  });

  test("fullscreen window reports isFullScreen and scale 1", () => {
    const win = new FakeWindow({ width: 1920, height: 1080 }, { fullScreen: true });
    const snap = windowMode.getWindowModeSnapshot(
      { isMiniPlayer: false, isPinned: false },
      win
    );
    assert.equal(snap.isFullScreen, true);
    assert.equal(snap.isCompact, false);
    assert.equal(snap.scale, 1);
  });

  test("translucent fullscreen bypass counts as fullscreen", () => {
    const win = new FakeWindow({ width: 1920, height: 1080 }, { fullScreen: false });
    const snap = windowMode.getWindowModeSnapshot(
      { isMiniPlayer: false, isPinned: false, translucentFullscreenBypass: true },
      win
    );
    assert.equal(snap.isFullScreen, true);
  });

  test("mini player is compact and scales from its small bounds", () => {
    const win = new FakeWindow(MINI_BOUNDS);
    const snap = windowMode.getWindowModeSnapshot(
      { isMiniPlayer: true, isPinned: true },
      win
    );
    assert.deepEqual(snap, {
      isMiniPlayer: true,
      isPinned: true,
      isFullScreen: false,
      isCompact: true,
      scale: 315 / 1080,
    });
  });

  test("compact thresholds are inclusive at 720x420", () => {
    const atThreshold = new FakeWindow({ width: 720, height: 420 });
    assert.equal(
      windowMode.getWindowModeSnapshot({}, atThreshold).isCompact,
      true
    );
    const justOver = new FakeWindow({ width: 721, height: 421 });
    assert.equal(windowMode.getWindowModeSnapshot({}, justOver).isCompact, false);
  });

  test("a single small dimension is enough to be compact", () => {
    const wideButShort = new FakeWindow({ width: 1600, height: 420 });
    assert.equal(
      windowMode.getWindowModeSnapshot({}, wideButShort).isCompact,
      true
    );
    const tallButNarrow = new FakeWindow({ width: 720, height: 1080 });
    assert.equal(
      windowMode.getWindowModeSnapshot({}, tallButNarrow).isCompact,
      true
    );
  });

  test("destroyed window degrades to scale 1 and not compact", () => {
    const win = new FakeWindow(MINI_BOUNDS);
    win.destroy();
    const snap = windowMode.getWindowModeSnapshot({}, win);
    assert.equal(snap.scale, 1);
    assert.equal(snap.isCompact, false);
    assert.equal(snap.isFullScreen, false);
  });

  test("null window still returns the five snapshot fields", () => {
    const snap = windowMode.getWindowModeSnapshot({ isMiniPlayer: true }, null);
    assert.deepEqual(Object.keys(snap).sort(), [
      "isCompact",
      "isFullScreen",
      "isMiniPlayer",
      "isPinned",
      "scale",
    ]);
    assert.equal(snap.isMiniPlayer, true);
    assert.equal(snap.isCompact, true);
    assert.equal(snap.scale, 1);
  });

  test("throwing window APIs are contained", () => {
    const broken = {
      isDestroyed: () => false,
      getContentBounds: () => {
        throw new Error("boom");
      },
      isFullScreen: () => {
        throw new Error("boom");
      },
    };
    const snap = windowMode.getWindowModeSnapshot({ isPinned: true }, broken);
    assert.equal(snap.scale, 1);
    assert.equal(snap.isFullScreen, false);
    assert.equal(snap.isPinned, true);
  });
});

describe("isAuthorizedSnapshotSender", () => {
  function makeCtx(overrides) {
    const mainFrame = { url: "file:///index.html" };
    const mainContents = { mainFrame, id: 1 };
    return Object.assign(
      {
        sender: mainContents,
        senderFrame: mainFrame,
        mainWindow: { isDestroyed: () => false, webContents: mainContents },
      },
      overrides
    );
  }

  test("accepts the main window's own top frame", () => {
    assert.equal(windowMode.isAuthorizedSnapshotSender(makeCtx()), true);
  });

  test("rejects another webContents", () => {
    const ctx = makeCtx();
    ctx.sender = { id: 99, mainFrame: { url: "https://evil.example" } };
    assert.equal(windowMode.isAuthorizedSnapshotSender(ctx), false);
  });

  test("rejects a sub-frame of the main window", () => {
    const ctx = makeCtx();
    ctx.senderFrame = { url: "file:///iframe.html" };
    assert.equal(windowMode.isAuthorizedSnapshotSender(ctx), false);
  });

  test("rejects missing/destroyed senders and windows", () => {
    assert.equal(windowMode.isAuthorizedSnapshotSender({}), false);
    assert.equal(
      windowMode.isAuthorizedSnapshotSender(
        makeCtx({ sender: { isDestroyed: () => true } })
      ),
      false
    );
    assert.equal(windowMode.isAuthorizedSnapshotSender(makeCtx({ mainWindow: null })), false);
    assert.equal(
      windowMode.isAuthorizedSnapshotSender(
        makeCtx({ mainWindow: { isDestroyed: () => true, webContents: {} } })
      ),
      false
    );
    assert.equal(
      windowMode.isAuthorizedSnapshotSender(
        makeCtx({ mainWindow: { isDestroyed: () => false, webContents: null } })
      ),
      false
    );
  });
});

describe("blur auto-shrink policy", () => {
  test("does nothing when not pinned", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    assert.equal(ctl.blur(1000), "ignore");
    assert.equal(ctl.shrinkCalls, 0);
    assert.deepEqual(win.getBounds(), { x: 0, y: 0, width: 1280, height: 720 });
  });

  test("pinned normal window shrinks once and stays pinned", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    ctl.pin();
    assert.equal(ctl.blur(1000), "shrink");
    assert.equal(ctl.shrinkCalls, 1);
    assert.deepEqual(win.getBounds(), MINI_BOUNDS);
    assert.equal(win.isAlwaysOnTop(), true);
    const snap = ctl.snapshot();
    assert.equal(snap.isMiniPlayer, true);
    assert.equal(snap.isPinned, true);
    assert.equal(snap.isCompact, true);
  });

  test("shrink is throttled for 250ms from the previous shrink", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    ctl.pin();
    assert.equal(ctl.blur(1000), "shrink");
    assert.equal(ctl.shrinkCalls, 1);
    // Re-enter normal mode manually, then blur 249ms later: must not shrink.
    ctl.mode.isMiniPlayer = false;
    ctl.lastShrinkTime = 1000;
    assert.equal(ctl.blur(1249), "ignore");
    assert.equal(ctl.shrinkCalls, 1);
    // Exactly at the 250ms boundary the interval is satisfied.
    assert.equal(ctl.blur(1250), "shrink");
    assert.equal(ctl.shrinkCalls, 2);
  });

  test("mini player blur only re-asserts always-on-top, never resizes", () => {
    const win = new FakeWindow(MINI_BOUNDS, { alwaysOnTop: false });
    const ctl = new ModeController(win);
    ctl.mode.isPinned = true;
    ctl.mode.isMiniPlayer = true;
    const before = win.getBounds();
    assert.equal(ctl.blur(5000), "repin");
    assert.equal(ctl.shrinkCalls, 0);
    assert.deepEqual(win.getBounds(), before);
    assert.equal(win.isAlwaysOnTop(), true);
    const snap = ctl.snapshot();
    assert.equal(snap.isMiniPlayer, true);
    assert.equal(snap.scale, 315 / 1080);
  });

  test("mini player already on top does not reapply always-on-top", () => {
    const win = new FakeWindow(MINI_BOUNDS, { alwaysOnTop: true });
    const ctl = new ModeController(win);
    ctl.mode.isPinned = true;
    ctl.mode.isMiniPlayer = true;
    win.mutations.length = 0;
    assert.equal(ctl.blur(5000), "repin");
    assert.deepEqual(win.mutations, []);
  });

  test("unpinning disables blur shrinking permanently", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    ctl.pin();
    ctl.lastShrinkTime = 0;
    ctl.unpin();
    const before = win.getBounds();
    assert.equal(ctl.blur(100000), "ignore");
    assert.equal(ctl.shrinkCalls, 0);
    assert.deepEqual(win.getBounds(), before);
    assert.equal(ctl.snapshot().isPinned, false);
  });

  test("blur on a destroyed window is ignored", () => {
    const win = new FakeWindow({ width: 1280, height: 720 }, { alwaysOnTop: true });
    const ctl = new ModeController(win);
    ctl.mode.isPinned = true;
    ctl.mode.isMiniPlayer = true;
    win.destroy();
    assert.equal(ctl.blur(1000), "ignore");
    assert.equal(ctl.shrinkCalls, 0);
  });
});

describe("simulated session: snapshot follows window state", () => {
  function row(label, win, snap) {
    return {
      label,
      bounds: win.getBounds(),
      snapshot: snap,
    };
  }

  test("mini -> drag -> unpin -> blur keeps the snapshot authoritative", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    const timeline = [];
    timeline.push(row("start (normal)", win, ctl.snapshot()));

    ctl.pin();
    timeline.push(row("F10 pin on", win, ctl.snapshot()));

    ctl.blur(1000);
    timeline.push(row("blur -> auto mini", win, ctl.snapshot()));

    // User drags/resizes the mini window; the resize path recomputes the snapshot.
    win.setBounds({ x: 900, y: 500, width: 640, height: 360 });
    timeline.push(row("drag/resize mini", win, ctl.snapshot()));

    ctl.unpin();
    timeline.push(row("F10 pin off", win, ctl.snapshot()));

    const beforeBounds = win.getBounds();
    ctl.blur(200000);
    timeline.push(row("blur after unpin", win, ctl.snapshot()));

    assert.deepEqual(win.getBounds(), beforeBounds);
    assert.equal(ctl.shrinkCalls, 1);

    const [start, pinned, mini, resized, unpinned, blurred] = timeline;
    assert.deepEqual(start.snapshot, {
      isMiniPlayer: false,
      isPinned: false,
      isFullScreen: false,
      isCompact: false,
      scale: 720 / 1080,
    });
    assert.equal(pinned.snapshot.isPinned, true);
    assert.equal(mini.snapshot.isMiniPlayer, true);
    assert.equal(mini.snapshot.isCompact, true);
    assert.equal(resized.snapshot.scale, 360 / 1080);
    assert.equal(resized.snapshot.isCompact, true);
    assert.equal(resized.snapshot.isPinned, true);
    assert.equal(unpinned.snapshot.isPinned, false);
    assert.equal(unpinned.snapshot.isMiniPlayer, false);
    assert.equal(unpinned.bounds.width, 640);
    assert.deepEqual(blurred.bounds, unpinned.bounds);
    assert.deepEqual(blurred.snapshot, unpinned.snapshot);
  });

  test("fullscreen enter/exit is visible in the snapshot", () => {
    const win = new FakeWindow({ width: 1280, height: 720 });
    const ctl = new ModeController(win);
    assert.equal(ctl.snapshot().isFullScreen, false);

    win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
    win.setFullScreen(true);
    const fs = ctl.snapshot();
    assert.equal(fs.isFullScreen, true);
    assert.equal(fs.scale, 1);
    assert.equal(fs.isCompact, false);

    win.setFullScreen(false);
    win.setBounds({ x: 160, y: 90, width: 1280, height: 720 });
    const restored = ctl.snapshot();
    assert.equal(restored.isFullScreen, false);
    assert.equal(restored.scale, 720 / 1080);
  });
});

describe("preload surface", () => {
  test("exposes getWindowModeSnapshot on the invoke channel", () => {
    const preloadPath = path.resolve(__dirname, "..", "preload.js");
    const exposed = {};
    const invokes = [];
    const fakeElectron = {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          exposed[name] = api;
        },
      },
      ipcRenderer: {
        invoke: (channel, ...args) => {
          invokes.push(channel);
          return Promise.resolve({ channel, args });
        },
        send: () => {},
        on: () => {},
      },
    };

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve(preloadPath)];
      require(preloadPath);
    } finally {
      Module._load = originalLoad;
    }

    const api = exposed.electronUtilsRender;
    assert.ok(api, "electronUtilsRender must be exposed");
    assert.equal(typeof api.getWindowModeSnapshot, "function");
    return api.getWindowModeSnapshot().then((result) => {
      assert.equal(result.channel, "getWindowModeSnapshot");
      assert.deepEqual(invokes, ["getWindowModeSnapshot"]);
    });
  });
});
