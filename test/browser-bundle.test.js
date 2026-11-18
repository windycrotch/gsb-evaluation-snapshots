// DOM-stub smoke test for the generated browser bundle. No browser, no deps:
// a tiny stand-in for the DOM nodes the entry module touches, then load the
// bundle in a sandboxed context and drive a few rAF frames. This proves the
// bundled wiring constructs the engine, respects the auto-hop pause-menu
// toggle, and still runs fixed 128 Hz steps under the browser code path.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'examples', 'site', 'game.bundle.js');
const code = readFileSync(bundlePath, 'utf8');

function makeElement(id) {
  return {
    id,
    hidden: false,
    checked: false,
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    textContent: '',
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] || []) fn(event);
    },
    getContext() {
      // Every canvas 2D call used by the renderer becomes a no-op function.
      return new Proxy(
        {},
        { get: () => (...args) => void args },
      );
    },
    requestPointerLock() {},
  };
}

let nowMs = 0;

function makeSandbox() {
  const ids = [
    'view', 'hud-speed', 'hud-state', 'hud-rate', 'hud-auto',
    'overlay', 'pause-menu', 'auto-toggle', 'resume-btn', 'reset-btn',
  ];
  const byId = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  const winListeners = {};
  const docListeners = {};
  const rafQueue = [];

  const documentStub = {
    getElementById: (id) => byId[id],
    pointerLockElement: null,
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    },
  };
  const sandbox = {
    console,
    performance: { now: () => nowMs },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    document: documentStub,
  };
  // browser-main references window.addEventListener, document.addEventListener,
  // and document.pointerLockElement; alias window to the sandbox itself.
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => {
    (winListeners[type] ||= []).push(fn);
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return { byId, winListeners, docListeners, rafQueue, sandbox };
}

test('browser bundle boots, runs fixed steps and the pause-menu auto-hop toggle works', () => {
  const { byId, winListeners, docListeners, rafQueue, sandbox } = makeSandbox();
  vm.runInContext(code, sandbox);

  // The entry schedules one rAF on boot.
  assert.equal(rafQueue.length, 1);
  assert.ok(winListeners.keydown?.length > 0, 'keydown listener registered on window');

  // Simulate pointer lock (unpause) via pointerlockchange.
  sandbox.document.pointerLockElement = byId.view;
  for (const fn of docListeners.pointerlockchange || []) fn();
  assert.equal(byId.overlay.hidden, true);

  // Hold W, then run ten ~60 Hz frames; ground speed should climb.
  const press = (codeName) =>
    winListeners.keydown.forEach((fn) =>
      fn({ code: codeName, preventDefault() {}, repeat: false }));
  press('KeyW');

  const before = Number(byId['hud-speed'].textContent) || 0;
  // 40 frames at ~60 Hz spans ~667 ms, crossing the HUD's 500 ms refresh window.
  for (let f = 0; f < 40; f++) {
    nowMs += 1000 / 60;
    rafQueue.shift()(nowMs);
  }
  const after = Number(byId['hud-speed'].textContent);
  assert.ok(after > before, `speed should rise while running: ${before} -> ${after}`);
  assert.match(byId['hud-rate'].textContent, /128 Hz sim/);

  // Pause-menu auto-hop control must propagate to the engine.
  byId['auto-toggle'].checked = false;
  byId['auto-toggle'].dispatch('change');
  assert.equal(byId['hud-auto'].textContent, 'false');
  byId['auto-toggle'].checked = true;
  byId['auto-toggle'].dispatch('change');
  assert.equal(byId['hud-auto'].textContent, 'true');

  // Reset button restores zero speed. Release W first so the post-reset frame
  // does not immediately re-accelerate, then let the HUD repaint.
  winListeners.keyup.forEach((fn) => fn({ code: 'KeyW' }));
  byId['reset-btn'].dispatch('click');
  nowMs += 1000 / 60;
  rafQueue.shift()(nowMs);
  assert.equal(Number(byId['hud-speed'].textContent), 0);
});
