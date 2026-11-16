/*!
 * Local-only headless verification harness for the cymatics player.
 * It loads the REAL js/cymatics.js + js/app.js inside a sandbox with tiny
 * browser stubs (no DOM rendering, no AudioContext, no requestAnimationFrame
 * loop) so the player's state and redraw flow can be driven and asserted
 * from Node. A seeded PRNG replaces Math.random for reproducible grains.
 *
 * Run: node verify/harness.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// --- deterministic random: mulberry32, injectable in place of Math.random --
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- minimal browser stubs -------------------------------------------------
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    parentElement: { getBoundingClientRect: () => ({ width: 760 }) },
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4) }),
      putImageData: () => {},
      drawImage: () => {},
      clearRect: () => {},
      fillRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      rect: () => {},
      arc: () => {},
      clip: () => {},
      stroke: () => {},
      imageSmoothingEnabled: true,
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    }),
    toDataURL: () => "data:image/png;base64,",
  };
}

function makeSandbox(search = "") {
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    style: {},
    getContext: makeCanvas().getContext,
    parentElement: { getBoundingClientRect: () => ({ width: 760 }) },
    width: 760,
    height: 760,
  });
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement: () => makeCanvas(),
  };
  const sandbox = {
    console,
    Math, // the app takes randomness from its injectable rng seam, not Math.random
    Intl,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document,
    window: {},
    location: { search, pathname: "/index.html" },
    history: { replaceState: () => {} },
    requestAnimationFrame: () => 0, // loop is driven manually in the tests
    addEventListener: () => {},
    devicePixelRatio: 1,
    module: { exports: {} },
    exports: {},
  };
  sandbox.window.addEventListener = () => {};
  sandbox.window.devicePixelRatio = 1;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const root = path.join(__dirname, "..");
  vm.runInContext(fs.readFileSync(path.join(root, "js", "cymatics.js"), "utf8"), sandbox, {
    filename: "cymatics.js",
  });
  vm.runInContext(fs.readFileSync(path.join(root, "js", "app.js"), "utf8"), sandbox, {
    filename: "app.js",
  });
  // Top-level const/let are lexical bindings, not context properties: expose
  // the symbols the tests drive.
  vm.runInContext(
    "globalThis.__api = { state, grains: () => grains, " +
      "shake, toNode, settle, scatter, unsettle, buildField, init, onStep, onFrequency, " +
      "onSize, onMix, onShape, onGrains, onRender, draw, start, wake, setRng };",
    sandbox
  );
  const api = sandbox.__api;
  Object.defineProperty(sandbox, "grains", { get: () => api.grains() });
  for (const k of Object.keys(api)) {
    if (k === "grains") continue;
    sandbox[k] = api[k];
  }
  // Deterministic randomness through the app's own injection seam.
  const seeded = makeRng(0x1234abcd);
  api.setRng(seeded);
  return {
    sandbox,
    reseed(seed) {
      const next = makeRng(seed);
      api.setRng(next);
      return next;
    },
  };
}

// Drive the physics manually (no rAF): run shake() until every grain has
// settled or the frame budget is exhausted. Returns frame stats.
function runUntilSettled(sandbox, maxFrames = 4000) {
  const { shake, grains } = sandbox;
  let frames = 0;
  let lastMoved = Infinity;
  while (frames < maxFrames) {
    const unsettledBefore = grains.filter((g) => !g.settled).length;
    lastMoved = shake();
    frames++;
    const unsettledAfter = grains.filter((g) => !g.settled).length;
    if (unsettledAfter === 0) break;
    if (unsettledAfter === unsettledBefore && lastMoved === 0 && frames > 50) break;
  }
  return {
    frames,
    settled: grains.filter((g) => g.settled).length,
    total: grains.length,
    stuck: grains.filter((g) => !g.settled).length,
  };
}

// The player's own node-distance, identical semantics to shake()'s test.
const SETTLE_THRESHOLD = 0.0012;
function maxSettledDistance(sandbox) {
  const { toNode, grains } = sandbox;
  let max = 0;
  let bad = 0;
  for (const g of grains) {
    if (!g.settled) continue;
    const d = toNode(g.x, g.y).distance;
    if (d >= SETTLE_THRESHOLD) bad++;
    max = Math.max(max, d);
  }
  return { max, bad };
}

module.exports = { makeSandbox, runUntilSettled, maxSettledDistance, makeRng, SETTLE_THRESHOLD };
