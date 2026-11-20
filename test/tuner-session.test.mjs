import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { importTs } from "./support/load-ts.mjs";

const repoRoot = new URL("../", import.meta.url);
const { createTunerSession, DEFAULT_TUNER_HISTORY_SIZE } = await importTs(
  "lib/audio/tuner-session.ts",
);
const { hzToNote } = await importTs("lib/audio/note.ts");

// ── Test doubles ─────────────────────────────────────────────────────────────
// The session depends only on small structural audio interfaces, so plain
// objects stand in for the browser graph and each test settles the awaits in
// whatever order it needs. No real microphone or AudioContext is involved.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness({ historySize } = {}) {
  const states = [];
  const readings = [];
  const errors = [];
  const contexts = [];
  const mediaCalls = [];
  const moduleCalls = [];
  let detectHz = null;
  let moduleMode = "resolve"; // "resolve" | "reject" | "hold"

  function makeStream() {
    const tracks = [makeTrack(), makeTrack()];
    return { tracks, getTracks: () => tracks };
  }

  function makeTrack() {
    return {
      stopped: 0,
      stop() {
        this.stopped += 1;
      },
    };
  }

  function makeConnectable(label) {
    return {
      label,
      connects: [],
      disconnects: 0,
      connect(target) {
        this.connects.push(target);
        return target;
      },
      disconnect() {
        this.disconnects += 1;
      },
    };
  }

  function makeContext() {
    const context = {
      sampleRate: 48000,
      destination: { label: "destination" },
      closed: 0,
      added: [],
      nodes: {},
      audioWorklet: {
        addModule(url) {
          context.added.push(url);
          const d = deferred();
          moduleCalls.push(d);
          if (moduleMode === "reject") d.reject(new Error("worklet unavailable"));
          else if (moduleMode === "resolve") d.resolve();
          return d.promise;
        },
      },
      createMediaStreamSource(stream) {
        const node = makeConnectable("source");
        node.stream = stream;
        context.nodes.source = node;
        return node;
      },
      createGain() {
        const node = makeConnectable("gain");
        node.gain = { value: 1 };
        context.nodes.gain = node;
        return node;
      },
      close() {
        context.closed += 1;
        return Promise.resolve();
      },
    };
    contexts.push(context);
    return context;
  }

  function makeWorkletNode() {
    const node = makeConnectable("worklet");
    const port = {
      onmessage: null,
      closed: 0,
      close() {
        this.closed += 1;
      },
    };
    node.port = port;
    node.emit = (samples) => port.onmessage?.({ data: { samples } });
    const ctx = contexts[contexts.length - 1];
    if (ctx) ctx.nodes.worklet = node;
    return node;
  }

  const session = createTunerSession({
    getUserMedia() {
      const d = deferred();
      mediaCalls.push(d);
      return d.promise;
    },
    createAudioContext: makeContext,
    loadWorkletModule: (context) =>
      context.audioWorklet.addModule("/tuner-audio-processor.js"),
    createWorkletNode: makeWorkletNode,
    detectPitch: () => detectHz,
    hzToNote,
    onStateChange: (s) => states.push(s),
    onReadingChange: (r) => readings.push(r),
    onErrorChange: (e) => errors.push(e),
    historySize,
  });

  return {
    session,
    states,
    readings,
    errors,
    contexts,
    mediaCalls,
    moduleCalls,
    makeStream,
    setDetectHz: (hz) => {
      detectHz = hz;
    },
    moduleLoad: (mode) => {
      moduleMode = mode;
    },
    lastState: () => states[states.length - 1],
    lastReading: () => readings[readings.length - 1],
    lastError: () => errors[errors.length - 1],
  };
}

// Hand a fresh fake stream to the pending getUserMedia call.
function grantMicrophone(h, index = h.mediaCalls.length - 1) {
  const stream = h.makeStream();
  h.mediaCalls[index].resolve(stream);
  return stream;
}

// Create the stream up front when the test needs a handle before the call is
// settled (for example, to prove a late stream gets stopped).
function pendingStream(h, index) {
  const stream = h.makeStream();
  return {
    stream,
    grant() {
      h.mediaCalls[index].resolve(stream);
    },
  };
}

const fakeSamples = new Float32Array([0.5, -0.5, 0.25]);

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ── Cold start ──────────────────────────────────────────────────────────────

test("a start loads the worklet and reports running once the graph is up", async () => {
  const h = makeHarness();
  const p = h.session.start();
  assert.equal(h.mediaCalls.length, 1, "microphone requested once");
  assert.equal(h.lastState(), "idle", "not running before the stream arrives");

  grantMicrophone(h);
  await p;

  assert.equal(h.lastState(), "running");
  assert.equal(h.lastError(), null, "start clears any previous error");
  assert.equal(h.lastReading(), null, "no read-out until a pitch arrives");
  assert.equal(h.contexts.length, 1);
  assert.deepEqual(h.contexts[0].added, ["/tuner-audio-processor.js"]);

  h.session.stop();
});

test("the graph is source -> worklet -> zero gain -> destination", async () => {
  const h = makeHarness();
  const p = h.session.start();
  const stream = grantMicrophone(h);
  await p;

  const ctx = h.contexts[0];
  const { source, worklet, gain } = ctx.nodes;
  assert.equal(source.stream, stream, "source wraps the live stream");
  assert.deepEqual(source.connects, [worklet]);
  assert.deepEqual(worklet.connects, [gain]);
  assert.deepEqual(gain.connects, [ctx.destination]);
  assert.equal(gain.gain.value, 0, "the monitor gain stays silent");

  h.session.stop();
});

// ── Concurrent start / stop ─────────────────────────────────────────────────

test("stop while the permission prompt is pending discards the late stream", async () => {
  const h = makeHarness();
  const pending = pendingStream(h, 0);
  const start = h.session.start();

  h.session.stop();
  pending.grant();
  await start;

  assert.equal(h.contexts.length, 0, "no audio context after stop");
  assert.deepEqual(
    pending.stream.tracks.map((t) => t.stopped),
    [1, 1],
    "a stream that arrives after stop is stopped immediately",
  );
  assert.equal(h.lastState(), "idle");
  assert.equal(h.lastReading(), null);
  assert.equal(h.lastError(), null);
});

test("stop while the worklet module is loading releases the half-built session", async () => {
  const h = makeHarness();
  h.moduleLoad("hold");
  const pending = pendingStream(h, 0);
  const start = h.session.start();
  pending.grant();
  await flush(); // stream accepted, context created, module load still pending

  assert.equal(h.contexts.length, 1, "context exists during the module load");
  h.session.stop();
  await flush();

  assert.equal(h.contexts[0].closed, 1, "the half-built context is closed");
  assert.deepEqual(pending.stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(h.contexts[0].nodes.worklet, undefined, "no worklet node was built");

  // A module load that settles later must not resurrect the session.
  h.moduleCalls[0].resolve();
  await start;
  await flush();

  assert.equal(h.lastState(), "idle");
  assert.equal(h.contexts.length, 1, "no second context is created");
  assert.equal(h.contexts[0].nodes.worklet, undefined);
});

test("a newer start supersedes one that is still opening the microphone", async () => {
  const h = makeHarness();
  const stale = pendingStream(h, 0);
  const fresh = pendingStream(h, 1);
  const first = h.session.start();
  const second = h.session.start();
  assert.equal(h.mediaCalls.length, 2);

  // Resolve the superseded start first: its stream must be released, not used.
  stale.grant();
  await first;

  assert.deepEqual(stale.stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(h.contexts.length, 0, "the superseded start builds no context");
  assert.equal(h.lastState(), "idle", "the user has not reached running yet");

  fresh.grant();
  await second;

  assert.equal(h.lastState(), "running");
  assert.equal(h.contexts.length, 1, "only the latest start owns a context");
  assert.deepEqual(fresh.stream.tracks.map((t) => t.stopped), [0, 0]);

  h.session.stop();
});

test("rapid alternating start/stop settles on the last intent", async () => {
  const h = makeHarness();
  const a = pendingStream(h, 0);
  const b = pendingStream(h, 1);
  const c = pendingStream(h, 2);

  const p1 = h.session.start();
  h.session.stop();
  const p2 = h.session.start();
  h.session.stop();
  const p3 = h.session.start();

  // Resolve out of order to prove no older start can win.
  b.grant();
  a.grant();
  c.grant();
  await Promise.all([p1, p2, p3]);
  await flush();

  assert.equal(h.lastState(), "running");
  assert.equal(h.contexts.length, 1, "one context for the surviving session");
  assert.deepEqual(a.stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.deepEqual(b.stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.deepEqual(c.stream.tracks.map((t) => t.stopped), [0, 0]);

  h.session.stop();
});

test("a superseded start's late failure cannot overwrite a running session", async () => {
  const h = makeHarness();
  h.moduleLoad("reject");
  const first = h.session.start();
  grantMicrophone(h, 0);
  await flush(); // first is now awaiting its rejecting module load

  h.moduleLoad("resolve");
  const second = h.session.start();
  grantMicrophone(h, 1);
  await second;
  assert.equal(h.lastState(), "running");

  await first; // the old module rejection must be ignored
  await flush();

  assert.equal(h.lastState(), "running", "still running on the newer session");
  assert.equal(h.lastError(), null, "no stale error is reported");

  h.session.stop();
});

// ── Readings and smoothing ──────────────────────────────────────────────────

test("readings use the median of the last five detections", async () => {
  const h = makeHarness({ historySize: DEFAULT_TUNER_HISTORY_SIZE });
  const p = h.session.start();
  grantMicrophone(h);
  await p;

  const node = h.contexts[0].nodes.worklet;
  for (const hz of [100, 200, 300, 400, 500, 600]) {
    h.setDetectHz(hz);
    node.emit(fakeSamples);
  }

  const reading = h.lastReading();
  assert.equal(reading.smoothedHz, 400, "median of the last five: 200..600");
  const expected = hzToNote(400);
  assert.equal(reading.name, expected.name);
  assert.equal(reading.fullName, expected.fullName);
  assert.equal(reading.cents, expected.cents);
  assert.equal(
    h.readings.filter((r) => r !== null).length,
    6,
    "one reading per detected frame",
  );

  h.session.stop();
});

test("silence between plucks leaves the last reading in place", async () => {
  const h = makeHarness();
  const p = h.session.start();
  grantMicrophone(h);
  await p;
  const node = h.contexts[0].nodes.worklet;

  h.setDetectHz(220);
  node.emit(fakeSamples);
  assert.equal(h.lastReading().name, hzToNote(220).name);

  h.setDetectHz(null);
  const count = h.readings.length;
  node.emit(fakeSamples);
  assert.equal(h.readings.length, count, "no empty reading is emitted");

  h.session.stop();
});

test("stop clears the reading and the next start begins a fresh history", async () => {
  const h = makeHarness();
  const p = h.session.start();
  grantMicrophone(h);
  await p;
  h.setDetectHz(100);
  h.contexts[0].nodes.worklet.emit(fakeSamples);
  assert.equal(h.lastReading().hz, 100);

  h.session.stop();
  assert.equal(h.lastReading(), null, "stop clears the read-out");
  assert.equal(h.lastState(), "idle");

  const p2 = h.session.start();
  grantMicrophone(h);
  await p2;
  h.setDetectHz(500);
  h.contexts[1].nodes.worklet.emit(fakeSamples);

  assert.equal(
    h.lastReading().smoothedHz,
    500,
    "old history must not blend into the new session",
  );

  h.session.stop();
});

test("a frame from a released worklet writes nothing", async () => {
  const h = makeHarness();
  const p = h.session.start();
  grantMicrophone(h);
  await p;
  const oldNode = h.contexts[0].nodes.worklet;
  h.setDetectHz(440);

  h.session.stop();
  const readingsAfterStop = h.readings.length;
  oldNode.emit(fakeSamples); // port.onmessage was detached
  assert.equal(h.readings.length, readingsAfterStop);
  assert.equal(h.lastReading(), null);
});

// ── Failures and retries ────────────────────────────────────────────────────

test("a denied microphone shows a retryable error and keeps no resources", async () => {
  const h = makeHarness();
  const denied = h.session.start();
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  h.mediaCalls[0].reject(error);
  await denied;

  assert.equal(h.lastError(), "Permission denied");
  assert.equal(h.lastState(), "idle");
  assert.equal(h.lastReading(), null);
  assert.equal(h.contexts.length, 0, "no audio context is created");

  // Retry: the error clears up front and the tuner enters the running state.
  const retry = h.session.start();
  assert.equal(h.lastError(), null, "a retry clears the error up front");
  grantMicrophone(h);
  await retry;

  assert.equal(h.lastError(), null);
  assert.equal(h.lastState(), "running");
  assert.equal(h.contexts.length, 1);

  h.session.stop();
});

test("a non-Error rejection gets a readable message", async () => {
  const h = makeHarness();
  const p = h.session.start();
  h.mediaCalls[0].reject("nope");
  await p;

  assert.equal(h.lastError(), "Couldn't access the microphone.");
  assert.equal(h.lastState(), "idle");
});

test("a worklet module that fails to load is cleaned up and retryable", async () => {
  const h = makeHarness();
  h.moduleLoad("reject");

  const p = h.session.start();
  const stream = grantMicrophone(h);
  await p;

  assert.match(h.lastError(), /worklet unavailable/);
  assert.equal(h.lastState(), "idle");
  assert.equal(h.contexts[0].closed, 1, "the audio context is closed");
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(h.contexts[0].nodes.worklet, undefined, "no worklet node lingers");

  h.moduleLoad("resolve");
  const retry = h.session.start();
  grantMicrophone(h);
  await retry;

  assert.equal(h.lastError(), null, "the retry clears the error");
  assert.equal(h.lastState(), "running");

  h.session.stop();
});

// ── Teardown ────────────────────────────────────────────────────────────────

test("stop releases tracks, closes the context and disconnects every node", async () => {
  const h = makeHarness();
  const p = h.session.start();
  const stream = grantMicrophone(h);
  await p;

  const ctx = h.contexts[0];
  h.session.stop();

  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(ctx.closed, 1);
  assert.equal(h.lastState(), "idle");
  assert.equal(ctx.nodes.worklet.disconnects, 1);
  assert.equal(ctx.nodes.gain.disconnects, 1);
  assert.equal(ctx.nodes.source.disconnects, 1);
  assert.equal(ctx.nodes.worklet.port.closed, 1);
  assert.equal(ctx.nodes.worklet.port.onmessage, null);
});

test("repeated stop and dispose never throw or release twice", async () => {
  const h = makeHarness();
  const p = h.session.start();
  const stream = grantMicrophone(h);
  await p;

  assert.doesNotThrow(() => h.session.stop());
  assert.doesNotThrow(() => h.session.stop());
  assert.doesNotThrow(() => h.session.dispose());
  assert.doesNotThrow(() => h.session.stop());

  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(h.contexts[0].closed, 1);
});

test("dispose during startup releases the late stream and ignores its frames", async () => {
  const h = makeHarness();
  const pending = pendingStream(h, 0);
  const start = h.session.start();
  h.session.dispose();
  pending.grant();
  await start;
  await flush();

  assert.deepEqual(pending.stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.lastState(), "idle");
  assert.equal(h.lastError(), null);
});

// ── Hook wiring ─────────────────────────────────────────────────────────────

test("the hook owns a session, disposes it on unmount and adds no timers", async () => {
  const source = await readFile(new URL("lib/audio/use-tuner.ts", repoRoot), "utf8");
  assert.match(source, /createTunerSession\(/);
  assert.match(source, /dispose\(\)/, "unmount releases the session");
  assert.doesNotMatch(
    source,
    /setInterval|setTimeout|requestAnimationFrame/,
    "the tuner schedules nothing that could outlive the page",
  );
});
