/**
 * Headless lifecycle regression suite.
 *
 *   npm run verify:lifecycle
 *
 * Drives the real RaceDirector - no rendering, no DOM - through the full
 * countdown -> race -> pause -> results -> menu -> restart lifecycle, in
 * the awkward orders players actually produce: pausing mid-countdown,
 * quitting mid-race, hammering pause/resume around the flag.
 *
 * Every check here exercises the SAME public API the browser entries call
 * (startRace / pause / resume / quitToMenu / update), so a green run means
 * the Esc key, the touch pause button and the menu flows behave identically.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT } from '../src/sim/race';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { SimEnv, ResultsData } from '../src/sim/types';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(44)} ${detail}`);
}

console.log('\n=== NOCTIS GP - race lifecycle regression ===\n');

// ---- world (shared, built once) -------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

const DT = 1 / 60;

interface Harness {
  director: RaceDirector;
  results: ResultsData[];
  countdowns: (string | null)[];
  states: string[];
}

function makeHarness(autopilot = true): Harness {
  const env: SimEnv = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000),
    terrain,
    track,
    audio: new RaceAudio(),
    dust: new Dust(new THREE.Scene()),
    autopilot,
    menu: null,
  };
  const h: Harness = { director: null as unknown as RaceDirector, results: [], countdowns: [], states: [] };
  h.director = new RaceDirector(env, {
    onResults: (r) => h.results.push(r),
    onCountdown: (t) => h.countdowns.push(t),
    onStateChange: (s) => h.states.push(s),
  });
  return h;
}

const step = (h: Harness, seconds: number): void => {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) h.director.update(DT);
};

const raceToGreen = (h: Harness): void => {
  let guard = 0;
  while (h.director.state !== 'race' && guard++ < 60 * 30) h.director.update(DT);
};

// ---- 1. a normal finish pops the results board, exactly once ---------------
{
  const h = makeHarness();
  h.director.startRace();
  let t = 0;
  while (h.director.state !== 'results' && t < 600) {
    h.director.update(DT);
    t += DT;
  }
  const r = h.results[0];
  check('finish triggers the results board', h.director.state === 'results' && h.results.length === 1,
    `state=${h.director.state} after ${f(t, 1)}s, ${h.results.length} classification(s)`);
  check('results only after the full distance', h.director.player.finished && h.director.player.lap >= LAPS,
    `player lap ${h.director.player.lap}/${LAPS}, finished=${h.director.player.finished}`);
  check('classification matches the live standings', !!r && r.position === h.director.playerPosition && r.standings.length === CAR_COUNT,
    `P${r?.position} of ${r?.standings.length}`);
  // The board must not re-fire while the slow-motion roll continues.
  step(h, 5);
  check('results fire exactly once', h.results.length === 1, `${h.results.length} classification(s) after 5s more`);
}

// ---- 2. pause inside the countdown: no skipped numerals, no early start ----
{
  const h = makeHarness();
  h.director.startRace();
  step(h, 1); // 1s in: numeral 3 already shown
  const frozen = h.director.countdownT;
  const eventsBefore = h.countdowns.length;

  h.director.pause();
  check('pause from countdown is accepted', h.director.state === 'paused', `state=${h.director.state}`);
  step(h, 3);
  check('countdown value is frozen while paused', h.director.countdownT === frozen,
    `${f(frozen)}s before, ${f(h.director.countdownT)}s after 3s paused`);
  check('no countdown events while paused', h.countdowns.length === eventsBefore && h.director.state === 'paused',
    `${h.countdowns.length - eventsBefore} event(s), state=${h.director.state}`);

  h.director.resume();
  check('resume returns to the countdown', h.director.state === 'countdown', `state=${h.director.state}`);
  let t = 0;
  while (h.director.state !== 'race' && t < 10) {
    h.director.update(DT);
    t += DT;
  }
  // The remaining time must be the frozen value plus the GO hold, not less.
  check('countdown does not fast-forward after resume', h.director.state === 'race' && t > frozen + 0.4,
    `${f(t)}s to lights-out vs ${f(frozen + 0.55)}s expected`);
  const numerals = h.countdowns.filter((x): x is string => x !== null);
  check('numeral sequence is intact', numerals.join(',') === '3,2,1,GO', `[${numerals.join(',')}]`);
}

// ---- 3. pause inside the race: the clock and the sim freeze exactly --------
{
  const h = makeHarness();
  h.director.startRace();
  raceToGreen(h);
  step(h, 2);
  const clock0 = h.director.clock;
  const dist0 = h.director.player.totalDist;

  h.director.pause();
  check('pause from race is accepted', h.director.state === 'paused', `state=${h.director.state}`);
  step(h, 2);
  check('race clock is frozen while paused', h.director.clock === clock0, `${f(clock0, 3)}s vs ${f(h.director.clock, 3)}s`);
  check('cars do not move while paused', h.director.player.totalDist === dist0, 'player totalDist unchanged');

  h.director.resume();
  check('resume returns to the race', h.director.state === 'race', `state=${h.director.state}`);
  step(h, 1);
  check('race clock continues from where it stopped', Math.abs(h.director.clock - (clock0 + 1)) < 0.03,
    `${f(clock0, 3)}s -> ${f(h.director.clock, 3)}s after 1s`);
  check('the sim advances again after resume', h.director.player.totalDist > dist0, `+${f(h.director.player.totalDist - dist0, 1)} m`);
}

// ---- 4. quit to menu, then restart: nothing from the old race survives -----
{
  const h = makeHarness();
  h.director.startRace();
  const grid0 = h.director.grid();
  raceToGreen(h);
  // Dirty every kind of per-race state: laps, best lap, a live rocket, a
  // dropped peel, a carried item, spent item boxes.
  let t = 0;
  while (h.director.bestLap === null && t < 300) {
    h.director.update(DT);
    t += DT;
  }
  h.director.player.item = 'rocket';
  h.director.items.useItem(h.director.player, h.director.cars);
  h.director.player.item = 'banana';
  h.director.items.useItem(h.director.player, h.director.cars);
  step(h, 0.5);
  const dirty = h.director.items.debugCounts;
  check('the dirty race really has live hazards', dirty.rockets > 0 && dirty.peels > 0,
    `${dirty.rockets} rocket(s), ${dirty.peels} peel(s), bestLap=${h.director.bestLap === null ? 'null' : f(h.director.bestLap)}`);

  h.director.quitToMenu();
  const clean = h.director.items.debugCounts;
  check('quit clears live items and boxes', clean.rockets === 0 && clean.peels === 0 && clean.inactiveBoxes === 0,
    `rockets=${clean.rockets} peels=${clean.peels} inactiveBoxes=${clean.inactiveBoxes}`);
  check('quit clears race bookkeeping', h.director.bestLap === null && h.director.clock === 0 && h.director.finishDelay === 0,
    `bestLap=${h.director.bestLap} clock=${h.director.clock} finishDelay=${h.director.finishDelay}`);
  check('quit clears the countdown numeral', h.countdowns[h.countdowns.length - 1] === null, 'onCountdown(null) fired');
  check('menu standings are the attract pack', h.director.hudStandings().every((r) => !r.finished),
    'nobody marked finished');

  h.director.startRace();
  check('restart begins at the countdown', h.director.state === 'countdown' && h.director.countdownT > 3.8,
    `state=${h.director.state} countdownT=${f(h.director.countdownT)}`);
  const p = h.director.player;
  check('restart resets the player', p.lap === 0 && p.cpIndex === 0 && !p.finished && p.item === null && p.lapTimes.length === 0,
    `lap=${p.lap} cp=${p.cpIndex} finished=${p.finished} item=${p.item} laps=${p.lapTimes.length}`);
  check('restart resets position, best lap and progress',
    h.director.playerPosition === CAR_COUNT && h.director.bestLap === null && h.director.raceProgress === 0,
    `P${h.director.playerPosition}/${CAR_COUNT} bestLap=${h.director.bestLap} progress=${f(h.director.raceProgress, 3)}`);
  check('restart HUD shows a fresh field',
    h.director.hudStandings().every((r) => r.lap === 1 && !r.finished),
    h.director.hudStandings().map((r) => `L${r.lap}${r.finished ? 'F' : ''}`).join(','));
  const grid1 = h.director.grid();
  const sameGrid = grid1.length === grid0.length && grid1.every((c, i) => Math.abs(c.s - grid0[i].s) < 0.01 && c.name === grid0[i].name);
  check('restart produces the same clean grid', sameGrid, `${grid1.length} cars re-gridded`);
}

// ---- 5. rivals finishing must never pop results for an unfinished player ---
{
  const h = makeHarness(false); // player parked on the grid, no autopilot
  h.director.startRace();
  raceToGreen(h);
  let t = 0;
  const rivals = (): boolean => h.director.cars.filter((c) => !c.isPlayer).every((c) => c.finished);
  while (!rivals() && t < 700) {
    h.director.update(DT);
    t += DT;
  }
  check('every rival can finish without the player', rivals(), `all rivals home after ${f(t, 1)}s`);
  step(h, 10); // well past any results delay
  check('no results while the player is unfinished', h.results.length === 0 && h.director.state === 'race',
    `results=${h.results.length} state=${h.director.state} playerLap=${h.director.player.lap}`);
}

// ---- 6. hammering pause/resume: one classification, no negative delay ------
{
  const h = makeHarness();
  h.director.startRace();
  // Deterministic jitter: pause/resume every handful of frames, including
  // through the countdown, the finish delay and the flag itself.
  let t = 0;
  let minDelay = Infinity;
  let pausedFrames = 0;
  let clockWhilePaused: number | null = null;
  let pauseLeak = false;
  while (h.director.state !== 'results' && t < 800) {
    const frame = Math.round(t / DT);
    if (frame % 9 === 0 && (h.director.state === 'race' || h.director.state === 'countdown')) {
      h.director.pause();
      clockWhilePaused = h.director.clock;
    } else if (frame % 9 === 2 && h.director.state === 'paused') {
      if (h.director.clock !== clockWhilePaused) pauseLeak = true;
      h.director.resume();
    }
    h.director.update(DT);
    if (h.director.state === 'paused') pausedFrames++;
    if (h.director.player.finished) minDelay = Math.min(minDelay, h.director.finishDelay);
    t += DT;
  }
  check('race still completes under pause jitter', h.director.state === 'results', `state=${h.director.state} after ${f(t, 1)}s (${pausedFrames} paused frames)`);
  check('exactly one classification under jitter', h.results.length === 1, `${h.results.length} classification(s)`);
  check('results delay never goes negative', minDelay >= 0, `min finishDelay=${f(minDelay, 4)}s`);
  check('no time passes while paused', !pauseLeak, 'clock frozen on every paused frame');
}

// ---- 7. seeded chaos walk: any order of menu actions keeps invariants ------
{
  const h = makeHarness();
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const VALID = new Set(['attract', 'countdown', 'race', 'paused', 'results']);
  let racesStarted = 0;
  let bad = '';
  h.director.startRace();
  racesStarted++;
  for (let i = 0; i < 20000 && !bad; i++) {
    const r = rand();
    if (r < 0.012) h.director.pause();
    else if (r < 0.024) h.director.resume();
    else if (r < 0.03) h.director.quitToMenu();
    else if (r < 0.036) {
      h.director.startRace();
      racesStarted++;
      // A fresh race must be observably fresh, every single time.
      const d = h.director;
      if (d.state !== 'countdown' || d.player.lap !== 0 || d.player.finished || d.bestLap !== null || d.raceProgress !== 0) {
        bad = `restart #${racesStarted} left residue (state=${d.state} lap=${d.player.lap} bestLap=${d.bestLap})`;
        break;
      }
    }
    h.director.update(DT);
    const d = h.director;
    if (!VALID.has(d.state)) bad = `invalid state ${d.state}`;
    else if (d.state === 'results' && !d.player.finished) bad = 'results with an unfinished player';
    else if (d.state === 'countdown' && (d.countdownT < -0.6 || d.countdownT > 3.95)) bad = `countdownT out of range: ${d.countdownT}`;
    else if (d.clock < 0) bad = `negative clock ${d.clock}`;
    else if (d.finishDelay < 0) bad = `negative finishDelay ${d.finishDelay}`;
  }
  check('chaos walk keeps every invariant', bad === '', bad || `20000 frames, ${racesStarted} races started`);
  check('classifications never exceed completed races', h.results.length <= racesStarted && h.results.every(() => true),
    `${h.results.length} classification(s) across ${racesStarted} race(s)`);
  // However the walk ended, quitting and restarting must still be clean.
  h.director.quitToMenu();
  h.director.startRace();
  check('clean restart after the chaos walk', h.director.state === 'countdown' && h.director.raceProgress === 0 && h.director.bestLap === null,
    `state=${h.director.state}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
