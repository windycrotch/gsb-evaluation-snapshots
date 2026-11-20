/**
 * Headless race-lifecycle verification.
 *
 *   npm run verify:lifecycle
 *
 * The full-race verifier (tools/race-sim.ts) proves a race can be completed.
 * This one proves the *seams between races* and the *order at the flag* are
 * sound: that the finish-settle-restart chain is explainable when several
 * events land in the same frame, that classification is a total order with no
 * gaps or ties, and that a restart cannot inherit anything from the race that
 * preceded it.
 *
 * Everything here drives the real RaceDirector, CarSim, AIController, Terrain,
 * Track and ItemField. There are no stubs: the only thing that is synthetic is
 * the *input* (a headless race is driven by the AI), and where a test needs a
 * particular race state - two cars crossing on the same frame, a player
 * retiring mid-race - it builds that state through the shipped public API and
 * then lets the real simulation run.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT, compareClassified } from '../src/sim/race';
import { AIController } from '../src/sim/ai';
import type { CarSim } from '../src/sim/car';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { ResultsData, SimEnv } from '../src/sim/types';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(46)} ${detail}`);
}

const DT = 1 / 60;

// ---- the one shared world ------------------------------------------------
// Built once: the circuit and terrain are expensive and immutable, and every
// director below runs against exactly the same track the browser does.
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);
const L = track.length;

function makeEnv(): SimEnv {
  const scene = new THREE.Scene();
  return {
    scene,
    camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000),
    terrain,
    track,
    audio: new RaceAudio(),
    dust: new Dust(scene),
    autopilot: true,
    menu: null,
  };
}

interface Director {
  d: RaceDirector;
  results: ResultsData | null;
}

function makeDirector(opts: { classifyOnPlayerFinish?: boolean; catchUp?: boolean } = {}): Director {
  const box: Director = { d: null as unknown as RaceDirector, results: null };
  const d = new RaceDirector(makeEnv(), { onResults: (r) => (box.results = r) });
  if (opts.classifyOnPlayerFinish !== undefined) d.classifyOnPlayerFinish = opts.classifyOnPlayerFinish;
  if (opts.catchUp !== undefined) d.catchUp = opts.catchUp;
  box.d = d;
  return box;
}

/** Advance until the flag falls or `maxSec` elapses. */
function runUntilResults(box: Director, maxSec: number): number {
  let t = 0;
  while (t < maxSec && box.d.state !== 'results') {
    box.d.update(DT);
    t += DT;
  }
  return t;
}

/** With classifyOnPlayerFinish off, advance until every car has taken the flag. */
function runUntilAllFinish(d: RaceDirector, maxSec: number): number {
  let t = 0;
  while (t < maxSec && !d.cars.every((c) => c.finished)) {
    d.update(DT);
    t += DT;
  }
  return t;
}

/** Advance a fixed number of seconds regardless of state. */
function advance(d: RaceDirector, sec: number): void {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) d.update(DT);
}

console.log('\n=== NOCTIS GP - race lifecycle verification ===\n');

// =========================================================================
// 1. A normal three-lap race: every car records exactly one finish time.
// =========================================================================
{
  console.log('-- 1. normal three-lap race --');
  // classifyOnPlayerFinish off so the race keeps running until the WHOLE field
  // has taken the flag. That is the only way to assert "one record per car"
  // for cars the player has not already finished ahead of.
  const box = makeDirector({ classifyOnPlayerFinish: false });
  const d = box.d;
  d.startRace();
  const t = runUntilAllFinish(d, 900);
  const cls = d.classification();

  check('race reached the flag', d.cars.every((c) => c.finished), `${f(t, 1)}s simulated, ${d.cars.filter((c) => c.finished).length}/${CAR_COUNT} finished`);
  check('every car is classified', cls.length === CAR_COUNT, `${cls.length}/${CAR_COUNT} rows`);
  check('every car finished', d.cars.every((c) => c.finished), `${d.cars.filter((c) => c.finished).length}/${CAR_COUNT} finished`);

  let exactlyOne = true;
  for (const c of d.cars) {
    if (!c.finished || c.lapTimes.length !== LAPS || c.finishTime <= 0) exactlyOne = false;
  }
  check('exactly one finish record per car', exactlyOne, 'each car: finished, 3 lap times, one finish time');

  // Finishing twice must not rewrite the record. Drive past the line again
  // after the flag and assert the timestamp is untouched.
  const finishBefore = d.cars.map((c) => c.finishTime);
  advance(d, 8);
  check('a second crossing cannot rewrite a finish', d.cars.every((c, i) => c.finishTime === finishBefore[i]),
        `times ${finishBefore.map((x) => f(x, 0)).join(',')}`);

  check('positions are a permutation of 1..N', cls.every((r, i) => r.position === i + 1), cls.map((r) => r.position).join(','));

  // Finish times must be non-decreasing down the order for finishers, i.e. the
  // classification really is sorted by the clock.
  let sorted = true;
  for (let i = 1; i < cls.length; i++) {
    const a = cls[i - 1];
    const b = cls[i];
    if (a.finished && b.finished && a.time !== null && b.time !== null && b.time < a.time) sorted = false;
  }
  check('finishers are ordered by time', sorted, `first ${f(cls[0].time ?? 0)}s, last ${f(cls[cls.length - 1].time ?? 0)}s`);
}

// =========================================================================
// 1b. The results board itself carries the whole field, once each.
// =========================================================================
{
  console.log('\n-- 1b. results board --');
  const box = makeDirector({ classifyOnPlayerFinish: true });
  const d = box.d;
  d.startRace();
  runUntilResults(box, 900);
  advance(d, 3);
  const board = box.results?.standings ?? [];
  const names = board.map((r) => r.name);
  check('results board is emitted', box.results !== null, box.results ? `${board.length} rows` : 'no onResults callback');
  check('results board is complete', board.length === CAR_COUNT, `${board.length} rows`);
  check('results board has no duplicates', new Set(names).size === names.length, `${new Set(names).size} distinct names`);
  check('every car appears exactly once', CAR_COUNT - new Set(names).size === 0, names.join(','));
  // The player's row exists even when the player did not win.
  check('player is on the board', board.some((r) => r.isPlayer), `player row at index ${board.findIndex((r) => r.isPlayer) + 1}`);
}

// =========================================================================
// 2. Several cars crossing on the SAME frame must still get distinct ranks.
// =========================================================================
{
  console.log('\n-- 2. same-frame finishes --');
  const box = makeDirector({ classifyOnPlayerFinish: false });
  const d = box.d;
  d.startRace();
  // Let the field spread out a little so this is a real race, not a grid.
  advance(d, 30);

  // Stage a genuine photo finish: put four cars just short of the line on
  // their final lap, nose to tail, and let the real physics carry them across.
  // The step that happens to carry them over the line may be the same 1/60 s
  // frame for all of them, which is exactly the case that used to tie.
  const finalLap = LAPS;
  const staged = d.cars.slice(0, 4);
  staged.forEach((c, i) => {
    const s = L - 0.6 - i * 0.15; // staggered by centimetres, all cross together
    const fr = track.frameAt(s);
    c.placeAt(fr, s, terrain);
    c.lap = finalLap - 1;
    c.cpIndex = track.checkpoints.length;
    c.totalDist = L * (finalLap - 1) + s;
    c.disabled = false;
    c.idling = false;
    // A little speed so the crossing happens inside one or two substeps.
    c.vel.set(fr.tx * 30, 0, fr.tz * 30);
  });
  advance(d, 1.5);

  const finishedNow = d.cars.filter((c) => c.finished);
  check('staged cars took the flag', staged.every((c) => c.finished), `${finishedNow.length} finishers, ${staged.filter((c) => c.finished).length} of the staged four`);

  // The critical assertion: with four cars finishing inside the same frame,
  // their finish records must be a strict total order - no shared finishTime
  // used as the only key, no two sharing a rank.
  const cls = d.classification();
  const crossTimes = staged.map((c) => +c.finishTime.toFixed(6));
  const uniqueTimes = new Set(crossTimes).size;
  const positions = cls.filter((r) => staged.some((c) => c.name === r.name)).map((r) => r.position);
  check('finish ranks are unique', new Set(positions).size === positions.length, `positions ${positions.join(',')}`);
  check('same-frame crossings are ordered', uniqueTimes === crossTimes.length || staged.every((c) => c.finishOrder > 0),
        `${uniqueTimes} distinct timestamps / ${crossTimes.length} crossings, finishOrder ${staged.map((c) => c.finishOrder).join(',')}`);

  // Each staged car's rank must match the physical crossing order: the race
  // clock first (they can cross in different substeps), then - for cars that
  // share a clock - the interpolated position within the substep. crossFrac
  // only decides anything within a single-substep tie, exactly as the
  // classifier does.
  const byRank = cls.filter((r) => staged.some((c) => c.name === r.name)).sort((a, b) => a.position - b.position);
  const byFrac = staged
    .filter((c) => c.finished)
    .slice()
    .sort((a, b) => a.finishTime - b.finishTime || a.finishCrossFrac - b.finishCrossFrac || a.finishOrder - b.finishOrder);
  check('rank follows actual crossing order', byRank.every((r, i) => r.name === byFrac[i].name),
        `ranks ${byRank.map((r) => r.name).join(' < ')} (${new Set(crossTimes).size} distinct clocks)`);

  // The classifier is a strict total order: no pair compares equal.
  let equalPair: string | null = null;
  for (let i = 0; i < d.cars.length && !equalPair; i++) {
    for (let j = i + 1; j < d.cars.length; j++) {
      if (compareClassified(d.cars[i], d.cars[j]) === 0) {
        equalPair = `${d.cars[i].name}/${d.cars[j].name}`;
        break;
      }
    }
  }
  check('classifier has no ties', equalPair === null, equalPair ?? 'every pair is strictly ordered');
}

// =========================================================================
// 2b. Two cars crossing inside the SAME physics substep share a clock. That
// is the exact case a finishTime-only sort would collapse into a tie.
// =========================================================================
{
  console.log('\n-- 2b. same-substep crossing (identical clock) --');
  const box = makeDirector({ classifyOnPlayerFinish: false });
  const d = box.d;
  d.startRace();
  advance(d, 5);

  const pair = d.cars.slice(0, 2);
  // At 1/120 s and 60 m/s a substep covers 0.5 m. Placing both cars within one
  // substep's travel of the line, 2 cm apart, makes them cross in the SAME
  // substep - so they share a race clock and only the interpolated fraction
  // can order them.
  pair.forEach((c, i) => {
    const s = L - 0.6 - i * 0.02;
    const fr = track.frameAt(s);
    c.placeAt({ ...fr, x: fr.x + fr.rx * (i === 0 ? -2 : 2), z: fr.z + fr.rz * (i === 0 ? -2 : 2) }, s, terrain);
    c.lap = LAPS - 1;
    c.cpIndex = track.checkpoints.length;
    c.totalDist = L * (LAPS - 1) + s;
    c.disabled = false;
    c.idling = false;
    c.vel.set(fr.tx * 60, 0, fr.tz * 60);
  });
  advance(d, 0.5);

  const finishedPairs = pair.filter((c) => c.finished);
  const sameClock = finishedPairs.length === 2 && finishedPairs[0].finishTime === finishedPairs[1].finishTime;
  check('the pair crosses in one substep', sameClock,
        finishedPairs.map((c) => `${c.name}:t=${f(c.finishTime, 5)}`).join(' '));

  if (sameClock) {
    // Same clock => finishCrossFrac must still separate them: the car that was
    // closer to the line crossed earlier in the substep.
    const [a, b] = finishedPairs;
    const earlier = a.finishCrossFrac < b.finishCrossFrac ? a : b;
    const later = earlier === a ? b : a;
    check('substep fraction breaks the clock tie', earlier.finishCrossFrac !== later.finishCrossFrac,
          `${earlier.name}=${f(earlier.finishCrossFrac, 4)} < ${later.name}=${f(later.finishCrossFrac, 4)}`);
    const cls = d.classification();
    const posEarlier = cls.find((r) => r.name === earlier.name)?.position ?? -1;
    const posLater = cls.find((r) => r.name === later.name)?.position ?? 999;
    check('the earlier crossing ranks ahead', posEarlier < posLater, `P${posEarlier} ${earlier.name} vs P${posLater} ${later.name}`);
    check('both still get distinct positions', posEarlier !== posLater, `${posEarlier} != ${posLater}`);
  } else {
    check('substep fraction breaks the clock tie', false, 'pair did not share a clock; cannot exercise the tie');
    check('the earlier crossing ranks ahead', false, 'not exercised');
    check('both still get distinct positions', false, 'not exercised');
  }
}

// =========================================================================
// 3. Restart: nothing from the previous race survives.
// =========================================================================
function snapshotState(d: RaceDirector): string {
  return d.cars
    .map((c) => {
      const ai = c.ai as AIController | null;
      return [
        c.name, c.lap, c.lapTimes.length, c.cpIndex, c.finished ? 1 : 0, c.retired ? 1 : 0,
        f(c.finishTime, 4), f(c.totalDist, 3), f(c.boost, 3), c.item ?? '-',
        f(c.shieldT, 3), f(c.turboT, 3), f(c.stunT, 3),
        ai ? f(ai.debugBias(), 6) : 'na',
      ].join(',');
    })
    .join('|');
}

{
  console.log('\n-- 3. restart hygiene --');
  const box = makeDirector({ classifyOnPlayerFinish: true });
  const d = box.d;
  d.startRace();
  // Race the clock until the player finishes, then let the board appear so the
  // restart is exactly the one the menu drives.
  runUntilResults(box, 900);
  advance(d, 3);

  const dirty = {
    anyFinished: d.cars.some((c) => c.finished),
    anyLaps: d.cars.some((c) => c.lapTimes.length > 0),
    bestLap: d.bestLap,
    clock: d.clock,
  };
  check('previous race left dirty state to clear', dirty.anyFinished && dirty.anyLaps && (dirty.bestLap ?? 0) > 0,
        `finished=${dirty.anyFinished}, lap times=${dirty.anyLaps}, best lap=${f(dirty.bestLap ?? 0, 1)}s`);

  d.startRace();
  const clean = {
    finished: d.cars.filter((c) => c.finished).length,
    retired: d.cars.filter((c) => c.retired).length,
    laps: d.cars.filter((c) => c.lapTimes.length > 0).length,
    cp: d.cars.filter((c) => c.cpIndex !== 0).length,
    bestLap: d.bestLap,
    clock: d.clock,
    finishTimes: d.cars.filter((c) => c.finishTime !== 0).length,
    items: d.cars.filter((c) => c.item !== null).length,
    biases: d.cars.map((c) => (c.ai as AIController).debugBias()),
  };
  check('restart clears finish flags', clean.finished === 0 && clean.finishTimes === 0, `${clean.finished} finished, ${clean.finishTimes} with a finish time`);
  check('restart clears retired flags', clean.retired === 0, `${clean.retired} retired`);
  check('restart clears laps and lap times', clean.laps === 0, `${clean.laps} cars carrying lap times`);
  check('restart clears checkpoints', clean.cp === 0, `${clean.cp} cars mid-checkpoint`);
  check('restart clears best lap and clock', clean.bestLap === null && clean.clock === 0, `bestLap=${clean.bestLap}, clock=${f(clean.clock)}s`);
  check('restart clears held items', clean.items === 0, `${clean.items} cars holding a power-up`);
  check('restart neutralises catch-up bias', clean.biases.every((b) => b === 1), clean.biases.map((b) => f(b, 3)).join(','));

  // Grid geometry must be identical to the first race's grid.
  const g0 = d.cars.map((c) => ({ name: c.name, s: c.s, totalDist: c.totalDist, grid: c.gridIndex }));
  d.startRace();
  const g1 = d.cars.map((c) => ({ name: c.name, s: c.s, totalDist: c.totalDist, grid: c.gridIndex }));
  check('restart reproduces the grid', g0.every((r, i) => r.name === g1[i].name && Math.abs(r.s - g1[i].s) < 1e-6 && r.grid === g1[i].grid),
        `${g1.length} cars, player at s=${f(g1[g1.length - 1].s, 1)}`);
}

// =========================================================================
// 4. Two rapid restarts == one restart.
// =========================================================================
{
  console.log('\n-- 4. idempotent restart --');
  const box = makeDirector({ classifyOnPlayerFinish: true });
  const d = box.d;

  // Race A, then restart once.
  d.startRace();
  runUntilResults(box, 900);
  d.startRace();
  const once = snapshotState(d);

  // Race B (let it get dirty in a different way), then restart twice in a row.
  advance(d, 40);
  d.retirePlayer();
  advance(d, 3);
  d.startRace();
  d.startRace();
  const twice = snapshotState(d);

  check('restart twice equals restart once', once === twice, once === twice ? 'identical car state after both paths' : 'state diverged');

  // And the simulation itself must then run identically from the same state.
  // Two directors started from the same fresh grid and stepped in lockstep
  // must agree exactly, which is the strongest form of "no residue". Power-ups
  // are switched off on both: the item rolls use Math.random(), so leaving them
  // on would compare two different dice rather than two states.
  const a = makeDirector({ classifyOnPlayerFinish: false }).d;
  const b = makeDirector({ classifyOnPlayerFinish: false }).d;
  for (const d2 of [a, b]) d2.items.setAiUsePolicy(() => false);
  a.startRace();
  b.startRace();
  // Dirty b with a partial race and a restart, then compare against a fresh a.
  advance(b, 25);
  b.startRace();
  let firstDiff = -1;
  for (let i = 0; i < 60 * 20; i++) {
    for (const d2 of [a, b]) {
      d2.items.reset();
      for (const c of d2.cars) c.item = null;
    }
    a.update(DT);
    b.update(DT);
    if (firstDiff < 0) {
      for (let k = 0; k < a.cars.length; k++) {
        const ca = a.cars[k];
        const cb = b.cars[k];
        if (ca.name !== cb.name || Math.abs(ca.pos.x - cb.pos.x) > 1e-9 || Math.abs(ca.totalDist - cb.totalDist) > 1e-9 || Math.abs(ca.speed - cb.speed) > 1e-9) {
          firstDiff = i;
          break;
        }
      }
    }
  }
  check('restarted race tracks a fresh race exactly', firstDiff < 0,
        firstDiff < 0 ? '20 s of lockstep at 1e-9' : `diverged at frame ${firstDiff}`);
}

// =========================================================================
// 5. Catch-up bias converges on retirement and on reset.
// =========================================================================
{
  console.log('\n-- 5. catch-up convergence --');
  // Build a race where some rivals are clearly ahead of a weak player, so
  // their bias has actually engaged and is measurably below 1.
  const box = makeDirector({ classifyOnPlayerFinish: false, catchUp: true });
  const d = box.d;
  d.items.setAiUsePolicy(() => false);
  d.startRace();
  const pa = d.player.ai as AIController;
  pa.skill = 0.85;
  pa.boldness = 0.85;
  for (let i = 0; i < 60 * 120; i++) {
    d.items.reset();
    for (const c of d.cars) c.item = null;
    d.update(DT);
  }
  const leaders = d.cars.filter((c) => c !== d.player && c.totalDist > d.player.totalDist + 200);
  const engaged = leaders.filter((c) => (c.ai as AIController).debugBias() < 0.98);
  check('catch-up engages on cars ahead of the player', engaged.length > 0,
        `${engaged.length} leaders below 0.98 (${engaged.map((c) => `${c.name}:${f((c.ai as AIController).debugBias(), 3)}`).join(' ')})`);

  // Retire the player. There is no longer a reference, so every bias must
  // converge to neutral. The director holds 'race' for finishDelay (2 s) after
  // a retirement, and catch-up is only evaluated in 'race', so the window in
  // which convergence can happen IS that delay - converge within it.
  const beforeRetire = d.cars.filter((c) => c !== d.player).map((c) => (c.ai as AIController).debugBias());
  const easedBefore = Math.min(...beforeRetire);
  d.retirePlayer();
  check('retirement is recorded', d.player.retired, 'player flagged retired');
  advance(d, 1.9);
  const afterRetire = d.cars.filter((c) => c !== d.player).map((c) => (c.ai as AIController).debugBias());
  const nearNeutral = afterRetire.every((b) => Math.abs(b - 1) <= 0.01);
  check('bias converges to neutral after retirement', nearNeutral,
        `${f(easedBefore, 3)} -> worst ${f(Math.max(...afterRetire.map((b) => Math.abs(b - 1))), 4)} from 1.0`);

  // The flag actually falls, and the field is classified with the player last.
  // This director has classifyOnPlayerFinish off, so use a fresh one to check
  // the real retirement-to-results path the menu drives.
  {
    const rb = makeDirector({ classifyOnPlayerFinish: true });
    rb.d.startRace();
    advance(rb.d, 10);
    rb.d.retirePlayer();
    runUntilResults(rb, 10);
    const row = rb.d.classification().find((r) => r.name === 'YOU');
    check('retirement reaches the results board', rb.d.state === 'results' && rb.results !== null && row?.position === CAR_COUNT,
          `state ${rb.d.state}, player P${row?.position}, ${rb.results?.standings.length ?? 0} rows`);
  }

  // The retired player must be classified last, and never appear as finished.
  const cls = d.classification();
  const playerRow = cls.find((r) => r.name === 'YOU');
  check('retired player is classified last', playerRow?.position === CAR_COUNT && playerRow?.retired === true && playerRow?.finished === false,
        `position ${playerRow?.position}, retired=${playerRow?.retired}, finished=${playerRow?.finished}`);

  // Reset path: a mid-race reset must not leave a bias pinned at an artefact.
  const box2 = makeDirector({ classifyOnPlayerFinish: false, catchUp: true });
  const d2 = box2.d;
  d2.items.setAiUsePolicy(() => false);
  d2.startRace();
  const pa2 = d2.player.ai as AIController;
  pa2.skill = 0.85;
  pa2.boldness = 0.85;
  for (let i = 0; i < 60 * 90; i++) {
    d2.items.reset();
    for (const c of d2.cars) c.item = null;
    d2.update(DT);
  }
  const before = d2.cars.filter((c) => c !== d2.player).map((c) => (c.ai as AIController).debugBias());
  d2.resetPlayer();
  // Immediately after the reset the director holds the field neutral - the
  // bias targets are 1 even though the gaps say otherwise.
  const holds = d2.cars.filter((c) => c !== d2.player && c.catchUpHoldT > 0).length;
  check('player reset holds the field neutral', holds > 0, `${holds} rivals on a settle hold`);
  const heldTargets = d2.cars.filter((c) => c !== d2.player).map((c) => (c.ai as AIController).debugBiasTarget());
  check('reset pins every bias target to 1', heldTargets.every((v) => v === 1), heldTargets.map((v) => f(v, 3)).join(','));

  // Wind past the settle window and let the bias re-converge on the new gap.
  for (let i = 0; i < 60 * 6; i++) {
    d2.items.reset();
    for (const c of d2.cars) c.item = null;
    d2.update(DT);
  }
  const after = d2.cars.filter((c) => c !== d2.player).map((c) => (c.ai as AIController).debugBias());
  const bounded = after.every((b) => b >= 0.83 && b <= 1.0);
  check('bias stays in range after a reset', bounded,
        `before [${f(Math.min(...before), 3)}..${f(Math.max(...before), 3)}] -> after [${f(Math.min(...after), 3)}..${f(Math.max(...after), 3)}]`);
  // Every bias target, post-settle, must be governed by the player's CURRENT
  // gap again rather than frozen on the pre-reset gap: the cars ahead of the
  // player are eased (target < 1) and the ones behind sit at neutral.
  const liveTargets = d2.cars
    .filter((c) => c !== d2.player)
    .map((c) => ({ ahead: c.totalDist > d2.player.totalDist, t: (c.ai as AIController).debugBiasTarget() }));
  const governed = liveTargets.every((r) => (r.ahead ? r.t <= 1 : r.t === 1));
  const anyEased = liveTargets.some((r) => r.ahead && r.t < 1);
  check('bias re-converges on the post-reset gap', governed && anyEased,
        liveTargets.map((r) => `${r.ahead ? 'A' : 'B'}${f(r.t, 3)}`).join(','));

  // A reset must not disturb the classification or resurrect a finished car's
  // state. Freeze the player's finish first, then reset and check it is inert.
  {
    const rb = makeDirector({ classifyOnPlayerFinish: false });
    rb.d.items.setAiUsePolicy(() => false);
    rb.d.startRace();
    runUntilAllFinish(rb.d, 900);
    const times = rb.d.cars.map((c) => c.finishTime);
    const order = rb.d.classification().map((r) => r.name).join(',');
    rb.d.resetPlayer();
    const afterReset = rb.d.cars.map((c) => c.finishTime);
    check('reset leaves finish records intact', times.every((x, i) => afterReset[i] === x), 'finish times unchanged');
    check('reset leaves the classification intact', rb.d.classification().map((r) => r.name).join(',') === order, 'order unchanged');
  }
}

// =========================================================================
// 6. A finished car stops taking part in the gap comparison.
// =========================================================================
{
  console.log('\n-- 6. finished cars do not distort catch-up --');
  const box = makeDirector({ classifyOnPlayerFinish: false, catchUp: true });
  const d = box.d;
  d.items.setAiUsePolicy(() => false);
  d.startRace();
  advance(d, 20);

  // Park one rival just behind the player and let it gain a real bias (it is
  // behind, so it should be neutral - instead put it ahead so it eases).
  const probe = d.cars.filter((c) => c !== d.player)[0] as CarSim;
  probe.totalDist = d.player.totalDist + 900; // well ahead: full ease
  advance(d, 3);
  const easedTarget = (probe.ai as AIController).debugBiasTarget();
  check('a leading rival is eased', easedTarget < 0.99, `target ${f(easedTarget, 3)}`);
  // Let the smoothing actually catch up to that target, so the recorded bias
  // at the flag is a genuinely eased one and the decay below is meaningful.
  advance(d, 6);
  const biasBeforeFlag = (probe.ai as AIController).debugBias();
  check('the leading rival is running eased', biasBeforeFlag < 0.95, `bias ${f(biasBeforeFlag, 3)}`);

  // Finish it through the shipped state and advance. Its target must snap back
  // to neutral, and it must not pull anyone else's gap around.
  probe.finished = true;
  probe.finishTime = d.clock;
  probe.finishCrossFrac = 0.5;
  probe.finishOrder = 1;
  advance(d, 0.1);
  const targetAfterFinish = (probe.ai as AIController).debugBiasTarget();
  check('a finished car gets a neutral bias target', targetAfterFinish === 1, `target ${f(targetAfterFinish, 3)}`);

  // Its smoothed bias must also decay towards neutral rather than staying
  // pinned at the eased pace it was holding when it crossed.
  const biasAtFlag = (probe.ai as AIController).debugBias();
  advance(d, 6);
  const biasLater = (probe.ai as AIController).debugBias();
  check('a finished car\'s bias decays to neutral', biasLater > biasAtFlag && Math.abs(biasLater - 1) < 0.01,
        `${f(biasAtFlag, 3)} -> ${f(biasLater, 3)}`);

  // With the PLAYER finished there is no reference left at all, so every
  // rival still running must be driven back to neutral. This is the case that
  // matters: a parked finisher cannot keep pulling the field's pace around.
  d.player.finished = true;
  d.player.finishTime = d.clock;
  advance(d, 0.5);
  const allNeutralTargets = d.cars.filter((c) => c !== d.player).map((c) => (c.ai as AIController).debugBiasTarget());
  check('player finish releases every rival', allNeutralTargets.every((v) => v === 1),
        allNeutralTargets.map((v) => f(v, 3)).join(','));
}

// =========================================================================
// 7. Retirement cannot be undone by later race logic, and survives a
//    countdown withdrawal.
// =========================================================================
{
  console.log('\n-- 7. retirement is final --');
  const box = makeDirector({ classifyOnPlayerFinish: false });
  const d = box.d;
  d.items.setAiUsePolicy(() => false);
  d.startRace();
  advance(d, 15);
  d.retirePlayer();
  const parked = { lap: d.player.lap, dist: d.player.totalDist, finished: d.player.finished };
  // Drive the retired player past the line by hand, through the real physics,
  // and confirm it cannot be credited with a lap or a finish.
  const fr = track.frameAt(L - 3);
  d.player.placeAt(fr, L - 3, terrain);
  d.player.lap = LAPS - 1;
  d.player.cpIndex = track.checkpoints.length;
  d.player.totalDist = L * (LAPS - 1) + (L - 3);
  d.player.vel.set(fr.tx * 40, 0, fr.tz * 40);
  advance(d, 2);
  check('a retired car cannot finish', !d.player.finished && d.player.retired, `finished=${d.player.finished}`);
  check('a retired car cannot advance laps', d.player.lap === LAPS - 1, `lap ${d.player.lap}`);
  void parked;

  // Withdrawing during the countdown must leave the car parked when the
  // lights go out, not convert it back into a driver.
  {
    const cb = makeDirector({ classifyOnPlayerFinish: true });
    cb.d.startRace();
    cb.d.retirePlayer();
    // Run past lights-out.
    advance(cb.d, 5);
    check('countdown retirement survives the start', cb.d.player.retired && cb.d.player.disabled,
          `retired=${cb.d.player.retired}, disabled=${cb.d.player.disabled}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
