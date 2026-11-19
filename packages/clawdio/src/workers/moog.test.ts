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
import { MoogModule } from "clawdio-moog";

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve("clawdio-moog/clawdio_moog_bg.wasm");

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

describe("MoogWorklet", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Processor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any;

  beforeEach(async () => {
    installWorkletGlobals();
    ({ default: Processor } = await import("./moog"));
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
    send({
      type: "init-module",
      data: { cutoff: 0.065, resonance: 3.5 },
    });
    await flushMicrotasks();
  };

  it("preserves the wasm-loaded handshake contract", async () => {
    await handshake();

    const types = (processor.port.messages as { type: string }[]).map(
      (m) => m.type,
    );
    expect(types).toContain("wasm-loaded");
    expect(processor.worklet).toBeInstanceOf(MoogModule);
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
    const setCutoff = vi.spyOn(MoogModule.prototype, "set_cutoff");
    const setResonance = vi.spyOn(MoogModule.prototype, "set_resonance");

    // Messages arrive before any WASM bytes: last write must win.
    send({ type: "set-cutoff", data: 0.2 });
    send({ type: "set-cutoff", data: 0.8 });
    send({ type: "set-resonance", data: 1.0 });
    send({ type: "set-resonance", data: 2.5 });

    await handshake();

    const appliedCutoff = setCutoff.mock.calls.map(([v]) => v);
    const appliedResonance = setResonance.mock.calls.map(([v]) => v);
    expect(appliedCutoff).toContain(0.8);
    expect(appliedCutoff).not.toContain(0.2);
    expect(appliedResonance).toContain(2.5);
    expect(appliedResonance).not.toContain(1.0);

    expect(processor.cutoff).toBe(0.8);
    expect(processor.resonance).toBe(2.5);
  });

  it("applies runtime set-* messages immediately to the live WASM module", async () => {
    await handshake();

    const setCutoff = vi.spyOn(MoogModule.prototype, "set_cutoff");
    const setResonance = vi.spyOn(MoogModule.prototype, "set_resonance");

    send({ type: "set-cutoff", data: 0.42 });
    send({ type: "set-resonance", data: 1.75 });

    expect(setCutoff).toHaveBeenLastCalledWith(0.42);
    expect(setResonance).toHaveBeenLastCalledWith(1.75);

    // The audible result actually changes with the new cutoff.
    const lowCut = makeIo(128);
    send({ type: "set-cutoff", data: 0.02 });
    processor.process(lowCut.inputs, lowCut.outputs);

    const highCut = makeIo(128);
    send({ type: "set-cutoff", data: 0.95 });
    processor.process(highCut.inputs, highCut.outputs);

    expect(Array.from(highCut.outputs[0][0])).not.toEqual(
      Array.from(lowCut.outputs[0][0]),
    );
    expect(allFinite(highCut.outputs)).toBe(true);
  });

  it("rejects illegal values without writing them to the module", async () => {
    await handshake();
    const setCutoff = vi.spyOn(MoogModule.prototype, "set_cutoff");
    const setResonance = vi.spyOn(MoogModule.prototype, "set_resonance");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const illegal of [Number.NaN, Number.NEGATIVE_INFINITY, "0.5"]) {
      send({ type: "set-cutoff", data: illegal });
      send({ type: "set-resonance", data: illegal });
    }

    expect(setCutoff).not.toHaveBeenCalled();
    expect(setResonance).not.toHaveBeenCalled();
    expect(processor.cutoff).toBe(0.065);
    expect(processor.resonance).toBe(3.5);
    expect(warn).toHaveBeenCalled();

    // The audio thread keeps working with the last legal parameters.
    const io = makeIo(32);
    expect(() => processor.process(io.inputs, io.outputs)).not.toThrow();
    expect(allFinite(io.outputs)).toBe(true);
  });

  it("clamps out-of-range values instead of rejecting them", async () => {
    await handshake();
    const setCutoff = vi.spyOn(MoogModule.prototype, "set_cutoff");
    const setResonance = vi.spyOn(MoogModule.prototype, "set_resonance");

    send({ type: "set-cutoff", data: 50 });
    send({ type: "set-resonance", data: -50 });

    expect(setCutoff).toHaveBeenLastCalledWith(1);
    expect(setResonance).toHaveBeenLastCalledWith(0);
    expect(processor.cutoff).toBe(1);
    expect(processor.resonance).toBe(0);
  });

  it("mutes output when processing throws and recovers on the next parameter update", async () => {
    await handshake();

    const processSpy = vi
      .spyOn(MoogModule.prototype, "process")
      .mockImplementationOnce(() => {
        throw new Error("simulated WASM failure");
      });

    const failed = makeIo(16);
    expect(() =>
      processor.process(failed.inputs, failed.outputs),
    ).not.toThrow();
    expect(isSilent(failed.outputs)).toBe(true);
    expect(processSpy).toHaveBeenCalled();

    const stillMuted = makeIo(16);
    processor.process(stillMuted.inputs, stillMuted.outputs);
    expect(isSilent(stillMuted.outputs)).toBe(true);

    // A successful parameter update clears the failure state.
    vi.spyOn(MoogModule.prototype, "set_cutoff");
    send({ type: "set-cutoff", data: 0.3 });

    const recovered = makeIo(16);
    processor.process(recovered.inputs, recovered.outputs);
    expect(isSilent(recovered.outputs)).toBe(false);
    expect(allFinite(recovered.outputs)).toBe(true);

    processSpy.mockRestore();
  });

  it("reports wasm-load-failed and stays silent, then recovers after a successful re-init", async () => {
    send({ type: "init-wasm", data: new Uint8Array([1, 2, 3, 4]).buffer });
    await waitForMessage(processor.port, "wasm-load-failed");

    const muted = makeIo(8);
    processor.process(muted.inputs, muted.outputs);
    expect(isSilent(muted.outputs)).toBe(true);
    expect(processor.wasmStatus.wasmFailed).toBe(true);

    // Parameters arriving during the outage are cached, not lost.
    send({ type: "set-resonance", data: 1.25 });

    const setResonance = vi.spyOn(MoogModule.prototype, "set_resonance");
    await handshake();
    expect(setResonance).toHaveBeenLastCalledWith(1.25);
    expect(processor.worklet).toBeInstanceOf(MoogModule);
    expect(processor.wasmStatus.wasmFailed).toBe(false);
    expect(processor.processingFailed).toBe(false);

    const recovered = makeIo(128);
    processor.process(recovered.inputs, recovered.outputs);
    expect(isSilent(recovered.outputs)).toBe(false);
    expect(allFinite(recovered.outputs)).toBe(true);
  });
});
