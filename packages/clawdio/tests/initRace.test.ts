import assert from "node:assert/strict";
import test from "node:test";

import { createBitcrusherProcessor } from "../src/workers/bitcrusherProcessor.ts";
import type { ProcessorPort } from "../src/workers/effectProcessor.ts";

const createPort = () => {
  const sent: Array<Record<string, unknown> & { type: string }> = [];
  const port: ProcessorPort = {
    postMessage: (message) =>
      sent.push(message as Record<string, unknown> & { type: string }),
    close: () => {},
  };
  return { port, sent };
};

const makeBindings = () => {
  let created = 0;
  let initCalls = 0;
  let resolveCompile: (() => void) | null = null;

  const bindings = {
    // Simulate a slow compile: resolves only when the test says so.
    initWasm: (module: Promise<WebAssembly.Module>) => {
      initCalls += 1;
      return new Promise<void>((resolve) => {
        resolveCompile = () => {
          module.then(() => resolve());
        };
      });
    },
    createModule: () => {
      created += 1;
      return {
        setBits: () => true,
        process: (samples: Float32Array) => new Float32Array(samples.length),
      };
    },
    get created() {
      return created;
    },
    get initCalls() {
      return initCalls;
    },
    compileDone: () => resolveCompile?.(),
  };

  return bindings;
};

/** Valid (empty) WebAssembly module bytes: magic + version. */
const EMPTY_WASM = () =>
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer;

test("init-module racing ahead of the WASM compile is deferred, not lost", async () => {
  const { port, sent } = createPort();
  const bindings = makeBindings();
  const state = createBitcrusherProcessor(port, bindings);

  state.effect.handle({ type: "init-wasm", data: EMPTY_WASM() });

  // Main thread races: init-module arrives before compile resolves.
  state.effect.handle({
    type: "init-module",
    data: { bits: 5, normfreq: 0.25 },
  });

  assert.equal(state.effect.isReady, false, "module cannot exist yet");
  assert.equal(bindings.created, 0, "constructor must not run before WASM");

  // The loader calls `init` on a microtask; let it register before completing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  bindings.compileDone();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(state.effect.isReady, true, "module built after compile");
  assert.equal(bindings.created, 1);
  assert.equal(state.effect.valueOf("bits"), 5);
  assert.equal(state.effect.valueOf("normfreq"), 0.25);
  assert.ok(sent.some((message) => message.type === "wasm-loaded"));
});

test("dispose while init is pending drops the deferred module build", async () => {
  const { port } = createPort();
  const bindings = makeBindings();
  const state = createBitcrusherProcessor(port, bindings);

  state.effect.handle({ type: "init-wasm", data: EMPTY_WASM() });
  state.effect.handle({
    type: "init-module",
    data: { bits: 5, normfreq: 0.25 },
  });
  state.effect.handle({ type: "dispose" });

  await new Promise((resolve) => setTimeout(resolve, 0));
  bindings.compileDone();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(state.effect.isReady, false);
  assert.equal(bindings.created, 0, "no module should be built after dispose");
});

test("a constructor that throws after WASM loaded is reported", async () => {
  const { port, sent } = createPort();
  const state = createBitcrusherProcessor(port, {
    initWasm: async () => ({}),
    createModule: () => {
      throw new Error("constructor exploded");
    },
  });

  // Complete the handshake first so the failure is not mistaken for "WASM not
  // ready yet".
  state.effect.handle({ type: "init-wasm", data: EMPTY_WASM() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(sent.some((message) => message.type === "wasm-loaded"));

  state.effect.handle({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });

  assert.equal(state.effect.isReady, false);
  const error = sent.find((message) => message.type === "wasm-error");
  assert.ok(error, "expected a wasm-error report");
  assert.match(
    (error!.data as { message: string }).message,
    /constructor exploded/
  );
});
