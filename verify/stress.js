/* stress: simulate the real rAF loop semantics with randomized, interleaved
 * entry paths (init-by-name, bad-name fallback, onStep incl. twins, slider,
 * size, mix, shape) and assert the invariant after every switch:
 *  - every settled grain is within 0.0012 of the CURRENT mode's nodal lines
 *  - after the loop sleeps, no grain is left moving
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { makeSandbox, SETTLE_THRESHOLD } = require("./harness");

// Recreate the app's own loop semantics on top of the sandboxed functions.
function makeLoop(sandbox) {
  let running = false;
  let scheduled = false;
  let still = 0;
  const STILL = 0.0002;
  const STILL_FRAMES = 30;
  function frame() {
    scheduled = false;
    if (!running) return;
    const moved = sandbox.state.render !== "field" ? sandbox.shake() : 0;
    still = moved < STILL ? still + 1 : 0;
    if (still >= STILL_FRAMES) {
      running = false;
      return;
    }
    scheduled = true;
    setImmediate(frame);
  }
  return {
    isRunning: () => running,
    start() {
      if (running) return;
      running = true;
      if (!scheduled) {
        scheduled = true;
        setImmediate(frame);
      }
    },
    kick() {
      still = 0;
      this.start();
    },
    async waitSleep(maxFrames = 20000) {
      let n = 0;
      while (running && n < maxFrames) {
        await new Promise((r) => setImmediate(r));
        n++;
      }
      return { slept: !running, frames: n };
    },
  };
}

// The app's internal calls resolve lexical bindings, so sandbox property
// wrappers cannot intercept them; kick the loop after every entry path,
// exactly as the app's own unsettle()/scatter()/onRender() call wake().
function wire(sandbox) {
  const loop = makeLoop(sandbox);
  return loop;
}

function invariant(sandbox, label) {
  let bad = 0;
  let max = 0;
  for (const g of sandbox.grains) {
    if (!g.settled) continue;
    const d = sandbox.toNode(g.x, g.y).distance;
    if (d >= SETTLE_THRESHOLD) bad++;
    if (d > max) max = d;
  }
  if (bad) console.log(`   INVARIANT FAIL [${label}]: ${bad} settled grains off-node (max ${max.toExponential(2)})`);
  return bad;
}

(async () => {
  let totalFail = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { sandbox } = makeSandbox("");
    sandbox.setRng((() => {
      let a = (seed * 2654435761) >>> 0;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })());
    const loop = wire(sandbox);
    sandbox.init();
    loop.kick();

    const modes = sandbox.state.modes;
    const ops = [];
    for (let k = 0; k < 40; k++) {
      const roll = (seed * 40 + k * 7) % 10;
      if (roll < 3) {
        const m = modes[(seed + k) % modes.length];
        ops.push(() => sandbox.settle(false, m.name)); // by-name entry (URL/arrow style)
      } else if (roll < 5) {
        ops.push(() => sandbox.settle(false, "nope-" + k)); // nonexistent name -> freq fallback
      } else if (roll < 7) {
        ops.push(() => sandbox.onStep(k % 2 ? 1 : -1)); // arrows, includes twins
      } else if (roll < 8) {
        ops.push(() => sandbox.onMix({ value: String(-1 + ((k % 10) / 5)) }));
      } else if (roll < 9) {
        ops.push(() => sandbox.onFrequency({ value: String(50 + ((k * 97) % 900)) }));
      } else {
        ops.push(() => sandbox.onShape({ value: k % 2 ? "circle" : "square" }));
      }
    }

    for (let k = 0; k < ops.length; k++) {
      // sometimes interrupt before the previous figure finished forming
      if (k % 3 === 1) {
        await new Promise((r) => setImmediate(r));
      } else {
        await loop.waitSleep();
      }
      ops[k]();
      loop.kick(); // every app entry path ends in wake()/start()
      const badMid = invariant(sandbox, `seed${seed} op${k} immediate`);
      totalFail += badMid;
      const panel = sandbox.document.getElementById("modeName").textContent;
      if (panel !== sandbox.state.mode.name) {
        console.log(`   PANEL FAIL seed${seed} op${k}: ${panel} vs ${sandbox.state.mode.name}`);
        totalFail++;
      }
    }
    const end = await loop.waitSleep();
    totalFail += invariant(sandbox, `seed${seed} final`);
    const unsettled = sandbox.grains.filter((g) => !g.settled).length;
    if (unsettled) {
      console.log(`   seed${seed}: loop slept with ${unsettled} unsettled grains (never converge)`);
      totalFail += unsettled;
    }
    console.log(`seed ${seed}: done, slept=${end.slept}, frames=${end.frames}, mode=${sandbox.state.mode.name}`);
  }
  console.log(totalFail === 0 ? "STRESS PASS" : `STRESS FAIL: ${totalFail}`);
  process.exit(totalFail ? 1 : 0);
})();
