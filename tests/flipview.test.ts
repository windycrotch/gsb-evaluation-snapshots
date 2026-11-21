/** Flip Viewport (Spine 4.3): the view is mirrored left to right; only the way the scene is looked at changes. */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REF_VIDEO, videoRect } from '../src/core/refVideo';
import { flipSign, screenToWorld, worldToScreen } from '../src/store/scene';
import { flipViewport } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const cam = { x: 30, y: 80, zoom: 2 };
const flipped = { ...cam, flip: true };

describe('the screen mapping of a flipped view', () => {
  it('has the sign -1 only when flipped', () => {
    expect(flipSign(cam)).toBe(1);
    expect(flipSign({ flip: false })).toBe(1);
    expect(flipSign(flipped)).toBe(-1);
  });

  it('mirrors x around the centre of the viewport and leaves y alone', () => {
    const [x, y] = worldToScreen(cam, 800, 600, 50, 100);
    const [fx, fy] = worldToScreen(flipped, 800, 600, 50, 100);
    expect(fy).toBe(y);
    expect(fx - 400).toBeCloseTo(-(x - 400), 9);
    // the camera centre stays in the middle either way
    expect(worldToScreen(flipped, 800, 600, 30, 80)).toEqual([400, 300]);
  });

  it('screenToWorld undoes worldToScreen, flipped or not', () => {
    for (const c of [cam, flipped]) {
      for (const [wx, wy] of [
        [0, 0],
        [123.5, -40],
        [-77, 301],
      ]) {
        const [sx, sy] = worldToScreen(c, 1000, 700, wx, wy);
        const [bx, by] = screenToWorld(c, 1000, 700, sx, sy);
        expect(bx).toBeCloseTo(wx, 9);
        expect(by).toBeCloseTo(wy, 9);
      }
    }
  });

  it('a point right of the centre in the world is left of it on a flipped screen', () => {
    expect(worldToScreen(cam, 800, 600, 130, 80)[0]).toBeGreaterThan(400);
    expect(worldToScreen(flipped, 800, 600, 130, 80)[0]).toBeLessThan(400);
  });
});

describe('the reference video of a flipped view', () => {
  it('sits at the mirrored place', () => {
    const view = { ...DEFAULT_REF_VIDEO, x: 60, y: 80, scale: 100 };
    const a = videoRect(cam, 800, 600, view, 100, 60);
    const b = videoRect(flipped, 800, 600, view, 100, 60);
    expect(b.width).toBe(a.width);
    expect(b.top).toBe(a.top);
    expect(b.left + b.width / 2 - 400).toBeCloseTo(-(a.left + a.width / 2 - 400), 9);
  });
});

describe('flipViewport', () => {
  beforeEach(() => {
    docStore.replace(buildFixture().project);
    uiStore.patch({ camera: { x: 12, y: 34, zoom: 1.5 } });
  });

  it('toggles the flip and keeps the rest of the camera and the document', () => {
    const before = JSON.stringify(docStore.get());
    flipViewport();
    expect(uiStore.get().camera).toEqual({ x: 12, y: 34, zoom: 1.5, flip: true });
    flipViewport();
    expect(uiStore.get().camera.flip).toBe(false);
    expect(uiStore.get().camera).toMatchObject({ x: 12, y: 34, zoom: 1.5 });
    expect(JSON.stringify(docStore.get())).toBe(before);
    expect(docStore.canUndo).toBe(false); // a view setting: no history step
  });
});
