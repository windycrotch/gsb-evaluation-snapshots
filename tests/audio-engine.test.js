import test from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../audio-engine.js";
import { DelayGraph } from "../audio-graph.js";
import { normalizeDelay, withTimeout } from "../shared.js";

class Param {
  constructor() { this.value = 0; this.calls = []; }
  setValueAtTime(value, time) { this.value = value; this.calls.push(["set", value, time]); }
  linearRampToValueAtTime(value, time) { this.calls.push(["ramp", value, time]); }
  cancelScheduledValues(time) { this.calls.push(["cancel", time]); }
  cancelAndHoldAtTime(time) { this.calls.push(["hold", time]); }
}
class Node {
  constructor(log, name) { this.log = log; this.name = name; this.connections = []; }
  connect(other) { this.connections.push(other); this.log.push(`${this.name}->${other.name}`); }
  disconnect() { this.log.push(`disconnect:${this.name}`); this.connections = []; }
}
class Track extends EventTarget {
  readyState = "live";
  muted = false;
  stops = 0;
  constructor(log) { super(); this.log = log; }
  stop() { this.stops++; this.readyState = "ended"; this.log.push("track:stop"); }
}
class Context extends EventTarget {
  currentTime = 0;
  state = "suspended";
  sampleRate = 48000;
  constructor(log) { super(); this.log = log; this.destination = new Node(log, "out"); }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; this.log.push("context:close"); }
  createMediaStreamSource() { this.source = new Node(this.log, "source"); return this.source; }
  createDelay(max) { assert.equal(max, 60); const node = new Node(this.log, "delay"); node.delayTime = new Param(); return node; }
  createGain() { const node = new Node(this.log, "gain"); node.gain = new Param(); return node; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { streamId: "single-use-test", tabId: 5, tabTitle: "Test", sessionId: "session1", delay: 30 };
function fixture(getStream) {
  const log = [];
  const track = new Track(log);
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const context = new Context(log);
  let captures = 0;
  const mediaDevices = new EventTarget();
  mediaDevices.getUserMedia = async constraints => {
    captures++;
    assert.equal(constraints.video, false);
    assert.equal(constraints.audio.mandatory.chromeMediaSource, "tab");
    return getStream ? getStream(stream) : stream;
  };
  const engine = new AudioEngine({ mediaDevices, createContext: () => context });
  return { engine, context, track, log, captures: () => captures };
}

test("0–60 seconds clamp, 0.1 precision, invalid settings rejected", () => {
  assert.equal(normalizeDelay(-1), 0);
  assert.equal(normalizeDelay(61), 60);
  assert.equal(normalizeDelay(30.14), 30.1);
  for (const value of [NaN, Infinity, "30", null]) assert.throws(() => normalizeDelay(value));
});

test("initial 30 seconds is set before input; only one output; repeated start captures once", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([f.engine.start(request), f.engine.start(request)]);
    assert.equal(first.phase, "running");
    assert.equal(second.active, true);
    assert.equal(f.captures(), 1);
    assert.deepEqual(f.log, ["source->delay", "delay->gain", "gain->out"]);
    assert.equal(f.engine.session.graph.delay.delayTime.value, 30);
    assert.equal(first.bufferRemaining, 30);
    f.context.currentTime = 30;
    assert.equal(f.engine.snapshot().bufferRemaining, 0);
  } finally { await f.engine.stop(); }
  assert.ok(f.log.indexOf("disconnect:gain") < f.log.indexOf("track:stop"));
  assert.equal(f.track.stops, 1);
  assert.equal(f.context.state, "closed");
});

test("increase pauses by the added delay while holding content; reset jumps and cancels the pause", () => {
  const log = [];
  const context = new Context(log);
  const graph = new DelayGraph(context, new Node(log, "source"), 30);
  context.currentTime = 100;
  graph.setDelay(35);
  assert.ok(Math.abs(graph.timing().pauseRemaining - 5.04) < 1e-8);
  const heldReadPosition = 100.02 - 30;
  for (const time of [100.1, 101, 103, 104.9]) {
    assert.ok(Math.abs(time - graph.tapAt(time) - heldReadPosition) < 1e-8);
  }
  assert.ok(graph.gain.gain.calls.some(call => call[0] === "set" && call[1] === 0 && Math.abs(call[2] - 105.04) < 1e-8));
  context.currentTime = 103;
  graph.setDelay(30.0);
  assert.ok(Math.abs(graph.transition.from - 32.98) < 1e-8);
  assert.equal(graph.timing().pauseRemaining, 0);
  context.currentTime = 103.1;
  assert.equal(graph.tapAt(context.currentTime), 30);
  assert.equal(graph.timing().transitionRemaining, 0);
  graph.setDelay(60);
  assert.ok(graph.gain.gain.calls.some(call => call[0] === "ramp" && call[1] === 0));
  assert.equal(graph.tapAt(134), 60);
  assert.equal(log.filter(line => line.endsWith("->out")).length, 1);
  graph.disconnect();
});

test("mute/unmute preserves stream and delay graph; ended releases resources", async () => {
  const f = fixture();
  await f.engine.start(request);
  const graph = f.engine.session.graph;
  f.track.muted = true; f.track.dispatchEvent(new Event("mute"));
  assert.equal(f.engine.snapshot().phase, "interrupted");
  assert.equal(f.engine.snapshot().active, true);
  f.track.muted = false; f.track.dispatchEvent(new Event("unmute"));
  assert.equal(f.engine.snapshot().phase, "running");
  assert.equal(f.engine.session.graph, graph);
  f.track.dispatchEvent(new Event("ended"));
  await tick();
  assert.equal(f.engine.snapshot().active, false);
  assert.equal(f.engine.snapshot().phase, "interrupted");
  assert.equal(f.track.stops, 1);
  assert.equal(f.captures(), 1);
});

test("stop during pending getUserMedia releases a late stream", async () => {
  let resolve;
  const f = fixture(stream => new Promise(done => { resolve = () => done(stream); }));
  const pending = f.engine.start(request);
  await f.engine.stop();
  resolve();
  await pending;
  assert.equal(f.track.stops, 1);
  assert.equal(f.engine.snapshot().active, false);
  assert.equal(f.context.state, "suspended");
});

test("getUserMedia rejection becomes readable terminal error", async () => {
  const f = fixture(() => { throw new DOMException("Denied", "NotAllowedError"); });
  const state = await f.engine.start(request);
  assert.equal(state.phase, "error");
  assert.equal(state.active, false);
  assert.match(state.error, /回到/);
});

test("context interruption resumes, failure makes exactly three attempts and releases", async () => {
  const f = fixture();
  await f.engine.start(request);
  f.context.state = "suspended";
  f.context.dispatchEvent(new Event("statechange"));
  await tick();
  assert.equal(f.context.state, "running");
  assert.equal(f.engine.snapshot().phase, "running");
  let attempts = 0;
  f.context.resume = async () => { attempts++; throw new Error("Device unavailable"); };
  f.context.state = "suspended";
  f.context.dispatchEvent(new Event("statechange"));
  await tick();
  assert.equal(attempts, 3);
  assert.equal(f.engine.snapshot().phase, "error");
  assert.equal(f.track.stops, 1);
});

test("timeout helper disposes a late resolved value", async () => {
  let disposed = false;
  await assert.rejects(withTimeout(new Promise(resolve => setTimeout(() => resolve("stream"), 20)), 2, () => { disposed = true; }), { name: "TimeoutError" });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(disposed, true);
});
