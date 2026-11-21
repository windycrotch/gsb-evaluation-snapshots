/**
 * The frames of a sequence laid out in time (the thumbnails on the dopesheet): every span shows what `sequenceIndexAt` says plays there.
 */
import { describe, expect, it } from 'vitest';
import { SEQUENCE_MODES } from '../src/core/model';
import type { SequenceKey } from '../src/core/model';
import { sequenceIndexAt, sequenceSpans } from '../src/core/sequence';

const key = (time: number, mode: SequenceKey['mode'], index: number, delay: number): SequenceKey => ({ time, mode, index, delay });

/** The frame the runtime shows at `t`, kept inside the sequence the way the editor draws it. */
const played = (keys: SequenceKey[], t: number, count: number) => Math.min(count - 1, Math.max(0, sequenceIndexAt(keys, t, count)));

describe('sequenceSpans', () => {
  it('is one span for a held frame, from its key to the end', () => {
    expect(sequenceSpans([key(0.5, 'hold', 2, 0)], 5, 2)).toEqual([{ start: 0.5, end: 2, index: 2 }]);
  });

  it('leaves out the time before the first key and an empty timeline', () => {
    expect(sequenceSpans([key(1, 'hold', 0, 0)], 3, 2)[0].start).toBe(1);
    expect(sequenceSpans([], 3, 2)).toEqual([]);
  });

  it('steps a loop one frame per delay and ends at the next key', () => {
    const spans = sequenceSpans([key(0, 'loop', 0, 0.25), key(1, 'hold', 1, 0)], 3, 2);
    expect(spans.map((s) => s.index)).toEqual([0, 1, 2, 0, 1]);
    expect(spans[3].end).toBeCloseTo(1, 3);
    expect(spans[4].start).toBeCloseTo(1, 4);
    expect(spans[4]).toMatchObject({ end: 2, index: 1 });
  });

  it('plays once and stays on the last frame, merged into one span', () => {
    const spans = sequenceSpans([key(0, 'once', 0, 0.2)], 3, 2);
    expect(spans.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(spans[2].end).toBe(2);
  });

  it('covers a window only, with the spans cut at its edges', () => {
    const spans = sequenceSpans([key(0, 'loop', 0, 0.1)], 4, 10, 3.05, 3.35);
    expect(spans[0].start).toBeCloseTo(3.05, 9);
    expect(spans[spans.length - 1].end).toBeCloseTo(3.35, 9);
  });

  it('is cheap for a very small delay', () => {
    expect(sequenceSpans([key(0, 'loop', 0, 0.00001)], 4, 100).length).toBeLessThanOrEqual(2000);
  });

  it('treats a delay of zero as one held frame', () => {
    const spans = sequenceSpans([key(0, 'loop', 1, 0)], 4, 3);
    expect(spans).toEqual([{ start: 0, end: 3, index: 1 }]);
  });

  it('shows at every moment what sequenceIndexAt says, for every mode, with several keys', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let round = 0; round < 60; round++) {
      const count = 1 + Math.floor(rnd() * 8);
      const end = 1 + rnd() * 3;
      const n = 1 + Math.floor(rnd() * 4);
      const times = Array.from({ length: n }, () => Math.round(rnd() * end * 20) / 20).sort((a, b) => a - b);
      const keys = times.map((t, i) =>
        key(
          i && t === times[i - 1] ? t + 0.01 : t,
          SEQUENCE_MODES[Math.floor(rnd() * SEQUENCE_MODES.length)],
          Math.floor(rnd() * (count + 2)),
          rnd() < 0.15 ? 0 : 0.03 + rnd() * 0.3,
        ),
      );
      const spans = sequenceSpans(keys, count, end);
      for (const s of spans) {
        expect(s.index).toBeGreaterThanOrEqual(0);
        expect(s.index).toBeLessThan(count);
        expect(s.end).toBeGreaterThan(s.start);
      }
      for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end - 1e-9);
      for (let t = keys[0].time + 0.0037; t < end; t += 0.0211) {
        const s = spans.find((x) => t > x.start + 1e-6 && t < x.end - 1e-6);
        if (!s) continue; // right at an edge between two spans
        expect(s.index, `round ${round} t=${t}`).toBe(played(keys, t, count));
      }
      // nothing in the middle of the animation is left without a frame
      const first = keys[0].time;
      for (let t = first + 0.0049; t < end - 0.002; t += 0.0317)
        expect(
          spans.some((x) => t >= x.start - 1e-6 && t <= x.end + 1e-6),
          `round ${round} gap at ${t}`,
        ).toBe(true);
    }
  });
});
