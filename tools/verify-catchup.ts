/**
 * Headless catch-up scenario verification.
 *
 *   npm run verify:catchup
 *
 * race-sim.ts proves the catch-up system moves the macro race (a weak player
 * stays in touch). This script proves the per-car multiplier ITSELF is
 * computed from the real signed arc gap to the player in the situations that
 * used to leak stale state:
 *
 *   - direction and magnitude: a rival ahead eases off (down to -16% at
 *     700 m), a rival behind presses on (up to +5% at 700 m), and the
 *     smoothed multiplier stays inside [0.8, 1.06];
 *   - line crossing: two cars on opposite sides of the start/finish line are
 *     judged by the shortest wrapped arc distance, not the raw lap distance;
 *   - pause: the multiplier freezes while paused and keeps approaching its
 *     target smoothly after resume - no jump;
 *   - restart: a new race starts every rival's multiplier back at 1;
 *   - finish: a car that has taken the flag stops having its target rewritten.
 *
 * Everything runs through the real RaceDirector, Track, Terrain, CarSim and
 * AIController - no rendering, no DOM, no substitute physics. The only
 * artifice is `pin()`, which re-seats the player and one rival at controlled
 * arc positions each frame so the gap under test is exact; the cars are still
 * stepped by the real simulation in between.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector } from '../src/sim/race';
import { AIController } from '../src/sim/ai';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { CarSim } from '../src/sim/car';
import type { SimEnv } from '../src/sim/types';

const DT = 1 / 60;
const f = (v: number, d = 3): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(46)} ${detail}`);
}

console.log('\n=== NOCTIS GP - catch-up scenario verification ===\n');

// ---- world ---------------------------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);
const L = track.length;
console.log(`  lap length ${f(L, 0)} m\n`);

// ---- harness ---------------------------------------------------------------

/** A real director, past the countdown and into the 'race' state. */
function makeDirector(): RaceDirector {
  const env: SimEnv = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000),
    terrain,
    track,
    audio: new RaceAudio(),
    dust: new Dust(new THREE.Scene()),
    autopilot: true, // the player is driven by the same AI, so it keeps racing
    menu: null,
  };
  const d = new RaceDirector(env);
  d.startRace();
  for (let i = 0; i < 60 * 10 && d.state !== 'race'; i++) d.update(DT);
  if (d.state !== 'race') throw new Error('countdown never ended');
  return d;
}

/** The first rival and its controller. */
function subject(d: RaceDirector): { car: CarSim; ai: AIController } {
  const car = d.cars.find((c) => c !== d.player);
  if (!car || !car.ai) throw new Error('no rival on the grid');
  return { car, ai: car.ai as AIController };
}

/**
 * Re-seat a car at an exact arc position, keeping its velocity so the stuck
 * and recovery logic stays quiet. totalDist is what the catch-up math reads,
 * so it is set explicitly (placeAt would wrap it into [0, L)).
 */
function pin(car: CarSim, totalDist: number): void {
  const s = ((totalDist % L) + L) % L;
  const frame = track.frameAt(s);
  const vx = car.vel.x;
  const vy = car.vel.y;
  const vz = car.vel.z;
  car.placeAt(frame, s, terrain);
  car.vel.set(vx, vy, vz);
  car.totalDist = totalDist;
  car.lastS = s;
}

/**
 * Hold the player and the subject at exact arc positions while the real
 * simulation steps, so the signed gap under test stays exact. Items are
 * cleared: a random stun would not change the gap (both cars are pinned) but
 * there is no reason to invite noise.
 */
function runPinned(d: RaceDirector, subj: CarSim, playerDist: number, subjDist: number, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    pin(d.player, playerDist);
    pin(subj, subjDist);
    for (const c of d.cars) c.item = null;
    d.update(DT);
  }
}

const BASE = 0.3 * L; // lap-1 arc position used for the non-wrapping cases

// ---- 1. direction and magnitude -------------------------------------------
console.log('  --- direction and magnitude (smoothed multiplier after 6 s at a fixed gap) ---');
{
  const cases: { label: string; gap: number; want: number }[] = [
    { label: 'rival 700 m ahead eases off fully', gap: +700, want: 0.84 },
    { label: 'rival 1000 m ahead saturates at 700 m', gap: +1000, want: 0.84 },
    { label: 'rival 350 m ahead eases off halfway', gap: +350, want: 0.92 },
    { label: 'rival 700 m behind presses on fully', gap: -700, want: 1.05 },
    { label: 'rival 350 m behind presses on halfway', gap: -350, want: 1.025 },
  ];
  for (const c of cases) {
    const d = makeDirector();
    const { car, ai } = subject(d);
    runPinned(d, car, BASE, BASE + c.gap, 6);
    const bias = ai.debugBias();
    check(
      c.label,
      Math.abs(bias - c.want) < 0.005 && bias >= 0.8 && bias <= 1.06,
      `gap ${c.gap > 0 ? '+' : ''}${c.gap} m -> bias ${f(bias)} (target ${f(c.want)})`,
    );
  }
}

// ---- 2. start/finish line crossing -----------------------------------------
console.log('\n  --- line crossing (shortest wrapped arc distance) ---');
{
  // Rival 30 m past the line, player 40 m before it: the wrapped gap is
  // +70 m, so the rival eases only slightly. Raw lap distance would see a
  // ~L-70 m gap and saturate the effect - that is the bug this guards.
  const d1 = makeDirector();
  const s1 = subject(d1);
  runPinned(d1, s1.car, L - 40, L + 30, 6);
  const b1 = s1.ai.debugBias();
  check(
    'rival just past the line eases only slightly',
    Math.abs(b1 - 0.984) < 0.005 && b1 < 1,
    `wrapped gap +70 m -> bias ${f(b1)} (target 0.984, saturation would give 0.840)`,
  );

  // Mirror image: rival 40 m before the line, player 30 m past it.
  const d2 = makeDirector();
  const s2 = subject(d2);
  runPinned(d2, s2.car, L + 30, L - 40, 6);
  const b2 = s2.ai.debugBias();
  check(
    'rival just before the line presses only slightly',
    Math.abs(b2 - 1.005) < 0.005 && b2 > 1,
    `wrapped gap -70 m -> bias ${f(b2)} (target 1.005, saturation would give 1.050)`,
  );
}

// ---- 3. pause and resume ----------------------------------------------------
console.log('\n  --- pause and resume ---');
{
  const d = makeDirector();
  const { car, ai } = subject(d);
  // Partway through the approach to the full-ease target.
  runPinned(d, car, BASE, BASE + 700, 0.5);
  const before = ai.debugBias();
  check('multiplier is mid-approach before pausing', before < 0.95 && before > 0.84, `bias ${f(before)} on the way to 0.840`);

  d.pause();
  for (let i = 0; i < 300; i++) d.update(DT); // 5 s of paused frames
  const frozen = ai.debugBias();
  check('multiplier is frozen while paused', frozen === before, `bias ${f(frozen)} after 5 s paused (was ${f(before)})`);

  d.resume();
  pin(d.player, BASE);
  pin(car, BASE + 700);
  d.update(DT);
  const resumed = ai.debugBias();
  check(
    'resume continues smoothly, no jump',
    resumed < before && before - resumed < 0.01,
    `bias ${f(resumed)} one frame after resume (from ${f(before)})`,
  );

  runPinned(d, car, BASE, BASE + 700, 6);
  const settled = ai.debugBias();
  check('multiplier still reaches the target after resume', Math.abs(settled - 0.84) < 0.005, `bias ${f(settled)}`);
}

// ---- 4. restart --------------------------------------------------------------
console.log('\n  --- restart ---');
{
  const d = makeDirector();
  const { car, ai } = subject(d);
  runPinned(d, car, BASE, BASE + 700, 6);
  const raced = ai.debugBias();
  if (Math.abs(raced - 1) < 0.05) check('multiplier moved away from 1 during the race', false, `bias ${f(raced)}`);

  d.startRace();
  const allReset = d.cars.every((c) => c === d.player || !c.ai || (c.ai as AIController).debugBias() === 1);
  check('every rival multiplier returns to 1 on restart', allReset,
    `biases [${d.cars.filter((c) => c !== d.player).map((c) => f((c.ai as AIController).debugBias(), 2)).join(', ')}]`);

  for (let i = 0; i < 120; i++) d.update(DT); // countdown frames
  const stillReset = d.cars.every((c) => c === d.player || !c.ai || (c.ai as AIController).debugBias() === 1);
  check('no stale multiplier leaks in during the countdown', stillReset, 'all rivals still at 1.000');
}

// ---- 5. finished cars --------------------------------------------------------
console.log('\n  --- finished cars ---');
{
  const d = makeDirector();
  const { car, ai } = subject(d);
  runPinned(d, car, BASE, BASE + 700, 1);
  const atFinish = ai.debugBias();

  car.finished = true; // takes the flag while easing off ahead of the player
  // The gap then inverts: the rival ends up 700 m BEHIND the player, which
  // would command 1.05 if the car still took part in catch-up.
  runPinned(d, car, BASE + 700, BASE, 6);
  const after = ai.debugBias();
  check(
    'a finished car no longer gets its target rewritten',
    after <= atFinish && Math.abs(after - 0.84) < 0.01,
    `bias ${f(after)} (still settling on the pre-finish target 0.840, not 1.050)`,
  );
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
