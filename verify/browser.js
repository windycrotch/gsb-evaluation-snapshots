/*!
 * In-browser counterpart of verify/verify.js. The production scripts declare
 * their functions as globals, so this page drives the real settle/onStep
 * flow with a seeded RNG and a manually stepped physics loop.
 */
(function () {
  const THRESHOLD = 0.0012; // same semantics as shake()'s settle test in app.js
  const logEl = document.getElementById("log");
  const summaryEl = document.getElementById("summary");

  // mulberry32: the same seeded generator the Node harness uses.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function line(text, cls) {
    const span = document.createElement("div");
    span.className = cls || "";
    span.textContent = text;
    logEl.appendChild(span);
  }

  // Drive shake() straight through (the page's own rAF loop is suppressed by
  // stepping physics manually) until every grain has settled or the budget is
  // exhausted.
  function runUntilSettled(maxFrames = 4000) {
    let frames = 0;
    while (frames++ < maxFrames && grains.some((g) => !g.settled)) {
      shake();
    }
    return {
      frames,
      stuck: grains.filter((g) => !g.settled).length,
    };
  }

  function maxSettledDistance() {
    let max = 0;
    let bad = 0;
    for (const g of grains) {
      if (!g.settled) continue;
      const d = toNode(g.x, g.y).distance;
      if (d >= THRESHOLD) bad++;
      if (d > max) max = d;
    }
    return { max, bad };
  }

  const checks = [];
  function check(name, fn) {
    checks.push({ name, fn });
  }

  function freshState(search) {
    // The page is not reloaded between checks, so restore every default that
    // init() only assigns when its URL parameter is absent; otherwise a shape
    // or size changed by an earlier check would leak into the next spectrum.
    state.shape = "square";
    state.size = 0.3;
    state.mix = -1;
    state.grains = 20000;
    state.render = "sand";
    state.mode = null;
    state.frequency = 340;
    const url = new URL(location.href);
    url.search = search || "";
    history.replaceState(null, "", url);
    setRng(mulberry32(0xc0ffee));
    init();
  }

  function assertAllUnsettled(label) {
    const n = grains.filter((g) => g.settled).length;
    if (n !== 0) throw new Error(`${label}: ${n} grains kept a stale settled flag`);
  }

  function assertSettledOnNodes(label) {
    const run = runUntilSettled();
    const d = maxSettledDistance();
    if (d.bad !== 0) throw new Error(`${label}: ${d.bad} settled grains off-node (max ${d.max.toExponential(2)})`);
    if (d.max >= THRESHOLD) throw new Error(`${label}: max distance ${d.max} >= ${THRESHOLD}`);
    if (run.stuck !== 0) throw new Error(`${label}: ${run.stuck} grains never settled`);
    if (document.getElementById("modeName").textContent !== state.mode.name)
      throw new Error(`${label}: panel mode disagrees with state.mode`);
    draw();
  }

  check("by-name URL opens the named mode", () => {
    freshState("?shape=square&mode=" + encodeURIComponent("1, 3"));
    if (state.mode.name !== "1, 3") throw new Error("named mode not selected");
    assertAllUnsettled("init by name");
    assertSettledOnNodes("init by name");
  });

  check("nonexistent mode name falls back to nearest frequency", () => {
    freshState("?shape=square&mode=" + encodeURIComponent("99, 99"));
    const expected = nearestMode(state.modes, state.frequency);
    if (state.mode.name !== expected.name) throw new Error("fallback is not the nearest mode");
    if (document.getElementById("modeName").textContent !== expected.name)
      throw new Error("panel kept the bogus name");
    assertSettledOnNodes("bad-name fallback");
  });

  check("bad mode name on the drumhead falls back too", () => {
    freshState("?shape=circle&mode=banana");
    if (!state.mode.name) throw new Error("no fallback mode picked");
    assertSettledOnNodes("circle fallback");
  });

  check("out-of-range size/mix are ignored (999 cm, mix 7; 5 cm, mix -2)", () => {
    freshState("?shape=square&size=999&mix=7");
    if (state.size !== 0.3 || state.mix !== -1) throw new Error("upper bounds not ignored");
    freshState("?shape=square&size=5&mix=-2");
    if (state.size !== 0.3 || state.mix !== -1) throw new Error("lower bounds not ignored");
  });

  check("boundary size 10/60 cm and mix -1/1 are accepted", () => {
    for (const cm of [10, 60]) {
      freshState(`?shape=square&size=${cm}`);
      if (state.size !== cm / 100) throw new Error(`size ${cm} rejected`);
    }
    for (const mix of [-1, 1]) {
      freshState(`?shape=square&mix=${mix}`);
      if (state.mix !== mix) throw new Error(`mix ${mix} rejected`);
    }
  });

  check("twin modes 0,5 <-> 3,4 swap figure and sand at equal frequency", () => {
    freshState("?shape=square&mode=" + encodeURIComponent("0, 5"));
    assertSettledOnNodes("0,5 baseline");
    const i05 = state.modes.findIndex((m) => m.name === "0, 5");
    const i34 = state.modes.findIndex((m) => m.name === "3, 4");
    // physically identical (m^2+n^2 = 25 for both); Bessel-free plate formula
    // still accumulates floating-point rounding, so compare with a tolerance
    if (Math.abs(state.modes[i05].frequency - state.modes[i34].frequency) > 1e-6)
      throw new Error(
        `test premise broken: twins differ in frequency ` +
          `${state.modes[i05].frequency} vs ${state.modes[i34].frequency} (indices ${i05}, ${i34})`
      );
    const before = grains.map((g) => [g.x, g.y]);
    onStep(i34 > i05 ? 1 : -1);
    if (state.mode.name !== "3, 4") throw new Error("arrow did not reach the twin");
    if (document.getElementById("modeName").textContent !== "3, 4")
      throw new Error("panel not updated for twin");
    assertAllUnsettled("twin step");
    assertSettledOnNodes("twin 3,4");
    const moved = grains.reduce(
      (n, g, k) => n + (Math.hypot(g.x - before[k][0], g.y - before[k][1]) > 1e-6 ? 1 : 0),
      0
    );
    if (moved <= grains.length / 2) throw new Error("sand never left the old twin's figure");
    onStep(i05 > i34 ? 1 : -1);
    if (state.mode.name !== "0, 5") throw new Error("return step did not restore the twin");
    assertSettledOnNodes("twin back 0,5");
  });

  check("whole-spectrum arrow walk stays aligned", () => {
    freshState("");
    const startIndex = state.modes.indexOf(state.mode);
    let steps = 0;
    while (state.modes.indexOf(state.mode) < state.modes.length - 1) {
      onStep(1);
      steps++;
      assertAllUnsettled(`step ${steps}`);
      assertSettledOnNodes(`step ${steps}`);
    }
    if (state.mode.name !== state.modes[state.modes.length - 1].name)
      throw new Error("walk did not reach the last mode");
    if (steps !== state.modes.length - 1 - startIndex)
      throw new Error(`walk took ${steps} steps, expected ${state.modes.length - 1 - startIndex}`);
  });

  check("the three settle branches each clear the settled flag", () => {
    freshState("");
    runUntilSettled();
    settle(false, "1, 4"); // name hit
    assertAllUnsettled("name hit");
    runUntilSettled();
    state.frequency = 500;
    settle(false); // frequency fallback
    assertAllUnsettled("frequency fallback");
    runUntilSettled();
    const r = settle(false, "no-such-mode"); // missing name
    if (r.matched !== "frequency") throw new Error("missing name did not report fallback");
    assertAllUnsettled("missing name");
    assertSettledOnNodes("missing name");
  });

  check("unsettled grains move on the next frame", () => {
    freshState("?shape=square&mode=" + encodeURIComponent("2, 2"));
    runUntilSettled();
    onStep(1);
    const moving = grains.filter((g) => !g.settled);
    if (!moving.length) throw new Error("no unsettled grains to observe");
    const p = moving.map((g) => [g.x, g.y]);
    shake();
    const anyMoved = moving.some((g, k) => Math.hypot(g.x - p[k][0], g.y - p[k][1]) > 0 || g.settled);
    if (!anyMoved) throw new Error("unsettled grains stayed put");
    assertSettledOnNodes("after movement");
  });

  check("mix rebuild and shape change re-settle on the new nodes", () => {
    freshState("");
    runUntilSettled();
    onMix({ value: "0.5" });
    assertAllUnsettled("mix");
    assertSettledOnNodes("mix");
    onShape({ value: "circle" });
    assertAllUnsettled("shape");
    assertSettledOnNodes("circle");
  });

  async function run() {
    logEl.textContent = "";
    let failed = 0;
    for (const c of checks) {
      try {
        c.fn();
        line(`ok   ${c.name}`, "ok");
      } catch (e) {
        failed++;
        line(`FAIL ${c.name}: ${e.message}`, "fail");
      }
      // yield so the canvas paints each settled figure between checks
      await new Promise((r) => setTimeout(r, 30));
    }
    summaryEl.textContent = `${checks.length - failed}/${checks.length} passed`;
    summaryEl.className = failed ? "fail" : "ok";
    line(`\nthreshold: every settled grain within ${THRESHOLD} of a current-mode nodal line`, "info");
  }

  document.getElementById("run").addEventListener("click", run);
  run();
})();
