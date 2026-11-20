import { beforeEach, describe, expect, test, vi } from "vitest";

// The freeze processor is a plain AudioWorkletProcessor: module-level globals
// (`sampleRate`, `registerProcessor`, `AudioWorkletProcessor`) are all it needs.
// Installing them lets the real DSP run under Node, so these tests check the
// audio itself rather than a mock.

const SR = 44100;
const BLOCK = 128;
const TONE_HZ = 440;

type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

let Registered: new () => Processor;

const send = (processor: Processor, data: unknown) => processor.port.onmessage!({ data });

const installWorkletGlobals = () => {
  const globals = globalThis as Record<string, unknown>;
  globals.sampleRate = SR;
  globals.registerProcessor = (_name: string, ctor: new () => Processor) => {
    Registered = ctor;
  };
  globals.AudioWorkletProcessor = class {
    port: Processor["port"] = { onmessage: null, postMessage: () => {} };
  };
};

const makeProcessor = async () => {
  vi.resetModules();
  installWorkletGlobals();
  await import("../../src/audio/freezeProcessor");
  return new Registered();
};

const sine = (length: number, frequency = TONE_HZ, amplitude = 0.5) =>
  Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / SR));

/** A recording whose first half is a tone and second half is silence. */
const halfTone = () => {
  const data = new Float32Array(SR);
  data.set(sine(SR / 2), 0);
  return data;
};

const block = () => [new Float32Array(BLOCK), new Float32Array(BLOCK)];

const render = (processor: Processor, blocks: number) => {
  const out = block();
  let peak = 0;
  let energy = 0;
  for (let b = 0; b < blocks; b++) {
    processor.process([], [out]);
    for (let i = 0; i < BLOCK; i++) {
      const sample = Math.abs(out[0][i]);
      peak = Math.max(peak, sample);
      energy += sample * sample;
    }
  }
  return { out, peak, rms: Math.sqrt(energy / (blocks * BLOCK)) };
};

const collect = (processor: Processor, blocks: number) => {
  const out = block();
  const frames: Float32Array[] = [];
  for (let b = 0; b < blocks; b++) {
    processor.process([], [out]);
    frames.push(out[0].slice());
  }
  return frames;
};

const load = (processor: Processor, channels: Float32Array[]) => send(processor, { type: "load", channels });
const jump = (processor: Processor, position: number) => send(processor, { type: "seek", position, jump: true });
const glide = (processor: Processor, position: number) => send(processor, { type: "seek", position, jump: false });
const active = (processor: Processor, on: boolean) => send(processor, { type: "active", active: on });

beforeEach(() => vi.resetModules());

describe("activation", () => {
  test("nothing is emitted before the worklet is active, even after a load and seek", async () => {
    const processor = await makeProcessor();
    expect(render(processor, 4).peak).toBe(0);
    load(processor, [sine(SR), sine(SR)]);
    jump(processor, 0.25);
    expect(render(processor, 8).peak).toBe(0);
  });

  test("activating before any load is inert rather than throwing", async () => {
    const processor = await makeProcessor();
    active(processor, true);
    expect(() => render(processor, 4)).not.toThrow();
    expect(render(processor, 4).peak).toBe(0);
  });

  test("a loaded, active freeze emits the recording's content", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR), sine(SR)]);
    jump(processor, 0.25);
    active(processor, true);
    const { peak, rms } = render(processor, 40);
    expect(peak).toBeGreaterThan(0.3);
    expect(rms).toBeGreaterThan(0.2);
  });

  test("deactivating stops output immediately and reactivating restores it", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR), sine(SR)]);
    jump(processor, 0.25);
    active(processor, true);
    render(processor, 20);

    active(processor, false);
    expect(render(processor, 5).peak).toBe(0);

    active(processor, true);
    expect(render(processor, 20).peak).toBeGreaterThan(0.3);
  });
});

describe("seek and jump", () => {
  test("a jump resets the vocoder, so a silent region is silent rather than echoing old frames", async () => {
    const processor = await makeProcessor();
    load(processor, [halfTone(), halfTone()]);
    jump(processor, 0.1);
    active(processor, true);
    expect(render(processor, 40).peak).toBeGreaterThan(0.3);

    jump(processor, 0.8);
    expect(render(processor, 1).peak).toBe(0);

    const fresh = await makeProcessor();
    load(fresh, [halfTone(), halfTone()]);
    jump(fresh, 0.8);
    active(fresh, true);
    expect(render(fresh, 1).peak).toBe(0);
  });

  test("a jump to a new position starts from the new frames, independent of what played before", async () => {
    const channel = sine(SR, 300);
    const played = await makeProcessor();
    load(played, [channel, channel]);
    jump(played, 0.2);
    active(played, true);
    render(played, 60);
    jump(played, 0.6);
    const afterJump = render(played, 8);

    const fresh = await makeProcessor();
    load(fresh, [channel, channel]);
    jump(fresh, 0.6);
    active(fresh, true);
    const fromFresh = render(fresh, 8);

    let maxDiff = 0;
    for (let i = 0; i < BLOCK; i++) maxDiff = Math.max(maxDiff, Math.abs(afterJump.out[0][i] - fromFresh.out[0][i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  test("a smooth seek glides toward the target instead of hard-cutting", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR, 220), sine(SR, 220)]);
    jump(processor, 0.1);
    active(processor, true);
    render(processor, 20);
    glide(processor, 0.6);
    // A gliding seek keeps output continuous; it never has to reset frames.
    const first = render(processor, 1).peak;
    const second = render(processor, 1).peak;
    expect(first).toBeGreaterThan(0.3);
    expect(second).toBeGreaterThan(0.3);
  });

  test("seeking before a load does not throw and takes effect once loaded", async () => {
    const processor = await makeProcessor();
    jump(processor, 0.4);
    active(processor, true);
    expect(() => render(processor, 2)).not.toThrow();
    load(processor, [sine(SR), sine(SR)]);
    active(processor, true);
    expect(render(processor, 20).peak).toBeGreaterThan(0.3);
  });
});

describe("channel handling", () => {
  test("mono content fills every output channel", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR)]);
    jump(processor, 0.3);
    active(processor, true);
    const out = block();
    for (let b = 0; b < 20; b++) processor.process([], [out]);
    let diff = 0;
    for (let i = 0; i < BLOCK; i++) diff = Math.max(diff, Math.abs(out[0][i] - out[1][i]));
    expect(diff).toBe(0);
    expect(Math.max(...out[0]) - Math.min(...out[0])).toBeGreaterThan(0);
  });

  test("reloading with a different channel count rebuilds the voices", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR, 220)]);
    jump(processor, 0.2);
    active(processor, true);
    expect(render(processor, 20).peak).toBeGreaterThan(0.3);

    load(processor, [sine(SR, 220), sine(SR, 330)]);
    active(processor, true);
    expect(render(processor, 20).peak).toBeGreaterThan(0.3);
  });
});

describe("timing", () => {
  test("a held position is a steady snapshot: consecutive blocks have equal level", async () => {
    const processor = await makeProcessor();
    load(processor, [sine(SR), sine(SR)]);
    jump(processor, 0.5);
    active(processor, true);
    render(processor, 20);

    const out = block();
    const peaks: number[] = [];
    for (let b = 0; b < 32; b++) {
      processor.process([], [out]);
      let peak = 0;
      for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(out[0][i]));
      peaks.push(peak);
    }
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeLessThan(1.02);
  });

  test("processing an inactive processor leaves the held snapshot untouched", async () => {
    const channel = sine(SR, 330);
    const setup = async () => {
      const processor = await makeProcessor();
      load(processor, [channel, channel]);
      jump(processor, 0.5);
      active(processor, true);
      render(processor, 8);
      return processor;
    };

    // Control: goes quiet but is never invoked while idle.
    const control = await setup();
    active(control, false);
    active(control, true);
    const expected = collect(control, 8);

    // Subject: the host keeps calling process() throughout the silence.
    const idle = await setup();
    active(idle, false);
    render(idle, 200);
    active(idle, true);
    const actual = collect(idle, 8);

    let maxDiff = 0;
    for (let b = 0; b < expected.length; b++) {
      for (let i = 0; i < BLOCK; i++) maxDiff = Math.max(maxDiff, Math.abs(actual[b][i] - expected[b][i]));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });
});
