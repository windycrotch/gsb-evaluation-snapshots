/** The shape of a sound for the timeline. */
import { describe, expect, it } from 'vitest';
import { peakAt, peaksOf } from '../src/core/waveform';

describe('peaks', () => {
  it('keeps the loudest sample of every slice, over all channels', () => {
    const left = new Float32Array(1000);
    const right = new Float32Array(1000);
    left[10] = 0.5;
    right[10] = -0.8; // louder, other channel
    left[990] = -0.25;
    const p = peaksOf([left, right], 1000, 100); // slices of 10 samples
    expect(p.duration).toBe(1);
    expect(p.values).toHaveLength(100);
    expect(p.values[1]).toBeCloseTo(0.8, 6);
    expect(p.values[99]).toBeCloseTo(0.25, 6);
    expect(p.values[50]).toBe(0);
  });

  it('reads the loudness at a time, and nothing outside the sound', () => {
    const data = new Float32Array(2000);
    data[1500] = 1;
    const p = peaksOf([data], 1000, 100);
    expect(p.duration).toBe(2);
    expect(peakAt(p, 1.5)).toBe(1);
    expect(peakAt(p, 0.5)).toBe(0);
    expect(peakAt(p, -1)).toBe(0);
    expect(peakAt(p, 2)).toBe(0);
  });

  it('copes with nothing', () => {
    const p = peaksOf([], 44100);
    expect(p.duration).toBe(0);
    expect(peakAt(p, 0)).toBe(0);
    expect(peaksOf([new Float32Array(0)], 0).values).toHaveLength(0);
  });
});
