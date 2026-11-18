"use strict";

/**
 * Local, dependency-free walkthrough of the window-mode snapshot + blur policy.
 *
 *   npm run simulate:window-mode
 *
 * Prints a before/after comparison of the window bounds and the five snapshot
 * fields for every path: pin, blur-shrink, mini drag, mini blur (repin only),
 * unpin, blur after unpin, and the 250ms throttle boundary.
 */

const path = require("path");
const { getWindowModeSnapshot, applyBlurPolicy } = require(
  path.join(__dirname, "..", "window-mode")
);

function fakeWindow(bounds, opts) {
  const options = opts || {};
  const win = {
    bounds: Object.assign({ x: 100, y: 100, width: 1280, height: 720 }, bounds),
    fullScreen: Boolean(options.fullScreen),
    alwaysOnTop: Boolean(options.alwaysOnTop),
    destroyed: false,
    isDestroyed: () => win.destroyed,
    getBounds: () => Object.assign({}, win.bounds),
    getContentBounds: () => Object.assign({}, win.bounds),
    setBounds: (next) => {
      win.bounds = Object.assign({}, next);
    },
    isFullScreen: () => win.fullScreen,
    setFullScreen: (v) => {
      win.fullScreen = Boolean(v);
    },
    isAlwaysOnTop: () => win.alwaysOnTop,
    setAlwaysOnTop: (v) => {
      win.alwaysOnTop = Boolean(v);
    },
  };
  return win;
}

function fmtBounds(b) {
  return `${b.width}x${b.height} @ (${b.x},${b.y})`;
}

function fmtSnap(s) {
  return [
    `isMiniPlayer=${s.isMiniPlayer}`,
    `isPinned=${s.isPinned}`,
    `isFullScreen=${s.isFullScreen}`,
    `isCompact=${s.isCompact}`,
    `scale=${s.scale.toFixed(3)}`,
  ].join(" ");
}

const win = fakeWindow();
const mode = {
  isMiniPlayer: false,
  isPinned: false,
  translucentFullscreenBypass: false,
};
let lastShrinkTime = 0;
let shrinkCalls = 0;

const snapshot = () => getWindowModeSnapshot(mode, win);

function blur(now) {
  return applyBlurPolicy({
    mode,
    win,
    now,
    lastShrinkTime,
    isAlwaysOnTop: () => win.isAlwaysOnTop(),
    applyAlwaysOnTop: () => win.setAlwaysOnTop(true),
    shrink: () => {
      shrinkCalls += 1;
      mode.isMiniPlayer = true;
      win.setBounds({ x: 1360, y: 741, width: 560, height: 315 });
      win.setAlwaysOnTop(true);
      lastShrinkTime = now;
    },
  }).action;
}

function step(label, mutate) {
  const before = { bounds: win.getBounds(), snap: snapshot() };
  const notes = mutate ? mutate() : [];
  const after = { bounds: win.getBounds(), snap: snapshot() };
  const same =
    before.bounds.width === after.bounds.width &&
    before.bounds.height === after.bounds.height &&
    before.bounds.x === after.bounds.x &&
    before.bounds.y === after.bounds.y;

  console.log(`\n### ${label}`);
  (notes || []).forEach((n) => console.log(`  ${n}`));
  console.log(
    `  bounds  : ${fmtBounds(before.bounds)}  ->  ${fmtBounds(after.bounds)}${
      same ? "  (unchanged)" : ""
    }`
  );
  console.log(`  snapshot: ${fmtSnap(before.snap)}`);
  console.log(`            -> ${fmtSnap(after.snap)}`);
}

console.log("Window-mode snapshot / blur policy simulation");

step("initial state");

step("F10 pin on (always-on-top)", () => {
  mode.isPinned = true;
  win.setAlwaysOnTop(true);
  return ["snapshot isPinned flips to true, bounds unchanged"];
});

step("blur while pinned -> auto shrink to mini", () => [
  `blur action: ${blur(1000)}`,
]);

step("blur again while already mini -> repin only, no resize", () => {
  win.setAlwaysOnTop(false);
  return [`blur action: ${blur(1100)}`, "always-on-top restored by repin"];
});

step("drag/resize the mini window (640x360)", () => {
  win.setBounds({ x: 900, y: 500, width: 640, height: 360 });
  return ["snapshot scale recomputed from the new content bounds"];
});

step("F10 pin off", () => {
  mode.isPinned = false;
  mode.isMiniPlayer = false;
  win.setAlwaysOnTop(false);
  return ["isPinned and isMiniPlayer both false; size stays 640x360"];
});

step("blur after unpin -> must not shrink", () => [
  `blur action: ${blur(5000)} (expected ignore)`,
]);

step("F9 mini again, then blur inside/outside the 250ms window", () => {
  mode.isPinned = true;
  mode.isMiniPlayer = false;
  win.setAlwaysOnTop(true);
  const notes = [];
  notes.push(`blur action: ${blur(10000)} (expected shrink)`);
  const afterShrink = win.getBounds();
  // Simulate the user expanding again without moving the throttle anchor.
  mode.isMiniPlayer = false;
  notes.push(`blur action: ${blur(10100)} (100ms after shrink, expected ignore)`);
  notes.push(
    `blur action: ${blur(10250)} (250ms after shrink, expected shrink)`
  );
  notes.push(
    `mini bounds after throttle demo: ${fmtBounds(afterShrink)} -> ${fmtBounds(
      win.getBounds()
    )}`
  );
  return notes;
});

step("F11 fullscreen while mini -> expands", () => {
  mode.isMiniPlayer = false;
  win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  win.setFullScreen(true);
});

step("F11 exit fullscreen -> restores windowed bounds", () => {
  win.setFullScreen(false);
  win.setBounds({ x: 120, y: 60, width: 1280, height: 720 });
});

console.log(`\nTotal blur-triggered shrink calls: ${shrinkCalls} (expected 3)`);
