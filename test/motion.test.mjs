/* Sedona Sunset — the walk, proven frame by frame.
 *
 *   node --test test/
 *
 * `src/motion.js` is a pure function of (state, dt, keys, ground sampler), so
 * every property the movement is required to have can be asserted here without
 * a browser, a canvas, a GPU or the `three` package. The two things that are
 * not in this file are the ones that are not movement: the arrival lift, which
 * is a camera nudge keyed to distance along this wash and lives in main.js, and
 * the actual height field, which is swapped for the analytic ones below.
 *
 * The terrain here is *synthetic and authored for the test* — flat plates, a
 * ramp, a step, a hole that returns NaN. That is deliberate: a test that used
 * the real height field could not tell "the step landed on the ground" from
 * "the noise happened to be flat there", and it would need `three` to run at
 * all. The real field is exercised separately, in the page, by tools/_jump.mjs
 * and tools/_walktest.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  G, JUMP_H, JUMP_V, WALK_SPEED, EYE, SETTLE_EPS,
  KEY, createState, cloneState, stepMotion, cameraOf,
} from '../src/motion.js';

const DT = 1 / 120;
const NO_KEYS = Object.freeze({});

/* ── terrain, authored ────────────────────────────────────────────────────
 * A sampler is just (x, z) → height. These are the plates the requirements are
 * written against. */
const flat = () => 0;
const ramp = (x) => x * 0.2;                       // 11° up-slope, +x
const step = (x, z) => (x > 1.0 ? 0.3 : 0);          // a 30 cm ledge at x = 1
const holeAt = (bad) => (x, z) => (x >= bad ? NaN : 0);

/** Step `n` frames and return the states. A small driver so every test reads
 *  as the sequence of frames it is. */
function run(state, { n, dt = DT, keys = NO_KEYS, groundAt = flat, corridor, path, pitch } = {}) {
  const states = [state];
  for (let i = 0; i < n; i++) {
    const r = stepMotion(states[states.length - 1], {
      dt, keys, groundAt, corridor, path,
      ...(pitch === undefined ? {} : { pitch }),
    });
    states.push(r.state);
  }
  return states;
}

/* ── 1. standing still is a fixed point ──────────────────────────────────── */

test('still and no keys: repeated steps return byte-identical state', () => {
  const s0 = createState(4, 0, -12, 0.3, 0.1);
  const a = run(s0, { n: 1 })[1];
  const b = run(a, { n: 600 })[600];
  assert.deepEqual(b, a, 'state drifted while nothing was pressed');
  assert.deepEqual(cameraOf(b), cameraOf(a));
  /* Not merely "close": the snap-to-zero thresholds mean these are exactly
     equal, which is what makes two captures of one spot pixel-identical. */
  assert.equal(b.vx, 0);
  assert.equal(b.vz, 0);
  assert.equal(b.bob, 0);
  assert.equal(b.settle, 0);
});

test('a step of zero or negative time changes nothing', () => {
  const s0 = createState(1, 0, -2, 0.5, -0.2);
  s0.vx = 1.2; s0.vz = -0.7; s0.air = true; s0.vy = 2.0; s0.settle = 0.03;
  /* A sampler that would throw if touched: a paused frame has no business
     asking the terrain anything. */
  const boom = () => { throw new Error('groundAt called on a no-op step'); };
  for (const dt of [0, -0.016, -1]) {
    const r = stepMotion(s0, { dt, keys: { KeyW: true, Space: true }, groundAt: boom });
    assert.equal(r.error, null);
    assert.equal(r.state.x, s0.x);
    assert.equal(r.state.z, s0.z);
    assert.equal(r.state.vx, s0.vx);
    assert.equal(r.state.vy, s0.vy);
    assert.equal(r.state.air, true);
    assert.equal(r.state.settle, s0.settle);
    /* The jump latch is not consumed by a frame that never simulated. */
    assert.equal(r.state.jumpHeld, s0.jumpHeld);
  }
});

/* ── 2. air: no steering ─────────────────────────────────────────────────── */

test('distance keys do not change horizontal velocity while airborne', () => {
  /* Leave the ground holding forward, then hold D for the whole arc. */
  let s = createState(0, 0, 0, 0, 0);
  s = stepMotion(s, { dt: DT, keys: { KeyW: true, Space: true }, groundAt: flat }).state;
  assert.equal(s.air, true);
  const vx0 = s.vx, vz0 = s.vz;
  assert.ok(Math.hypot(vx0, vz0) > 1.4, 'takeoff should carry walking pace');

  for (let i = 0; i < 24 && s.air; i++) {
    s = stepMotion(s, { dt: DT, keys: { KeyD: true, KeyA: true, KeyS: true, KeyW: true }, groundAt: flat }).state;
    assert.equal(s.vx, vx0, 'vx changed in the air');
    assert.equal(s.vz, vz0, 'vz changed in the air');
  }
});

/* ── 3. the jump latch ───────────────────────────────────────────────────── */

test('a jump triggers only on the rising edge of Space', () => {
  let s = createState(0, 0, 0);
  /* Held from the start: one jump, and every later frame is still airborne
     with no second launch. */
  s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
  assert.equal(s.air, true);
  const vy0 = s.vy;
  let frames = 0;
  while (s.air && frames < 240) {
    s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
    frames++;
    if (s.air) assert.ok(s.vy <= vy0, 'vy rose again mid-flight from a held key');
  }
  assert.equal(s.air, false, 'should have landed');
  const afterLanding = s;
  /* Still held at and after touchdown: no pogo stick. */
  for (let i = 0; i < 120; i++) {
    s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
    assert.equal(s.air, false, 'holding Space re-jumped on landing');
  }
  assert.equal(s.y, 0);

  /* Release, then press: exactly one more jump. */
  s = stepMotion(afterLanding, { dt: DT, keys: {}, groundAt: flat }).state;
  assert.equal(s.air, false);
  s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
  assert.equal(s.air, true, 'a fresh press after release must jump');
});

test('a press during flight is not banked into a jump on landing', () => {
  let s = createState(0, 0, 0);
  s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
  /* Release and re-press while still well above the ground. */
  s = stepMotion(s, { dt: DT, keys: {}, groundAt: flat }).state;
  s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
  assert.equal(s.air, true);
  let n = 0;
  while (s.air && n < 240) {
    s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
    n++;
  }
  assert.equal(s.air, false);
  /* Key is down at touchdown and was pressed mid-flight: it must not fire. */
  for (let i = 0; i < 60; i++) {
    s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
    assert.equal(s.air, false, 'a mid-flight press was banked into a landing jump');
  }
});

/* ── 4. the arc ──────────────────────────────────────────────────────────── */

test('the jump is about 45 cm and about 0.6 s', () => {
  const fine = 1 / 600;
  let s = createState(0, 0, 0);
  s = stepMotion(s, { dt: fine, keys: { Space: true }, groundAt: flat }).state;
  let apex = 0, t = 0;
  while (s.air && t < 3) {
    apex = Math.max(apex, s.y);
    s = stepMotion(s, { dt: fine, keys: { Space: true }, groundAt: flat }).state;
    t += fine;
  }
  assert.ok(Math.abs(apex - JUMP_H) < 0.01, `apex ${apex.toFixed(3)} m`);
  assert.ok(Math.abs(t - 2 * JUMP_V / G) < 0.02, `airtime ${t.toFixed(3)} s`);
});

/* ── 5. the landing dip ──────────────────────────────────────────────────── */

test('a landing dips the eye by the impact and returns to exactly zero', () => {
  let s = createState(0, 0, 0);
  s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
  let n = 0;
  while (s.air && n < 480) {
    s = stepMotion(s, { dt: DT, keys: { Space: true }, groundAt: flat }).state;
    n++;
  }
  assert.equal(s.air, false);
  assert.ok(s.settle > 0, 'landing produced no dip');

  let deepest = 0, framesToZero = -1;
  for (let i = 0; i < 600; i++) {
    deepest = Math.max(deepest, s.settle);
    if (s.settle === 0 && s.settleV === 0) { framesToZero = i; break; }
    /* Critical damping: the eye comes up to level and never overshoots it. */
    assert.ok(s.settle >= 0, 'the dip crossed below level');
    s = stepMotion(s, { dt: DT, keys: {}, groundAt: flat }).state;
  }
  assert.ok(deepest > 0.005 && deepest < 0.08, `dip ${(deepest * 100).toFixed(2)} cm`);
  assert.ok(framesToZero >= 0 && framesToZero * DT < 2.0,
    `dip did not reach exact zero in finite time (${framesToZero < 0 ? 'never' : (framesToZero * DT).toFixed(2) + ' s'})`);
  assert.equal(s.settle, 0);
  assert.equal(s.settleV, 0);
  assert.equal(cameraOf(s).eye, EYE);
});

test('a harder landing dips further than a soft one', () => {
  const drop = (height) => {
    let s = createState(0, height, 0);
    s.air = true; s.vy = 0;
    let deepest = 0;
    for (let i = 0; i < 600 && (s.air || s.settle > 0); i++) {
      s = stepMotion(s, { dt: DT, keys: {}, groundAt: flat }).state;
      deepest = Math.max(deepest, s.settle);
    }
    return deepest;
  };
  assert.ok(drop(2.0) > drop(0.5), 'impact speed did not scale the dip');
});

/* ── 6. eye offset and pitch are independent ─────────────────────────────── */

test('eye offset and pitch do not move each other', () => {
  const trace = (pitch) => run(createState(0, 0, 0, 0, pitch), {
    n: 180, keys: { Space: true }, groundAt: flat, pitch,
  }).slice(1).map(cameraOf);

  const level = trace(0);
  const down = trace(-0.7);
  for (let i = 0; i < level.length; i++) {
    assert.equal(level[i].eye, down[i].eye, `eye differed at frame ${i}`);
    assert.equal(down[i].pitch, -0.7, `pitch was written by the step at frame ${i}`);
  }
  /* And pitch is carried through an actual landing dip untouched. */
  const dipped = trace(0).some(c => c.settle > 0);
  assert.ok(dipped, 'the trace never landed, so nothing was proven');
});

/* ── 7. a non-finite ground sample is refused, not propagated ────────────── */

test('NaN ground holds the last position and never reaches the camera', () => {
  const groundAt = holeAt(2.0);
  /* Walk toward the hole at x = 2 from x = 0. */
  let s = createState(0, 0, 0, Math.PI / 2, 0); // forward = +x
  let lastGood = s;
  let refused = null;
  for (let i = 0; i < 600; i++) {
    const r = stepMotion(s, { dt: DT, keys: { KeyW: true }, groundAt });
    if (r.error) { refused = { r, prev: s }; break; }
    lastGood = s = r.state;
  }
  assert.ok(refused, 'the walker never reached the hole');

  const { state, camera, error } = refused.r;
  assert.equal(error, 'ground');
  /* The whole previous state is returned: position, velocity, airborne. */
  assert.deepEqual(state, cloneState(refused.prev));
  /* The camera fields are finite and describe that held position. */
  assert.ok(Number.isFinite(camera.eye));
  assert.ok(Number.isFinite(camera.pitch));
  assert.equal(camera.eye, EYE + state.bob - state.settle);
  assert.equal(state.x, lastGood.x);
  assert.equal(state.y, lastGood.y);
  assert.ok(Number.isFinite(state.x) && Number.isFinite(state.y));

  /* Still refused on the next frame, and still held. */
  const again = stepMotion(state, { dt: DT, keys: { KeyW: true }, groundAt });
  assert.equal(again.error, 'ground');
  assert.deepEqual(again.state, cloneState(state));
});

test('a sampler that throws is treated as a bad sample', () => {
  const s0 = createState(1, 0, 1);
  const r = stepMotion(s0, { dt: DT, keys: {}, groundAt: () => { throw new Error('boom'); } });
  assert.equal(r.error, 'ground');
  assert.deepEqual(r.state, cloneState(s0));
});

/* ── 8. landing on higher ground lands early ─────────────────────────────── */

test('a jump that comes down on a ledge lands early and still dips', () => {
  /* Flat ground, then a 30 cm ledge at x = 1. Jump forward from x = 0.6 at
     walking pace so the arc crosses the ledge. */
  const landOn = (groundAt, ledgedAt) => {
    let s = createState(0.6, 0, 0, Math.PI / 2, 0);   // forward = +x
    s.y = groundAt(s.x, s.z);
    s = stepMotion(s, { dt: DT, keys: { KeyW: true, Space: true }, groundAt }).state;
    assert.equal(s.air, true);
    let t = 0, dipped = false, landedX = null;
    while (s.air && t < 3) {
      s = stepMotion(s, { dt: DT, keys: { KeyW: true }, groundAt }).state;
      t += DT;
    }
    dipped = s.settle > 0 || s.settleV > 0;
    landedX = s.x;
    return { t, dipped, y: s.y, x: landedX };
  };

  const flatLanding = landOn(() => 0);
  const ledgeLanding = landOn((x) => (x > 1.0 ? 0.3 : 0));

  assert.equal(ledgeLanding.y, 0.3, 'did not reseat on the ledge');
  assert.ok(ledgeLanding.x > 1.0, 'never reached the ledge');
  assert.ok(ledgeLanding.t < flatLanding.t,
    `ledge landing ${ledgeLanding.t.toFixed(3)} s was not earlier than flat ${flatLanding.t.toFixed(3)} s`);
  assert.ok(ledgeLanding.dipped, 'an early landing produced no dip');
});

/* ── 9. the corridor: one component limited, the other left alone ────────── */

/* A straight, synthetic wash: heading 0, so +u is +x and +s is −z. The path
   stub answers the same (x, s, th) triple `WashPath.atZ` returns. */
const straightPath = {
  atZ(z) { return { x: 0, s: -z, th: 0, k: 0 }; },
};
function boxCorridor(halfWidth = 5, sMin = -8, sMax = 100) {
  const step = 1, n = Math.ceil((sMax - sMin) / step) + 2;
  const L = new Float32Array(n).fill(halfWidth);
  const R = new Float32Array(n).fill(halfWidth);
  return { sMin, sMax, step, n, L, R };
}

test('at a side limit the lateral speed is bled off and forward walking is not', () => {
  const corridor = boxCorridor(5);
  const path = straightPath;

  /* Walk straight at the right-hand wall (yaw = +90° faces +x). */
  let s = createState(3.0, 0, 0, Math.PI / 2, 0);
  let maxU = 0;
  for (let i = 0; i < 120 * 8; i++) {
    s = stepMotion(s, { dt: DT, keys: { KeyW: true }, groundAt: flat, corridor, path }).state;
    maxU = Math.max(maxU, s.x);
  }
  assert.ok(maxU <= 5.01, `walked through the wall to u=${maxU.toFixed(2)}`);
  assert.ok(Math.abs(s.vx) < 0.2, `lateral speed not bled: vx=${s.vx.toFixed(2)}`);

  /* Now walk forward (−z) while pressed against that same wall. The along-wash
     speed must be full walking pace — the wall limits the outward component
     only. */
  let f = createState(4.9, 0, 0, 0, 0);
  for (let i = 0; i < 120 * 3; i++) {
    f = stepMotion(f, { dt: DT, keys: { KeyW: true }, groundAt: flat, corridor, path }).state;
  }
  assert.ok(f.vz < -WALK_SPEED + 0.05 && f.vz > -WALK_SPEED - 0.05,
    `forward speed ${f.vz.toFixed(3)} is not ${WALK_SPEED}`);
  assert.ok(f.z < -2, 'did not actually walk along the wash');
});

test('at the ends of the walk the along-wash speed is cut and a sidestep is not', () => {
  const corridor = boxCorridor(5, -8, 20);
  const path = straightPath;

  /* Run at the head (s = 20, i.e. z = −20). s must not pass sMax. */
  let s = createState(0, 0, -18, 0, 0);
  for (let i = 0; i < 120 * 5; i++) {
    s = stepMotion(s, { dt: DT, keys: { KeyW: true }, groundAt: flat, corridor, path }).state;
  }
  assert.ok(-s.z <= 20.01, `walked past the head to s=${(-s.z).toFixed(2)}`);
  assert.ok(Math.abs(s.vz) < 0.2, `along-wash speed not cut: vz=${s.vz.toFixed(2)}`);

  /* And a sidestep at the head still works. */
  let d = createState(0, 0, -19.8, 0, 0);
  for (let i = 0; i < 120 * 2; i++) {
    d = stepMotion(d, { dt: DT, keys: { KeyD: true }, groundAt: flat, corridor, path }).state;
  }
  assert.ok(d.x > 1.0, `sidestep at the head was blocked: x=${d.x.toFixed(2)}`);
});

/* ── 10. reproducibility ─────────────────────────────────────────────────── */

test('identical inputs produce identical output, bit for bit', () => {
  const script = [
    ['KeyW'], ['KeyW'], ['KeyW', 'Space'], ['KeyW'], ['KeyW'], [],
    ['KeyD'], ['Space'], ['KeyS'], [], ['Space'], [],
  ];
  const drive = () => {
    let s = createState(1.2, 0, -3.4, 0.2, 0.05);
    const out = [];
    for (let k = 0; k < 40; k++) {
      const set = script[k % script.length];
      const keys = {};
      for (const c of set) keys[KEY[c]] = true;
      s = stepMotion(s, { dt: DT, keys, groundAt: ramp }).state;
      out.push(JSON.stringify(s));
    }
    return out;
  };
  assert.deepEqual(drive(), drive());
});

/* ── 11. the step does not mutate its input ──────────────────────────────── */

test('stepMotion leaves the state it was given untouched', () => {
  const s0 = createState(2, 0, -5, 0.1, 0.02);
  s0.vx = 0.9;
  const before = cloneState(s0);
  stepMotion(s0, { dt: DT, keys: { KeyW: true, Space: true }, groundAt: ramp });
  assert.deepEqual(s0, before);
});
