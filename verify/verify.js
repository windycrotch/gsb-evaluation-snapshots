/*!
 * Headless acceptance suite for the mode/sand-consistency invariant.
 * No browser, no audio: the real js/cymatics.js + js/app.js run in a vm
 * sandbox with a seeded RNG injected through the app's setRng() seam.
 *
 * Invariant under test (threshold semantics identical to shake() in app.js):
 *   after a mode switch and once the sand has settled, EVERY settled grain
 *   is within SETTLE_THRESHOLD (0.0012, plate units) of the CURRENT mode's
 *   nodal line; grains that have not settled are still moving.
 *
 * Run: node verify/verify.js
 */
const assert = require("assert");
const {
  makeSandbox,
  runUntilSettled,
  maxSettledDistance,
  SETTLE_THRESHOLD,
} = require("./harness");

let passed = 0;
const failures = [];
function test(name, fn) {
  const { sandbox, reseed } = makeSandbox("");
  reseed(0xc0ffee);
  try {
    fn(sandbox);
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

// Assert the core invariant after the physics has been allowed to finish.
function assertSettledOnCurrentNodes(sandbox, label) {
  const run = runUntilSettled(sandbox);
  const { max, bad } = maxSettledDistance(sandbox);
  assert.strictEqual(bad, 0, `${label}: ${bad} settled grains are >= ${SETTLE_THRESHOLD} from a node`);
  assert.ok(max < SETTLE_THRESHOLD, `${label}: max node distance ${max} >= ${SETTLE_THRESHOLD}`);
  assert.strictEqual(run.stuck, 0, `${label}: ${run.stuck} grains never settled`);
  // panel and state must name the same mode
  assert.strictEqual(
    sandbox.document.getElementById("modeName").textContent,
    sandbox.state.mode.name,
    `${label}: panel mode disagrees with state.mode`
  );
  return run;
}

// A freshly switched figure: every settled flag must have been cleared.
function assertAllUnsettled(sandbox, label) {
  const stillSettled = sandbox.grains.filter((g) => g.settled).length;
  assert.strictEqual(stillSettled, 0, `${label}: ${stillSettled} grains kept a stale settled flag`);
}

// Unsettled grains must actually move on the next physics frame.
function assertUnsettledGrainsMove(sandbox, label) {
  const moving = sandbox.grains.filter((g) => !g.settled);
  assert.ok(moving.length > 0, `${label}: expected unsettled grains to observe`);
  const before = moving.map((g) => [g.x, g.y]);
  sandbox.shake();
  let movedCount = 0;
  moving.forEach((g, k) => {
    if (Math.hypot(g.x - before[k][0], g.y - before[k][1]) > 0 || g.settled) movedCount++;
  });
  assert.ok(movedCount > 0, `${label}: unsettled grains did not move or settle on a shake frame`);
}

console.log("1. URL entry paths (init -> settle)");

test("by-name URL opens the named mode and sand settles on its nodes", (s) => {
  // rebuild a sandbox whose location carries the query string
  const { sandbox } = makeSandbox("?shape=square&mode=" + encodeURIComponent("1, 3"));
  sandbox.setRng(require("./harness").makeRng(0xc0ffee));
  sandbox.init();
  assert.strictEqual(sandbox.state.mode.name, "1, 3");
  assertAllUnsettled(sandbox, "init by name");
  assertSettledOnCurrentNodes(sandbox, "init by name");
});

test("nonexistent mode name falls back to nearest-frequency mode, no throw", (s) => {
  const { sandbox } = makeSandbox("?shape=square&mode=" + encodeURIComponent("99, 99"));
  sandbox.setRng(require("./harness").makeRng(0xc0ffee));
  assert.doesNotThrow(() => sandbox.init());
  const expected = require("../js/cymatics.js").nearestMode(sandbox.state.modes, sandbox.state.frequency);
  assert.strictEqual(sandbox.state.mode.name, expected.name, "fallback is not the nearest mode");
  assert.strictEqual(
    sandbox.document.getElementById("modeName").textContent,
    expected.name,
    "panel kept the bogus name"
  );
  assertSettledOnCurrentNodes(sandbox, "bad-name fallback");
});

test("nonexistent mode name on the drumhead also falls back", () => {
  const { sandbox } = makeSandbox("?shape=circle&mode=banana");
  sandbox.setRng(require("./harness").makeRng(0xc0ffee));
  assert.doesNotThrow(() => sandbox.init());
  assert.ok(sandbox.state.mode.name, "a fallback mode was picked");
  assertSettledOnCurrentNodes(sandbox, "circle bad-name fallback");
});

test("out-of-range size and mix are ignored, defaults kept", () => {
  const { sandbox } = makeSandbox("?shape=square&size=999&mix=7&mode=" + encodeURIComponent("1, 1"));
  sandbox.init();
  assert.strictEqual(sandbox.state.size, 0.3, "size 999 cm was not ignored");
  assert.strictEqual(sandbox.state.mix, -1, "mix 7 was not ignored");
});

test("below-range size and mix are ignored, defaults kept", () => {
  const { sandbox } = makeSandbox("?shape=square&size=5&mix=-2");
  sandbox.init();
  assert.strictEqual(sandbox.state.size, 0.3);
  assert.strictEqual(sandbox.state.mix, -1);
});

test("boundary sizes 10 and 60 cm are accepted", () => {
  for (const cm of [10, 60]) {
    const { sandbox } = makeSandbox(`?shape=square&size=${cm}`);
    sandbox.init();
    assert.strictEqual(sandbox.state.size, cm / 100, `size ${cm} cm rejected`);
  }
});

test("boundary mixes -1 and 1 are accepted", () => {
  for (const mix of [-1, 1]) {
    const { sandbox } = makeSandbox(`?shape=square&mix=${mix}`);
    sandbox.init();
    assert.strictEqual(sandbox.state.mix, mix, `mix ${mix} rejected`);
  }
});

test("non-numeric size/mix are ignored rather than NaN-ing the state", () => {
  const { sandbox } = makeSandbox("?shape=square&size=abc&mix=xyz");
  sandbox.init();
  assert.strictEqual(sandbox.state.size, 0.3);
  assert.strictEqual(sandbox.state.mix, -1);
});

console.log("2. Arrow stepping (onStep), including same-frequency twins");

test("twin modes 0,5 and 3,4 swap figure and sand despite equal frequency", () => {
  const { sandbox } = makeSandbox("?shape=square&mode=" + encodeURIComponent("0, 5"));
  sandbox.setRng(require("./harness").makeRng(7));
  sandbox.init();
  assertSettledOnCurrentNodes(sandbox, "0,5 baseline");
  const i05 = sandbox.state.modes.findIndex((m) => m.name === "0, 5");
  const i34 = sandbox.state.modes.findIndex((m) => m.name === "3, 4");
  assert.ok(i05 >= 0 && i34 >= 0, "twin modes missing from spectrum");
  assert.ok(
    Math.abs(sandbox.state.modes[i05].frequency - sandbox.state.modes[i34].frequency) < 1e-6,
    "test premise: the two modes must share a frequency"
  );
  const before = sandbox.grains.map((g) => [g.x, g.y]);
  sandbox.onStep(i34 > i05 ? 1 : -1);
  assert.strictEqual(sandbox.state.mode.name, "3, 4", "arrow did not reach the twin");
  assert.strictEqual(sandbox.document.getElementById("modeName").textContent, "3, 4", "panel not updated");
  assertAllUnsettled(sandbox, "twin step");
  assertSettledOnCurrentNodes(sandbox, "twin step 3,4");
  const moved = sandbox.grains.reduce(
    (n, g, k) => n + (Math.hypot(g.x - before[k][0], g.y - before[k][1]) > 1e-6 ? 1 : 0),
    0
  );
  assert.ok(moved > sandbox.grains.length / 2, "the sand never left the old twin's figure");
});

test("stepping back from 3,4 returns to 0,5 and re-settles there", () => {
  const { sandbox } = makeSandbox("?shape=square&mode=" + encodeURIComponent("3, 4"));
  sandbox.setRng(require("./harness").makeRng(11));
  sandbox.init();
  runUntilSettled(sandbox);
  const i05 = sandbox.state.modes.findIndex((m) => m.name === "0, 5");
  const i34 = sandbox.state.modes.findIndex((m) => m.name === "3, 4");
  // move in whichever direction the sorted spectrum places the twin
  sandbox.onStep(i05 > i34 ? 1 : -1);
  assert.strictEqual(sandbox.state.mode.name, "0, 5");
  assertAllUnsettled(sandbox, "twin back-step");
  assertSettledOnCurrentNodes(sandbox, "twin back 0,5");
});

test("walking the entire square spectrum keeps panel, state and sand aligned", (s) => {
  s.init();
  const startIndex = s.state.modes.indexOf(s.state.mode);
  let steps = 0;
  while (s.state.modes.indexOf(s.state.mode) < s.state.modes.length - 1) {
    s.onStep(1);
    steps++;
    assert.strictEqual(s.document.getElementById("modeName").textContent, s.state.mode.name);
    assertAllUnsettled(s, `step ${steps}`);
    assertSettledOnCurrentNodes(s, `step ${steps} ${s.state.mode.name}`);
  }
  assert.strictEqual(s.state.mode.name, s.state.modes[s.state.modes.length - 1].name);
  assert.strictEqual(steps, s.state.modes.length - 1 - startIndex, "spectrum walk step count");
});

test("arrow buttons clamp at both ends of the spectrum", () => {
  const { sandbox } = makeSandbox("");
  sandbox.setRng(require("./harness").makeRng(3));
  sandbox.init();
  // walk to the first mode, then extra back-steps must stay on it
  while (sandbox.state.modes.indexOf(sandbox.state.mode) > 0) sandbox.onStep(-1);
  const first = sandbox.state.modes[0].name;
  assert.strictEqual(sandbox.state.mode.name, first);
  for (let k = 0; k < 5; k++) sandbox.onStep(-1);
  assert.strictEqual(sandbox.state.mode.name, first, "step-back ran past the first mode");
  assertAllUnsettled(sandbox, "clamped back-step");
  assertSettledOnCurrentNodes(sandbox, "clamped back-step");
  // and the high end clamps too
  while (sandbox.state.modes.indexOf(sandbox.state.mode) < sandbox.state.modes.length - 1) sandbox.onStep(1);
  const last = sandbox.state.modes[sandbox.state.modes.length - 1].name;
  for (let k = 0; k < 5; k++) sandbox.onStep(1);
  assert.strictEqual(sandbox.state.mode.name, last, "step-forward ran past the last mode");
  assertSettledOnCurrentNodes(sandbox, "clamped forward-step");
});

console.log("3. The three settle branches explicitly reset the settled flag");

test("by-name hit, frequency fallback and missing name all unsettle", () => {
  const { sandbox } = makeSandbox("");
  sandbox.setRng(require("./harness").makeRng(5));
  sandbox.init();
  runUntilSettled(sandbox);
  // by-name hit
  sandbox.settle(false, "1, 4");
  assertAllUnsettled(sandbox, "name hit");
  runUntilSettled(sandbox);
  // frequency fallback (no name argument)
  sandbox.state.frequency = 500;
  sandbox.settle(false);
  assertAllUnsettled(sandbox, "frequency fallback");
  runUntilSettled(sandbox);
  // missing name
  const r = sandbox.settle(false, "no-such-mode");
  assert.strictEqual(r.matched, "frequency", "missing name did not report a frequency fallback");
  assertAllUnsettled(sandbox, "missing name");
  assertSettledOnCurrentNodes(sandbox, "missing name");
});

test("re-entrant settle before physics runs still leaves every grain unsettled", () => {
  const { sandbox } = makeSandbox("");
  sandbox.init();
  runUntilSettled(sandbox);
  sandbox.settle(false, "1, 4");
  sandbox.settle(false, "2, 4");
  sandbox.settle(false, "0, 3");
  assertAllUnsettled(sandbox, "re-entrant settle");
  assertSettledOnCurrentNodes(sandbox, "re-entrant settle");
});

console.log("4. Unsettled grains keep moving; other redraw paths stay consistent");

test("unsettled grains move on the next frame after a switch", () => {
  const { sandbox } = makeSandbox("?shape=square&mode=" + encodeURIComponent("2, 2"));
  sandbox.setRng(require("./harness").makeRng(13));
  sandbox.init();
  runUntilSettled(sandbox);
  sandbox.onStep(1);
  assertUnsettledGrainsMove(sandbox, "post-switch frame");
  assertSettledOnCurrentNodes(sandbox, "after observing movement");
});

test("superposition (mix) rebuild re-settles on the moved nodes", () => {
  const { sandbox } = makeSandbox("");
  sandbox.setRng(require("./harness").makeRng(17));
  sandbox.init();
  runUntilSettled(sandbox);
  sandbox.onMix({ value: "0.5" });
  assertAllUnsettled(sandbox, "mix rebuild");
  assertSettledOnCurrentNodes(sandbox, "mix rebuild");
});

test("shape change rebuilds the sand and settles on the new plate", () => {
  const { sandbox } = makeSandbox("?shape=square");
  sandbox.setRng(require("./harness").makeRng(19));
  sandbox.init();
  runUntilSettled(sandbox);
  sandbox.onShape({ value: "circle" });
  assertAllUnsettled(sandbox, "shape change");
  assertSettledOnCurrentNodes(sandbox, "circle after shape change");
});

test("slider drags re-settle every time", () => {
  const { sandbox } = makeSandbox("");
  sandbox.setRng(require("./harness").makeRng(23));
  sandbox.init();
  for (const v of [100, 250, 500, 750, 900]) {
    sandbox.onFrequency({ value: String(v) });
    assertAllUnsettled(sandbox, `slider ${v}`);
    assertSettledOnCurrentNodes(sandbox, `slider ${v}`);
  }
});

test("seeded RNG is reproducible: two identical runs place grains identically", () => {
  const a = makeSandbox("");
  a.reseed(424242);
  a.sandbox.init();
  const b = makeSandbox("");
  b.reseed(424242);
  b.sandbox.init();
  assert.strictEqual(a.sandbox.grains.length, b.sandbox.grains.length);
  for (let k = 0; k < a.sandbox.grains.length; k++) {
    assert.strictEqual(a.sandbox.grains[k].x, b.sandbox.grains[k].x, `grain ${k} x differs`);
    assert.strictEqual(a.sandbox.grains[k].y, b.sandbox.grains[k].y, `grain ${k} y differs`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
