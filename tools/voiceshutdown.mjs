/* Offline lifecycle contract for the two event voices.
 *
 * What this proves, and why it does not need a browser.
 *
 * The bug is a lifecycle bug, not a timbre bug: a one-shot source outliving
 * the race or the voice that started it. Whether a bark sounds right is a
 * question for tools/audio.mjs, which renders real Web Audio in Chromium.
 * Whether a bark is STOPPED and DISCONNECTED when it should be is a question
 * about which calls were made, and that can be answered against a fake
 * AudioContext that records every connection, every source start/stop and a
 * value-at-time model for AudioParams — all driven by an explicit fake clock
 * the test advances by hand. No sound card, no browser, no wall time, and it
 * runs anywhere Node runs.
 *
 * The fake graph is deliberately minimal but behaviourally honest in the four
 * ways the contract relies on:
 *
 *   1. Nodes remember their connections and disconnect() really removes them,
 *      so "no residual connection" is directly assertable.
 *   2. Scheduled sources carry start/stop times; advancing the clock fires
 *      their onended at the stop time, exactly as the real queue does.
 *   3. AudioParams store their automation events and answer valueAt(t), so the
 *      boost motor's decay against the physics timer can be measured.
 *   4. stop() on a source already stopped throws, matching the spec — the
 *      production code is expected to swallow that.
 *
 * Four scenarios, the four the brief names: a normal gearchange (including
 * the idle-off-throttle near-silence rule), bark and boost ignition firing on
 * top of each other, events attempted after dispose, and a restart in which
 * the old voice must not pollute the new one — plus the boost motor's
 * boostTimer decay and a shift landing mid-boost, since those own the
 * "neither side swallows the other's stop logic" requirement.
 *
 *   node tools/voiceshutdown.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { EngineVoice } = await import(pathToFileURL(path.join(ROOT, 'src/audio/engine.js')).href);
const { FeedbackVoices } = await import(pathToFileURL(path.join(ROOT, 'src/audio/feedback.js')).href);

/* ------------------------------------------------------------------ */
/* Fake AudioParam                                                     */
/* ------------------------------------------------------------------ */
class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
    this.cancelledAt = null;
    /* AudioParams are legal connection destinations; keep an input list so
       the graph walks and the orphan checks see them. */
    this.inputs = [];
    this.isParam = true;
  }
  _push(kind, time, args) {
    if (this.cancelledAt != null && time < this.cancelledAt) return;
    this.events.push({ kind, time, args });
  }
  setValueAtTime(v, t) { this._push('set', t, [v]); return this; }
  linearRampToValueAtTime(v, t) { this._push('linear', t, [v]); return this; }
  exponentialRampToValueAtTime(v, t) { this._push('exponential', t, [v]); return this; }
  setTargetAtTime(v, t, tau) { this._push('target', t, [v, t, tau]); return this; }
  cancelScheduledValues(t) {
    this.cancelledAt = t;
    this.events = this.events.filter(e => e.time < t);
    return this;
  }
  /** The value at the most recent scheduled instant — where a voice driven by
      per-frame update() calls has actually brought the parameter. */
  latest() {
    if (!this.events.length) return this.value;
    return this.valueAt(Math.max(...this.events.map(e => e.time)));
  }
  /**
   * Replay the automation up to time `t`. Each event is evaluated over the
   * interval from its own time to the next event:
   *   - setTargetAtTime is the real exponential approach
   *     v(t) = target + (v0 - target) * exp(-(t-t0)/tau), which is what the
   *     boost motor's decay rides;
   *   - setValueAtTime jumps;
   *   - the ramps interpolate linearly or exponentially to their end value.
   */
  valueAt(t) {
    let v = this.value;
    /* Events accumulate one per update() on several different params, so
       they are not guaranteed to arrive in time order — replay a sorted
       copy, which is the order a real AudioContext executes its queue.
       setTargetAtTime events compose: each one starts the exponential from
       wherever the previous event actually left the parameter. */
    const evs = [...this.events].sort((a, b) => a.time - b.time);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.time > t) break;
      const next = evs[i + 1];
      /* A target keeps approaching until the NEXT event, not until t on its
         own — the following event's start value is the point this one
         reached. The final event runs out to the query time. */
      const until = next ? Math.min(next.time, t) : t;
      if (e.kind === 'set') v = e.args[0];
      else if (e.kind === 'target') {
        const target = e.args[0];
        const tau = e.args[2];
        v = target + (v - target) * Math.exp(-(until - e.time) / tau);
      } else {
        const tEnd = next ? next.time : e.time;
        const k = tEnd > e.time ? Math.max(0, Math.min(1, (until - e.time) / (tEnd - e.time))) : 1;
        v = e.kind === 'linear'
          ? v + (e.args[0] - v) * k
          : v * Math.pow(e.args[0] / Math.max(1e-12, v), k);
      }
    }
    return v;
  }
}

/* ------------------------------------------------------------------ */
/* Fake nodes and sources                                              */
/* ------------------------------------------------------------------ */
let NODE_ID = 0;

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = ++NODE_ID;
    this.outputs = [];          // { node, output, input }
    this.inputs = [];           // { node, output, input }
    this.disconnected = false;
    ctx.nodes.add(this);
  }
  connect(dest, output = 0, input = 0) {
    this.outputs.push({ node: dest, output, input });
    dest.inputs.push({ node: this, output, input });
    return dest;
  }
  disconnect(...args) {
    this.disconnected = true;
    if (!args.length) {
      for (const o of this.outputs) {
        o.node.inputs = o.node.inputs.filter(c => c.node !== this);
      }
      this.outputs = [];
      return;
    }
    const dest = args[0];
    this.outputs = this.outputs.filter(o => o.node !== dest);
    if (dest) dest.inputs = dest.inputs.filter(c => c.node !== this);
  }
}

class FakeGain extends FakeNode {
  constructor(ctx) { super(ctx, 'gain'); this.gain = new FakeParam(1); }
}
class FakeBiquad extends FakeNode {
  constructor(ctx) {
    super(ctx, 'biquad');
    this.type = 'lowpass';
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
    this.gain = new FakeParam(0);
  }
}
class FakeWaveShaper extends FakeNode {
  constructor(ctx) { super(ctx, 'shaper'); this.curve = null; this.oversample = 'none'; }
}
class FakePeriodicWave {
  constructor(real, imag) { this.real = real; this.imag = imag; }
}

class FakeSource extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.stopped = false;
    this.startTime = null;
    this.stopTime = null;
    this.onended = null;
    this.playbackRate = new FakeParam(1);
    this.detune = new FakeParam(0);
    this.frequency = new FakeParam(440);
    this.type = '';
    this.buffer = null;
    this.loop = false;
    ctx.sources.add(this);
  }
  start(when = 0, offset = 0) {
    if (this.started) throw new Error('FakeSource: start() called twice');
    this.started = true;
    this.startTime = when;
    this.offset = offset;
  }
  setPeriodicWave(wave) { this.periodicWave = wave; }
  stop(when = 0) {
    /* Withdraw any queued natural-end event first, even on the double-stop
       path: the production code is allowed to call stop() on a source whose
       envelope already ended, and neither call may leave an onended for the
       clock to run into a torn-down graph. */
    this.ctx._pending = this.ctx._pending.filter(p => p.src !== this);
    if (this.stopped) throw new Error('FakeSource: stop() called twice');
    this.stopped = true;
    this.stopTime = when;
    /* A source left to run out naturally queues an onended; a teardown stop
       that lands before the stop time takes ownership of the disconnect
       instead, so the clock gets nothing to fire. */
    if (when > this.ctx.currentTime) this.ctx._scheduleEnd(this);
  }
}

/* ------------------------------------------------------------------ */
/* Fake context: node factory, short self-made buffer, fake clock      */
/* ------------------------------------------------------------------ */
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._ch = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(ch) { return this._ch[ch]; }
}

class FakeContext {
  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.nodes = new Set();
    this.sources = new Set();
    this._pending = [];        // { at, src }
  }
  createGain() { return new FakeGain(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createWaveShaper() { return new FakeWaveShaper(this); }
  createBufferSource() { return new FakeSource(this, 'buffer-source'); }
  createOscillator() { return new FakeSource(this, 'oscillator'); }
  createPeriodicWave(real, imag) { return new FakePeriodicWave(real, imag); }
  /* A short, self-made buffer: half a second of deterministic white noise.
     Seeded mulberry32 in the spirit of src/audio/noise.js, but written here
     so the harness has zero dependency on the code it is testing. */
  createBuffer(channels, length, sampleRate) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  makeNoiseBuffer(seconds = 0.5, seed = 4711) {
    const n = Math.floor(seconds * this.sampleRate);
    const buf = this.createBuffer(1, n, this.sampleRate);
    const d = buf.getChannelData(0);
    let a = seed >>> 0;
    for (let i = 0; i < n; i++) {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    }
    return buf;
  }
  _scheduleEnd(src) { this._pending.push({ at: src.stopTime, src }); }
  /** Advance the fake clock, firing onended for sources whose stop time has
      arrived — the harness's substitute for the render queue. */
  advance(dt) {
    this.currentTime += dt;
    const due = this._pending.filter(p => p.at <= this.currentTime);
    this._pending = this._pending.filter(p => p.at > this.currentTime);
    for (const { src } of due) {
      const cb = src.onended;
      src.onended = null;
      if (cb) cb();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Assertion plumbing                                                  */
/* ------------------------------------------------------------------ */
let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) { console.log('    ✓ ' + msg); }
  else { failures++; console.log('    ✗ ' + msg); }
};
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${a}, want ${b})`);
const section = (name) => console.log('\n  ' + name);

/** Nodes reachable by following live connections DOWNSTREAM from `root`. */
function reachable(root) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n) || n.disconnected) return;
    seen.add(n);
    for (const o of n.outputs) walk(o.node);
  };
  walk(root);
  return seen;
}

/**
 * Every node upstream of `root` that can still reach it through live
 * connections — the direction a source actually flows. Used to prove the
 * car bus still has a working graph feeding it after a restart, and none at
 * all after a dispose.
 */
function feeding(root) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n) || n.disconnected) return;
    seen.add(n);
    for (const c of n.inputs || []) walk(c.node);
  };
  walk(root);
  return seen;
}

const buildPair = (ctx) => {
  const white = ctx.makeNoiseBuffer(0.5);
  const carBus = ctx.createGain();
  const hitBus = ctx.createGain();
  const engine = new EngineVoice(ctx, carBus, { white }, 91);
  const feedback = new FeedbackVoices(ctx, carBus, hitBus, { white }, 1207);
  return { ctx, white, carBus, hitBus, engine, feedback };
};

const IDLE = 1050 / 7400;
const H = 1 / 60;

/* ================================================================== */
/* Scenario 1 — a normal gearchange, and the idle near-silence rule    */
/* ================================================================== */
section('1. normal gearchange: bark starts, ends, and is reaped');
{
  const ctx = new FakeContext();
  const { engine } = buildPair(ctx);

  /* Warm the voice up under load so a real bark is allowed. */
  for (let i = 0; i < 30; i++) engine.update(H, 0.7, 1, 0, 2, ctx.currentTime + H);
  const before = engine.shots.count;
  eq(before, 0, 'no one-shots in flight before the shift');

  engine.update(H, 0.7, 1, 0, 3, ctx.currentTime + H);   // gear 2 → 3
  eq(engine.shots.count, 1, 'upshift registers exactly one bark');
  const barkSrc = [...engine.shots.active][0].src;
  ok(barkSrc.started && barkSrc.stopped, 'bark source is started with a stop time');
  ok(barkSrc.outputs.length > 0, 'bark source holds a connection while in flight');

  /* Run the fake clock past the longest bark envelope (~0.16 s + tail). */
  for (let i = 0; i < 15; i++) ctx.advance(H);
  eq(engine.shots.count, 0, 'bark leaves the registry when its envelope ends');
  ok(barkSrc.disconnected, 'ended bark source disconnects itself');
  /* Its per-shot gain came out with it: nothing still wired into the
     permanent bark filter from a dead transient. */
  const stillIntoBarkBand = barkBand =>
    barkBand.inputs.filter(c => c.node.disconnected === false).length;
  ok(stillIntoBarkBand(engine.barkBand) === 0,
    'no orphan per-shot gain left connected into the bark filter');

  /* A second, downshift event on the same voice: the registry must recycle. */
  engine.update(H, 0.7, 1, 0, 2, ctx.currentTime + H);
  eq(engine.shots.count, 1, 'downshift registers a fresh bark');
  for (let i = 0; i < 15; i++) ctx.advance(H);
  eq(engine.shots.count, 0, 'downshift bark is reaped on its own end');

  /* The idle-off-throttle rule: parked, no throttle, gear steps must be
     effectively silent and must allocate nothing. */
  const idle = new FakeContext();
  const idlePair = buildPair(idle);
  for (let i = 0; i < 20; i++) idlePair.engine.update(H, IDLE, 0, 0, 0, idle.currentTime + H);
  const idleSourcesBefore = idle.sources.size;
  idlePair.engine.update(H, IDLE, 0, 0, 1, idle.currentTime + H);   // 0 → 1
  eq(idlePair.engine.shots.count, 0, 'idle off-throttle shift fires no bark');
  eq(idle.sources.size, idleSourcesBefore, 'idle off-throttle shift allocates no source');
  /* And through the public entry point directly, not only via update(). */
  idlePair.engine.bark(idle.currentTime, IDLE, 0, 1);
  eq(idlePair.engine.shots.count, 0, 'bark() at idle off-throttle stays silent by contract');

  /* Sanity counterpart: the same gear edge under load DOES speak, proving the
     silence is the idle rule and not a voice that can no longer make sound. */
  engine.bark(ctx.currentTime, 0.7, 1, 1);
  eq(engine.shots.count, 1, 'a loaded shift still barks after the idle case ran');
  engine.dispose();
  idlePair.engine.dispose();
  idlePair.feedback.dispose();
}

/* ================================================================== */
/* Scenario 2 — concurrent triggers near the same frame                */
/* ================================================================== */
section('2. concurrent bark and boost ignition: independent teardown');
{
  const ctx = new FakeContext();
  const { engine, feedback } = buildPair(ctx);

  for (let i = 0; i < 30; i++) {
    engine.update(H, 0.7, 1, 0, 2, ctx.currentTime + H);
    feedback.update(H, 0.7, 0, ctx.currentTime + H);
  }

  /* Same frame: gearchange bark AND pad ignition. */
  const t = ctx.currentTime + H;
  engine.update(H, 0.7, 1, 0, 3, t);
  feedback.boostStart(t, 0.7);
  eq(engine.shots.count, 1, 'engine owns its bark');
  /* boostStart is one tone oscillator plus one noise burst. */
  eq(feedback.shots.count, 2, 'feedback owns its tone and its ignition burst');
  ok(engine.shots.active !== feedback.shots.active, 'the two registries are distinct');

  /* Natural endings: the bark (~0.1 s) finishes well before the ignition
     (~0.21 s), and neither registry touches the other's contents. */
  for (let i = 0; i < 8; i++) ctx.advance(H);          // ~0.133 s
  eq(engine.shots.count, 0, 'bark finishes on its own clock');
  ok(feedback.shots.count >= 1, 'ignition still in flight when the bark has ended');
  for (let i = 0; i < 10; i++) ctx.advance(H);         // past 0.21 s
  eq(feedback.shots.count, 0, 'ignition finishes on its own clock');

  /* Overlap again, then cut only the engine: feedback must be untouched. */
  const t2 = ctx.currentTime + H;
  engine.update(H, 0.7, 1, 0, 4, t2);
  feedback.boostStart(t2, 0.7);
  eq(engine.shots.count, 1, 'second bark registered');
  eq(feedback.shots.count, 2, 'second ignition registered');
  engine.cutTransients();
  eq(engine.shots.count, 0, 'cutTransients empties the engine registry');
  eq(feedback.shots.count, 2, 'engine cut does not swallow the feedback shots');
  feedback.cutTransients();
  eq(feedback.shots.count, 0, 'feedback cut empties its own registry');

  engine.dispose();
  feedback.dispose();
}

/* ================================================================== */
/* Scenario 3 — events attempted after dispose                         */
/* ================================================================== */
section('3. after dispose: no voice sounds, no source lingers');
{
  const ctx = new FakeContext();
  const { engine, feedback, carBus } = buildPair(ctx);
  for (let i = 0; i < 10; i++) {
    engine.update(H, 0.7, 1, 0, 2, ctx.currentTime + H);
    feedback.update(H, 0.7, 0, ctx.currentTime + H);
  }

  /* Put real in-flight transients down first, then tear everything down. */
  const t = ctx.currentTime + H;
  engine.update(H, 0.7, 1, 0, 3, t);
  feedback.boostStart(t, 0.7);
  const inFlight = engine.shots.count + feedback.shots.count;
  ok(inFlight === 3, `three transients in flight pre-dispose (got ${inFlight})`);

  engine.dispose();
  feedback.dispose();
  eq(engine.shots.count + feedback.shots.count, 0, 'dispose stops every in-flight one-shot');
  ok(engine.disposed && feedback.disposed, 'both voices mark themselves disposed');

  /* Every permanent node must be disconnected. */
  const liveEngineNodes = engine.nodes.filter(n => !n.disconnected).length;
  const liveFeedbackNodes = feedback.nodes.filter(n => !n.disconnected).length;
  eq(liveEngineNodes, 0, 'all engine permanent nodes disconnected');
  eq(liveFeedbackNodes, 0, 'all feedback permanent nodes disconnected');
  /* And nothing still feeding the shared car bus. */
  eq(feeding(carBus).size, 1, 'car bus has no graph feeding it after dispose');

  /* Every source the context ever made for these voices is stopped. */
  const loose = [...ctx.sources].filter(s => !s.stopped);
  eq(loose.length, 0, 'no source remains un-stopped after dispose');

  /* Post-dispose calls must be silent no-ops, not exceptions and not new
     sources. Calling update again must not schedule onto dead params. */
  const sourcesAtDispose = ctx.sources.size;
  let threw = false;
  try {
    engine.update(H, 0.9, 1, 0, 4, ctx.currentTime + H);
    engine.bark(ctx.currentTime + H, 0.9, 1, 1);
    feedback.update(H, 0.9, 1.2, ctx.currentTime + H);
    feedback.boostStart(ctx.currentTime + H, 0.9);
    feedback.position(ctx.currentTime + H, 'gained');
    engine.cutTransients();
    feedback.cutTransients();
    engine.dispose();          // idempotent
    feedback.dispose();
  } catch (e) { threw = true; }
  ok(!threw, 'every entry point is a safe no-op after dispose');
  eq(ctx.sources.size, sourcesAtDispose, 'post-dispose calls allocate no sources');
  eq(engine.shots.count + feedback.shots.count, 0, 'post-dispose calls register no one-shots');

  /* The clock may still hold end-events that were queued before teardown —
     dispose's direct stop() is what withdraws them, and crucially no callback
     may resurrect a connection. Snapshot the dead graph, run the clock well
     past every stop time, and prove nothing reconnects. */
  const connectionsBefore = [...ctx.nodes].reduce((n, x) => n + x.outputs.length, 0);
  for (let i = 0; i < 30; i++) ctx.advance(H);
  const connectionsAfter = [...ctx.nodes].reduce((n, x) => n + x.outputs.length, 0);
  eq(connectionsAfter, connectionsBefore, 'clock events after dispose reconnect nothing');
  eq(engine.shots.count + feedback.shots.count, 0, 'late onended callbacks re-register nothing');
}

/* ================================================================== */
/* Scenario 4 — restart: old voice cannot pollute the new race         */
/* ================================================================== */
section('4. restart: cutTransients seals the old race off from the new');
{
  const ctx = new FakeContext();
  const { engine, feedback, carBus } = buildPair(ctx);
  /* The render clock and the frame clock move together, as Audio.update keeps
     `now` advancing in offline mode: scheduling times are real clock times and
     advance() fires end-events at the correct instants. */
  const frame = (rpm, throttle, gear, boost = 0) => {
    ctx.advance(H);
    engine.update(H, rpm, throttle, 0, gear, ctx.currentTime);
    feedback.update(H, rpm, boost, ctx.currentTime);
    return ctx.currentTime;
  };
  for (let i = 0; i < 30; i++) frame(0.7, 1, 2);

  /* The pad has been pushing for a few frames before the race ends, so the
     motor is already at its sustained level rather than one frame out of
     silence — the realistic restart-during-boost condition. */
  for (let i = 0; i < 8; i++) frame(0.7, 1, 2, 1.2);
  /* Last frame of the old race: a gear edge barks while the pad motor is live. */
  const lastT = frame(0.7, 1, 3, 1.2);
  feedback.boostStart(lastT, 0.7);
  ok(engine.shots.count === 1 && feedback.shots.count === 2, 'old race has transients in flight');
  const motorAudible = feedback.boostOut.gain.valueAt(lastT);
  ok(motorAudible > 0.01, `boost motor is audible before the cut (gain ${motorAudible.toFixed(4)})`);

  /* The restart boundary, exactly as Audio.raceReset() drives it. */
  engine.cutTransients();
  feedback.cutTransients();
  eq(engine.shots.count + feedback.shots.count, 0, 'restart cuts every old one-shot');
  ok(engine.gear === null, 'engine gear latch resets so the new grid cannot read as a shift');

  /* The motor must be parked: drive zero-timer frames the way the reset
     physics will, and confirm the output gain is driven to silence. */
  for (let i = 0; i < 6; i++) frame(IDLE, 0, 0, 0);
  const motorAfter = feedback.boostOut.gain.valueAt(ctx.currentTime);
  ok(motorAfter < 1e-3, `boost motor returns to silence after restart (gain ${motorAfter.toExponential(2)})`);

  /* New race on the SAME graph: the permanent nodes are still connected and
     the voices work, while nothing old is sounding. */
  const liveNodes = engine.nodes.concat(feedback.nodes).filter(n => !n.disconnected).length;
  ok(liveNodes > 0, 'permanent graph survives the restart intact');
  ok(feeding(carBus).size > 2, 'new race still has a connected graph feeding the car bus');

  /* Gear 1 is the first frame after the nulled latch, so it sets the latch
     without an edge; the step to 2 is the new race's first real gearchange. */
  for (let i = 0; i < 30; i++) frame(0.6, 1, 1);
  frame(0.6, 1, 2);
  eq(engine.shots.count, 1, 'new race barks cleanly on the reused voice');
  for (let i = 0; i < 15; i++) ctx.advance(H);
  eq(engine.shots.count, 0, 'new race bark reaps normally');

  engine.dispose();
  feedback.dispose();
}

/* ================================================================== */
/* Scenario 5 — boost motor follows boostTimer; shift mid-boost         */
/* ================================================================== */
section('5. boost motor tracks boostTimer and coexists with a mid-boost shift');
{
  const ctx = new FakeContext();
  const { engine, feedback } = buildPair(ctx);
  const tick = (rpm, throttle, gear, boost) => {
    ctx.advance(H);
    engine.update(H, rpm, throttle, 0, gear, ctx.currentTime);
    feedback.update(H, rpm, boost, ctx.currentTime);
    return ctx.currentTime;
  };

  /* Arm the pad: 1.2 s of timer, the same number physics.js uses, and let the
     attack approach settle for a few frames. */
  for (let i = 0; i < 8; i++) tick(0.5, 1, 2, 1.2);
  const gPeak = feedback.boostOut.gain.valueAt(ctx.currentTime);
  ok(gPeak > 0.05, `motor swells in while boostTimer is full (gain ${gPeak.toFixed(4)})`);

  /* Decay the timer to zero over 1.2 s of fake physics frames. */
  const steps = Math.ceil(1.2 / H);
  for (let i = 0; i < steps; i++) {
    tick(0.5, 1, 2, Math.max(0, 1.2 - (i + 1) * H));
  }
  /* Zero-timer frames. The voice approaches zero exponentially rather than
     jumping, so measure what the contract actually requires: the gain falls by
     orders of magnitude off its peak and keeps converging frame over frame. */
  for (let i = 0; i < 24; i++) tick(0.5, 1, 2, 0);
  const gSettled = feedback.boostOut.gain.valueAt(ctx.currentTime);
  for (let i = 0; i < 24; i++) tick(0.5, 1, 2, 0);
  const gZero = feedback.boostOut.gain.valueAt(ctx.currentTime);
  ok(gSettled < gPeak * 0.05,
    `motor falls below 5% of its peak once boostTimer is zero (${gSettled.toExponential(2)} vs peak ${gPeak.toFixed(3)})`);
  ok(gZero < gSettled, `motor keeps converging to silence (${gSettled.toExponential(2)} → ${gZero.toExponential(2)})`);
  ok(gZero < 1e-3, `motor reaches the silence floor (gain ${gZero.toExponential(2)})`);
  ok(feedback.shots.count === 0, 'the sustained motor allocates no one-shots while running');

  /* Mid-boost gearchange: both voices carry independent stop logic. */
  const ctx2 = new FakeContext();
  const pair2 = buildPair(ctx2);
  const tick2 = (rpm, throttle, gear, boost) => {
    ctx2.advance(H);
    pair2.engine.update(H, rpm, throttle, 0, gear, ctx2.currentTime);
    pair2.feedback.update(H, rpm, boost, ctx2.currentTime);
    return ctx2.currentTime;
  };
  for (let i = 0; i < 20; i++) tick2(0.7, 1, 2, 0);
  const igniteAt = tick2(0.7, 1, 2, 1.0);
  pair2.feedback.boostStart(igniteAt, 0.7);
  for (let i = 0; i < 10; i++) tick2(0.7, 1, 2, 1.0);
  tick2(0.7, 1, 3, 1.0);                          // shift mid-boost
  eq(pair2.engine.shots.count, 1, 'shift bark fires while the boost motor runs');
  ok(pair2.feedback.shots.count >= 1, 'boost ignition survives the shift');
  const motorGain = pair2.feedback.boostOut.gain.valueAt(ctx2.currentTime);
  ok(motorGain > 0.02, `boost motor keeps running through the shift (gain ${motorGain.toFixed(4)})`);

  /* Run the render clock past the bark's envelope: it ends on its own and the
     boost path is never touched. The motor then decays to silence on its own
     timer, proving neither side swallows the other's stop logic. */
  for (let i = 0; i < 12; i++) {
    tick2(0.7, 1, 3, Math.max(0, 1.0 - i * H));
  }
  eq(pair2.engine.shots.count, 0, 'bark ends without touching the boost path');
  for (let i = 0; i < steps + 24; i++) tick2(0.5, 1, 3, 0);
  ok(pair2.feedback.boostOut.gain.valueAt(ctx2.currentTime) < 1e-3,
    'boost motor still reaches silence on its own after the interleaved shift');

  pair2.engine.dispose();
  pair2.feedback.dispose();
  engine.dispose();
  feedback.dispose();
}

/* ------------------------------------------------------------------ */
console.log('');
if (failures) {
  console.log(`  ✗ ${failures} of ${checks} checks failed`);
} else {
  console.log(`  ✓ all ${checks} checks passed — normal shift, concurrency, post-dispose, `
    + 'restart isolation, boost decay');
}
finish(failures ? 1 : (process.exitCode || 0));
