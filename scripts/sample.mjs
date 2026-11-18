// Reproducible local sample.
//
// Given a fixed initial position, yaw, a per-frame mouse-displacement sequence
// and a key sequence, this prints every 128 Hz physics step: position,
// horizontal speed and grounded state. The exact same inputs are re-bucketed
// into two renderer frame rates (128 Hz and 64 Hz); both runs must produce the
// identical trajectory, which is asserted at the end.
//
// A note on the input shape and frame-rate independence: the engine splits a
// frame's mouse displacement EVENLY across every tick it drives, so a sequence
// whose per-tick mouse displacement is constant inside each frame is
// reproduced tick-for-tick at any frame rate whose frame is an integer number
// of ticks. This sample therefore uses fixed, segment-constant mouse values.
// Feedback-style re-aiming (recomputing the sweep from the current velocity
// each tick) is the advanced human technique; its per-tick gain mechanics are
// covered deterministically by test/physics.test.js (AC3b), while this sample
// stays bit-exact across rates by construction.
//
// Run:  node scripts/sample.mjs
// Outputs JSON dumps under examples/output/ plus a readable console summary.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEP_SECONDS, TICK_RATE } from '../src/constants.js';
import { framesFromTickInputs, runFrames, tickSchedule } from '../src/driver.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'examples', 'output');
mkdirSync(outDir, { recursive: true });

// --- Fixed, documented input -------------------------------------------------

const INITIAL = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  autoHop: true,
};

const KEYS = {
  none: { forward: false, back: false, left: false, right: false },
  W: { forward: true, back: false, left: false, right: false },
  D: { forward: false, back: false, left: false, right: true },
  A: { forward: false, back: false, left: true, right: false },
};

// 256 ticks = 2.0 s at 128 Hz. Every segment length is a multiple of 4 so the
// same schedule buckets cleanly into 128/64/32 Hz frames with constant held
// keys and constant per-tick mouse displacement inside each frame.
//
//  * ticks 1..31  : ground run-up holding W (reaches the 320 u/s ground cap).
//  * tick 32      : manual jump edge.
//  * ticks 33..224: airborne. Strafe key alternates every 32 ticks and the
//                   mouse sweeps in the matching direction at a fixed shallow
//                   rate (0.5 px/tick). The wish direction stays angled to the
//                   velocity, so the 30 u/s air wish cap still admits gains.
//                   Auto-hop re-jumps on each landing tick, direction untouched.
//  * ticks 225..256: no keys; the final landing settles under ground friction.
const MOUSE = 0.5;
const schedule = tickSchedule([
  { ticks: 31, keys: KEYS.W },
  { ticks: 1, keys: KEYS.W, jumpPressed: true },
  { ticks: 32, keys: KEYS.D, mouseDX: MOUSE },
  { ticks: 32, keys: KEYS.A, mouseDX: -MOUSE },
  { ticks: 32, keys: KEYS.D, mouseDX: MOUSE },
  { ticks: 32, keys: KEYS.A, mouseDX: -MOUSE },
  { ticks: 32, keys: KEYS.D, mouseDX: MOUSE },
  { ticks: 32, keys: KEYS.A, mouseDX: -MOUSE },
  { ticks: 32, keys: KEYS.none },
]);
if (schedule.length !== 256) throw new Error('sample must be exactly 256 ticks');

// Re-bucket the identical canonical schedule into two renderer rates.
const frames128 = framesFromTickInputs(schedule, 1); // 1 tick/frame -> 128 Hz
const frames64 = framesFromTickInputs(schedule, 2);  // 2 ticks/frame -> 64 Hz

// --- Runs --------------------------------------------------------------------

const run128 = runFrames(INITIAL, frames128);
const run64 = runFrames(INITIAL, frames64);

function roundRecord(r) {
  return {
    step: r.step,
    time: Number(r.time.toFixed(6)),
    position: {
      x: Number(r.position.x.toFixed(6)),
      y: Number(r.position.y.toFixed(6)),
      z: Number(r.position.z.toFixed(6)),
    },
    horizontalSpeed: Number(r.horizontalSpeed.toFixed(6)),
    yaw: Number(r.yaw.toFixed(6)),
    grounded: r.grounded,
    landed: r.landed,
    jumped: r.jumped,
  };
}

const trace128 = run128.records.map(roundRecord);
const trace64 = run64.records.map(roundRecord);
const identical = JSON.stringify(trace128) === JSON.stringify(trace64);

// --- Console summary ---------------------------------------------------------

console.log(`tick rate ${TICK_RATE} Hz, dt=${STEP_SECONDS}s, steps=${trace128.length}`);
console.log(`renderer A: 128 Hz (${frames128.length} frames, 1 tick each)`);
console.log(`renderer B:  64 Hz (${frames64.length} frames, 2 ticks each)`);
console.log(`trajectories identical: ${identical ? 'YES' : 'NO'}`);
if (!identical) process.exitCode = 1;

console.log('\nstep   time      pos(x,y,z)                                    hSpeed   grounded landed jumped');
for (const r of trace128) {
  if (r.step % 8 === 0 || r.landed || r.jumped) {
    const p = r.position;
    console.log(
      String(r.step).padStart(4),
      r.time.toFixed(4).padStart(7),
      `(${p.x.toFixed(3).padStart(9)}, ${p.y.toFixed(3).padStart(9)}, ${p.z.toFixed(3).padStart(8)})`,
      r.horizontalSpeed.toFixed(3).padStart(9),
      String(r.grounded).padEnd(8),
      String(r.landed).padEnd(6),
      String(r.jumped),
    );
  }
}

const hops = trace128.filter((r) => r.jumped).map((r) => r.step);
const landings = trace128.filter((r) => r.landed).map((r) => r.step);
const first = trace128[0];
const last = trace128[trace128.length - 1];
const peakSpeed = Math.max(...trace128.map((r) => r.horizontalSpeed));
// Count ticks where air acceleration actually added horizontal speed.
let gainingTicks = 0;
for (let i = 1; i < trace128.length; i++) {
  if (!trace128[i].grounded && trace128[i].horizontalSpeed > trace128[i - 1].horizontalSpeed + 1e-9) {
    gainingTicks++;
  }
}
console.log(`\njump ticks:    ${hops.join(', ')}`);
console.log(`landing ticks: ${landings.join(', ')}`);
console.log(`horizontal speed: ${first.horizontalSpeed.toFixed(3)} -> ${last.horizontalSpeed.toFixed(3)} u/s (peak ${peakSpeed.toFixed(3)})`);
console.log(`airborne ticks that gained horizontal speed: ${gainingTicks}`);

// --- Machine-readable dumps --------------------------------------------------

const payload = {
  initial: INITIAL,
  input: {
    tickRate: TICK_RATE,
    stepSeconds: STEP_SECONDS,
    frames128,
    frames64,
    tickSchedule: schedule,
  },
  output: {
    renderer128Hz: trace128,
    renderer64Hz: trace64,
    trajectoriesIdentical: identical,
  },
};
writeFileSync(join(outDir, 'sample-trace.json'), JSON.stringify(payload, null, 2));
writeFileSync(join(outDir, 'sample-trace-128hz.json'), JSON.stringify(trace128, null, 2));
console.log(`\nwrote ${join(outDir, 'sample-trace.json')}`);
