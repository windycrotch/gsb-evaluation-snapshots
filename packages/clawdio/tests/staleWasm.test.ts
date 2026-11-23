import assert from "node:assert/strict";
import test from "node:test";

import { createBitcrusherProcessor } from "../src/workers/bitcrusherProcessor.ts";
import { createMoogProcessor } from "../src/workers/moogProcessor.ts";
import type { ProcessorPort } from "../src/workers/effectProcessor.ts";

/**
 * Guards against a stale WASM package: if the published `clawdio-*` build has
 * no live setters, the worklet must report a clear parameter error instead of
 * throwing a TypeError inside `process()`.
 */
const createPort = () => {
  const sent: Array<Record<string, unknown> & { type: string }> = [];
  const port: ProcessorPort = {
    postMessage: (message) =>
      sent.push(message as Record<string, unknown> & { type: string }),
    close: () => {},
  };
  return { port, sent };
};

const staleBitcrusher = {
  process: (samples: Float32Array) => new Float32Array(samples.length),
};

const staleMoog = {
  process: (samples: Float32Array) => new Float32Array(samples.length),
};

test("bitcrusher without setBits reports an error and keeps rendering", () => {
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, {
    initWasm: async () => ({}),
    createModule: () => staleBitcrusher as never,
  });

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.5 } });
  state.effect.handle({ type: "set-bits", data: 8 });

  const error = sent.find((message) => message.type === "parameter-error");
  assert.ok(error, "should report a parameter error");
  assert.match(
    (error.data as { message: string }).message,
    /rejected the bits update/
  );

  // Rendering still works (silence here) and does not throw.
  const outputs = [[new Float32Array(8)]];
  assert.doesNotThrow(() => state.effect.process([[new Float32Array(8)]], outputs));
});

test("moog without setters reports an error and keeps rendering", () => {
  const { port, sent } = createPort();
  const state = createMoogProcessor(port, {
    initWasm: async () => ({}),
    createModule: () => staleMoog as never,
  });

  state.effect.handle({
    type: "init-module",
    data: { cutoff: 0.5, resonance: 2 },
  });
  state.effect.handle({ type: "set-cutoff", data: 0.8 });
  state.effect.handle({ type: "set-resonance", data: 6 });

  const errors = sent.filter((message) => message.type === "parameter-error");
  // Two from flushing the initial values during attach, two from the explicit
  // updates: every rejected write is surfaced, not swallowed.
  const parameters = errors.map(
    (message) => (message.data as { parameter: string }).parameter
  );
  assert.ok(parameters.includes("cutoff"));
  assert.ok(parameters.includes("resonance"));
  assert.equal(errors.length, 4);

  // The values the user asked for are not claimed as applied.
  assert.equal(state.effect.valueOf("cutoff"), undefined);
  assert.equal(state.effect.valueOf("resonance"), undefined);

  const outputs = [[new Float32Array(8)]];
  assert.doesNotThrow(() => state.effect.process([[new Float32Array(8)]], outputs));
});
