/** Snapping to the grid and to guides, and the guides stored in a project. */
import { beforeEach, describe, expect, it } from 'vitest';
import { GUIDE_PULL, cleanGuides, gridStep, guideAt, niceStep, snapPoint } from '../src/core/snap';
import { repairProject, validateProject } from '../src/core/validate';
import { docStore } from '../src/store/doc';
import * as G from '../src/store/guideActions';
import { buildFixture } from './fixture';

describe('the grid', () => {
  it('has a step of 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.1)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(6)).toBe(10);
    expect(niceStep(28)).toBe(50);
    expect(gridStep(1)).toBe(50);
    expect(gridStep(4)).toBe(10);
  });
});

describe('snapPoint', () => {
  it('rounds to the grid when it is on, and leaves a point alone when it is off', () => {
    const on = snapPoint(123, -78, { zoom: 1, grid: true });
    expect([on.x, on.y]).toEqual([100, -100]);
    const off = snapPoint(123, -78, { zoom: 1, grid: false });
    expect([off.x, off.y]).toEqual([123, -78]);
  });

  it('sticks to a guide that is within reach, before the grid', () => {
    const guides = { x: [117], y: [] };
    const near = snapPoint(120, 12, { zoom: 1, grid: true, guides });
    expect([near.x, near.guideX, near.y, near.guideY]).toEqual([117, true, 0, false]);
    const far = snapPoint(130, 12, { zoom: 1, grid: true, guides });
    expect(far.guideX).toBe(false);
    // the reach is in pixels: zoomed in it is shorter in the scene
    const zoomed = snapPoint(117.5, 0, { zoom: 8, grid: false, guides });
    expect(zoomed.guideX).toBe(true);
    const tooFar = snapPoint(117 + (GUIDE_PULL + 1) / 8, 0, { zoom: 8, grid: false, guides });
    expect(tooFar.guideX).toBe(false);
  });

  it('takes the nearest of two guides', () => {
    const s = snapPoint(10, 0, { zoom: 1, grid: false, guides: { x: [4, 13], y: [] } });
    expect(s.x).toBe(13);
  });
});

describe('guides', () => {
  it('are cleaned: finite, rounded, unique, sorted and not too many', () => {
    expect(cleanGuides({ x: [3, 1, 3, NaN, 'a', Infinity, 2.00049], y: 'no' })).toEqual({ x: [1, 2, 3], y: [] });
    expect(cleanGuides(null)).toEqual({ x: [], y: [] });
    expect(cleanGuides({ x: Array.from({ length: 300 }, (_, i) => i) }).x).toHaveLength(100);
  });

  it('are found near a coordinate', () => {
    expect(guideAt([10, 50], 51, 2)).toBe(1);
    expect(guideAt([10, 50], 30, 2)).toBe(-1);
  });
});

describe('guide actions', () => {
  beforeEach(() => docStore.replace(buildFixture().project));

  it('add, move and remove a guide, and undo', () => {
    expect(G.addGuide('x', 40)).toBe(0);
    expect(G.addGuide('y', -15)).toBe(0);
    expect(docStore.get().guides).toEqual({ x: [40], y: [-15] });
    expect(G.addGuide('x', 40)).toBe(0); // the same line again is the same guide
    expect(docStore.get().guides!.x).toEqual([40]);
    G.moveGuide('x', 0, 75);
    expect(docStore.get().guides!.x).toEqual([75]);
    G.removeGuide('y', 0);
    expect(docStore.get().guides).toEqual({ x: [75], y: [] });
    docStore.undo();
    expect(docStore.get().guides!.y).toEqual([-15]);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('are cleared together', () => {
    G.addGuide('x', 1);
    G.addGuide('y', 2);
    G.clearGuides();
    expect(docStore.get().guides).toBeUndefined();
    expect(G.clearGuides()).toBe(0);
  });

  it('are repaired when a project holds damaged ones', () => {
    const f = buildFixture().project;
    f.guides = { x: [5, 5, NaN], y: [9, 2] };
    expect(repairProject(f).some((m) => /guides/.test(m))).toBe(true);
    expect(f.guides).toEqual({ x: [5], y: [2, 9] });
  });
});
