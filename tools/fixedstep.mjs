// Fixed-step determinism check for World.advance(): the same World, the same input frames and the
// same total elapsed time must produce the identical final state and event stream no matter how
// the caller chunks the time. One scripted match is driven three ways — a single bulk call, frame
// by frame, and random sub/supra-tick chunks — and any divergence exits non-zero.
import { World } from '../src/sim/world.js';
import { BTN, TICK } from '../src/sim/constants.js';
import { RNG } from '../src/core/math.js';

const N = 2400; // ticks = 40 s of fight
const SEED = 7;

// Topping energy up at fixed tick indices keeps ults (and therefore beam clashes) coming. It is
// driven from inside step so it happens at the same sim tick in every chunking.
const REFILL_AT = new Set([840, 1440]);
class TestWorld extends World {
  step(inputs, dt) {
    super.step(inputs, dt);
    this.ticks = (this.ticks || 0) + 1;
    if (REFILL_AT.has(this.ticks)) for (const f of this.fighters) f.energy = 100;
  }
}

// One self-made input sequence shared by every run: walk in, force a beam clash with scripted
// mashing, then brawl on a seeded RNG (same sequence every time, no world feedback).
function makeFrames(n) {
  const rng = new RNG(0xc1a0);
  const frames = [];
  const mv = [0, 0], st = [0, 0], blk = [0, 0];
  for (let i = 0; i < n; i++) {
    const a = { fwd: 0, strafe: 0, buttons: 0 };
    const b = { fwd: 0, strafe: 0, buttons: 0 };
    if (i < 12) { a.fwd = 1; b.fwd = 1; } // close to beam-clash range, but not point blank
    if ((i >= 810 && i < 840) || (i >= 1410 && i < 1440)) { a.fwd = -1; b.fwd = -1; } // back off for the next clash
    if (i === 60 || (i >= 850 && i <= 870 && i % 4 === 0) || (i >= 1450 && i <= 1470 && i % 4 === 0)) {
      a.buttons |= BTN.ULT; b.buttons |= BTN.ULT;
    }
    if ((i >= 70 && i < 260) || (i >= 880 && i < 1060) || (i >= 1480 && i < 1660)) {
      if (i % 2 === 0) a.buttons |= BTN.LIGHT; // mash! fighter 0 taps faster than fighter 1
      if (i % 5 === 0) b.buttons |= BTN.LIGHT;
    }
    if (i > 280) {
      for (const [inp, s] of [[a, 0], [b, 1]]) {
        if (i % 20 === 0) { mv[s] = rng.range(-1, 1); st[s] = rng.range(-1, 1); }
        inp.fwd = mv[s]; inp.strafe = st[s];
        if (rng.chance(0.03)) inp.buttons |= BTN.LIGHT;
        if (rng.chance(0.012)) inp.buttons |= BTN.HEAVY;
        if (rng.chance(0.008)) inp.buttons |= BTN.S1;
        if (rng.chance(0.006)) inp.buttons |= BTN.S2;
        if (rng.chance(0.01)) inp.buttons |= BTN.DASH;
        if (rng.chance(0.006)) inp.buttons |= BTN.JUMP;
        if (rng.chance(0.008)) blk[s] = i + rng.int(8, 30);
        if (i < blk[s]) inp.buttons |= BTN.BLOCK;
      }
    }
    frames.push([a, b]);
  }
  return frames;
}

function run(frames, mode) {
  const w = new TestWorld({ chars: ['clawd', 'codex'], seed: SEED });
  for (const f of w.fighters) f.energy = 100; // the opening clash does not wait on meter gain
  w.begin();
  const events = [];
  let ticks = 0;
  const pump = (fr, dt) => {
    ticks += w.advance(fr, dt);
    for (const e of w.events) events.push(e);
    w.events.length = 0;
  };
  const total = frames.length * TICK;
  if (mode === 'bulk') {
    pump(frames, total);
  } else if (mode === 'frame') {
    for (const f of frames) pump([f], TICK);
  } else {
    // random chunks: durations are random multiples of a fraction of a tick, so sub-tick
    // remainders constantly carry over between calls
    const rng = new RNG(0x5eed);
    let i = 0, t = 0;
    while (t < total - 1e-9) {
      const chunk = Math.min(rng.range(0.3, 6.5) * TICK, total - t);
      // enqueue enough frames to cover the ticks this chunk can run, plus a lead; the queue
      // keeps any surplus in order for later ticks
      const k = Math.min(frames.length - i, Math.ceil(chunk / TICK) + 1);
      pump(frames.slice(i, i + k), chunk);
      i += k;
      t += chunk;
    }
    if (i < frames.length) pump(frames.slice(i), 0); // unreachable unless tick accounting broke
  }
  return { w, events, ticks };
}

function snapshot(w) {
  return {
    time: w.time, timeLeft: w.timeLeft, over: w.over, winner: w.winner, ticks: w.ticks,
    fighters: w.fighters.map((f) => ({
      x: f.x, y: f.y, z: f.z, vx: f.vx, vy: f.vy, vz: f.vz, yaw: f.yaw,
      hp: f.hp, energy: f.energy, stamina: f.stamina, state: f.state, st: f.st,
    })),
    projectiles: w.projectiles.length,
    zones: w.zones.length,
    clash: { on: w.clash.on, c: w.clash.c },
    rng: w.rng.s,
  };
}

const frames = makeFrames(N);
const modes = ['bulk', 'frame', 'random'];
const runs = {};
for (const m of modes) runs[m] = run(frames, m);

const count = (ev, type) => ev.filter((e) => e.type === type).length;
console.log(`fixed-step determinism: ${N} ticks (${(N * TICK).toFixed(1)}s), seed ${SEED}`);
for (const m of modes) {
  const { w, events, ticks } = runs[m];
  const [f0, f1] = w.fighters;
  console.log(
    `  ${m.padEnd(6)} ticks=${ticks} events=${events.length}` +
    ` hits=${count(events, 'hit')} clangs=${count(events, 'clang')} clashes=${count(events, 'clash_start')}` +
    ` hp=[${f0.hp.toFixed(2)}, ${f1.hp.toFixed(2)}] over=${w.over} winner=${w.winner}`,
  );
}

let fail = 0;
const base = runs.bulk;
const baseSnap = JSON.stringify(snapshot(base.w));
const baseEvents = JSON.stringify(base.events);
for (const m of ['frame', 'random']) {
  const snap = JSON.stringify(snapshot(runs[m].w));
  const ev = JSON.stringify(runs[m].events);
  if (snap !== baseSnap) {
    fail = 1;
    console.error(`MISMATCH (${m} vs bulk): final state differs`);
    console.error(`  bulk:   ${baseSnap}`);
    console.error(`  ${m}: ${snap}`);
  }
  if (ev !== baseEvents) {
    fail = 1;
    console.error(`MISMATCH (${m} vs bulk): event stream differs (${runs[m].events.length} vs ${base.events.length} events)`);
    const a = runs[m].events, b = base.events;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        console.error(`  first diff at event #${i}:`);
        console.error(`    bulk:   ${JSON.stringify(b[i])}`);
        console.error(`    ${m}: ${JSON.stringify(a[i])}`);
        break;
      }
    }
  }
}
if (fail) {
  console.error('FAIL: fixed-step advance is not chunk-invariant');
  process.exit(1);
}
console.log('OK: final state and event stream are identical across all chunkings');
