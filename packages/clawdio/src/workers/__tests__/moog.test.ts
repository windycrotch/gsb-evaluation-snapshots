import { describe, it, expect } from "vitest";
import { MoogModule } from "clawdio-moog";
// Importing registers the processor via the global registerProcessor stub.
import "../moog";
import { createWorkletHarness, loadWasmBytes } from "./harness";
import { getRegisteredProcessor } from "./setup";

type Processor = {
  worklet: {
    process: (samples: Float32Array) => Float32Array;
  } | null;
  cutoff: number;
  resonance: number;
  port: { deliver: (data: unknown) => void; outbound: unknown[] };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

const sine = (n: number, step = 0.1): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin(i * step));

const impulse = (n: number): Float32Array => {
  const v = new Float32Array(n);
  v[0] = 1;
  return v;
};

const allFinite = (values: Float32Array): boolean =>
  Array.from(values).every(Number.isFinite);

const ringLength = (values: Float32Array, floor = 1e-5): number => {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Math.abs(values[i]) > floor) return i + 1;
  }
  return 0;
};

const startHarness = (cutoff = 0.3, resonance = 1.0) =>
  createWorkletHarness("clawdio-moog", "clawdio-moog", { cutoff, resonance });

const microtask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MoogWorklet runtime parameter updates", () => {
  it("applies set-cutoff to subsequent audio blocks", async () => {
    const harness = await startHarness(0.05, 0.0);

    const lowRing = ringLength(harness.processBlock(impulse(4096)));
    await harness.send({ type: "set-cutoff", data: 0.9 });
    const highRing = ringLength(harness.processBlock(impulse(4096)));

    expect(highRing).toBeLessThan(lowRing);
    expect((harness.processor as unknown as Processor).cutoff).toBe(0.9);
  });

  it("applies set-resonance to subsequent audio blocks", async () => {
    const harness = await startHarness(0.3, 0.0);
    const flat = harness.processBlock(sine(1024, 0.05));

    await harness.send({ type: "set-resonance", data: 3.5 });
    const resonant = harness.processBlock(sine(1024, 0.05));

    const energy = (v: Float32Array) =>
      Array.from(v).reduce((sum, x) => sum + x * x, 0);
    expect(Math.abs(energy(resonant) - energy(flat))).toBeGreaterThan(
      Number.EPSILON
    );
    expect((harness.processor as unknown as Processor).resonance).toBe(3.5);
  });

  it("makes the last of a burst of rapid setters win", async () => {
    const harness = await startHarness(0.2, 1.0);
    const cutoffs = [0.9, 0.01, 0.5, 0.13, 0.77];
    const resonances = [0.1, 4.0, 0.5, 2.2, 3.3];

    await Promise.all([
      ...cutoffs.map((cutoff) =>
        harness.send({ type: "set-cutoff", data: cutoff })
      ),
      ...resonances.map((resonance) =>
        harness.send({ type: "set-resonance", data: resonance })
      ),
    ]);

    const processor = harness.processor as unknown as Processor;
    expect(processor.cutoff).toBe(0.77);
    expect(processor.resonance).toBe(3.3);

    // The live WASM module must match a fresh node at the final parameters.
    const reference = await startHarness(0.77, 3.3);
    // Prime both filters identically first so their internal pole states
    // match, then compare a block under the final coefficients.
    const prime = sine(512, 0.11);
    harness.processBlock(prime);
    reference.processBlock(prime);
    const input = sine(256, 0.07);
    expect(Array.from(harness.processBlock(input))).toEqual(
      Array.from(reference.processBlock(input))
    );
  });

  it("keeps every output finite during parameter switching (no NaN/Inf)", async () => {
    const harness = await startHarness(0.2, 1.0);
    let previousTail = 0;

    for (let block = 0; block < 25; block++) {
      await harness.send({
        type: "set-cutoff",
        data: (block * 0.17) % 1.0,
      });
      await harness.send({
        type: "set-resonance",
        data: (block * 0.9) % 4.0,
      });

      const output = harness.processBlock(sine(256, 0.13));
      expect(allFinite(output)).toBe(true);
      // State is retained across the switch: no hard discontinuity at the
      // block boundary.
      expect(Math.abs(output[0] - previousTail)).toBeLessThan(0.5);
      previousTail = output[output.length - 1];
    }
  });

  it("survives a WASM setter failure and keeps the old parameters", async () => {
    const RealCtor = getRegisteredProcessor(
      "clawdio-moog"
    ) as unknown as { new (): Processor };

    let failSetter = false;
    class FailingMoog extends (RealCtor as unknown as new () => object) {
      protected createModule(cutoff: number, resonance: number) {
        const module = MoogModule.new(cutoff, resonance);
        // Wrap so the failure triggers when the worklet applies a new
        // parameter (set_cutoff), not only at construction time.
        return new Proxy(module, {
          get(target, prop, receiver) {
            if (
              failSetter &&
              (prop === "set_cutoff" || prop === "set_resonance")
            ) {
              return () => {
                throw new Error("simulated wasm trap");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        });
      }
    }

    const harness = await createWorkletHarness(
      "clawdio-moog",
      "clawdio-moog",
      { cutoff: 0.3, resonance: 1.0 },
      FailingMoog as never
    );
    // Parallel reference whose parameters never change, for exact output
    // comparison after the failed update.
    const reference = await startHarness(0.3, 1.0);

    const input = sine(128);
    expect(Array.from(harness.processBlock(input))).toEqual(
      Array.from(reference.processBlock(input))
    );

    failSetter = true;
    await expect(
      harness.send({ type: "set-cutoff", data: 0.9 })
    ).resolves.toBeUndefined();

    expect(harness.messages).toContainEqual(
      expect.objectContaining({ type: "set-params-failed" })
    );

    // Audio continues uninterrupted with the previously working module,
    // behaving exactly like a node that never got the failed update.
    const nextInput = sine(128, 0.09);
    expect(Array.from(harness.processBlock(nextInput))).toEqual(
      Array.from(reference.processBlock(nextInput))
    );

    failSetter = false;
    await harness.send({ type: "set-cutoff", data: 0.6 });
    expect((harness.processor as unknown as Processor).cutoff).toBe(0.6);
  });

  it("stays finite and bounded over a long run across the full parameter range", async () => {
    const harness = await startHarness(0.5, 2.0);
    const cutoffs = [0, 0.01, 0.5, 0.99, 1];
    const resonances = [0, 0.5, 3.5, 9.9, 10];

    for (let block = 0; block < 100; block++) {
      await harness.send({
        type: "set-cutoff",
        data: cutoffs[block % cutoffs.length],
      });
      await harness.send({
        type: "set-resonance",
        data: resonances[block % resonances.length],
      });
      const output = harness.processBlock(sine(512, 0.07));
      expect(allFinite(output)).toBe(true);
      // Rust-side clamp guarantees the [-1, 1] contract.
      expect(Array.from(output).every((v) => Math.abs(v) <= 1)).toBe(true);
    }
  }, 15000);

  it("tolerates setters called before WASM initialization without crashing", async () => {
    const Ctor = getRegisteredProcessor(
      "clawdio-moog"
    ) as unknown as { new (): Processor };

    const late = new Ctor();
    expect(() => {
      late.port.deliver({ type: "set-cutoff", data: 0.8 });
      late.port.deliver({ type: "set-resonance", data: 2.5 });
      expect(late.process([], [])).toBe(true);
    }).not.toThrow();
    await microtask();

    late.port.deliver({
      type: "init-wasm",
      data: loadWasmBytes("clawdio-moog"),
    });
    await microtask();
    late.port.deliver({
      type: "init-module",
      data: { cutoff: 0.065, resonance: 3.5 },
    });
    await microtask();

    expect(late.cutoff).toBe(0.8);
    expect(late.resonance).toBe(2.5);

    const out = new Float32Array(64);
    expect(late.process([[sine(64)]], [[out]])).toBe(true);
    expect(allFinite(out)).toBe(true);
  });

  it("sanitizes extreme parameters and NaN/Inf input into finite output", async () => {
    const harness = await startHarness(0.3, 1.0);
    await harness.send({ type: "set-cutoff", data: Number.NaN });
    expect((harness.processor as unknown as Processor).cutoff).toBe(0);
    await harness.send({
      type: "set-resonance",
      data: Number.POSITIVE_INFINITY,
    });
    expect((harness.processor as unknown as Processor).resonance).toBe(10);

    const poisoned = sine(128, 0.1);
    poisoned[10] = Number.NaN;
    poisoned[20] = Number.POSITIVE_INFINITY;
    const out = harness.processBlock(poisoned);
    expect(allFinite(out)).toBe(true);
    expect(Array.from(out).every((v) => Math.abs(v) <= 1)).toBe(true);
  });
});
