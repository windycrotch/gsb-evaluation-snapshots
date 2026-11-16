import { describe, expect, it } from 'vitest';

import { repairedTimeline } from './repairedTimeline';

const COUNT = 100;

/**
 * A kilohertz timeline in microseconds, with the stamps at `strays` moved by `offset`.
 */
function timeline(strays: readonly number[] = [], offset = 0): Float64Array {
  return Float64Array.from(
    { length: COUNT },
    (_unused, index) => index * 1000 + (strays.includes(index) ? offset : 0),
  );
}

describe('repairedTimeline', () => {
  it('leaves a clean timeline and a real gap as they are', () => {
    const withGap = Float64Array.from(
      { length: COUNT },
      (_unused, index) => index * 1000 + (index >= 50 ? 2_000_000 : 0),
    );
    expect(repairedTimeline(timeline())).toEqual({ times: timeline(), mended: 0 });
    expect(repairedTimeline(withGap)).toEqual({ times: withGap, mended: 0 });
  });

  it.each([
    ['the first stamp', [0]],
    ['the first pair', [0, 1]],
    ['the second pair', [1, 2]],
    ['a middle stamp', [50]],
    ['a middle pair', [50, 51]],
    ['a middle run of five', [40, 41, 42, 43, 44]],
    ['the first run of three', [0, 1, 2]],
    ['a run of three after the first stamp', [1, 2, 3]],
    ['the pair before last', [97, 98]],
    ['the last pair', [98, 99]],
    ['the last stamp', [99]],
  ])('puts back %s moved far forward or back', (_where, strays) => {
    for (const offset of [5e6, -5e6, 2 ** 40]) {
      expect(repairedTimeline(timeline(strays, offset))).toEqual({
        times: timeline(),
        mended: strays.length,
      });
    }
  });

  it('trusts a stretch of seventeen after a jump as a real gap, and mends one of sixteen', () => {
    const tailFrom = (start: number): Float64Array =>
      Float64Array.from(
        { length: COUNT },
        (_unused, index) => index * 1000 + (index >= start ? 2_000_000 : 0),
      );
    expect(repairedTimeline(tailFrom(COUNT - 17)).mended).toBe(0);
    expect(repairedTimeline(tailFrom(COUNT - 16))).toEqual({ times: timeline(), mended: 16 });
  });

  it('keeps a stamp between strays that is only jittered', () => {
    const recorded = timeline([40, 43], 5e6).map((time, index) =>
      index === 41 ? time + 300 : time,
    );
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(2);
    expect([times[40], times[41], times[42], times[43]]).toEqual([40_000, 41_300, 42_000, 43_000]);
  });

  it('puts back stamps left at zero before the clock ran', () => {
    const zeros = timeline().map((time, index) => (index < 3 ? 0 : time + 921_000_000));
    const { times, mended } = repairedTimeline(zeros);
    expect(mended).toBe(3);
    expect(times[0]).toBe(921_000_000);
  });

  it('keeps a real gap whose first stamp strays, and a stamp only jittered', () => {
    const recorded = Float64Array.from(
      { length: COUNT },
      (_unused, index) =>
        index * 1000 +
        (index >= 50 ? 2_000_000 : 0) +
        (index === 50 ? 5e6 : 0) +
        (index === 20 ? 300 : 0),
    );
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(1);
    expect(times[20]).toBe(20_300);
    expect(times[50]).toBe(50_000);
    expect(times[51]).toBe(2_051_000);
  });

  it('counts no stamp as mended that is only held while a jittered one ahead of it passes', () => {
    const { times, mended } = repairedTimeline(timeline([50], 30_000));
    expect(mended).toBe(0);
    expect(times[51]).toBe(times[50]);
    expect(times[81]).toBe(81_000);
  });

  it('never lets a stamp go back, though a jump back never returns', () => {
    const reset = Float64Array.from({ length: COUNT }, (_unused, index) =>
      index < 50 ? index * 1000 : index * 1000 - 5e6,
    );
    const { times } = repairedTimeline(reset);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThanOrEqual(times[index - 1] ?? 0);
    }
  });

  it('puts back a stamp left at zero in the middle, which no clock handed out', () => {
    const recorded = timeline();
    recorded[50] = 0;
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(1);
    expect(times[50]).toBe(50_000);
    expect(times[49]).toBe(49_000);
    expect(times[51]).toBe(51_000);
  });

  it('puts back a stamp not a number rather than letting it stand', () => {
    const recorded = timeline();
    recorded[50] = NaN;
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(1);
    expect(times[50]).toBe(50_000);
  });

  it.each([0, 1, 2])('puts back a stray in a record of three, at position %i', (bad) => {
    const captureBase = 921_000_000;
    const recorded = Float64Array.from([0, 10_000, 20_000], (offset) => captureBase + offset);
    recorded[bad] = captureBase + 1_000_030_000;
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(1);
    expect([...times]).toEqual([0, 10_000, 20_000].map((offset) => captureBase + offset));
  });

  it('keeps a real gap between two stretches of the same length, as a pause is', () => {
    const captureBase = 921_000_000;
    const paused = Float64Array.from(
      { length: 16 },
      (_unused, index) => captureBase + index * 1000 + (index >= 8 ? 2_000_000 : 0),
    );
    expect(repairedTimeline(paused)).toEqual({ times: paused, mended: 0 });
  });

  it('keeps a record of three whose stamps are all in step as they are', () => {
    const recorded = Float64Array.from([10_000, 20_000, 30_000]);
    expect(repairedTimeline(recorded)).toEqual({ times: recorded, mended: 0 });
  });

  it('puts back the first of two strays ahead of a shorter trusted stretch', () => {
    const recorded = Float64Array.from(
      { length: 40 },
      (_unused, index) => index * 1000 + ([10, 25].includes(index) ? 5e6 : 0),
    );
    const { times, mended } = repairedTimeline(recorded);
    expect(mended).toBe(2);
    expect([times[10], times[25]]).toEqual([10_000, 25_000]);
  });
});
