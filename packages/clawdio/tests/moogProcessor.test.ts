import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PARAMETERS } from "../src/shared/parameters.ts";
import {
  createMoogProcessor,
  type MoogWasmBindings,
  type MoogWasmModule,
} from "../src/workers/moogProcessor.ts";
import type { ProcessorPort } from "../src/workers/effectProcessor.ts";

type SentMessage = Record<string, unknown> & { type: string };

const createPort = () => {
  const sent: SentMessage[] = [];
  const port: ProcessorPort = {
    postMessage: (message) => sent.push(message as SentMessage),
    close: () => {},
  };
  return { port, sent };
};

/** Fake ladder filter mirroring `MoogModule`'s contract + validation. */
const createFakeBindings = () => {
  const applied: Array<{ cutoff: number; resonance: number }> = [];
  let instanceCount = 0;

  const bindings: MoogWasmBindings & { instanceCount: () => number } = {
    initWasm: async () => ({}),
    createModule: (cutoff, resonance) => {
      instanceCount += 1;
      applied.push({ cutoff, resonance });
      let state = 0;
      const module: MoogWasmModule = {
        setCutoff(value) {
          if (!Number.isFinite(value) || value < 0 || value > 1) return false;
          applied.push({ cutoff: value, resonance: -1 });
          return true;
        },
        setResonance(value) {
          if (!Number.isFinite(value) || value < 0 || value > 20) return false;
          applied.push({ cutoff: -1, resonance: value });
          return true;
        },
        process(samples) {
          // One-pole low pass; keeps `state` so we can prove continuity.
          const out = new Float32Array(samples.length);
          for (let i = 0; i < samples.length; i++) {
            state = state * 0.9 + samples[i] * 0.1;
            out[i] = state;
          }
          return out;
        },
      };
      return module;
    },
    instanceCount: () => instanceCount,
  };

  return bindings;
};

const createBuffers = (length: number, fill = 0.5) => {
  const input = [new Float32Array(length).fill(fill)];
  const output = [new Float32Array(length)];
  return { inputs: [input], outputs: [output], outputSamples: output[0] };
};

test("cutoff and resonance sent before init-module are queued, then applied", () => {
  const { port, sent } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());

  state.effect.handle({ type: "set-cutoff", data: 0.4 });
  state.effect.handle({ type: "set-resonance", data: 6 });

  assert.equal(state.effect.isReady, false);
  assert.equal(sent.length, 0, "legal pre-init updates must not error");

  const { inputs, outputs, outputSamples } = createBuffers(8);
  assert.doesNotThrow(() => state.effect.process(inputs, outputs));
  assert.ok(outputSamples.every((sample) => sample === 0));

  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.065, resonance: 3.5 },
  });

  assert.equal(state.effect.valueOf("cutoff"), 0.4);
  assert.equal(state.effect.valueOf("resonance"), 6);
});

test("illegal values are rejected with a field-specific error message", () => {
  const { port, sent } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());
  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.5, resonance: 4 },
  });
  sent.length = 0;

  const cases: Array<[string, unknown, string]> = [
    ["set-cutoff", 1.5, "cutoff"],
    ["set-cutoff", -0.1, "cutoff"],
    ["set-cutoff", Number.NaN, "cutoff"],
    ["set-resonance", Number.NaN, "resonance"],
    ["set-resonance", 1000, "resonance"],
  ];

  for (const [type, value, parameter] of cases) {
    state.effect.handle({ type, data: value });
    const error = sent.at(-1);
    assert.equal(error?.type, "parameter-error");
    const data = error?.data as { parameter: string; message: string };
    assert.equal(data.parameter, parameter);
    assert.match(data.message, new RegExp(`Invalid ${parameter}`));
  }

  assert.equal(state.effect.valueOf("cutoff"), 0.5);
  assert.equal(state.effect.valueOf("resonance"), 4);
});

test("audio keeps working after a rejected update", () => {
  const { port } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());
  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.3, resonance: 1 },
  });

  state.effect.handle({ type: "set-cutoff", data: 2 });
  state.effect.handle({ type: "set-resonance", data: Number.NaN });

  const { inputs, outputs, outputSamples } = createBuffers(32, 0.4);
  state.effect.process(inputs, outputs);

  assert.ok(outputSamples.some((sample) => sample !== 0));
  assert.ok(outputSamples.every((sample) => Number.isFinite(sample)));
});

test("rapid parameter changes finish on the last legal value", () => {
  const { port } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());

  // Interleave before init (queued) and after init (applied directly).
  state.effect.handle({ type: "set-cutoff", data: 0.2 });
  state.effect.handle({ type: "set-resonance", data: 2 });
  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.065, resonance: 3.5 },
  });

  for (const value of [0.3, 0.45, Number.NaN, 0.6, 1.2, 0.8]) {
    state.effect.handle({ type: "set-cutoff", data: value });
  }
  for (const value of [3, 4, Number.NaN, -1, 7.5]) {
    state.effect.handle({ type: "set-resonance", data: value });
  }

  assert.equal(state.effect.valueOf("cutoff"), 0.8);
  assert.equal(state.effect.valueOf("resonance"), 7.5);
});

test("repeated init-module does not reset the filter state", () => {
  const { port } = createPort();
  const bindings = createFakeBindings();
  const state = createMoogProcessor(port, bindings);
  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.2, resonance: 1 },
  });

  const first = createBuffers(8, 1);
  state.effect.process(first.inputs, first.outputs);

  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.2, resonance: 1 },
  });

  const second = createBuffers(8, 1);
  state.effect.process(second.inputs, second.outputs);

  assert.equal(bindings.instanceCount(), 1, "module must not be rebuilt");
  // The fake filter has memory, so the first sample of the second block must
  // continue from the previous value rather than restarting at 0.1.
  assert.ok(
    second.outputSamples[0] > 0.5,
    `state was reset (first sample ${second.outputSamples[0]})`
  );
});

test("missing init payload falls back to the documented defaults", () => {
  const { port } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());
  state.effect.handle({ type: "init-module", data: {} });

  assert.equal(state.effect.valueOf("cutoff"), DEFAULT_PARAMETERS.cutoff);
  assert.equal(state.effect.valueOf("resonance"), DEFAULT_PARAMETERS.resonance);
});

test("dispose frees the module and stops rendering", () => {
  const { port } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());
  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.3, resonance: 1 },
  });

  const module = state.effect.module as MoogWasmModule & { free: () => void };
  let freed = 0;
  module.free = () => {
    freed += 1;
  };

  state.effect.handle({ type: "dispose" });
  assert.equal(freed, 1);

  const { inputs, outputs } = createBuffers(8);
  assert.equal(state.effect.process(inputs, outputs), false);

  state.effect.handle({ type: "set-cutoff", data: 0.5 });
  assert.equal(state.effect.isReady, false);
});

test("unknown or malformed messages are ignored safely", () => {
  const { port, sent } = createPort();
  const state = createMoogProcessor(port, createFakeBindings());

  assert.doesNotThrow(() => {
    state.effect.handle(null);
    state.effect.handle(undefined);
    state.effect.handle(42);
    state.effect.handle("set-cutoff");
    state.effect.handle({});
    state.effect.handle({ type: 123 });
    state.effect.handle({ type: "set-unknown", data: 1 });
  });
  assert.equal(sent.length, 0);
  assert.equal(state.effect.isReady, false);
});
