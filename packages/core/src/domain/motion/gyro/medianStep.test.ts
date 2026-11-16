import { describe, expect, it } from 'vitest';

import { medianStep } from './medianStep';

function stamps(...values: number[]): Float64Array {
  return Float64Array.from(values);
}

describe('medianStep', () => {
  it('is the spacing of a record in step', () => {
    expect(medianStep(stamps(0, 1000, 2000, 3000))).toBe(1000);
  });

  it('is zero for fewer than two stamps, or none in step', () => {
    expect(medianStep(new Float64Array())).toBe(0);
    expect(medianStep(stamps(5))).toBe(0);
    expect(medianStep(stamps(5, 5))).toBe(0);
  });

  it('is not raised by one stamp glitched far ahead, however short the record', () => {
    expect(medianStep(stamps(10, 20, 1_000_030))).toBe(10);
    expect(medianStep(stamps(10, 1_000_020, 30))).toBe(10);
    expect(medianStep(stamps(1_000_010, 20, 30))).toBe(10);
    expect(medianStep(stamps(10, 20, 30, 1_000_040))).toBe(10);
  });

  it('is not raised by one stamp glitched far back', () => {
    expect(medianStep(stamps(10, -4_000_000, 30))).toBe(10);
    expect(medianStep(stamps(-4_000_000, 10, 20, 30))).toBe(10);
  });

  it('is not raised by a stamp left at zero between others', () => {
    expect(medianStep(stamps(10_000, 0, 30_000))).toBe(10_000);
  });

  it('ignores spans that are not positive and finite', () => {
    expect(medianStep(stamps(0, NaN, 2000, 3000))).toBe(1000);
    expect(medianStep(stamps(0, Infinity, 2000, 3000))).toBe(1000);
  });

  it('stays at the rate when one real gap is among many samples', () => {
    const withGap = Float64Array.from(
      { length: 100 },
      (_unused, index) => index * 1000 + (index >= 50 ? 2_000_000 : 0),
    );
    expect(medianStep(withGap)).toBe(1000);
  });

  it('stays at the rate when a run of strays interrupts it', () => {
    const withStrays = Float64Array.from(
      { length: 100 },
      (_unused, index) => index * 1000 + ([40, 41, 42, 43, 44].includes(index) ? 5e6 : 0),
    );
    expect(medianStep(withStrays)).toBe(1000);
  });

  it('keeps a jitter of a few hundred microseconds from deciding the rate', () => {
    const jittered = Float64Array.from(
      { length: 50 },
      (_unused, index) => index * 1000 + (index === 20 ? 400 : 0),
    );
    expect(medianStep(jittered)).toBe(1000);
  });
});
