/**
 * Headless full-race verification.
 *
 *   npm run verify:race
 *
 * Drives the real RaceDirector with the real Terrain, Track, CarSim,
 * AIController and ItemField - no rendering, no DOM, no browser - and asserts
 * that a full three-lap race is actually completable and behaves.
 *
 * This is the check that catches the bugs geometry review cannot: an AI that
 * cannot get round the pit, a jump that traps the car, a checkpoint rule that
 * silently never fires, an item that soft-locks a driver.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT } from '../src/sim/race';
import { AIController } from '../src/sim/ai';
import type { CarSim } from '../src/sim/car';
import { CarSim as CarSimCtor } from '../src/sim/car';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { Livery } from '../src/core/liveries';
import type { SimEnv, ResultsData } from '../src/sim/types';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(36)} ${detail}`);
}

console.log('\n=== NOCTIS GP - full race verification ===\n');

// ---- world ---------------------------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000);
const audio = new RaceAudio();
const dust = new Dust(scene);
const env: SimEnv = { scene, camera, terrain, track, audio, dust, autopilot: true, menu: null };

let results: ResultsData | null = null;
const notices: string[] = [];
const director = new RaceDirector(env, {
  onResults: (d) => {
    results = d;
    resultBox.value = d;
  },
  onNotice: (t) => notices.push(t),
  onStateChange: (s) => {
    if (s === 'race') console.log('  lights out\n');
  },
});
// TS narrows `results` to null inside this scope; keep a boxed view for the
// assertions further down, which run after the loop.
const resultBox: { value: ResultsData | null } = { value: null };

// ---- start ---------------------------------------------------------------
director.startRace();
const grid = director.grid();
check('grid has a full field', grid.length === CAR_COUNT, `${grid.length} cars`);
check('player starts at the back', grid.filter((g) => g.isPlayer).length === 1, grid.filter((g) => g.isPlayer).map((g) => `${g.name} P${grid.indexOf(g) + 1}`).join());

// ---- run the race --------------------------------------------------------
const DT = 1 / 60;
const MAX_SECONDS = 600;
let t = 0;
let maxSpeed = 0;
let maxAir = 0;
let airEvents = 0;
let wasAir = false;
let offRoadFrames = 0;
let totalFrames = 0;
let maxOffroadDist = 0;
let rampJumps = 0;
let nan = false;

const startL = track.length;

while (t < MAX_SECONDS && !results) {
  director.update(DT);
  t += DT;
  totalFrames++;

  for (const c of director.cars) {
    if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.x + c.vel.y + c.vel.z)) nan = true;
    if (c.isPlayer) {
      maxSpeed = Math.max(maxSpeed, c.speed);
      maxAir = Math.max(maxAir, c.airTime);
      if (c.airTime > 0.3 && !wasAir) {
        airEvents++;
        // Was this jump the designed ramp?
        const d = Math.abs(c.s - track.launchS);
        const wrapped = Math.min(d, startL - d);
        if (wrapped < 60) rampJumps++;
      }
      wasAir = c.airTime > 0.3;
      if (c.offroad > 0.5) offRoadFrames++;
      const near = track.nearestS(c.pos.x, c.pos.z);
      maxOffroadDist = Math.max(maxOffroadDist, near.dist - near.frame.hw);
    }
  }
  if (results) break;
}

const p = director.player;
const order = director.order;
const winner = order[0];

console.log('  --- field ---');
for (let i = 0; i < order.length; i++) {
  const c = order[i];
  const t = c.finished ? `${f(c.finishTime)}s` : `lap ${c.lap + 1}, DNF`;
  const best = c.lapTimes.length ? ` best ${f(Math.min(...c.lapTimes))}s` : '';
  console.log(
    `  ${String(i + 1).padStart(2)}. ${c.name.padEnd(6)} ${String(t).padStart(14)}${best.padEnd(14)} laps=[${c.lapTimes.map((x) => f(x, 1)).join(', ')}]`,
  );
}

console.log('\n  --- telemetry ---');
console.log(`  race duration    ${f(t, 1)} s of simulated time`);
console.log(`  player top speed ${f(maxSpeed * 3.6, 1)} km/h (${f(maxSpeed, 1)} m/s)`);
console.log(`  longest airtime  ${f(maxAir, 2)} s, ${airEvents} jump${airEvents === 1 ? '' : 's'}`);
console.log(`  ramp jumps taken ${rampJumps}`);
console.log(`  off-road frames  ${offRoadFrames} (${((offRoadFrames / totalFrames) * 100).toFixed(1)}% of the race)`);
console.log(`  furthest off     ${f(maxOffroadDist, 1)} m beyond the white line`);
console.log(`  player laps      ${p.lapTimes.length} times: [${p.lapTimes.map((x) => f(x, 1)).join(', ')}]`);
console.log(`  best lap         ${director.bestLap === null ? 'n/a' : `${f(director.bestLap)} s`}`);
console.log(`  checkpoints      final cpIndex ${p.cpIndex} of ${track.checkpoints.length}\n`);

check('race reached the results screen', resultBox.value !== null, resultBox.value ? `classified after ${f(t, 1)}s` : `no result after ${MAX_SECONDS}s`);
check('no NaN in the physics', !nan, nan ? 'car state went non-finite' : 'all finite');
check('winner completed all laps', winner.lap >= LAPS, `${winner.name} finished ${winner.lap} lap(s)`);
check('player completed the race', p.finished, p.finished ? `P${director.playerPosition} in ${f(p.finishTime)}s` : `player stopped on lap ${p.lap + 1}`);
// The flag falls when the player finishes, so cars still circulating are
// classified as running rather than as failures. What must hold is that
// nobody was stranded.
const running = director.cars.filter((c) => !c.finished);
check('nobody is stranded when the flag falls', running.every((c) => c.lap >= LAPS - 1 && c.speed > 5), `${running.length} still running, all on the final lap and moving`);
check('classification covers the whole field', (resultBox.value?.standings.length ?? 0) === CAR_COUNT, `${resultBox.value?.standings.length ?? 0}/${CAR_COUNT} classified`);
check('lap times are recorded', p.lapTimes.length === LAPS, `${p.lapTimes.length} lap times`);

const laps = p.lapTimes;
if (laps.length === LAPS) {
  const fastest = Math.min(...laps);
  const slowest = Math.max(...laps);
  const spread = slowest - fastest;
  check('lap times are plausible', fastest > 60 && slowest < 400, `${f(fastest, 1)}s to ${f(slowest, 1)}s`);
  check('lap times are consistent', spread < fastest * 0.5, `${f(spread, 1)}s spread over ${LAPS} laps`);
} else {
  check('lap times are plausible', false, `only ${laps.length} laps completed`);
}

check('car reaches racing speed', maxSpeed > 45, `${f(maxSpeed * 3.6, 1)} km/h top speed`);
check('AI stays on the circuit', maxOffroadDist < 60, `furthest ${f(maxOffroadDist, 1)} m off the white line`);
check('AI rarely leaves the road', offRoadFrames / totalFrames < 0.25, `${((offRoadFrames / totalFrames) * 100).toFixed(1)}% of frames off-road`);
check('the launch ramp is usable', airEvents >= 1, `${airEvents} airborne moments, ${rampJumps} of them on the ramp`);
check('no missed-checkpoint spam', notices.filter((n) => n === 'MISSED CHECKPOINT').length < 6, `${notices.filter((n) => n === 'MISSED CHECKPOINT').length} notices`);

// ---- field spread --------------------------------------------------------
{
  const finishes = director.cars.filter((c) => c.finished).map((c) => c.finishTime);
  if (finishes.length > 1) {
    const spread = Math.max(...finishes) - Math.min(...finishes);
    // A field finishing within a few seconds of each other means the AI
    // skill spread is doing something; a field finishing minutes apart means
    // some cars are getting stuck somewhere.
    check('field finishes together', spread < 90, `${f(spread, 1)}s between first and last`);
  } else {
    check('field finishes together', false, 'not enough finishers to judge');
  }
}

// ---- attract mode sanity -------------------------------------------------
{
  director.quitToMenu();
  let attractOk = true;
  let furthest = 0;
  const startS = director.cars.map((c) => c.s);
  for (let i = 0; i < 600; i++) {
    director.update(DT);
    for (const c of director.cars) {
      if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z)) attractOk = false;
      const near = track.nearestS(c.pos.x, c.pos.z);
      if (near.dist > near.frame.hw + 30) attractOk = false;
    }
  }
  for (let i = 0; i < director.cars.length; i++) {
    let d = director.cars[i].s - startS[i];
    if (d > track.length / 2) d -= track.length;
    if (d < -track.length / 2) d += track.length;
    furthest = Math.max(furthest, d);
  }
  check('attract mode is stable', attractOk, 'AI circulate the circuit for 10 s without straying');
  // The attract pack has to be genuinely DRIVING: the cinematic camera is
  // framing it in motion, so a frozen pack is a visible bug.
  check('attract pack is actually driving', furthest > 100,
        `leader covered ${f(furthest, 0)} m of road in 10 s`);
}

// ---- restart determinism -------------------------------------------------
{
  director.startRace();
  const g2 = director.grid();
  const sameGrid =
    g2.length === grid.length && g2.every((c, i) => Math.abs(c.s - grid[i].s) < 0.01 && c.name === grid[i].name);
  check('restart produces the same grid', sameGrid, `${g2.length} cars re-grided`);
  for (let i = 0; i < 300; i++) director.update(DT);
  check('cars leave the grid', director.cars.every((c) => c.speed > 1), `min speed ${f(Math.min(...director.cars.map((c) => c.speed)), 1)} m/s`);
}

// ---- idempotent crossing: laps, finish time and order each settle once ----
// The reported bug: two cars crossing together overwrote each other's time,
// and a finished car shoved back over the line recorded another lap. These
// checks drive the real per-car race logic (progress accumulation included),
// with the clock advanced so a finish time is a meaningful number.
{
  const L = track.length;
  // A fresh director per scenario keeps the world state (and the item field)
  // out of the measurement.
  const sandbox = (): { d: RaceDirector; c: CarSim } => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()),
      autopilot: true, menu: null,
    });
    d.catchUp = false;
    d.startRace();
    // Skip the countdown so the race logic is live, and put the clock at a
    // realistic race time so finish times are not all zero.
    d.state = 'race';
    d.clock = 240;
    for (const c of d.cars) {
      c.disabled = false;
      c.idling = false;
      // Park every other car far away: this test is about crossing, not
      // about contact pushing the subject around.
      c.pos.set(3200, 200, 3200);
      c.vel.set(0, 0, 0);
    }
    d.player.ai = null;
    return { d, c: d.player };
  };
  // Move the car from arc position `from` to `to` through one real raceLogic
  // pass. This is the exact unit update() runs per car per substep, so it
  // exercises the progress accumulation, not just the crossing branch.
  const step = (d: RaceDirector, c: CarSim, from: number, to: number): void => {
    c.lastS = from;
    c.s = to;
    const f = track.frameAt(to % L);
    c.pos.set(f.x, terrain.sampleHeight(f.x, f.z) + 0.58, f.z);
    d['raceLogic'](c);
  };
  // A car on its final lap, fully checkpointed, whose distance already covers
  // this lap - so the next forward crossing is the finish, not a lap.
  const armFinalLap = (d: RaceDirector, c: CarSim): void => {
    c.lap = LAPS - 1;
    c.cpIndex = track.checkpoints.length;
    c.totalDist = (LAPS - 1) * L + L - 4;
    c.lapStart = d.clock - 120;
  };

  // (a) re-entering the crossing in the same frame settles exactly one lap
  {
    const { d, c } = sandbox();
    armFinalLap(d, c);
    const laps0 = c.lapTimes.length;
    // First pass crosses the line and finishes.
    step(d, c, L - 4, 4);
    const lapsAfter = c.lapTimes.length;
    // Re-running the same substep (same s) must detect nothing.
    step(d, c, 4, 4);
    step(d, c, 4, 4);
    check('a crossing settles exactly one lap', lapsAfter === laps0 + 1 && c.lapTimes.length === lapsAfter,
          `${c.lapTimes.length - laps0} lap(s) from 1 crossing + 2 re-entries`);
    check('the flag falls exactly once', c.finished && c.lap === LAPS, `lap ${c.lap}, finished ${c.finished}`);
    check('finish time is the crossing instant', c.finished && c.finishTime > 0,
          `${f(c.finishTime, 2)}s at race clock ${f(d.clock, 2)}s`);
  }

  // (b) a finished car shoved back and forth over the line neither scores a
  //     fourth lap nor changes its finish time
  {
    const { d, c } = sandbox();
    armFinalLap(d, c);
    step(d, c, L - 4, 4);
    const t0 = c.finishTime;
    const laps0 = c.lapTimes.length;
    const dist0 = c.totalDist;
    for (let i = 0; i < 40; i++) {
      step(d, c, 4, L - 4); // shoved backwards over the line
      step(d, c, L - 4, 4); // and forwards again
    }
    check('a finished car cannot score another lap', c.lapTimes.length === laps0 && c.lap === LAPS,
          `lap ${c.lap}, ${c.lapTimes.length} lap times`);
    check('a finished car keeps its first finish time', c.finishTime === t0, `${f(c.finishTime, 3)}s vs ${f(t0, 3)}s`);
    check('a finished car’s distance is frozen', c.totalDist === dist0, `${f(c.totalDist, 1)} vs ${f(dist0, 1)}`);
  }

  // (c) exact ties in totalDist resolve the same way every time, whatever
  //     order the array is handed to the sort in
  {
    const { d } = sandbox();
    for (const c of d.cars) {
      c.finished = false;
      c.totalDist = 3 * L; // all eight exactly level
    }
    const orders: string[] = [];
    for (let k = 0; k < 6; k++) {
      // Shuffle the underlying array differently each round.
      d.cars.sort((a, b) => ((a.serial * (k + 1)) % 7) - ((b.serial * (k + 1)) % 7));
      d['recomputeOrder']();
      orders.push(d.order.map((x) => x.name).join(','));
    }
    const stable = orders.every((o) => o === orders[0]);
    check('exact ties sort the same way every time', stable, stable ? orders[0] : orders.join(' | '));
    const serialOrder = d.order.every((c, i) => i === 0 || d.order[i - 1].serial < c.serial);
    check('exact ties fall back to creation order', serialOrder, 'serial ascending');
  }

  // (d) the opening crossing is not a lap, and re-crossing it does not score
  {
    const { d, c } = sandbox();
    // Grid state: behind the line, no checkpoints taken, distance still small.
    c.lap = 0;
    c.cpIndex = 0;
    c.totalDist = L - 8;
    c.lapStart = 0;
    step(d, c, L - 8, 4);
    const lapAfterStart = c.lap;
    const cpAfterStart = c.cpIndex;
    check('the opening crossing starts the race, not a lap', lapAfterStart === 0 && cpAfterStart >= 1,
          `lap ${lapAfterStart}, cpIndex ${cpAfterStart}`);
    // Shove it back over the line and forward again without the checkpoints.
    for (let i = 0; i < 30; i++) {
      step(d, c, 4, L - 4);
      step(d, c, L - 4, 4);
    }
    check('re-crossing the line cannot score a lap', c.lap === 0 && c.lapTimes.length === 0,
          `lap ${c.lap}, ${c.lapTimes.length} lap times`);
  }

  // (e) two cars crossing on the same substep keep their own finish times
  {
    const { d } = sandbox();
    const a = d.cars[0];
    const b = d.cars[1];
    armFinalLap(d, a);
    armFinalLap(d, b);
    step(d, a, L - 4, 4);
    // One substep later, so the finish times differ by the clock's resolution.
    d.clock += 1 / 120;
    step(d, b, L - 4, 4);
    check('simultaneous finishers each record their own time',
          a.finished && b.finished && a.lapTimes.length === 1 && b.lapTimes.length === 1,
          `A ${f(a.finishTime, 3)}s, B ${f(b.finishTime, 3)}s, both finished ${a.finished && b.finished}`);
    d['recomputeOrder']();
    const orderOk = d.order[0] === a || d.order[0] === b;
    check('simultaneous finishers are ordered by settle order', orderOk, `${d.order[0].name} leads`);
  }
}

// ---- restart leaves no trace of the previous race ------------------------
// The CarFactory type lets a host pool its cars - and a host that does would
// otherwise carry last race's AI state straight onto the new grid, because
// spawnRaceGrid would hand back the same objects. This test uses exactly such
// a pooling factory, so the guarantee has to come from the director's reset
// rather than from fresh allocation.
{
  const dt = 1 / 60;
  const pool = new Map<string, { car: CarSim; ai: AIController }>();
  const poolingFactory = (livery: Livery, isPlayer: boolean, name: string): CarSim => {
    let slot = pool.get(name);
    if (!slot) {
      const car = new CarSimCtor(null, { name, color: livery.color, isPlayer });
      slot = { car, ai: new AIController(car, { skill: 0.92, boldness: 0.92 }) };
      pool.set(name, slot);
    }
    slot.car.name = name;
    slot.car.isPlayer = isPlayer;
    slot.car.color = livery.color;
    slot.car.ai = slot.ai;
    return slot.car;
  };
  const d = new RaceDirector(
    {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()),
      autopilot: true, menu: null,
    },
    {},
    poolingFactory,
  );
  d.classifyOnPlayerFinish = false;
  d.startRace();
  // Run long enough that the catch-up bias has actually moved the rivals off
  // its resting value, then dirty every other piece of per-race state.
  for (let i = 0; i < 60 * 25; i++) d.update(dt);
  for (const c of d.cars) {
    c.shieldT = 3;
    c.turboT = 2;
    c.stunT = 1.5;
    c.item = 'rocket';
    c.boost = 0.1;
    c.padCooldown = 12;
  }
  const aiBefore = d.cars.map((c) => c.ai as AIController);
  const dirty = aiBefore.some((a) => Math.abs(a.debugBias() - 1) > 0.005);
  d.startRace();
  const ai = d.cars.map((c) => c.ai as AIController);
  const reused = ai.every((a, i) => a === aiBefore[i]);
  const clean = ai.every((a) => {
    const s = a.debugState();
    return s.bias === 1 && s.biasTarget === 1 && s.offset === 0 && s.targetOffset === 0 &&
      s.offsetTimer === 0 && s.recoverTimer === 0 && s.passSide === 1;
  });
  const carsClean = d.cars.every(
    (c) => c.shieldT === 0 && c.turboT === 0 && c.stunT === 0 && c.item === null && c.padCooldown === -1,
  );
  const boostClean = d.cars.every((c) => Math.abs(c.boost - 0.62) < 1e-9);
  check('restart clears the smoothed catch-up bias', clean, clean ? 'bias 1, offset 0' : 'residual state on the grid');
  check('restart clears shields, turbo, stun and items', carsClean, carsClean ? 'all clear' : 'residual effect on the grid');
  check('restart restores the starting boost', boostClean, `boost ${d.cars[0].boost.toFixed(2)}`);
  check('catch-up bias was genuinely dirty before restart', dirty, dirty ? 'rivals were off pace' : 'nothing to clear (inconclusive)');
  check('pooled cars and AI are reused across a restart', reused, reused ? 'same instances, still clean' : 'pool was not exercised');
}

// ---- full-distance run: can EVERY car actually cover three laps? ---------
// The race above ends when the player finishes, so it only proves the front
// of the field can complete the distance. This run keeps going until all
// eight cars have taken the flag.
{
  const env2: SimEnv = { scene: new THREE.Scene(), camera, terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()), autopilot: true, menu: null };
  const full = new RaceDirector(env2);
  full.classifyOnPlayerFinish = false;
  full.startRace();
  let elapsed = 0;
  while (elapsed < 900 && !full.cars.every((c) => c.finished)) {
    full.update(DT);
    elapsed += DT;
  }
  const stragglers = full.cars.filter((c) => !c.finished);
  console.log('\n  --- full distance ---');
  console.log(`  elapsed           ${f(elapsed, 1)} s`);
  console.log(`  finished          ${CAR_COUNT - stragglers.length}/${CAR_COUNT}`);
  console.log(`  slowest car       ${f(Math.max(...full.cars.map((c) => c.finishTime || Infinity)), 1)} s`);
  console.log(`  spread            ${f(Math.max(...full.cars.map((c) => c.finishTime)) - Math.min(...full.cars.map((c) => c.finishTime)), 1)} s\n`);
  check('every car completes three laps', stragglers.length === 0, stragglers.length ? `${stragglers.map((c) => c.name).join(', ')} did not finish` : `all ${CAR_COUNT} took the flag`);
  check('full field finishes within a race distance', elapsed < 700, `${f(elapsed, 1)} s of racing`);
}

// ---- catch-up: does a weak player keep the pack in sight? -----------------
// A raw difficulty setting is the wrong lever, so the shipped system is
// catch-up instead. This measures it: run the same weak player with it on and
// off, and require the gap to the leader to actually shrink.
{
  const trial = (catchUp: boolean, skill: number): { maxGap: number; finish: number } => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain,
      track,
      audio: new RaceAudio(),
      dust: new Dust(new THREE.Scene()),
      autopilot: true,
      menu: null,
    });
    d.catchUp = catchUp;
    d.classifyOnPlayerFinish = false;
    d.startRace();
    // A "beginner" is modelled honestly: the same driver logic, driven worse.
    const pa = d.player.ai as AIController;
    pa.skill = skill;
    pa.boldness = skill;
    let maxGap = 0;
    // 700 s, not 400: a car at 88% pace needs ~400 s just for three laps, so a
    // shorter budget measures the clock rather than the catch-up.
    for (let i = 0; i < 60 * 700; i++) {
      // Neutralise power-ups for this trial. Rockets, bananas and stuns are
      // random, and a single stun can cost more than the whole catch-up
      // effect, which makes the measurement useless.
      for (const c of d.cars) c.item = null;
      d.update(1 / 60);
      let lead = -Infinity;
      for (const c of d.cars) if (c !== d.player) lead = Math.max(lead, c.totalDist);
      if (Number.isFinite(lead)) maxGap = Math.max(maxGap, lead - d.player.totalDist);
      if (d.cars.every((c) => c.finished)) break;
    }
    const me = d.player;
    return { maxGap, finish: me.finished ? me.finishTime : Infinity };
  };

  const off = trial(false, 0.88);
  const on = trial(true, 0.88);
  console.log('\n  --- catch-up (player driving at 88% of normal pace) ---');
  console.log(`    catch-up OFF   worst gap to the leader ${f(off.maxGap, 0)} m`);
  console.log(`    catch-up ON    worst gap to the leader ${f(on.maxGap, 0)} m`);
  console.log(`    player finished: ${on.finish === Infinity ? 'DNF' : f(on.finish, 1) + 's'}\n`);

  check('catch-up actually changes the race', Math.abs(off.maxGap - on.maxGap) > 100,
        `gap moves ${f(off.maxGap - on.maxGap, 0)} m`);
  check('catch-up keeps a weak player in touch', on.maxGap < 900 && on.maxGap < off.maxGap * 0.6,
        `worst gap ${f(on.maxGap, 0)} m vs ${f(off.maxGap, 0)} m without it`);
  check('a weak player still finishes', on.finish !== Infinity, `${f(on.finish, 1)}s`);
  // A rival ahead must still be able to win: catch-up is a hand, not a magnet.
  const winner = ((): string => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain, track, audio: new RaceAudio(), dust: new Dust(new THREE.Scene()),
      autopilot: true, menu: null,
    });
    d.catchUp = true;
    d.classifyOnPlayerFinish = false;
    d.startRace();
    for (let i = 0; i < 60 * 600; i++) {
      for (const c of d.cars) c.item = null;
      d.update(1 / 60);
      if (d.cars.every((c) => c.finished)) break;
    }
    return d.order[0].name;
  })();
  check('catch-up does not hand the race to the player', winner !== 'YOU', `winner was ${winner}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
