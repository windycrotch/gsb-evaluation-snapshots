/**
 * Sprite sheets and frames: the grid, the cells in order, which empty cells to drop, the names the frames get, and the action that
 * adds frames as pictures and a sequence in one step of the history.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSequence, sequenceFrameNames } from '../src/core/sequence';
import { cellRects, delayForFps, framesToKeep, gridByCell, gridByCount, isBlankPixels, sheetSequence } from '../src/core/spritesheet';
import { emptyProject, newAnimation } from '../src/core/model';
import { assets } from '../src/store/assets';
import type { ImageAsset } from '../src/store/assets';
import { addFrames } from '../src/store/frameImport';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';

describe('the grid', () => {
  it('divides the picture by columns and rows inside the margin and the spacing', () => {
    expect(gridByCount(256, 64, 4, 1)).toEqual({ cols: 4, rows: 1, cellW: 64, cellH: 64, margin: 0, spacing: 0 });
    expect(gridByCount(210, 100, 4, 2, 5, 2)).toMatchObject({
      cellW: Math.floor((210 - 10 - 6) / 4),
      cellH: Math.floor((100 - 10 - 2) / 2),
    });
  });

  it('fits as many cells of a given size as there are room for, counting the gaps between them', () => {
    expect(gridByCell(256, 128, 64, 64)).toMatchObject({ cols: 4, rows: 2 });
    expect(gridByCell(262, 64, 64, 64, 0, 2)).toMatchObject({ cols: 4, rows: 1 }); // 4 cells and 3 gaps of 2 = 262
    expect(gridByCell(261, 64, 64, 64, 0, 2)).toMatchObject({ cols: 3 });
    expect(gridByCell(10, 10, 64, 64)).toBeNull();
  });

  it('refuses a grid whose cells would be empty, and cleans numbers it is given', () => {
    expect(gridByCount(4, 4, 8, 1)).toBeNull();
    expect(gridByCount(100, 100, 0, -3)).toMatchObject({ cols: 1, rows: 1 });
    expect(gridByCount(100, 100, NaN, 2)).toMatchObject({ cols: 1 });
  });

  it('lists the cells along the rows, or down the columns', () => {
    const grid = gridByCount(60, 40, 3, 2)!;
    const rows = cellRects(grid);
    expect(rows.map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [20, 0],
      [40, 0],
      [0, 20],
      [20, 20],
      [40, 20],
    ]);
    expect(cellRects(grid, true).map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [0, 20],
      [20, 0],
      [20, 20],
      [40, 0],
      [40, 20],
    ]);
    expect(rows.every((r) => r.w === 20 && r.h === 20)).toBe(true);
  });

  it('keeps the margin and the spacing in the cell positions', () => {
    const grid = gridByCount(110, 54, 3, 1, 4, 6)!;
    expect(cellRects(grid).map((r) => r.x)).toEqual([4, 4 + grid.cellW + 6, 4 + 2 * (grid.cellW + 6)]);
    for (const r of cellRects(grid)) expect(r.x + r.w).toBeLessThanOrEqual(110);
  });
});

describe('empty cells', () => {
  it('drops the empty cells at the end only', () => {
    expect(framesToKeep([false, true, false, true, true])).toBe(3);
    expect(framesToKeep([true, true])).toBe(0);
    expect(framesToKeep([false, false])).toBe(2);
    expect(framesToKeep([])).toBe(0);
  });

  it('sees a cell as empty when every pixel is transparent', () => {
    expect(isBlankPixels(new Uint8ClampedArray([9, 9, 9, 0, 1, 2, 3, 0]))).toBe(true);
    expect(isBlankPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(false);
    expect(isBlankPixels(new Uint8ClampedArray([0, 0, 0, 3]), 5)).toBe(true);
  });
});

describe('the names', () => {
  it('numbers the frames from 1, two digits at least, wider for a long sheet', () => {
    expect(sheetSequence('run', 3).names).toEqual(['run01', 'run02', 'run03']);
    expect(sheetSequence('run', 120).names[0]).toBe('run001');
    expect(sheetSequence('run', 120).names[119]).toBe('run120');
  });

  it('are found again as one sequence by the series detector', () => {
    for (const count of [2, 9, 10, 99, 100]) {
      const { sequence, names } = sheetSequence('fx/spark', count);
      const found = detectSequence(names, names[0]);
      expect(found?.path).toBe('fx/spark');
      expect(found?.sequence).toMatchObject({ count, start: 1, digits: sequence.digits });
      expect(sequenceFrameNames(found!.path, found!.sequence)).toEqual(names);
    }
  });

  it('turns a frame rate into the delay of a frame', () => {
    expect(delayForFps(10)).toBe(0.1);
    expect(delayForFps(24)).toBeCloseTo(1 / 24, 4);
    expect(delayForFps(0)).toBe(0.1);
    expect(delayForFps(NaN)).toBe(0.1);
  });
});

const fake = (name: string): ImageAsset => ({
  name,
  width: 16,
  height: 16,
  blob: new Blob([]),
  bitmap: { close() {}, width: 16, height: 16 },
  version: 1,
});

describe('adding frames', () => {
  beforeEach(() => {
    docStore.replace(emptyProject('frames'));
    vi.spyOn(assets, 'decode').mockImplementation(async (name) => fake(name));
    uiStore.patch({ animationId: null, mode: 'setup', selection: emptySelection });
  });

  const blobs = (n: number) => Array.from({ length: n }, () => new Blob(['x']));

  it('adds the pictures and one slot that plays them, in one step of the history', async () => {
    const before = docStore.history.past.length;
    expect(await addFrames(blobs(4), { base: 'run', scene: true, delay: 0.1 })).toBe(4);
    expect(docStore.get().images.map((i) => i.name)).toEqual(['run01', 'run02', 'run03', 'run04']);
    const doc = docStore.get().skeleton;
    const slot = doc.slots[doc.slots.length - 1];
    const att = Object.values(doc.skins[0].attachments[slot.id])[0] as { type: string; path: string; sequence?: { count: number } };
    expect(att.path).toBe('run');
    expect(att.sequence?.count).toBe(4);
    expect(docStore.history.past.length).toBe(before + 1);
    docStore.undo();
    expect(docStore.get().images).toEqual([]);
    expect(docStore.get().skeleton.slots.length).toBe(doc.slots.length - 1);
  });

  it('keys the sequence to loop at the delay when an animation is open', async () => {
    const anim = newAnimation('a', 1);
    docStore.update('add animation', (d) => void d.skeleton.animations.push(anim));
    uiStore.patch({ animationId: anim.id });
    await addFrames(blobs(3), { base: 'blink', scene: true, delay: 0.125 });
    const bySlot = Object.values(docStore.get().skeleton.animations[0].sequence ?? {})[0] ?? {};
    const keys = Object.values(Object.values(bySlot)[0] ?? {})[0] ?? [];
    expect(keys).toEqual([{ time: 0, mode: 'loop', index: 0, delay: 0.125 }]);
  });

  it('only adds the pictures when the scene is not wanted', async () => {
    const slots = docStore.get().skeleton.slots.length;
    await addFrames(blobs(2), { base: 'p', scene: false, delay: null });
    expect(docStore.get().images.length).toBe(2);
    expect(docStore.get().skeleton.slots.length).toBe(slots);
  });

  it('refuses a name that a picture already has, and nothing at all to add, without changing anything', async () => {
    await addFrames(blobs(2), { base: 'x', scene: false, delay: null });
    const rev = docStore.revision;
    expect(await addFrames(blobs(3), { base: 'x', scene: true, delay: null })).toBe(0);
    expect(await addFrames([], { base: 'y', scene: true, delay: null })).toBe(0);
    expect(await addFrames(blobs(2), { base: ' / ', scene: true, delay: null })).toBe(0);
    expect(docStore.revision).toBe(rev);
  });
});
