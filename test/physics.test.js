// Acceptance + rule tests. Zero dependencies, runs on node --test.
//   node --test test/
//
// Covered acceptance criteria:
//   1. Same input at two different renderer frame rates -> identical trajectory.
//   2. Auto-hop off -> the landing tick does not auto-jump.
//   3. Air wish speed is truncated at 30 u/s, but real per-tick gains still
//      accumulate above 30 u/s total horizontal speed.
// Plus: fixed friction/jump order, accumulator remainder, even mouse split,
// and render interpolation never mutating the simulation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsEngine } from '../src/engine.js';
import {
  AIR_ACCELERATE,
  GROUND_FRICTION,
  GROUND_Z,
  MAX_AIR_WISH_SPEED,
  STEP_SECONDS,
  STOP_SPEED,
  TICK_RATE,
} from '../src/constants.js';
import { accelerate, airAccelerate, applyFriction, wishDirection } from '../src/physics.js';
import { framesFromTickInputs, runFrames, tickSchedule } from '../src/driver.js';

const KEYS = {
  none: { forward: false, back: false, left: false, right: false },
  W: { forward: true, back: false, left: false, right: false },
  D: { forward: false, back: false, left: false, right: true },
  A: { forward: false, back: false, left: true, right: false },
};

const INITIAL = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  autoHop: true,
};

// Deterministic bunny-hop schedule shared by the cross-rate runs.
const bhopSchedule = tickSchedule([
  { ticks: 31, keys: KEYS.W },
  { ticks: 1, keys: KEYS.W, jumpPressed: true },
  { ticks: 48, keys: KEYS.D, mouseDX: 2.0 },
  { ticks: 48, keys: KEYS.A, mouseDX: -2.0 },
  { ticks: 48, keys: KEYS.D, mouseDX: 2.0 },
  { ticks: 48, keys: KEYS.A, mouseDX: -2.0 },
  { ticks: 32, keys: KEYS.none },
]);

test('fixed step is exactly 1/128 second', () => {
  assert.equal(TICK_RATE, 128);
  assert.equal(STEP_SECONDS, 1 / 128);
});

test('AC1: identical input at 128 Hz and 64 Hz yields a bit-identical trajectory', () => {
  const a = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 1));
  const b = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 2));
  assert.equal(a.records.length, b.records.length);
  assert.equal(JSON.stringify(a.records), JSON.stringify(b.records));
});

test('AC1b: identical input at 128 Hz and 32 Hz yields a bit-identical trajectory', () => {
  const a = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 1));
  const c = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 4));
  assert.equal(JSON.stringify(a.records), JSON.stringify(c.records));
});

test('accumulator consumes whole steps and carries the remainder to the next frame', () => {
  const engine = new PhysicsEngine(INITIAL);
  // 60 Hz frame: 2.1333... ticks per frame — never an integer.
  const dt60 = 1 / 60;
  const r1 = engine.frame({ dt: dt60, keys: KEYS.none });
  assert.equal(r1.steps, 2);
  assert.ok(r1.remainder > 0 && r1.remainder < STEP_SECONDS);

  // Four frames total 8.533 ticks -> each frame drives 2, and the leftover
  // keeps accumulating until a third tick becomes affordable on the eighth.
  const r2 = engine.frame({ dt: dt60, keys: KEYS.none });
  assert.equal(r2.steps, 2);
  const r3 = engine.frame({ dt: dt60, keys: KEYS.none });
  assert.equal(r3.steps, 2);
  const r4 = engine.frame({ dt: dt60, keys: KEYS.none });
  assert.equal(r4.steps, 2);
  for (let i = 0; i < 3; i++) engine.frame({ dt: dt60, keys: KEYS.none });
  const r8 = engine.frame({ dt: dt60, keys: KEYS.none });
  assert.equal(r8.steps, 3); // catch-up tick once the remainders add up
  assert.equal(engine.stepCount, 17);
});

test('mouse displacement is split evenly across every tick a frame drives', () => {
  const engine = new PhysicsEngine(INITIAL);
  const r = engine.frame({ dt: 2 * STEP_SECONDS, mouseDX: 7, keys: KEYS.none });
  assert.equal(r.steps, 2);
  assert.equal(r.perStepMouseDX, 3.5);
  assert.equal(r.records[0].mouseDX, 3.5);
  assert.equal(r.records[1].mouseDX, 3.5);
});

test('mouse displacement in a frame that drives zero ticks is deferred, not dropped', () => {
  const engine = new PhysicsEngine(INITIAL);
  // A short frame under one tick: nothing runs, but the mouse is retained.
  const r1 = engine.frame({ dt: STEP_SECONDS * 0.25, mouseDX: 4, keys: KEYS.none });
  assert.equal(r1.steps, 0);
  const r2 = engine.frame({ dt: STEP_SECONDS * 0.9, mouseDX: 2, keys: KEYS.none });
  assert.equal(r2.steps, 1);
  // Pooled 6 px spread over the single tick that finally runs.
  assert.equal(r2.records[0].mouseDX, 6);
});

test('AC2: auto-hop on re-jumps exactly on the landing tick; off leaves the player grounded', () => {
  const schedule = tickSchedule([
    { ticks: 31, keys: KEYS.W },
    { ticks: 1, keys: KEYS.W, jumpPressed: true },
    { ticks: 100, keys: KEYS.none }, // long enough to contain the landing tick
  ]);

  const on = runFrames({ ...INITIAL, autoHop: true }, framesFromTickInputs(schedule, 1));
  const off = runFrames({ ...INITIAL, autoHop: false }, framesFromTickInputs(schedule, 1));

  const landingStep = on.records.findIndex((r) => r.landed);
  assert.ok(landingStep > 0);
  // Auto-hop on: the landing tick also jumps, and the next tick is airborne.
  assert.equal(on.records[landingStep].jumped, true);
  assert.equal(on.records[landingStep].grounded, false);
  assert.equal(on.records[landingStep + 1].grounded, false);

  // Auto-hop off: the same landing tick stays grounded with no jump; all later
  // ticks remain grounded (no key press can re-jump).
  assert.equal(off.records[landingStep].jumped, false);
  assert.equal(off.records[landingStep].grounded, true);
  assert.ok(off.records.slice(landingStep).every((r) => r.grounded));
});

test('auto-hop never changes horizontal direction or velocity on the landing tick', () => {
  const schedule = tickSchedule([
    { ticks: 31, keys: KEYS.W },
    { ticks: 1, keys: KEYS.W, jumpPressed: true },
    { ticks: 100, keys: KEYS.none }, // long enough to contain the landing tick (126)
  ]);
  const on = runFrames({ ...INITIAL, autoHop: true }, framesFromTickInputs(schedule, 1));
  const off = runFrames({ ...INITIAL, autoHop: false }, framesFromTickInputs(schedule, 1));
  const landingIdx = on.records.findIndex((r) => r.landed);
  assert.ok(landingIdx > 0);
  assert.equal(off.records[landingIdx].landed, true);
  assert.deepEqual(on.records[landingIdx].position, off.records[landingIdx].position);
  assert.deepEqual(on.records[landingIdx].velocity.x, off.records[landingIdx].velocity.x);
  assert.deepEqual(on.records[landingIdx].velocity.y, off.records[landingIdx].velocity.y);
  assert.notEqual(on.records[landingIdx].velocity.z, off.records[landingIdx].velocity.z);
});

test('AC3: air wish speed is capped at 30 u/s while real gains keep accumulating past it', () => {
  // Pure-function check of the cap semantics.
  const vel = { x: 200, y: 0 };                       // already far above 30
  const wish = wishDirection(KEYS.D, 0);             // sideways to velocity
  const before = { ...vel };
  airAccelerate(vel, wish);
  // The 30 u/s cap applies to the wish projection (head-on it would make
  // addspeed negative); sideways, addspeed stays 30 and a gain still lands.
  assert.equal(MAX_AIR_WISH_SPEED, 30);
  assert.equal(vel.x, before.x);                 // no forward/back change
  assert.ok(vel.y > 0);                          // real, uncapped magnitude gain
  assert.ok(Math.hypot(vel.x, vel.y) > 200);

  // Head-on wish: projection exceeds the cap, so nothing is added.
  const headOn = { x: 200, y: 0 };
  airAccelerate(headOn, wishDirection(KEYS.W, 0));
  assert.deepEqual(headOn, { x: 200, y: 0 });
});

test('AC3b: an engine strafe chain grows horizontal speed beyond 30 u/s tick after tick', () => {
  // Two complementary checks of the same rule.
  //
  // (a) Pure rule: starting already above 30 u/s, re-aim the wish direction to
  //     a fixed 85 deg off the velocity each tick and call airAccelerate.
  //     Every tick must gain and the total speed must keep climbing past 30.
  const theta = (85 * Math.PI) / 180;
  const pure = { x: 60, y: 0 };
  const pureStart = Math.hypot(pure.x, pure.y);
  for (let i = 0; i < 40; i++) {
    const heading = Math.atan2(pure.y, pure.x);
    const before = Math.hypot(pure.x, pure.y);
    airAccelerate(pure, {
      x: Math.cos(heading + theta),
      y: Math.sin(heading + theta),
    });
    assert.ok(Math.hypot(pure.x, pure.y) > before + 1e-12);
    assert.ok(Math.hypot(pure.x, pure.y) > MAX_AIR_WISH_SPEED);
  }
  assert.ok(Math.hypot(pure.x, pure.y) > pureStart + 5);

  // (b) Engine integration: drive PhysicsEngine one tick at a time, re-aiming
  //     yaw before each tick (the mouse sweeping to keep the strafe angled).
  //     Because each frame here drives exactly one tick, setting yaw before
  //     frame() is equivalent to the player moving the mouse that tick.
  const engine = new PhysicsEngine({
    position: { x: 0, y: 0, z: 200 },
    velocity: { x: 60, y: 0, z: 0 },
    yaw: 0,
    autoHop: false,
  });
  let grew = 0;
  for (let i = 0; i < 40; i++) {
    const heading = Math.atan2(engine.vel.y, engine.vel.x);
    // Right-strafe wish direction sits at angle (90 deg - yaw); choosing
    // yaw = 90 deg - heading - theta places it exactly theta degrees off the
    // velocity heading, i.e. just sideways where the 30 u/s wish cap still
    // permits a positive gain. Re-aiming each tick is the mouse sweep.
    engine.yaw = Math.PI / 2 - heading - theta;
    const before = Math.hypot(engine.vel.x, engine.vel.y);
    engine.frame({ dt: STEP_SECONDS, mouseDX: 0, keys: KEYS.D });
    const after = Math.hypot(engine.vel.x, engine.vel.y);
    if (after > before + 1e-12) grew++;
    assert.equal(engine.grounded, false);
    assert.ok(after > MAX_AIR_WISH_SPEED);
  }
  assert.equal(grew, 40);
});

test('friction only removes speed and never accelerates the player', () => {
  const vel = { x: 50, y: 0 };
  applyFriction(vel);
  assert.ok(vel.x > 0 && vel.x < 50);
  const tiny = { x: 0.0001, y: 0 };
  applyFriction(tiny);
  assert.ok(tiny.x >= 0);
  const stopped = { x: 0, y: 0 };
  applyFriction(stopped);
  assert.deepEqual(stopped, { x: 0, y: 0 });
});

test('friction follows the Source stop-speed formula', () => {
  const speed = 250;
  const vel = { x: speed, y: 0 };
  applyFriction(vel);
  const control = Math.max(speed, STOP_SPEED);
  const expected = speed - control * GROUND_FRICTION * STEP_SECONDS;
  assert.ok(Math.abs(vel.x - expected) < 1e-9);
});

test('fixed order: a jumping ground tick applies no friction before leaving', () => {
  // Two engines side by side: one jumps, one doesn't. The jumper keeps its full
  // horizontal speed; the non-jumper settles through friction+accel this tick.
  const jumper = new PhysicsEngine({ ...INITIAL, autoHop: false });
  const walker = new PhysicsEngine({ ...INITIAL, autoHop: false });
  // Give both some ground speed first, then let ground acceleration saturate
  // (320 u/s cap) so the walker's next tick is friction-neutral: at the cap,
  // friction's drop and ground acceleration's add exactly cancel.
  for (let i = 0; i < 128; i++) {
    jumper.frame({ dt: STEP_SECONDS, keys: KEYS.W });
    walker.frame({ dt: STEP_SECONDS, keys: KEYS.W });
  }
  const speedBefore = jumper.current.horizontalSpeed;
  assert.ok(Math.abs(walker.current.horizontalSpeed - speedBefore) < 1e-9);
  assert.ok(speedBefore > 300);

  jumper.frame({ dt: STEP_SECONDS, keys: KEYS.W, jumpPressed: true });
  walker.frame({ dt: STEP_SECONDS, keys: KEYS.W });

  assert.equal(jumper.current.jumped, true);
  assert.equal(jumper.current.grounded, false);
  // Jumping tick: no friction, no ground accel -> horizontal speed untouched.
  assert.ok(Math.abs(jumper.current.horizontalSpeed - speedBefore) < 1e-9);
  // Walker stayed grounded through the fixed friction-then-accel order; at the
  // cap the friction drop and accel add cancel, so net change is zero too.
  assert.equal(walker.current.grounded, true);
  assert.ok(Math.abs(walker.current.horizontalSpeed - speedBefore) < 1e-9);
});

test('air movement applies no friction: horizontal speed never decays in the air', () => {
  const engine = new PhysicsEngine({
    position: { x: 0, y: 0, z: 100 },
    velocity: { x: 123.456, y: 0, z: 0 },
    yaw: 0,
    autoHop: false,
  });
  for (let i = 0; i < 16; i++) engine.frame({ dt: STEP_SECONDS, keys: KEYS.none });
  assert.ok(Math.abs(engine.vel.x - 123.456) < 1e-9);
  assert.equal(engine.vel.y, 0);
});

test('gravity and the ground plane produce a deterministic flight length', () => {
  const engine = new PhysicsEngine({ ...INITIAL, autoHop: false });
  engine.frame({ dt: STEP_SECONDS, keys: KEYS.none, jumpPressed: true });
  assert.equal(engine.current.jumped, true);
  let followTicks = 0;
  while (!engine.grounded && followTicks < 200) {
    engine.frame({ dt: STEP_SECONDS, keys: KEYS.none });
    followTicks++;
  }
  // v=300, g=800 -> 2v/g = 0.75 s = 96 ticks total: the jump tick plus 95
  // follow-up ticks, with landing recorded on that final follow-up.
  assert.equal(followTicks, 94);
  assert.equal(engine.stepCount, 95);
  assert.equal(engine.pos.z, GROUND_Z);
  assert.equal(engine.vel.z, 0);
});

test('a jump press while airborne is consumed and never triggers a later jump', () => {
  const engine = new PhysicsEngine({ ...INITIAL, autoHop: false });
  engine.frame({ dt: STEP_SECONDS, keys: KEYS.none, jumpPressed: true }); // leaves ground
  engine.frame({ dt: STEP_SECONDS, keys: KEYS.none, jumpPressed: true }); // wasted in air
  // Flight plays out; on landing there must be no queued jump.
  while (!engine.grounded) engine.frame({ dt: STEP_SECONDS, keys: KEYS.none });
  const landing = engine.current;
  assert.equal(landing.jumped, false);
  assert.equal(landing.grounded, true);
  assert.equal(engine.jumpQueued, false);
});

test('render interpolation is display-only: calling renderState never changes the sim', () => {
  const engine = new PhysicsEngine(INITIAL);
  engine.frame({ dt: STEP_SECONDS * 1.5, keys: KEYS.W });
  const before = JSON.stringify(engine.current);
  for (let k = 0; k <= 10; k++) {
    const view = engine.renderState(k / 10);
    assert.ok(view.position.x >= engine.previous.position.x - 1e-12);
    assert.ok(view.position.x <= engine.current.position.x + 1e-12);
  }
  assert.equal(JSON.stringify(engine.current), before);
  assert.equal(engine.alpha, engine.accumulator / STEP_SECONDS);
});

test('wish-direction geometry: forward at yaw 0 is +x, right is +y', () => {
  assert.deepEqual(wishDirection(KEYS.W, 0), { x: 1, y: 0 });
  assert.deepEqual(wishDirection(KEYS.D, 0), { x: 0, y: 1 });
  const back = wishDirection({ ...KEYS.none, back: true }, 0);
  assert.deepEqual(back, { x: -1, y: 0 });
  assert.deepEqual(wishDirection(KEYS.A, 0), { x: 0, y: -1 });
});

test('ground acceleration saturates at the ground max wish speed', () => {
  const vel = { x: 0, y: 0 };
  const wish = { x: 1, y: 0 };
  for (let i = 0; i < 500; i++) accelerate(vel, wish, 320);
  assert.ok(vel.x <= 320 + 1e-9);
  assert.ok(vel.x > 319);
});

test('air acceleration coefficient matches the documented Source value', () => {
  assert.equal(AIR_ACCELERATE, 100);
  assert.equal(GROUND_FRICTION, 4);
});

test('the engine is deterministic: repeated identical runs match byte-for-byte', () => {
  const a = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 2));
  const b = runFrames(INITIAL, framesFromTickInputs(bhopSchedule, 2));
  assert.equal(JSON.stringify(a.records), JSON.stringify(b.records));
});
