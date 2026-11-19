import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeMessagePort,
  allFinite,
  flushMicrotasks,
  installWorkletGlobals,
  isSilent,
  makeIo,
} from "./test-harness";
import { BitcrusherModule } from "clawdio-bitcrusher";

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve(
  "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm",
);

/**
 * Raw WASM bytes — the worklet contract sends an `ArrayBuffer` in the
 * `init-wasm` message and compiles it itself (see `initWasm`).
 */
const loadWasmBytes = (): ArrayBuffer => {
  const bytes = readFileSync(WASM_PATH);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
};

const waitForMessage = async (
  port: FakeMessagePort,
  type: string,
  timeoutMs = 5000,
): Promise<unknown> => {
  const start = Date.now();
  for (;;) {
    const match = port.messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === type,
    );
    if (match) return match;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for "${type}" message. Got: ${JSON.stringify(
          port.messages,
        )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("BitcrusherWorklet", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Processor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any;

  beforeEach(async () => {
    installWorkletGlobals();
    ({ default: Processor } = await import("./bitcrusher"));
    processor = new Processor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const send = (data: unknown) =>
    (processor.port as FakeMessagePort).onmessage?.({ data });

  const handshake = async () => {
    send({ type: "init-wasm", data: loadWasmBytes() });
    await waitForMessage(processor.port, "wasm-loaded");
    // Mirror the main-thread contract: init-module follows wasm-loaded.
    send({ type: "init-module", data: { bits: 4, normfreq: 0.1 } });
    await flushMicrotasks();
  };

  it("preserves the wasm-loaded handshake contract", async () => {
    await handshake();

    const types = (processor.port.messages as { type: string }[]).map(
      (m) => m.type,
    );
    expect(types).toContain("wasm-loaded");
    expect(processor.worklet).toBeInstanceOf(BitcrusherModule);
  });

  it("emits silence before the WASM module is ready", () => {
    const io = makeIo();
    const keepAlive = processor.process(io.inputs, io.outputs);

    expect(keepAlive).toBe(true);
    expect(isSilent(io.outputs)).toBe(true);
  });

  it("processes audio and only emits finite samples once ready", async () => {
    await handshake();

    const io = makeIo(128);
    processor.process(io.inputs, io.outputs);

    expect(isSilent(io.outputs)).toBe(false);
    expect(allFinite(io.outputs)).toBe(true);
  });

  it("caches parameters set before the module is ready and applies the last one", async () => {
    const setBits = vi.spyOn(BitcrusherModule.prototype, "set_bits");
    const setNormfreq = vi.spyOn(BitcrusherModule.prototype, "set_normfreq");

    // Messages arrive before any WASM bytes: last write must win.
    send({ type: "set-bits", data: 2 });
    send({ type: "set-bits", data: 9 });
    send({ type: "set-normfreq", data: 0.3 });
    send({ type: "set-normfreq", data: 0.7 });

    await handshake();

    const appliedBits = setBits.mock.calls.map(([v]) => v);
    const appliedNormfreq = setNormfreq.mock.calls.map(([v]) => v);
    expect(appliedBits).toContain(9);
    expect(appliedBits).not.toContain(2);
    expect(appliedNormfreq).toContain(0.7);
    expect(appliedNormfreq).not.toContain(0.3);

    // Local fields converged on the last values too.
    expect(processor.bits).toBe(9);
    expect(processor.normfreq).toBe(0.7);
  });

  it("applies runtime set-* messages immediately to the live WASM module", async () => {
    await handshake();

    const setBits = vi.spyOn(BitcrusherModule.prototype, "set_bits");
    const setNormfreq = vi.spyOn(BitcrusherModule.prototype, "set_normfreq");

    send({ type: "set-bits", data: 12 });
    send({ type: "set-normfreq", data: 0.55 });

    expect(setBits).toHaveBeenLastCalledWith(12);
    expect(setNormfreq).toHaveBeenLastCalledWith(0.55);

    // The audible result actually changes with the new parameters.
    const before = makeIo(64);
    send({ type: "set-bits", data: 2 });
    processor.process(before.inputs, before.outputs);

    const after = makeIo(64);
    send({ type: "set-bits", data: 14 });
    processor.process(after.inputs, after.outputs);

    expect(Array.from(after.outputs[0][0])).not.toEqual(
      Array.from(before.outputs[0][0]),
    );
    expect(allFinite(after.outputs)).toBe(true);
  });

  it("rejects illegal values without writing them to the module", async () => {
    await handshake();
    const setBits = vi.spyOn(BitcrusherModule.prototype, "set_bits");
    const setNormfreq = vi.spyOn(BitcrusherModule.prototype, "set_normfreq");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const illegal of [Number.NaN, Number.POSITIVE_INFINITY, "8"]) {
      send({ type: "set-bits", data: illegal });
      send({ type: "set-normfreq", data: illegal });
    }

    expect(setBits).not.toHaveBeenCalled();
    expect(setNormfreq).not.toHaveBeenCalled();
    expect(processor.bits).toBe(4);
    expect(processor.normfreq).toBe(0.1);
    expect(warn).toHaveBeenCalled();

    // The audio thread keeps working with the last legal parameters.
    const io = makeIo(32);
    expect(() => processor.process(io.inputs, io.outputs)).not.toThrow();
    expect(allFinite(io.outputs)).toBe(true);
  });

  it("clamps out-of-range values instead of rejecting them", async () => {
    await handshake();
    const setBits = vi.spyOn(BitcrusherModule.prototype, "set_bits");
    const setNormfreq = vi.spyOn(BitcrusherModule.prototype, "set_normfreq");

    send({ type: "set-bits", data: 999 });
    send({ type: "set-normfreq", data: -5 });

    expect(setBits).toHaveBeenLastCalledWith(16);
    expect(setNormfreq).toHaveBeenLastCalledWith(0);
    expect(processor.bits).toBe(16);
    expect(processor.normfreq).toBe(0);
  });

  it("mutes output when processing throws and recovers on the next parameter update", async () => {
    await handshake();

    const originalProcess = BitcrusherModule.prototype.process;
    const processSpy = vi
      .spyOn(BitcrusherModule.prototype, "process")
      .mockImplementationOnce(() => {
        throw new Error("simulated WASM failure");
      });

    const failed = makeIo(16);
    expect(() =>
      processor.process(failed.inputs, failed.outputs),
    ).not.toThrow();
    expect(isSilent(failed.outputs)).toBe(true);
    expect(processSpy).toHaveBeenCalled();

    // Still muted on the following block while flagged.
    const stillMuted = makeIo(16);
    processor.process(stillMuted.inputs, stillMuted.outputs);
    expect(isSilent(stillMuted.outputs)).toBe(true);

    // A successful parameter update clears the failure state.
    vi.spyOn(BitcrusherModule.prototype, "set_bits");
    send({ type: "set-bits", data: 6 });

    const recovered = makeIo(16);
    processor.process(recovered.inputs, recovered.outputs);
    expect(isSilent(recovered.outputs)).toBe(false);
    expect(allFinite(recovered.outputs)).toBe(true);

    // Restore for any subsequent assertions.
    processSpy.mockRestore();
    expect(originalProcess).toBeDefined();
  });

  it("reports wasm-load-failed and stays silent, then recovers after a successful re-init", async () => {
    // Garbage bytes fail WebAssembly.compile inside the init promise.
    send({ type: "init-wasm", data: new Uint8Array([1, 2, 3, 4]).buffer });
    await waitForMessage(processor.port, "wasm-load-failed");

    const muted = makeIo(8);
    processor.process(muted.inputs, muted.outputs);
    expect(isSilent(muted.outputs)).toBe(true);
    expect(processor.wasmStatus.wasmFailed).toBe(true);

    // Parameters arriving during the outage are cached, not lost.
    send({ type: "set-bits", data: 7 });

    // Recovery: valid bytes re-trigger the handshake and a fresh module.
    const setBits = vi.spyOn(BitcrusherModule.prototype, "set_bits");
    await handshake();
    expect(setBits).toHaveBeenLastCalledWith(7);
    expect(processor.worklet).toBeInstanceOf(BitcrusherModule);
    expect(processor.wasmStatus.wasmFailed).toBe(false);
    expect(processor.processingFailed).toBe(false);

    // Processing runs again (no exception) and emits finite samples.
    const recovered = makeIo(64);
    expect(() =>
      processor.process(recovered.inputs, recovered.outputs),
    ).not.toThrow();
    expect(allFinite(recovered.outputs)).toBe(true);

    // And with normfreq 1 every sample is re-quantized, so the output
    // demonstrably differs from the muted (all-zero) state.
    send({ type: "set-normfreq", data: 1 });
    const audible = makeIo(64);
    processor.process(audible.inputs, audible.outputs);
    expect(isSilent(audible.outputs)).toBe(false);
  });
});
