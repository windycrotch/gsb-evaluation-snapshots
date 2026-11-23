import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBitcrusherProcessor } from "../src/workers/bitcrusherProcessor.ts";
import { createMoogProcessor } from "../src/workers/moogProcessor.ts";
import type { ProcessorPort } from "../src/workers/effectProcessor.ts";

/**
 * End-to-end worklet tests against the *real* Rust/WASM modules.
 *
 * Fixtures come from `node scripts/build-test-wasm.mjs` and are gitignored, so
 * the suite skips itself when Rust is not available. This is the layer that
 * proves a parameter actually reaches Rust rather than only the JS wrapper:
 * the exact `init(WebAssembly.compile(bytes))` flow used by the worklets is
 * wired through the same port messages the AudioWorkletNode posts.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures", "wasm");

const loadFixture = async (name: string) => {
  const dir = path.join(fixtureRoot, name);
  const jsPath = path.join(dir, `${name}.js`);
  if (!existsSync(jsPath)) return null;

  const glue = await import(pathToFileURL(jsPath).href);
  const wasmPath = path.join(dir, `${name}_bg.wasm`);
  const bytes = readFileSync(wasmPath);

  return {
    glue,
    /** Same signature as the `init` export the worklets import. */
    initWasm: (module: Promise<WebAssembly.Module>) => glue.default(module),
    /** Payload the main thread ships to `init-wasm`. */
    wasmBytes: () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ),
  };
};

const bitcrusherFixture = await loadFixture("clawdio_bitcrusher");
const moogFixture = await loadFixture("clawdio_moog");

const missing = !bitcrusherFixture || !moogFixture;
const skip = missing
  ? "WASM fixtures missing - run `node scripts/build-test-wasm.mjs`"
  : false;

type SentMessage = Record<string, unknown> & { type: string };

const createPort = () => {
  const sent: SentMessage[] = [];
  const port: ProcessorPort = {
    postMessage: (message) => sent.push(message as SentMessage),
    close: () => {},
  };
  return { port, sent };
};

const ramp = (length: number) => {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = i / length;
  return samples;
};

const renderBlock = (
  processor: { process: (i: Float32Array[][], o: Float32Array[][]) => boolean },
  input: Float32Array
) => {
  const outputs = [[new Float32Array(input.length)]];
  processor.process([[input]], outputs);
  return outputs[0][0];
};

/** Wait until `predicate` is true (WASM compile is async). */
const waitFor = async (
  predicate: () => boolean,
  { timeout = 3000, interval = 5 } = {}
) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return predicate();
};

const setupBitcrusher = async (options: { bits: number; normfreq: number }) => {
  const fixture = bitcrusherFixture!;
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, {
    initWasm: fixture.initWasm,
    createModule: (bits) => fixture.glue.BitcrusherModule.new(bits),
  });

  // Drive the real protocol: init-wasm -> wasm-loaded -> init-module.
  state.effect.handle({ type: "init-wasm", data: fixture.wasmBytes() });
  await waitFor(() => sent.some((message) => message.type === "wasm-loaded"));
  state.effect.handle({ type: "init-module", data: options });

  return { state, sent };
};

const setupMoog = async (options: { cutoff: number; resonance: number }) => {
  const fixture = moogFixture!;
  const { port, sent } = createPort();
  const state = createMoogProcessor(port, {
    initWasm: fixture.initWasm,
    createModule: (cutoff, resonance) =>
      fixture.glue.MoogModule.new(cutoff, resonance),
  });

  state.effect.handle({ type: "init-wasm", data: fixture.wasmBytes() });
  await waitFor(() => sent.some((message) => message.type === "wasm-loaded"));
  state.effect.handle({ type: "init-module", data: options });

  return { state, sent };
};

test("real WASM: init-wasm handshake produces the wasm-loaded reply", { skip }, async () => {
  const fixture = bitcrusherFixture!;
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, {
    initWasm: fixture.initWasm,
    createModule: (bits) => fixture.glue.BitcrusherModule.new(bits),
  });

  state.effect.handle({ type: "init-wasm", data: fixture.wasmBytes() });
  assert.ok(
    await waitFor(() =>
      sent.some((message) => message.type === "wasm-loaded")
    ),
    "worklet should report when WASM is compiled"
  );

  // Duplicate init-wasm must not double-load.
  state.effect.handle({ type: "init-wasm", data: fixture.wasmBytes() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    sent.filter((message) => message.type === "wasm-loaded").length,
    1
  );
});

test("real WASM: bit depth changes are audible without rebuilding", { skip }, async () => {
  const { state } = await setupBitcrusher({ bits: 2, normfreq: 1 });

  const input = ramp(128);
  const coarse = renderBlock(state.effect, input);
  const coarseLevels = new Set(Array.from(coarse)).size;
  assert.ok(coarseLevels <= 5, `expected coarse levels, got ${coarseLevels}`);

  state.effect.handle({ type: "set-bits", data: 16 });
  const fine = renderBlock(state.effect, input);
  const fineLevels = new Set(Array.from(fine)).size;

  assert.ok(
    fineLevels > coarseLevels,
    `16-bit should have more levels (${fineLevels} vs ${coarseLevels})`
  );
  assert.equal(state.effect.valueOf("bits"), 16);
});

/** Indices (>=1) where the bitcrusher held a new sample. */
const updateIndices = (samples: Float32Array) => {
  const indices: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] !== samples[i - 1]) indices.push(i);
  }
  return indices;
};

test("real WASM: changing bits keeps the phaser phase continuous", { skip }, async () => {
  const sampleCount = 256;
  const fullRamp = ramp(sampleCount);

  // Reference: a module that always used 16 bits. The update *schedule* only
  // depends on normfreq, so its second-half indices are the ground truth.
  const reference = await setupBitcrusher({ bits: 16, normfreq: 0.3 });
  const referenceOut = renderBlock(reference.state.effect, fullRamp);
  const referenceUpdates = updateIndices(
    referenceOut.subarray(sampleCount / 2)
  );

  // Subject: 2 bits for the first half, then switch to 16 bits. If `setBits`
  // rebuilt the module (or reset the phaser) the second-half schedule would
  // differ from the reference.
  const subject = await setupBitcrusher({ bits: 2, normfreq: 0.3 });
  renderBlock(subject.state.effect, fullRamp.subarray(0, sampleCount / 2));
  subject.state.effect.handle({ type: "set-bits", data: 16 });
  const subjectOut = renderBlock(
    subject.state.effect,
    fullRamp.subarray(sampleCount / 2)
  );

  assert.ok(referenceUpdates.length > 0, "expected the reference to update");
  assert.deepEqual(updateIndices(subjectOut), referenceUpdates);
});

test("real WASM: rejected bits keep the previous value and report an error", { skip }, async () => {
  const { state, sent } = await setupBitcrusher({ bits: 6, normfreq: 0.5 });
  state.effect.handle({ type: "set-bits", data: 8 });
  sent.length = 0;

  state.effect.handle({ type: "set-bits", data: 0 });
  state.effect.handle({ type: "set-bits", data: -4 });
  state.effect.handle({ type: "set-bits", data: Number.NaN });

  assert.equal(state.effect.valueOf("bits"), 8);
  const errors = sent.filter((message) => message.type === "parameter-error");
  assert.equal(errors.length, 3);
  for (const error of errors) {
    assert.equal(
      (error.data as { parameter: string }).parameter,
      "bits"
    );
  }

  // Still producing audio with the last legal bit depth.
  const out = renderBlock(state.effect, ramp(64));
  assert.ok(out.some((sample) => sample !== 0));
});

test("real WASM: slider before init still takes effect", { skip }, async () => {
  const fixture = bitcrusherFixture!;
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, {
    initWasm: fixture.initWasm,
    createModule: (bits) => fixture.glue.BitcrusherModule.new(bits),
  });

  // User dragged the slider before WASM finished compiling.
  state.effect.handle({ type: "set-bits", data: 3 });
  state.effect.handle({ type: "set-normfreq", data: 1 });

  // Rendering while the module is missing is silent but harmless.
  const preInit = renderBlock(state.effect, ramp(8));
  assert.ok(preInit.every((sample) => sample === 0));

  state.effect.handle({ type: "init-wasm", data: fixture.wasmBytes() });
  await waitFor(() => sent.some((message) => message.type === "wasm-loaded"));
  state.effect.handle({ type: "init-module", data: { bits: 8, normfreq: 0.1 } });

  assert.equal(state.effect.valueOf("bits"), 3);
  const out = renderBlock(state.effect, ramp(128));
  const levels = new Set(Array.from(out)).size;
  assert.ok(levels <= 9, `queued 3-bit setting was not applied (${levels})`);
});

test("real WASM: moog cutoff change alters output and keeps filter state", { skip }, async () => {
  const { state } = await setupMoog({ cutoff: 0.05, resonance: 0.5 });

  const input = Float32Array.from(ramp(256), (value) =>
    Math.sin(value * 40)
  );
  const low = renderBlock(state.effect, input);
  const lowEnergy = low.reduce((sum, sample) => sum + Math.abs(sample), 0);

  state.effect.handle({ type: "set-cutoff", data: 1 });
  const high = renderBlock(state.effect, input);
  const highEnergy = high.reduce((sum, sample) => sum + Math.abs(sample), 0);

  assert.equal(state.effect.valueOf("cutoff"), 1);
  assert.ok(
    highEnergy > lowEnergy,
    `opening the cutoff should pass more signal (${highEnergy} vs ${lowEnergy})`
  );
  assert.ok(high.every((sample) => Number.isFinite(sample)));
});

test("real WASM: moog rejects illegal cutoff/resonance and keeps sounding", { skip }, async () => {
  const { state, sent } = await setupMoog({ cutoff: 0.6, resonance: 2 });
  sent.length = 0;

  state.effect.handle({ type: "set-cutoff", data: 1.4 });
  state.effect.handle({ type: "set-resonance", data: Number.NaN });

  assert.equal(state.effect.valueOf("cutoff"), 0.6);
  assert.equal(state.effect.valueOf("resonance"), 2);
  assert.equal(
    sent.filter((message) => message.type === "parameter-error").length,
    2
  );

  const out = renderBlock(state.effect, ramp(128));
  assert.ok(out.some((sample) => Math.abs(sample) > 1e-6), "expected audio");
});

test("real WASM: rapid toggling settles on the last legal request", { skip }, async () => {
  const { state } = await setupMoog({ cutoff: 0.1, resonance: 1 });

  for (const value of [0.2, 0.3, Number.NaN, 0.55, 2.0, 0.7]) {
    state.effect.handle({ type: "set-cutoff", data: value });
  }
  for (const value of [2, 3, Number.NaN, -1, 6.5]) {
    state.effect.handle({ type: "set-resonance", data: value });
  }

  assert.equal(state.effect.valueOf("cutoff"), 0.7);
  assert.equal(state.effect.valueOf("resonance"), 6.5);
});

test("real WASM: disposal frees the module and stops rendering", { skip }, async () => {
  const { state } = await setupMoog({ cutoff: 0.4, resonance: 1 });

  const module = state.effect.module!;
  let freed = 0;
  (module as { free: () => void }).free = () => {
    freed += 1;
  };

  state.effect.handle({ type: "dispose" });
  assert.equal(freed, 1);
  assert.equal(state.effect.disposed, true);

  const out = renderBlock(state.effect, ramp(8));
  assert.ok(out.every((sample) => sample === 0));
});
