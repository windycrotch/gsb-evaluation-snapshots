import { describe, expect, it } from 'vitest';
import { ModuleKind } from '../src/types/graph';
import { GraphRuntime } from '../src/worklet/GraphRuntime';
import { BLOCK, cable, countProcessCalls, mod, patch, renderBlocks, rms } from './patchFixtures';

const { ATTEN, OUTPUT } = ModuleKind;

const close = (actual: number, expected: number, digits = 4) =>
  expect(actual).toBeCloseTo(expected, digits);

/** Reads one sample that should be constant across the whole block. */
const constant = (runtime: GraphRuntime, id: string) => {
  const module = runtime.getModule(id)!;
  const port = Object.keys(module.outputs)[0] ?? 'out';
  const buffer = module.outputs[port];
  for (let i = 1; i < BLOCK; i += 1) {
    expect(buffer[i]).toBe(buffer[0]);
  }
  return buffer[0];
};

describe('dependency ordering', () => {
  it('sorts a chain by its cables, not by declaration order or zero in-degree', () => {
    // Declared backwards: the engine must still run src -> a -> b -> out.
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('out', OUTPUT, { drive: 0.2 }),
          mod('b', ATTEN, { gain: 0.5, offset: 0 }),
          mod('a', ATTEN, { gain: 2, offset: 0 }),
          mod('src', ATTEN, { gain: 0, offset: 2 }),
        ],
        [
          cable('src', 'out', 'a', 'in'),
          cable('a', 'out', 'b', 'in'),
          cable('b', 'out', 'out', 'in'),
        ]
      )
    );

    expect(runtime.processingOrder).toEqual(['src', 'a', 'b', 'out']);

    const counts = ['src', 'a', 'b', 'out'].map((id) => countProcessCalls(runtime.getModule(id)!));
    renderBlocks(runtime, 3);

    // One block: 2V -> ×2 = 4V -> ×0.5 = 2V.
    close(constant(runtime, 'src'), 2);
    close(constant(runtime, 'a'), 4);
    close(constant(runtime, 'b'), 2);
    // Every module ran once per block — no re-entrant processing.
    for (const count of counts) expect(count.count).toBe(3);
  });
});

describe('feedback loops', () => {
  it('keeps a two-module ring sounding, in a deterministic order, with one block of delay', () => {
    // a and b feed each other; out taps a. Declared out, b, a.
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('out', OUTPUT, { drive: 0.2 }),
          mod('b', ATTEN, { gain: 0.5, offset: 0 }),
          mod('a', ATTEN, { gain: 1, offset: 1 }),
        ],
        [cable('a', 'out', 'b', 'in'), cable('b', 'out', 'a', 'in'), cable('a', 'out', 'out', 'in')]
      )
    );

    // Cycle members are laid out along the ring; the cable that closes the
    // loop (a -> b) reads a's previous block.
    expect(runtime.processingOrder).toEqual(['b', 'a', 'out']);

    const counts = ['b', 'a', 'out'].map((id) => countProcessCalls(runtime.getModule(id)!));

    const a = runtime.getModule('a')!;
    const b = runtime.getModule('b')!;
    const out = runtime.getModule('out')!;
    const { left } = renderBlocks(runtime, 1);
    // Block 1: b sees a's pre-roll (0V) -> 0V; a = b + 1V -> 1V.
    close(b.outputs.out[0], 0);
    close(a.outputs.out[0], 1);
    close(out.outputs.out[0], 1);
    expect(rms(left)).toBeGreaterThan(0);

    // Block 2: b sees a's block-1 output (1V) -> 0.5V; a = 0.5 + 1 -> 1.5V.
    renderBlocks(runtime, 1);
    close(b.outputs.out[0], 0.5);
    close(a.outputs.out[0], 1.5);

    // Block 3: b <- 1.5 * 0.5 = 0.75V; a -> 1.75V.
    renderBlocks(runtime, 1);
    close(b.outputs.out[0], 0.75);
    close(a.outputs.out[0], 1.75);

    // And it settles rather than dropping to silence: a -> 2, b -> 1.
    renderBlocks(runtime, 200);
    close(a.outputs.out[0], 2);
    close(b.outputs.out[0], 1);
    for (const count of counts) expect(count.count).toBe(203);
  });

  it('handles a self-patch with exactly one block of delay', () => {
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [mod('out', OUTPUT, { drive: 0.2 }), mod('self', ATTEN, { gain: 0.5, offset: 1 })],
        [cable('self', 'out', 'self', 'in'), cable('self', 'out', 'out', 'in')]
      )
    );

    expect(runtime.processingOrder).toEqual(['self', 'out']);
    const counts = countProcessCalls(runtime.getModule('self')!);

    // y[n] = 0.5 * y[n-1] + 1, starting from a zero pre-roll.
    const expected = [1, 1.5, 1.75, 1.875];
    for (const value of expected) {
      renderBlocks(runtime, 1);
      close(runtime.getModule('self')!.outputs.out[0], value);
    }
    expect(counts.count).toBe(expected.length);
  });

  it('runs branches hanging off a cycle after the cycle and keeps them sounding', () => {
    // Cycle a <-> b; c taps a and drives a chain c -> d; e dead-ends off b.
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('out', OUTPUT, { drive: 0.2 }),
          mod('e', ATTEN, { gain: 1, offset: 0 }),
          mod('d', ATTEN, { gain: 2, offset: 0 }),
          mod('c', ATTEN, { gain: 3, offset: 0 }),
          mod('b', ATTEN, { gain: 0.5, offset: 0 }),
          mod('a', ATTEN, { gain: 1, offset: 1 }),
        ],
        [
          cable('a', 'out', 'b', 'in'),
          cable('b', 'out', 'a', 'in'),
          cable('a', 'out', 'c', 'in'),
          cable('c', 'out', 'd', 'in'),
          cable('d', 'out', 'out', 'in'),
          cable('b', 'out', 'e', 'in'),
        ]
      )
    );

    // The cycle comes first because it has no acyclic feeders; the branches
    // that touch it come after it (c needs a), and d needs c.
    expect(runtime.processingOrder).toEqual(['b', 'a', 'e', 'c', 'd', 'out']);

    const counts = ['a', 'b', 'c', 'd', 'e', 'out'].map((id) =>
      countProcessCalls(runtime.getModule(id)!)
    );
    renderBlocks(runtime, 40);

    // a settles at 2V, b at 1V; the branches see the same-block values.
    close(constant(runtime, 'a'), 2);
    close(constant(runtime, 'b'), 1);
    close(constant(runtime, 'c'), 6);
    close(constant(runtime, 'e'), 1);
    close(constant(runtime, 'd'), 12);
    for (const count of counts) expect(count.count).toBe(40);
  });
});

describe('banana stacking', () => {
  it('sums two cables into the same input by voltage', () => {
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('s1', ATTEN, { gain: 0, offset: 2 }),
          mod('s2', ATTEN, { gain: 0, offset: 3 }),
          mod('sum', ATTEN, { gain: 1, offset: 0 }),
          mod('out', OUTPUT, { drive: 0.2 }),
        ],
        [
          cable('s1', 'out', 'sum', 'in'),
          cable('s2', 'out', 'sum', 'in'),
          cable('sum', 'out', 'out', 'in'),
        ]
      )
    );

    expect(runtime.processingOrder).toEqual(['s1', 's2', 'sum', 'out']);
    renderBlocks(runtime, 2);

    const sum = runtime.getModule('sum')!;
    for (let i = 0; i < BLOCK; i += 1) {
      expect(sum.inputs.in[i]).toBeCloseTo(5, 5);
    }
    close(constant(runtime, 'sum'), 5);
  });

  it('sums three cables of mixed sign into an input, including into a cycle', () => {
    // Three sources stack into the ring node a; a also feeds back from b.
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('s1', ATTEN, { gain: 0, offset: 2 }),
          mod('s2', ATTEN, { gain: 0, offset: 3 }),
          mod('s3', ATTEN, { gain: 0, offset: -1.5 }),
          mod('b', ATTEN, { gain: 0.5, offset: 0 }),
          mod('a', ATTEN, { gain: 1, offset: 0 }),
          mod('out', OUTPUT, { drive: 0.2 }),
        ],
        [
          cable('s1', 'out', 'a', 'in'),
          cable('s2', 'out', 'a', 'in'),
          cable('s3', 'out', 'a', 'in'),
          cable('a', 'out', 'b', 'in'),
          cable('b', 'out', 'a', 'in'),
          cable('a', 'out', 'out', 'in'),
        ]
      )
    );

    expect(runtime.processingOrder).toEqual(['s1', 's2', 's3', 'b', 'a', 'out']);
    renderBlocks(runtime, 3);

    // 2 + 3 - 1.5 = 3.5V into a, plus b's delayed feedback: a = 3.5 + 0.5*a_prev
    // settles at 7V, b at 3.5V.
    renderBlocks(runtime, 200);
    close(constant(runtime, 'a'), 7);
    close(constant(runtime, 'b'), 3.5);

    const a = runtime.getModule('a')!;
    for (let i = 0; i < BLOCK; i += 1) {
      expect(a.inputs.in[i]).toBeCloseTo(7, 4);
    }
  });
});

describe('live parameter changes inside a cycle', () => {
  it('keeps producing output after parameters change mid-run', () => {
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [
          mod('out', OUTPUT, { drive: 1 }),
          mod('b', ATTEN, { gain: 0.5, offset: 0 }),
          mod('a', ATTEN, { gain: 1, offset: 1 }),
        ],
        [cable('a', 'out', 'b', 'in'), cable('b', 'out', 'a', 'in'), cable('a', 'out', 'out', 'in')]
      )
    );

    const order = runtime.processingOrder;
    const counts = ['a', 'b', 'out'].map((id) => countProcessCalls(runtime.getModule(id)!));

    let { left } = renderBlocks(runtime, 20);
    expect(rms(left)).toBeGreaterThan(0.05);
    const before = runtime.getModule('a')!.outputs.out[0];
    close(before, 2);

    // Change the in-loop offset and gain while the engine is running.
    expect(runtime.setParam('a', 'offset', 2)).toBe(true);
    expect(runtime.setParam('b', 'gain', 0.25)).toBe(true);

    ({ left } = renderBlocks(runtime, 40));
    const after = runtime.getModule('a')!.outputs.out[0];
    // New fixed point: a = 2 + 0.25a -> 2.6667V.
    close(after, 8 / 3);
    expect(after).not.toBeCloseTo(before, 2);
    expect(rms(left)).toBeGreaterThan(0.05);

    // Every sample is finite and the loop did not lose its voice.
    for (const sample of left) expect(Number.isFinite(sample)).toBe(true);
    expect(runtime.processingOrder).toEqual(order);
    for (const count of counts) expect(count.count).toBe(60);
  });
});

describe('reload safety', () => {
  it('recovers from a cycle without leaking module instances', () => {
    const runtime = new GraphRuntime();
    runtime.loadGraph(
      patch(
        [mod('out', OUTPUT, { drive: 0.2 }), mod('a', ATTEN, { gain: 0.5, offset: 1 })],
        [cable('a', 'out', 'a', 'in'), cable('a', 'out', 'out', 'in')]
      )
    );
    renderBlocks(runtime, 5);

    runtime.loadGraph(
      patch(
        [mod('out', OUTPUT, { drive: 0.2 }), mod('a', ATTEN, { gain: 0.5, offset: 1 })],
        [cable('a', 'out', 'a', 'in'), cable('a', 'out', 'out', 'in')]
      )
    );
    expect(runtime.processingOrder).toEqual(['a', 'out']);
    renderBlocks(runtime, 1);
    close(runtime.getModule('a')!.outputs.out[0], 1);
  });
});
