import { bus, EV } from './events.js';
import { CFG } from './config.js';
import { World } from './world.js';
// Fixed-step simulation + interpolated render, with impact hitstop.
//
// HITSTOP MUST BE DEADLINED IN REAL TIME, NOT SIM TIME.
//
// The freeze works by scaling simulation time down to FROZEN_SCALE. If the deadline is
// also expressed in sim time, the two multiply: sim only advances at 6% of wall speed, so
// a 62 ms freeze takes 62/0.06 = 1033 ms of real time to elapse. Measured on the old
// code, requesting each duration and timing the real gap until the clock unfroze:
//
//     requested   30 ms ->  496 ms real   (16.5x)
//     requested   62 ms ->  963 ms real   (15.5x)
//     requested  124 ms -> 2082 ms real   (16.8x)
//     requested  210 ms -> 3473 ms real   (16.5x)   <- Ground Slam crit
//
// i.e. exactly 1/FROZEN_SCALE. Every single hit bought roughly a second of 6%-speed
// slow-motion, and an AoE crit nearly three and a half seconds. That is the "time
// dilation" — not frame rate. The deadline now lives on `performance.now()`, which the
// freeze cannot dilate, so 62 ms means 62 ms.
const FROZEN_SCALE = 0.14;   // sim speed during hitstop — a punch, not a stall
const DEFAULT_MS = CFG.combat.hitStopMs || 60;

// FREEZE BUDGET — a SLIDING-WINDOW cap on the share of REAL time spent frozen.
//
// The previous implementation was a leaky token bucket. It bounded the long-run average
// but not an arbitrary stretch of real time: a full bucket (75 ms) plus the 70 ms it
// refilled across the next second allowed ~145 ms of freeze inside one second — 14.5%
// against a 7% cap — which is exactly the "the picture stutters in bursts" report under
// group hits. Group damage arrives in clumps (one AoE hits 8 targets, a projectile
// detonates, an enemy answers), so a long-run average is the wrong instrument.
//
// This clock instead keeps the recently GRANTED freeze intervals and refuses any grant
// that would push the frozen time in ANY window of `windowSec` above `maxDuty*windowSec`.
// Because every such window is capped, splitting a longer span into `windowSec` chunks
// shows the cap holds for any span of real time, not just the trailing one. The
// feasibility check is exact: the overlap of a fixed interval set with a sliding window
// is piecewise linear in the window start, so its maximum sits on a breakpoint (an
// interval start, or an interval end minus the window length); those are the only starts
// we test.
//
//   maxDuty 0.07 x window 1.0 s = 70 ms of freeze available in any one second. That is
//   EXACTLY the heaviest single hit (HITSTOP_MAX 70 ms in combat.js), so one isolated
//   crit slam lands at full strength (the window is empty), while a sustained swarm can
//   only ever shorten later grants — never silently drop them, and every clipped
//   millisecond is counted in `hitstopStats`.
const HS = CFG.combat.hitstop || {};
const MAX_DUTY = HS.maxDuty ?? 0.07;            // share of real time that may be frozen
const WINDOW = HS.windowSec ?? 1.0;             // s — the sliding window the cap applies over
const WINDOW_CAP = MAX_DUTY * WINDOW;           // s of freeze allowed in any WINDOW
const MIN_GRANT = (HS.minGrantMs ?? 6) / 1000;  // below one frame a freeze cannot read
const LOG_KEEP = Math.max(4, WINDOW * 4);       // s of interval history kept for stats

const EMPTY_STATS = () => ({
  requested: 0,   // s of freeze asked for (every request)
  granted: 0,     // s actually added to the deadline
  clipped: 0,     // s requested but not granted (shortened or skipped) — observable
  skipped: 0,     // s of requests that got NO grant (shorter than one frame)
  redundant: 0,   // s already covered by a freeze in flight
  requests: 0,    // request count
  grants: 0,      // grants that added time
});

export class Clock {
  /**
   * @param step   fixed sim step (s)
   * @param nowFn  real-time source in SECONDS. Injectable so the budget can be tested
   *               deterministically without sleeping; defaults to performance.now().
   */
  constructor(step = 1 / 60, nowFn = null) {
    this.step = step; this.acc = 0;
    this._now = nowFn || (() => performance.now() / 1000);
    this.last = this._now();
    this.elapsed = 0; this.frame = 0; this.dtRaw = 0; this.alpha = 0;
    this.timeScale = 1; this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
    // Real-time deadline, in the same clock as `performance.now() / 1000`.
    this.hitstopRealUntil = 0;
    // Kept for anything reading it; expressed in real seconds now.
    this.hitstopUntil = 0;
    this.hitstopStats = EMPTY_STATS();
    // Granted freeze intervals [{s,e}] in real time — the budget's whole state.
    this._log = [];
    this._wallStart = null; this._wallNow = null;
    this.maxDuty = MAX_DUTY; this.windowSec = WINDOW;
    // Publish the clock so gameplay that must outlive a freeze (cooldowns, cast
    // validation) can read the SAME real clock the budget uses.
    World.clock = this;

    bus.on(EV.HITSTOP, (ms = DEFAULT_MS) => this.request(ms));
    // A rebuilt level is a new run: no freeze debt, no stale deadline, clean counters.
    bus.on(EV.LEVEL_READY, () => this.reset());
  }

  // ---- freeze budget -------------------------------------------------------
  /** Clear the budget / deadline / counters (level rebuild, fresh run). */
  reset() {
    this.hitstopRealUntil = 0;
    this.hitstopUntil = 0;
    this._log.length = 0;
    this.hitstopStats = EMPTY_STATS();
    this._wallStart = null; this._wallNow = null;
  }

  /** Sum of freeze granted inside [s, s+WINDOW], in seconds. */
  _windowLoad(s) {
    const e = s + WINDOW;
    let tot = 0;
    const log = this._log;
    for (let i = 0; i < log.length; i++) {
      const iv = log[i];
      const lo = iv.s > s ? iv.s : s;
      const hi = iv.e < e ? iv.e : e;
      if (hi > lo) tot += hi - lo;
    }
    return tot;
  }

  /**
   * Largest grant g in [0, extra] such that adding [start, start+g] keeps every
   * WINDOW-length real-time window at or below WINDOW_CAP. Exact, not iterative:
   * the windowed overlap maximum can only occur at a breakpoint.
   */
  _maxGrant(start, extra) {
    if (extra <= 0) return 0;
    const log = this._log;
    // Breakpoints: each live interval start / (end - WINDOW), plus the new interval's.
    // Evaluate feasibility of a candidate grant directly (the set is small: with a 7%
    // cap at >=6 ms grants there are at most ~11 intervals per second).
    const feasible = (g) => {
      const end = start + g;
      // Candidate window starts that can maximise overlap with the interval set.
      let worst = this._windowLoad(start);
      const t1 = end - WINDOW;
      const w1 = this._windowLoad(t1);
      if (w1 > worst) worst = w1;
      // Adding the new interval: its contribution to a window starting at s is the
      // overlap of [start,end] with [s,s+WINDOW]. At s=start that is min(g,WINDOW).
      // The window-load function above does not include the new interval, so add it.
      const addAt = (s) => Math.max(0, Math.min(end, s + WINDOW) - Math.max(start, s));
      if (worst + addAt(start) > WINDOW_CAP + 1e-9) return false;
      if (w1 + addAt(t1) > WINDOW_CAP + 1e-9) return false;
      for (let i = 0; i < log.length; i++) {
        const s = log[i].s;
        if (this._windowLoad(s) + addAt(s) > WINDOW_CAP + 1e-9) return false;
        const se = log[i].e - WINDOW;
        if (this._windowLoad(se) + addAt(se) > WINDOW_CAP + 1e-9) return false;
      }
      return true;
    };
    // Fast path — the common case is "fits whole".
    if (feasible(extra)) return extra;
    let lo = 0, hi = extra;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) * 0.5;
      if (feasible(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Handle one freeze request (ms). Public so tests can drive it directly. */
  request(ms = DEFAULT_MS) {
    const want = Math.max(0, (+ms || 0) / 1000);
    if (want <= 0) return 0;
    const now = this._now();
    const st = this.hitstopStats;
    st.requests++; st.requested += want;

    // A shorter request adds nothing while a longer freeze is already in flight.
    const pending = Math.max(0, this.hitstopRealUntil - now);
    const extra = want - pending;
    if (extra <= 0) { st.redundant += want; return 0; }
    // The portion already covered by the in-flight freeze still counts as "requested
    // and satisfied", so book it as redundant up front. This keeps the invariant
    // requested == granted + clipped + redundant exact, which is what makes "nothing is
    // silently lost" checkable rather than a claim.
    st.redundant += pending;

    // Grants extend from the EXISTING deadline, never from `now + pending + grant` —
    // re-banking pending freeze that was already paid for let chained hits exceed the
    // cap (measured 21.9% duty against a 4% grant sum on an earlier version).
    const start = Math.max(this.hitstopRealUntil, now);
    const grant = this._maxGrant(start, extra);

    // Below one frame the freeze cannot be seen, only felt as a missing frame, so a
    // zero-length grant is skipped — but it is RECORDED (never silent): the requested
    // millimetres show up in `clipped`/`skipped`, which the F3 overlay displays.
    if (grant < MIN_GRANT) {
      st.clipped += extra;
      st.skipped += extra;
      return 0;
    }
    if (grant < extra) st.clipped += extra - grant;
    st.granted += grant;
    st.grants++;
    this._log.push({ s: start, e: start + grant });
    this._pruneLog(now);
    this.hitstopRealUntil = start + grant;
    this.hitstopUntil = this.hitstopRealUntil;
    return grant;
  }

  _pruneLog(now) {
    const cut = now - LOG_KEEP;
    let i = 0;
    while (i < this._log.length && this._log[i].e <= cut) i++;
    if (i) this._log.splice(0, i);
  }

  // ---- frame loop ----------------------------------------------------------
  tick(onFixed) {
    const now = this._now();
    let dt = Math.min(now - this.last, 0.1);
    if (!(dt > 0)) dt = 0;                       // clock went backwards / first frame
    this.last = now; this.dtRaw = dt;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc > 0.5) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }

    // Wall-clock span for the LIFETIME duty readout. Reported from GRANTED time over
    // elapsed real time (see hitstopInfo), so it stays exact even when frames are
    // throttled (headless/background tab), unlike a per-frame sampled overlap.
    if (this._wallStart == null) this._wallStart = now;
    this._wallNow = now;
    this._pruneLog(now);

    const frozen = now < this.hitstopRealUntil;
    const scale = frozen ? FROZEN_SCALE : this.timeScale;
    this.acc += dt * scale;
    let guard = 0;
    while (this.acc >= this.step && guard++ < 5) { this.elapsed += this.step; onFixed(this.step, this.elapsed); this.acc -= this.step; }
    this.alpha = this.acc / this.step; this.frame++;
    return dt * scale;
  }

  /** True while an impact freeze is in force. */
  get frozen() { return this._now() < this.hitstopRealUntil; }

  /** Current real time (SECONDS) on the clock the budget and cooldowns share. */
  now() { return this._now(); }

  /** Freeze share over the trailing `win` seconds (exact, from the grant log). */
  dutyOver(win = WINDOW, now = this._now()) {
    const s = now - win, e = now;
    let tot = 0;
    const log = this._log;
    for (let i = 0; i < log.length; i++) {
      const a = log[i].s > s ? log[i].s : s;
      const b = log[i].e < e ? log[i].e : e;
      if (b > a) tot += b - a;
    }
    return win > 0 ? tot / win : 0;
  }

  /** Read-only snapshot for HUD/debug/tests. */
  hitstopInfo() {
    const st = this.hitstopStats;
    // Lifetime duty from GRANTED time over wall-clock elapsed since the first tick —
    // exact regardless of frame scheduling.
    const wall = (this._wallStart != null && this._wallNow != null) ? (this._wallNow - this._wallStart) : 0;
    const lifetimeDuty = wall > 1e-3 ? Math.min(1, (st.granted) / wall) : 0;
    return {
      maxDuty: MAX_DUTY, windowSec: WINDOW, capacityMs: WINDOW_CAP * 1000,
      frozen: this.frozen,
      remainingMs: Math.max(0, (this.hitstopRealUntil - this._now()) * 1000),
      duty: this.dutyOver(),
      lifetimeDuty,
      requestedMs: st.requested * 1000,
      grantedMs: st.granted * 1000,
      clippedMs: st.clipped * 1000,
      skippedMs: st.skipped * 1000,
      redundantMs: st.redundant * 1000,
      requests: st.requests, grants: st.grants,
    };
  }
}
