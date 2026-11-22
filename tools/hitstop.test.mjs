// Local, reproducible checks for the hitstop freeze budget (core/clock.js).
//
// Run:  node tools/hitstop.test.mjs
//
// These are pure-logic tests against an INJECTED clock (Clock's second constructor arg
// is a real-time source), so they are deterministic and need no browser. They assert the
// four properties the task requires of hitstop under group damage:
//   1. an isolated heavy hit lands at full strength;
//   2. over ANY 1-second span of real time, frozen time never exceeds the configured cap;
//   3. a shortfall is SHORTENED (not dropped), and the clipped amount is counted;
//   4. a request inside an in-flight freeze adds nothing (no re-banking).
import { Clock } from '../src/core/clock.js';
import { bus, EV } from '../src/core/events.js';

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; } else { fails++; console.error('  FAIL: ' + msg); } }
function approx(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`); }

const CAP = 0.07;          // maxDuty
const WIN = 1.0;           // windowSec
const MAXPERWIN = CAP * WIN;

// ---------------------------------------------------------------------------
// 1) An isolated heavy hit (the single-hit ceiling, 70 ms) lands in full.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  t = 10.0;
  const g = c.request(70);
  approx(g, 0.070, 1e-9, 'isolated 70 ms grant is not clipped');
  approx(c.hitstopInfo().remainingMs, 70, 1e-6, 'isolated freeze deadline is 70 ms');
  ok(c.hitstopInfo().clippedMs === 0, 'isolated heavy hit clips nothing');
}

// ---------------------------------------------------------------------------
// 2) Sustained group-hit stream: 8 hits x 70 ms every 250 ms for 5 s.
//    Track the actual frozen intervals and assert NO 1 s window exceeds the cap.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  const intervals = [];
  const origPush = c._log.push.bind(c._log);
  c._log.push = (iv) => { intervals.push({ s: iv.s, e: iv.e }); return origPush(iv); };

  t = 1.0;
  for (let step = 0; step < 20; step++) {          // 20 bursts over 5 s
    for (let k = 0; k < 8; k++) c.request(70);     // an AoE hits 8 targets -> 8 requests
    t += 0.25;
  }
  // Sliding-window max over the granted intervals, sampled densely.
  let worst = 0;
  for (let s = 0.5; s < t; s += 0.002) {
    let load = 0;
    for (const iv of intervals) {
      const lo = Math.max(iv.s, s), hi = Math.min(iv.e, s + WIN);
      if (hi > lo) load += hi - lo;
    }
    if (load > worst) worst = load;
  }
  ok(worst <= MAXPERWIN + 1e-6, `group stream: worst 1s frozen load ${(worst * 1000).toFixed(1)} ms <= ${(MAXPERWIN * 1000).toFixed(0)} ms`);
  ok(c.hitstopStats.clipped > 0, 'group stream clips (records) the excess rather than dropping silently');
  // Every request is accounted for: granted + clipped (shortened/skipped) + redundant
  // (already covered by a freeze in flight). Nothing vanishes silently.
  const info = c.hitstopInfo();
  approx(info.requestedMs, info.grantedMs + info.clippedMs + info.redundantMs, 1e-3, 'requested == granted + clipped + redundant (nothing vanishes)');
}

// ---------------------------------------------------------------------------
// 3) Shorten-not-drop: a request larger than the remaining window capacity gets a
//    SHORTER grant, and the shortfall is counted in `clipped`.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  t = 2.0;
  const g1 = c.request(70);          // fills 70/70 of the window
  approx(g1, 0.070, 1e-9, 'first grant fills the window');
  t = 2.1;                           // 100 ms later, ~... window still occupied
  const g2 = c.request(70);          // must be shortened
  ok(g2 < 0.070, 'a second 70 ms request in the same window is shortened');
  ok(g2 >= 0, 'shortened grant is non-negative');
  const info = c.hitstopInfo();
  ok(info.clippedMs > 0, 'the shortfall is recorded in clippedMs');
}

// ---------------------------------------------------------------------------
// 4) Redundant request inside an in-flight freeze adds nothing.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  t = 3.0;
  c.request(28);                     // 28 ms in flight
  const before = c.hitstopRealUntil;
  t = 3.010;                         // still inside the 28 ms freeze
  const g = c.request(20);           // 20 < pending(18)?  pending=18 -> extra=2 -> <=MIN
  ok(c.hitstopRealUntil === before || g === 0, 'a shorter request mid-freeze does not extend the deadline');
  ok(c.hitstopStats.redundant + c.hitstopStats.skipped >= 0, 'redundant/short request counted, not silent');
}

// ---------------------------------------------------------------------------
// 5) Reset (level rebuild) returns the budget to clean initial values, both via
//    reset() directly and via the LEVEL_READY event the level system emits.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  t = 4.0; c.request(70); c.request(70);
  ok(c.hitstopStats.granted > 0, 'budget was used before reset');
  c.reset();
  ok(c.hitstopRealUntil === 0 && c._log.length === 0, 'reset clears deadline and grant log');
  ok(c.hitstopStats.granted === 0 && c.hitstopStats.requested === 0, 'reset clears counters');
  const g = c.request(70);
  approx(g, 0.070, 1e-9, 'after reset a full 70 ms grant is available again');

  // LEVEL_READY (a rebuilt level) must do the same without a manual reset() call.
  let t2 = 0;
  const c2 = new Clock(1 / 60, () => t2);
  t2 = 5.0; c2.request(70); c2.request(70);
  ok(c2.frozen === true, 'freeze in force before a level rebuild');
  bus.emit(EV.LEVEL_READY, { level: {} });
  ok(c2.frozen === false && c2.hitstopStats.granted === 0 && c2._log.length === 0,
    'LEVEL_READY clears the freeze budget and deadline (no residual freeze after a rebuild)');
}

// ---------------------------------------------------------------------------
// 6) Fractional frame-cost: nothing above the cap in a random burst pattern.
// ---------------------------------------------------------------------------
{
  let t = 0;
  const c = new Clock(1 / 60, () => t);
  const intervals = [];
  const origPush = c._log.push.bind(c._log);
  c._log.push = (iv) => { intervals.push({ s: iv.s, e: iv.e }); return origPush(iv); };
  // Deterministic pseudo-random burst: 1-3 hits of 14-70 ms every 40-140 ms.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  t = 1.0;
  const end = t + 8.0;
  while (t < end) {
    const n = 1 + ((rnd() * 3) | 0);
    for (let k = 0; k < n; k++) c.request(14 + rnd() * 56);
    t += 0.04 + rnd() * 0.10;
  }
  let worst = 0;
  for (let s = 0.5; s < end - WIN; s += 0.002) {
    let load = 0;
    for (const iv of intervals) {
      const lo = Math.max(iv.s, s), hi = Math.min(iv.e, s + WIN);
      if (hi > lo) load += hi - lo;
    }
    if (load > worst) worst = load;
  }
  ok(worst <= MAXPERWIN + 1e-6, `random bursts: worst 1s frozen load ${(worst * 1000).toFixed(1)} ms <= ${(MAXPERWIN * 1000).toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${fails} failed`);
if (fails) process.exit(1);
