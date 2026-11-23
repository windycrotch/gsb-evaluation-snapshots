import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PARAMETERS } from "../src/shared/parameters.ts";
import {
  createBitcrusherProcessor,
  type BitcrusherWasmBindings,
  type BitcrusherWasmModule,
} from "../src/workers/bitcrusherProcessor.ts";
import type { ProcessorPort } from "../src/workers/effectProcessor.ts";

type SentMessage = Record<string, unknown> & { type: string };

type SentErrorData = {
  parameter: string;
  value: unknown;
  message: string;
};

const errorPayload = (message: SentMessage): SentErrorData =>
  message.data as SentErrorData;

const createPort = () => {
  const sent: SentMessage[] = [];
  const port: ProcessorPort = {
    postMessage: (message) => sent.push(message as SentMessage),
    close: () => {},
  };
  return { port, sent };
};

/**
 * Fake WASM module that mirrors the contract of the real `BitcrusherModule`
 * (including refusing illegal bit depths) while recording every call.
 */
const createFakeBindings = () => {
  const applied: Array<{ bits: number; at: number }> = [];
  let instanceCount = 0;
  let clock = 0;

  const bindings: BitcrusherWasmBindings & {
    applied: typeof applied;
    instanceCount: () => number;
  } = {
    initWasm: async () => {
      clock += 1;
      return {};
    },
    createModule: (bits) => {
      instanceCount += 1;
      let current = bits;
      applied.push({ bits, at: clock });
      const module: BitcrusherWasmModule = {
        setBits(value) {
          if (!Number.isInteger(value) || value < 1 || value > 32) return false;
          current = value;
          applied.push({ bits: value, at: clock });
          return true;
        },
        process(samples, normfreq) {
          const out = new Float32Array(samples.length);
          if (!(normfreq > 0)) return out;
          const step = 1 / Math.pow(2, current);
          for (let i = 0; i < samples.length; i++) {
            out[i] = Math.round(samples[i] / step) * step;
          }
          return out;
        },
      };
      return module;
    },
    applied,
    instanceCount: () => instanceCount,
  };

  return bindings;
};

/** Arguments shaped like an AudioWorklet `process(inputs, outputs)` call. */
const createBuffers = (length: number, fill = 0.25) => {
  const input = [new Float32Array(length).fill(fill)];
  const output = [new Float32Array(length)];
  return { inputs: [input], outputs: [output], outputSamples: output[0] };
};

test("parameters sent before init-module are not lost", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());

  // Race: the user drags the slider while WASM is still compiling.
  state.effect.handle({ type: "set-bits", data: 8 });
  state.effect.handle({ type: "set-normfreq", data: 0.75 });

  assert.equal(state.effect.isReady, false);
  assert.equal(state.effect.pendingCount, 2);

  // Rendering before the module exists must not throw and must stay silent.
  const { inputs, outputs, outputSamples } = createBuffers(8);
  assert.equal(state.effect.process(inputs, outputs), true);
  assert.ok(outputSamples.every((sample) => sample === 0));

  // Initialisation flushes the queue on top of the constructor defaults.
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  assert.equal(state.effect.isReady, true);
  assert.equal(state.effect.pendingCount, 0);
  assert.equal(state.effect.valueOf("bits"), 8);
  assert.equal(state.effect.valueOf("normfreq"), 0.75);
});

test("init-module applies the last value requested before it arrived", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());

  state.effect.handle({ type: "set-bits", data: 3 });
  state.effect.handle({ type: "set-bits", data: 6 });
  state.effect.handle({ type: "set-bits", data: 12 });
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  assert.equal(state.effect.valueOf("bits"), 12);
});

test("a rejected update keeps the previous parameters working", () => {
  const { port, sent } = createPort();
  const bindings = createFakeBindings();
  const state = createBitcrusherProcessor(port, bindings);

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.5 } });
  state.effect.handle({ type: "set-bits", data: 2 });
  sent.length = 0;

  state.effect.handle({ type: "set-bits", data: 0 });
  state.effect.handle({ type: "set-bits", data: -8 });
  state.effect.handle({ type: "set-bits", data: Number.NaN });

  assert.equal(state.effect.valueOf("bits"), 2, "illegal values must be ignored");

  const errors = sent.filter((message) => message.type === "parameter-error");
  assert.equal(errors.length, 3, "each rejection must be reported");
  for (const error of errors) {
    const data = errorPayload(error);
    assert.equal(data.parameter, "bits");
    assert.match(data.message, /Invalid bits/);
  }

  // Audio keeps flowing with the last legal bit depth.
  const { inputs, outputs, outputSamples } = createBuffers(16, 0.3);
  state.effect.process(inputs, outputs);
  assert.ok(outputSamples.some((sample) => sample !== 0), "expected audio");
  assert.ok(outputSamples.every((sample) => Number.isFinite(sample)));
});

test("rapid toggling ends on the last legal request", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  const sequence = [1, 2, 3, Number.NaN, 5, 0, 7, -3, 9];
  for (const value of sequence) {
    state.effect.handle({ type: "set-bits", data: value });
  }

  assert.equal(state.effect.valueOf("bits"), 9);
});

test("repeated init-module does not rebuild the module", () => {
  const { port } = createPort();
  const bindings = createFakeBindings();
  const state = createBitcrusherProcessor(port, bindings);

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });
  const first = state.effect.module;

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });
  state.effect.handle({ type: "init-module", data: { bits: 6, normfreq: 0.2 } });

  assert.equal(bindings.instanceCount(), 1, "module must be created once");
  assert.equal(state.effect.module, first, "state must be preserved");
  assert.equal(state.effect.valueOf("bits"), 6);
});

test("switching bits changes the rendered audio", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());
  state.effect.handle({ type: "init-module", data: { bits: 2, normfreq: 1 } });

  const coarse = createBuffers(32, 0.37);
  state.effect.process(coarse.inputs, coarse.outputs);
  state.effect.handle({ type: "set-bits", data: 16 });
  const fine = createBuffers(32, 0.37);
  state.effect.process(fine.inputs, fine.outputs);

  const differences = coarse.outputSamples.filter(
    (sample, index) => sample !== fine.outputSamples[index]
  ).length;
  assert.ok(differences > 0, "changing bits must affect output");
  assert.ok(
    Math.abs(fine.outputSamples[0] - 0.37) <
      Math.abs(coarse.outputSamples[0] - 0.37),
    "more bits should track the input more closely"
  );
});

test("normfreq updates reach the next process block", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());
  state.effect.handle({
    type: "init-module",
    data: { bits: 8, normfreq: 0 },
  });

  const silent = createBuffers(16, 0.5);
  state.effect.process(silent.inputs, silent.outputs);
  assert.ok(silent.outputSamples.every((sample) => sample === 0));

  state.effect.handle({ type: "set-normfreq", data: 1 });
  const loud = createBuffers(16, 0.5);
  state.effect.process(loud.inputs, loud.outputs);
  assert.ok(loud.outputSamples.some((sample) => sample !== 0));
});

test("init-module replaces illegal initial values with the defaults", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());

  assert.doesNotThrow(() =>
    state.effect.handle({
      type: "init-module",
      data: { bits: 0, normfreq: 99 },
    })
  );
  assert.equal(state.effect.valueOf("bits"), DEFAULT_PARAMETERS.bits);
  assert.equal(state.effect.valueOf("normfreq"), DEFAULT_PARAMETERS.normfreq);
});

test("init-module tolerates a missing payload", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());

  assert.doesNotThrow(() => state.effect.handle({ type: "init-module" }));
  assert.equal(state.effect.valueOf("bits"), DEFAULT_PARAMETERS.bits);
  assert.equal(
    state.effect.valueOf("normfreq"),
    DEFAULT_PARAMETERS.normfreq
  );
});

test("dispose frees the module, stops the processor and ignores later messages", () => {
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });
  const module = state.effect.module as BitcrusherWasmModule & {
    free: () => void;
  };
  let freed = 0;
  module.free = () => {
    freed += 1;
  };

  state.effect.handle({ type: "dispose" });
  assert.equal(freed, 1);
  assert.equal(state.effect.isReady, false);
  assert.equal(state.effect.disposed, true);

  // After disposal the processor tells Web Audio to stop calling it.
  const { inputs, outputs } = createBuffers(8);
  assert.equal(state.effect.process(inputs, outputs), false);

  // Late slider events are ignored rather than resurrecting state.
  sent.length = 0;
  state.effect.handle({ type: "set-bits", data: 5 });
  state.effect.handle({ type: "init-module", data: { bits: 5, normfreq: 0.1 } });
  assert.equal(state.effect.isReady, false);
  assert.equal(sent.length, 0, "no messages after dispose");
});

test("dispose is idempotent", () => {
  const { port } = createPort();
  const state = createBitcrusherProcessor(port, createFakeBindings());
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  state.effect.handle({ type: "dispose" });
  assert.doesNotThrow(() => state.effect.handle({ type: "dispose" }));
});

test("a throwing module is reported once and does not kill the processor", () => {
  const { port, sent } = createPort();
  const bindings = createFakeBindings();
  const state = createBitcrusherProcessor(port, bindings);
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  const module = state.effect.module as BitcrusherWasmModule;
  module.process = () => {
    throw new Error("wasm boom");
  };

  const first = createBuffers(8);
  assert.equal(state.effect.process(first.inputs, first.outputs), true);
  const second = createBuffers(8);
  assert.equal(state.effect.process(second.inputs, second.outputs), true);

  const errors = sent.filter((message) => message.type === "processing-error");
  assert.equal(errors.length, 1, "processing errors are reported once");
  assert.match(
    (errors[0].data as { message: string }).message,
    /wasm boom/
  );
});

test("non-finite samples from the module never reach the output", () => {
  const { port } = createPort();
  const bindings = createFakeBindings();
  const state = createBitcrusherProcessor(port, bindings);
  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  const module = state.effect.module as BitcrusherWasmModule;
  module.process = (samples) => {
    const out = new Float32Array(samples.length);
    out[0] = Number.NaN;
    out[1] = Infinity;
    out[2] = 0.5;
    return out;
  };

  const { inputs, outputs, outputSamples } = createBuffers(4);
  state.effect.process(inputs, outputs);
  assert.deepEqual(Array.from(outputSamples), [0, 0, 0.5, 0]);
});
