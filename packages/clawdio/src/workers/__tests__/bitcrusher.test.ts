import { describe, it, expect } from "vitest";
import { BitcrusherModule } from "clawdio-bitcrusher";
// Importing registers the processor via the global registerProcessor stub.
import "../bitcrusher";
import { createWorkletHarness, loadWasmBytes } from "./harness";
import { getRegisteredProcessor } from "./setup";

type Processor = {
  worklet: {
    process: (samples: Float32Array, normfreq: number) => Float32Array;
    free: () => void;
  } | null;
  bits: number;
  normfreq: number;
  port: { deliver: (data: unknown) => void; outbound: unknown[] };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

const sine = (n: number, step = 0.1): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin(i * step));

const distinctCount = (values: Float32Array): number =>
  new Set(Array.from(values)).size;

const allFinite = (values: Float32Array): boolean =>
  Array.from(values).every(Number.isFinite);

const startHarness = (bits = 4, normfreq = 0.5) =>
  createWorkletHarness("clawdio-bitcrusher", "clawdio-bitcrusher", {
    bits,
    normfreq,
  });

const microtask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BitcrusherWorklet runtime parameter updates", () => {
  it("applies set-bits to subsequent audio blocks", async () => {
    const harness = await startHarness(2, 0.5);

    const coarse = harness.processBlock(sine(512));
    await harness.send({ type: "set-bits", data: 12 });
    const fine = harness.processBlock(sine(512));

    expect(distinctCount(fine)).toBeGreaterThan(distinctCount(coarse));
    expect((harness.processor as unknown as Processor).bits).toBe(12);
    expect(harness.messages).not.toContainEqual(
      expect.objectContaining({ type: "set-bits-failed" })
    );
  });

  it("applies set-normfreq to subsequent audio blocks", async () => {
    const harness = await startHarness(4, 0.05);
    const slow = harness.processBlock(sine(512));

    await harness.send({ type: "set-normfreq", data: 1.0 });
    const fast = harness.processBlock(sine(512));

    // Higher normfreq holds each quantized value for fewer samples, so more
    // distinct values appear over the same window.
    expect(distinctCount(fast)).toBeGreaterThanOrEqual(distinctCount(slow));
    expect((harness.processor as unknown as Processor).normfreq).toBe(1.0);
  });

  it("makes the last of a burst of rapid setters win", async () => {
    const harness = await startHarness(4, 0.5);
    const values = [8, 3, 10, 5, 14, 2, 11];

    // Fire all messages before another render quantum runs, mimicking a
    // slider scrubbed far faster than the audio block rate.
    await Promise.all(
      values.map((bits) => harness.send({ type: "set-bits", data: bits }))
    );

    const processor = harness.processor as unknown as Processor;
    expect(processor.bits).toBe(11);

    // Output under the final module must match a fresh node built at 11 bits.
    const reference = await startHarness(11, 0.5);
    const input = sine(256);
    const actual = harness.processBlock(input);
    const expected = reference.processBlock(input);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it("keeps audio continuous across a rebuild (no click/zero gap)", async () => {
    const harness = await startHarness(4, 0.4);
    const before = harness.processBlock(sine(256));
    const tail = before[before.length - 1];

    await harness.send({ type: "set-bits", data: 9 });
    const after = harness.processBlock(sine(4));

    // Rebuilt module adopted the old held sample: first new sample matches.
    expect(Math.abs(after[0] - tail)).toBeLessThan(1e-6);
    expect(allFinite(after)).toBe(true);
  });

  it("falls back to the old module when a rebuild fails (no silence, no throw)", async () => {
    const RealCtor = getRegisteredProcessor(
      "clawdio-bitcrusher"
    ) as unknown as { new (): Processor };

    let failNextConstruction = false;
    class FailingBitcrusher extends (RealCtor as unknown as new () => object) {
      protected createModule(bits: number): BitcrusherModule {
        if (failNextConstruction) {
          throw new Error("simulated wasm allocation failure");
        }
        return BitcrusherModule.new(bits);
      }
    }

    const harness = await createWorkletHarness(
      "clawdio-bitcrusher",
      "clawdio-bitcrusher",
      { bits: 4, normfreq: 0.5 },
      FailingBitcrusher as never
    );
    // Untouched reference that never receives the failed rebuild, so its
    // internal phaser/held-sample state evolves identically to the fallback.
    const reference = await startHarness(4, 0.5);

    const input = sine(128);
    expect(Array.from(harness.processBlock(input))).toEqual(
      Array.from(reference.processBlock(input))
    );

    failNextConstruction = true;
    // Must not throw into the test even though construction fails.
    await expect(
      harness.send({ type: "set-bits", data: 10 })
    ).resolves.toBeUndefined();

    // Failure was reported observably...
    expect(harness.messages).toContainEqual(
      expect.objectContaining({ type: "set-bits-failed" })
    );

    // ...and the old module keeps producing exactly what an untouched node
    // would - not silence, not a half-built module.
    const nextInput = sine(128, 0.09);
    expect(Array.from(harness.processBlock(nextInput))).toEqual(
      Array.from(reference.processBlock(nextInput))
    );
    expect(distinctCount(harness.processBlock(sine(128, 0.11)))).toBeGreaterThan(
      1
    );

    // Recovery: once construction works again, updates flow through.
    failNextConstruction = false;
    await harness.send({ type: "set-bits", data: 12 });
    const recovered = harness.processBlock(sine(128));
    expect((harness.processor as unknown as Processor).bits).toBe(12);
    expect(distinctCount(recovered)).toBeGreaterThan(1);
  });

  it("stays finite and bounded over a long run with parameter churn", async () => {
    const harness = await startHarness(4, 0.3);
    const outputs = harness.processBlocks(200, (block) => {
      if (block % 7 === 0) {
        void harness.send({ type: "set-bits", data: 1 + (block % 16) });
      }
      if (block % 11 === 0) {
        void harness.send({
          type: "set-normfreq",
          data: 0.05 + (block % 19) * 0.05,
        });
      }
      return sine(128, 0.08);
    });
    // Let the queued microtask messages settle.
    await microtask();

    const all = outputs.flatMap((o) => Array.from(o));
    expect(all.every(Number.isFinite)).toBe(true);
    expect(Math.max(...all.map(Math.abs))).toBeLessThanOrEqual(1);
  }, 10000);

  it("tolerates setters called before WASM initialization without crashing", async () => {
    const Ctor = getRegisteredProcessor(
      "clawdio-bitcrusher"
    ) as unknown as { new (): Processor };

    // Setters first, initialization handshake second.
    const late = new Ctor();
    expect(() => {
      late.port.deliver({ type: "set-bits", data: 6 });
      late.port.deliver({ type: "set-normfreq", data: 0.9 });
      // No module yet: process() must simply keep returning true.
      expect(late.process([], [])).toBe(true);
    }).not.toThrow();
    await microtask();

    late.port.deliver({
      type: "init-wasm",
      data: loadWasmBytes("clawdio-bitcrusher"),
    });
    await microtask();
    late.port.deliver({
      type: "init-module",
      data: { bits: 4, normfreq: 0.2 },
    });
    await microtask();

    // Pending values were folded into module creation - nothing dropped.
    expect(late.bits).toBe(6);
    expect(late.normfreq).toBe(0.9);

    const out = new Float32Array(64);
    expect(late.process([[sine(64)]], [[out]])).toBe(true);
    expect(allFinite(out)).toBe(true);
  });

  it("sanitizes non-finite and out-of-range parameter values", async () => {
    const harness = await startHarness(4, 0.3);
    await harness.send({ type: "set-bits", data: Number.NaN });
    expect((harness.processor as unknown as Processor).bits).toBe(1);
    await harness.send({ type: "set-bits", data: 9999 });
    expect((harness.processor as unknown as Processor).bits).toBe(32);
    await harness.send({
      type: "set-normfreq",
      data: Number.POSITIVE_INFINITY,
    });
    expect((harness.processor as unknown as Processor).normfreq).toBe(0);

    const out = harness.processBlock(sine(64));
    expect(allFinite(out)).toBe(true);
  });
});
