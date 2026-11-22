// Acceptance tests for the GLVis `State` display lifecycle.
//
// Everything runs against a stub renderer and a fake DOM; no WebAssembly, no
// browser and no network are needed:
//
//   node test/display-lifecycle.test.cjs
//
// Covered paths: normal display, update fallback, repeated switching,
// screenshots during a switch, and recovery after a failed switch.

"use strict";

const assert = require("assert");
const {
  RendererStub,
  createEnvironment,
  flushMicrotasks,
} = require("./support/stub-environment.cjs");

const results = [];
let current = null;

function test(name, fn) {
  results.push({ name, fn });
}

function stream(id, extra = "") {
  return `solution\nstream_id=${id}\n${extra}`;
}

function sizesOf(state, renderer, env) {
  const dpr = env.win.devicePixelRatio || 1;
  return {
    logical: [state.logical_width_, state.logical_height_],
    style: [state.canvas_.style.width, state.canvas_.style.height],
    canvas: [state.canvas_.width, state.canvas_.height],
    rendererLogical: [renderer.logicalW, renderer.logicalH],
    rendererDrawable: [renderer.drawableW, renderer.drawableH],
    dpr,
  };
}

function assertAllSizesAgree(state, renderer, env, label) {
  const s = sizesOf(state, renderer, env);
  const [lw, lh] = s.logical;
  const px = Math.floor(lw * s.dpr);
  const py = Math.floor(lh * s.dpr);
  assert.deepStrictEqual(
    s.style,
    [`${lw}px`, `${lh}px`],
    `${label}: logical size and CSS size disagree (${JSON.stringify(s)})`
  );
  assert.deepStrictEqual(
    s.canvas,
    [px, py],
    `${label}: canvas pixel size disagrees with logical*dpr (${JSON.stringify(
      s
    )})`
  );
  assert.deepStrictEqual(
    s.rendererLogical,
    [lw, lh],
    `${label}: renderer logical size disagrees with canvas (${JSON.stringify(
      s
    )})`
  );
  assert.deepStrictEqual(
    s.rendererDrawable,
    [px, py],
    `${label}: renderer drawable size disagrees with canvas pixels (${JSON.stringify(
      s
    )})`
  );
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
function setup(options = {}) {
  const env = createEnvironment({
    dpr: options.dpr === undefined ? 1 : options.dpr,
  });
  const renderer = new RendererStub({ dpr: env.win.devicePixelRatio });
  const glvis = env.loadIndex(() => renderer);
  const state = new glvis.State(
    env.div,
    options.width === undefined ? 640 : options.width,
    options.height === undefined ? 480 : options.height,
    env.canvas
  );
  return { env, renderer, glvis, state };
}

// ---------------------------------------------------------------------------
// 1. Normal display
// ---------------------------------------------------------------------------
test("display makes logical, canvas and renderer sizes agree", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  assertAllSizesAgree(state, renderer, env, "after display");
  assert.strictEqual(renderer.frameId, 1);
  assert.strictEqual(renderer.calls.displayStream.length, 1);
  assert.deepStrictEqual(renderer.calls.displayStream[0].slice(1), [640, 480]);
});

test("display works with a non-unit device pixel ratio", async () => {
  const { env, renderer, state } = setup({ dpr: 2, width: 321, height: 123 });
  await state.display(stream(2));
  assertAllSizesAgree(state, renderer, env, "dpr=2 display");
  assert.deepStrictEqual([env.canvas.width, env.canvas.height], [642, 246]);
});

test("a stream that requests its own window size is overridden", async () => {
  const { env, renderer, state } = setup({ width: 500, height: 400 });
  await state.display(stream(3, "window_size 111 222\n"));
  assertAllSizesAgree(state, renderer, env, "after stream resize");
  assert.deepStrictEqual(
    [state.logical_width_, state.logical_height_],
    [500, 400]
  );
});

test("display honors a canvas size set before the stream is loaded", async () => {
  const { env, renderer, state } = setup();
  await state.setSize(300, 200);
  await state.display(stream(4));
  assertAllSizesAgree(state, renderer, env, "after setSize+display");
  assert.deepStrictEqual(renderer.calls.displayStream[0].slice(1), [300, 200]);
});

test("new-stream callbacks fire once per display with the State", async () => {
  const { state } = setup();
  const seen = [];
  state.registerNewStreamCallback((s) => seen.push(["a", s]));
  state.registerNewStreamCallback((s) => seen.push(["b", s]));
  await state.display(stream(1));
  assert.deepStrictEqual(
    seen.map((x) => x[0]),
    ["a", "b"]
  );
  assert.ok(seen.every((x) => x[1] === state));
});

test("display over an array of streams uses the parallel entry point", async () => {
  const { env, renderer, state } = setup();
  await state.display([
    "parallel 1 0\nstream_id=7",
    "parallel 1 0\nstream_id=8",
  ]);
  assert.strictEqual(renderer.calls.displayParallelStreams.length, 1);
  assert.strictEqual(renderer.frameId, 8);
  assertAllSizesAgree(state, renderer, env, "parallel display");
});

// ---------------------------------------------------------------------------
// 2. Update before the renderer is ready, and update fallback
// ---------------------------------------------------------------------------
test("update before the first display performs a full display", async () => {
  const { env, renderer, state } = setup();
  const seen = [];
  state.registerNewStreamCallback(() => seen.push(1));
  await state.update(stream(5));
  assert.strictEqual(renderer.calls.displayStream.length, 1);
  assert.strictEqual(renderer.calls.updateStream.length, 0);
  assert.strictEqual(seen.length, 1);
  assertAllSizesAgree(state, renderer, env, "update-first display");
});

test("update waits for a renderer that is not ready yet", async () => {
  const env = createEnvironment();
  const renderer = new RendererStub();
  const glvis = env.loadIndex(() => renderer);
  // make the emglvis promise resolve only after the first update is queued
  let release;
  const gate = new Promise((r) => (release = r));
  const gated = new glvis.State(env.div, 640, 480, env.canvas);
  gated.emglv_ = gate;

  const pending = gated.update(stream(6));
  await flushMicrotasks();
  assert.strictEqual(renderer.calls.displayStream.length, 0);
  release(renderer);
  await pending;
  assert.strictEqual(renderer.calls.displayStream.length, 1);
  assert.strictEqual(renderer.frameId, 6);
});

test("update returning nonzero falls back to a single full display", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  const loopsBefore = env.pendingFrames();

  renderer.failUpdate = true;
  await state.update(stream(9));

  assert.strictEqual(renderer.calls.updateStream.length, 1);
  assert.strictEqual(
    renderer.calls.displayStream.length,
    2,
    "fallback must call display exactly once"
  );
  assert.strictEqual(renderer.frameId, 9);
  assert.strictEqual(env.pendingFrames(), loopsBefore, "loop count changed");
  env.tick(4);
  assert.strictEqual(env.pendingFrames(), 1, "exactly one animation loop");
  assertAllSizesAgree(state, renderer, env, "after update fallback");
});

test("update that throws falls back to a full display", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  renderer.throwUpdate = new Error("bad update");
  await state.update(stream(10));
  assert.strictEqual(renderer.calls.displayStream.length, 2);
  assert.strictEqual(renderer.frameId, 10);
  env.tick(3);
  assert.strictEqual(env.pendingFrames(), 1, "exactly one animation loop");
});

test("successful update keeps one loop and consistent sizes", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  await state.update(stream(11));
  assert.strictEqual(renderer.calls.updateStream.length, 1);
  assert.strictEqual(renderer.calls.displayStream.length, 1);
  assert.strictEqual(renderer.frameId, 11);
  env.tick(3);
  assert.strictEqual(env.pendingFrames(), 1);
  assertAllSizesAgree(state, renderer, env, "after update");
});

// ---------------------------------------------------------------------------
// 3. Consecutive switches
// ---------------------------------------------------------------------------
test("consecutive displays do not stack loops or callbacks", async () => {
  const { env, renderer, state } = setup();
  let callbackCount = 0;
  state.registerNewStreamCallback(() => callbackCount++);

  await Promise.all([
    state.display(stream(1)),
    state.display(stream(2)),
    state.display(stream(3)),
  ]);

  assert.strictEqual(callbackCount, 3);
  assert.strictEqual(renderer.calls.displayStream.length, 3);
  assert.strictEqual(renderer.frameId, 3, "the last stream must win");
  env.tick(5);
  assert.strictEqual(env.pendingFrames(), 1, "only one animation loop");
  assertAllSizesAgree(state, renderer, env, "after consecutive displays");
});

test("interleaved display/update calls are serialized", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  await Promise.all([
    state.update(stream(2)),
    state.display(stream(3)),
    state.update(stream(4)),
  ]);
  assert.strictEqual(renderer.frameId, 4);
  env.tick(3);
  assert.strictEqual(env.pendingFrames(), 1);
  assertAllSizesAgree(state, renderer, env, "after interleaved calls");
});

test("each display targets the logical size in effect at its turn", async () => {
  const { env, renderer, state } = setup();
  const first = state.display(stream(1));
  const resize = state.setSize(200, 100);
  const second = state.display(stream(2));
  await Promise.all([first, resize, second]);
  assertAllSizesAgree(state, renderer, env, "after interleaved resize");
  assert.deepStrictEqual(renderer.calls.displayStream[1].slice(1), [200, 100]);
});

// ---------------------------------------------------------------------------
// 4. Screenshots while a switch is in progress
// ---------------------------------------------------------------------------
test("getScreenBuffer during a switch waits for the new stream", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));

  renderer.holdDisplay = true;
  const switching = state.display(stream(2));
  await flushMicrotasks();

  const shotPromise = state.getScreenBuffer(false);
  await flushMicrotasks();
  assert.strictEqual(
    renderer.calls.getScreenBuffer.length,
    0,
    "capture must not run before the switch completes"
  );

  renderer.releaseDisplay();
  const [shot] = await Promise.all([shotPromise, switching]);

  assert.strictEqual(shot[0], 2, "captured the previous stream's frame");
  assert.strictEqual(shot.length, env.canvas.width * env.canvas.height * 4);
  assertAllSizesAgree(state, renderer, env, "after capture");
});

test("getPNGURL during a switch waits for the new stream", async () => {
  const { renderer, state } = setup();
  await state.display(stream(1));
  renderer.holdDisplay = true;
  const switching = state.display(stream(2));
  await flushMicrotasks();
  const urlPromise = state.getPNGURL();
  // give the capture a chance to (incorrectly) read the held, old frame
  await flushMicrotasks();
  renderer.releaseDisplay();
  const [url] = await Promise.all([urlPromise, switching]);
  const bytes = Buffer.from(url.split(",")[1], "base64");
  assert.strictEqual(bytes[0], 2, "PNG came from the previous stream");
});

test("getScreenBufferAsCanvas during a switch waits for the new stream", async () => {
  const { renderer, state } = setup();
  await state.display(stream(1));
  renderer.holdDisplay = true;
  const switching = state.display(stream(2));
  await flushMicrotasks();
  const canvasPromise = state.getScreenBufferAsCanvas();
  await flushMicrotasks();
  renderer.releaseDisplay();
  const [can] = await Promise.all([canvasPromise, switching]);
  const data = can.getContext("2d")._put.data;
  assert.strictEqual(data[0], 2, "canvas came from the previous stream");
});

test("saveScreenshot during a switch waits for the new stream", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  renderer.holdDisplay = true;
  const switching = state.display(stream(2));
  await flushMicrotasks();
  const savePromise = state.saveScreenshot("shot.png");
  await flushMicrotasks();
  renderer.releaseDisplay();
  await Promise.all([savePromise, switching]);
  assert.strictEqual(env.links.length, 1);
  assert.strictEqual(env.links[0].download, "shot.png");
  const bytes = Buffer.from(env.links[0].href.split(",")[1], "base64");
  assert.strictEqual(bytes[0], 2, "screenshot came from the previous stream");
});

test("screenshots fail explicitly before any display", async () => {
  const { state } = setup();
  await assert.rejects(() => state.getPNGURL(), /no visualization/);
  await assert.rejects(
    () => state.getScreenBufferAsCanvas(),
    /no visualization/
  );
  await assert.rejects(() => state.getScreenBuffer(false), /no visualization/);
  await assert.rejects(() => state.saveScreenshot(), /no visualization/);
});

test("a size mismatch in the captured buffer is an explicit failure", async () => {
  const { renderer, state } = setup();
  await state.display(stream(1));
  const real = renderer.getScreenBuffer.bind(renderer);
  renderer.getScreenBuffer = () => real(false).slice(0, 16);
  await assert.rejects(() => state.getScreenBuffer(false), /size mismatch/);
  await assert.rejects(() => state.getScreenBufferAsCanvas(), /size mismatch/);
});

// ---------------------------------------------------------------------------
// 5. Recovery after a failed switch
// ---------------------------------------------------------------------------
test("failed display rejects and leaves the State usable", async () => {
  const { env, renderer, state } = setup();
  renderer.failDisplay = new Error("bad stream");
  await assert.rejects(() => state.display(stream(1)), /bad stream/);

  // no half-initialized state: no loop, no callback, no trusted frame
  assert.strictEqual(env.pendingFrames(), 0);
  await assert.rejects(() => state.getPNGURL());

  await state.display(stream(2));
  assert.strictEqual(renderer.frameId, 2);
  assertAllSizesAgree(state, renderer, env, "after recovery");
  env.tick(2);
  assert.strictEqual(env.pendingFrames(), 1, "exactly one animation loop");

  const url = await state.getPNGURL();
  assert.strictEqual(Buffer.from(url.split(",")[1], "base64")[0], 2);
});

test("invalid stream data rejects and can be followed by a valid display", async () => {
  const { env, renderer, state } = setup();
  await assert.rejects(() => state.display(42), /unsupported data type/);
  assert.strictEqual(renderer.calls.displayStream.length, 0);
  await state.display(stream(3));
  assert.strictEqual(renderer.frameId, 3);
  assertAllSizesAgree(state, renderer, env, "after invalid data");
});

test("a failed update fallback still reports the failure and recovers", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  renderer.failUpdate = true;
  renderer.failDisplay = new Error("fallback failed");
  await assert.rejects(() => state.update(stream(2)), /fallback failed/);
  assert.strictEqual(env.pendingFrames(), 1, "the existing loop keeps running");

  await state.display(stream(3));
  assert.strictEqual(renderer.frameId, 3);
  env.tick(2);
  assert.strictEqual(env.pendingFrames(), 1, "still exactly one loop");
  assertAllSizesAgree(state, renderer, env, "after fallback recovery");
});

test("a failed display does not stall later queued operations", async () => {
  const { renderer, state } = setup();
  renderer.failDisplay = new Error("nope");
  const failing = state.display(stream(1));
  const following = state.display(stream(2));
  await assert.rejects(() => failing, /nope/);
  await following;
  assert.strictEqual(renderer.frameId, 2);
});

test("a failed display leaves no half-initialized flags", async () => {
  const { state } = setup();
  const before = {
    emsetup: state.emsetup_,
    ready: state._renderer_ready_,
    loop: state._vis_loop_active_,
  };
  const renderer = new RendererStub();
  const env = createEnvironment();
  const glvis = env.loadIndex(() => renderer);
  const s = new glvis.State(env.div, 640, 480, env.canvas);
  renderer.failDisplay = new Error("boom");
  await assert.rejects(() => s.display(stream(1)), /boom/);
  // the failure must not pretend the renderer is set up or the loop started
  assert.strictEqual(s.emsetup_, false, "emsetup_ must be unset");
  assert.strictEqual(s._renderer_ready_, false);
  assert.strictEqual(s._vis_loop_active_, false);
  assert.strictEqual(s._display_failed_, true);
  // and a fresh State is untouched by another State's failure
  assert.deepStrictEqual(
    {
      emsetup: state.emsetup_,
      ready: state._renderer_ready_,
      loop: state._vis_loop_active_,
    },
    before
  );
});

test("a failed first display is retried as a display, not an update", async () => {
  const { renderer, state } = setup();
  renderer.failDisplay = new Error("first failure");
  await assert.rejects(() => state.display(stream(1)), /first failure/);
  await state.update(stream(2));
  assert.strictEqual(renderer.calls.updateStream.length, 0);
  assert.strictEqual(renderer.calls.displayStream.length, 2);
  assert.strictEqual(renderer.frameId, 2);
});

test("a stream that resizes the renderer is repaired before the next capture", async () => {
  const { env, renderer, state } = setup();
  await state.display(stream(1));
  // simulate the renderer changing its own resolution behind our back
  renderer.resizeWindow(33, 44);
  const buf = await state.getScreenBuffer(false);
  assert.deepStrictEqual([renderer.logicalW, renderer.logicalH], [640, 480]);
  assert.strictEqual(buf.length, env.canvas.width * env.canvas.height * 4);
  assertAllSizesAgree(state, renderer, env, "after capture repair");
});

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------
test("public method signatures are unchanged", async () => {
  const { glvis } = setup();
  const proto = glvis.State.prototype;
  assert.strictEqual(proto.display.length, 1);
  assert.strictEqual(proto.update.length, 1);
  assert.strictEqual(proto.setSize.length, 2);
  assert.strictEqual(proto.setCanvasSize.length, 2);
  assert.strictEqual(proto.registerNewStreamCallback.length, 1);
  assert.strictEqual(proto.getScreenBuffer.length, 0); // default parameter
  assert.strictEqual(proto.getScreenBufferAsCanvas.length, 0);
  assert.strictEqual(proto.getPNGURL.length, 0);
  assert.strictEqual(proto.saveScreenshot.length, 0);
  assert.strictEqual(proto.loadUrl.length, 1);
  assert.strictEqual(proto.loadStream.length, 1);
  assert.strictEqual(proto.sendKey.length, 1); // trailing params have defaults
  assert.strictEqual(proto.sendKeyStr.length, 1);
  // display/update/setSize still return promises
  const s = setup();
  const p = s.state.display(stream(1));
  assert.ok(p && typeof p.then === "function");
  await p;
  const q = s.state.setSize(100, 100);
  assert.ok(q && typeof q.then === "function");
  await q;
});

test("new-stream callback registration keeps every callback", async () => {
  const { state } = setup();
  const calls = [];
  const fa = () => calls.push("a");
  const fb = () => calls.push("b");
  state.registerNewStreamCallback(fa);
  state.registerNewStreamCallback(fb);
  await state.display(stream(1));
  await state.display(stream(2));
  assert.deepStrictEqual(calls, ["a", "b", "a", "b"]);
  // callbacks are not invoked by a plain update
  calls.length = 0;
  await state.update(stream(3));
  assert.deepStrictEqual(calls, []);
});

test("a callback that displays another stream does not deadlock", async () => {
  const { state } = setup();
  let armed = true;
  state.registerNewStreamCallback((s) => {
    if (armed) {
      armed = false;
      s.display(stream(99));
    }
  });
  await state.display(stream(1));
  await flushMicrotasks(16);
  const p = state.display(stream(2));
  await p;
  assert.strictEqual(state.canvas_.width > 0, true);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const { name, fn } of results) {
    current = name;
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL - ${name}`);
      console.log(indent(e && e.stack ? e.stack : String(e)));
    }
  }
  current = null;
  console.log(
    `\n${results.length - failed}/${results.length} passed` +
      (failed ? `, ${failed} failed` : "")
  );
  process.exitCode = failed ? 1 : 0;
})();

function indent(s) {
  return String(s)
    .split("\n")
    .map((l) => "       " + l)
    .join("\n");
}
