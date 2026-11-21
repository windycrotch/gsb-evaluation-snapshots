/** The outline map: the scene on a small map, the viewport rectangle, and the way back from a click. */
import { describe, expect, it } from 'vitest';
import { boxOf, fitMap, fromMap, toMap, unionBox, viewBox } from '../src/core/minimap';

describe('boxOf / unionBox', () => {
  it('holds the points, skips what is not a number, and is null for nothing', () => {
    expect(boxOf([])).toBeNull();
    expect(boxOf([[NaN, 1]])).toBeNull();
    expect(
      boxOf([
        [1, 2],
        [-3, 5],
        [Infinity, 0],
      ]),
    ).toEqual({ minX: -3, minY: 2, maxX: 1, maxY: 5 });
    const a = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(unionBox(a, null)).toBe(a);
    expect(unionBox(null, a)).toBe(a);
    expect(unionBox(a, { minX: -1, minY: 0.5, maxX: 0.5, maxY: 4 })).toEqual({ minX: -1, minY: 0, maxX: 1, maxY: 4 });
  });
});

describe('viewBox', () => {
  it('is the part of the scene the viewport shows', () => {
    expect(viewBox({ x: 10, y: -5, zoom: 2 }, 400, 200)).toEqual({ minX: -90, minY: -55, maxX: 110, maxY: 45 });
  });
});

describe('the map', () => {
  const content = { minX: -100, minY: 0, maxX: 100, maxY: 200 };
  it('fits the content and the viewport rectangle, and a round trip lands where it started', () => {
    const view = viewBox({ x: 0, y: 100, zoom: 1 }, 100, 100);
    const m = fitMap(content, view, 200, 120);
    for (const [x, y] of [
      [0, 100],
      [-100, 0],
      [100, 200],
      [37.5, -12],
    ] as const) {
      const [px, py] = toMap(m, x, y);
      const [bx, by] = fromMap(m, px, py);
      expect(bx).toBeCloseTo(x, 9);
      expect(by).toBeCloseTo(y, 9);
    }
    // up in the scene is up on the map
    expect(toMap(m, 0, 200)[1]).toBeLessThan(toMap(m, 0, 0)[1]);
    // everything is inside the map
    for (const [x, y] of [
      [-100, 0],
      [100, 200],
    ] as const) {
      const [px, py] = toMap(m, x, y);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(200);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(120);
    }
  });
  it('makes room for a viewport that is far from the content', () => {
    const view = viewBox({ x: 1000, y: 100, zoom: 1 }, 100, 100);
    const m = fitMap(content, view, 200, 120);
    const [px] = toMap(m, 1050, 100);
    expect(px).toBeLessThanOrEqual(200);
  });
  it('copes with a skeleton of no size and with none', () => {
    const point = { minX: 5, minY: 5, maxX: 5, maxY: 5 };
    const m = fitMap(point, point, 200, 120);
    expect(Number.isFinite(m.scale)).toBe(true);
    expect(fitMap(null, viewBox({ x: 0, y: 0, zoom: 1 }, 100, 100), 200, 120).scale).toBeGreaterThan(0);
  });
});
