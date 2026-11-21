/** The weight brush's fade shapes: the default is the old brush, every shape is 1 in the core, 0 at the radius and never rises outward. */
import { describe, expect, it } from 'vitest';
import { BRUSH_SHAPES, STRENGTH_CURVES, brushFalloff, shapeCurve, strengthAmount } from '../src/core/brush';

const oldFalloff = (d: number, radius: number, feather: number) => {
  const inner = radius * (1 - Math.max(0, Math.min(100, feather)) / 100);
  return d <= inner ? 1 : Math.pow(1 - (d - inner) / (radius - inner), 1.4);
};

describe('brushFalloff', () => {
  it('the soft shape is the brush as it was', () => {
    for (const feather of [0, 30, 100])
      for (let d = 0; d <= 100; d += 7) expect(brushFalloff(d, 100, feather, 'soft')).toBeCloseTo(oldFalloff(d, 100, feather), 12);
    expect(brushFalloff(40, 100, 60)).toBe(brushFalloff(40, 100, 60, 'soft'));
  });

  it('every shape is 1 in the core, 0 at the radius and never rises with the distance', () => {
    for (const shape of BRUSH_SHAPES) {
      expect(brushFalloff(0, 50, 100, shape)).toBe(1);
      expect(brushFalloff(50, 50, 100, shape)).toBeCloseTo(0, 12);
      expect(brushFalloff(20, 50, 0, shape)).toBe(1); // a hard edge
      let last = 1;
      for (let d = 0; d <= 50; d += 1) {
        const w = brushFalloff(d, 50, 100, shape);
        expect(w).toBeLessThanOrEqual(last + 1e-12);
        last = w;
      }
    }
  });

  it('the shapes order at the middle of the fade: smooth = 0.5, sharp lowest', () => {
    expect(shapeCurve(0.5, 'smooth')).toBeCloseTo(0.5, 12);
    expect(shapeCurve(0.5, 'linear')).toBeCloseTo(0.5, 12);
    expect(shapeCurve(0.5, 'sharp')).toBeLessThan(shapeCurve(0.5, 'soft'));
    expect(shapeCurve(0.5, 'soft')).toBeLessThan(0.5);
  });

  it('is 0 outside the radius, for a bad radius and for a NaN distance', () => {
    expect(brushFalloff(51, 50, 100)).toBe(0);
    expect(brushFalloff(1, 0, 100)).toBe(0);
    expect(brushFalloff(1, NaN, 100)).toBe(0);
    expect(brushFalloff(NaN, 50, 100)).toBe(0);
  });

  it('a feather out of range is clamped', () => {
    expect(brushFalloff(10, 50, 500, 'linear')).toBeCloseTo(brushFalloff(10, 50, 100, 'linear'), 12);
    expect(brushFalloff(10, 50, -20, 'linear')).toBe(1);
  });
});

describe('strength curve', () => {
  it('even is the slider as it was, and every curve keeps 0 and 1', () => {
    for (const c of STRENGTH_CURVES) {
      expect(strengthAmount(0, c)).toBe(0);
      expect(strengthAmount(1, c)).toBe(1);
    }
    for (const s of [0.1, 0.37, 0.8]) {
      expect(strengthAmount(s)).toBe(s);
      expect(strengthAmount(s, 'linear')).toBe(s);
    }
  });

  it('fine paints less than the slider, bold more, and both rise with it', () => {
    for (const s of [0.05, 0.3, 0.6, 0.95]) {
      expect(strengthAmount(s, 'fine')).toBeLessThan(s);
      expect(strengthAmount(s, 'bold')).toBeGreaterThan(s);
    }
    for (const c of STRENGTH_CURVES) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const v = strengthAmount(i / 20, c);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    expect(strengthAmount(0.1, 'fine')).toBeCloseTo(0.01, 12);
    expect(strengthAmount(0.1, 'bold')).toBeCloseTo(Math.sqrt(0.1), 12);
  });

  it('out of range is clamped', () => {
    expect(strengthAmount(-1, 'fine')).toBe(0);
    expect(strengthAmount(3, 'bold')).toBe(1);
  });
});
