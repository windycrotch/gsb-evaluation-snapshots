import { describe, it, expect } from "vitest";
// Importing registers the processor via the global registerProcessor stub.
import "../pink-noise";
import { createWorkletHarness } from "./harness";

const startHarness = (bufferSize = 4096) =>
  createWorkletHarness(
    "clawdio-pink-noise",
    "clawdio-pink-noise",
    { bufferSize }
  );

describe("PinkNoiseWorklet behavior does not regress", () => {
  it("generates the requested buffer size of finite samples", async () => {
    const harness = await startHarness(2048);
    const output = new Float32Array(2048);
    harness.processor.process([], [[output]]);

    expect(output).toHaveLength(2048);
    expect(Array.from(output).every(Number.isFinite)).toBe(true);
  });

  it("keeps every sample inside the [-1, 1) amplitude contract", async () => {
    const harness = await startHarness(4096);
    const output = new Float32Array(4096);
    harness.processor.process([], [[output]]);

    for (const sample of output) {
      expect(Math.abs(sample)).toBeLessThan(1);
    }
  });

  it("produces varying (non-constant) pink noise", async () => {
    const harness = await startHarness(4096);
    const output = new Float32Array(4096);
    harness.processor.process([], [[output]]);

    expect(new Set(Array.from(output)).size).toBeGreaterThan(100);
  });

  it("stays bounded across a long run of many blocks", async () => {
    const harness = await startHarness(1024);
    let total = 0;
    for (let block = 0; block < 50; block++) {
      const output = new Float32Array(1024);
      harness.processor.process([], [[output]]);
      for (const sample of output) {
        expect(Number.isFinite(sample)).toBe(true);
        expect(Math.abs(sample)).toBeLessThan(1);
        total++;
      }
    }
    expect(total).toBe(50 * 1024);
  }, 10000);
});
