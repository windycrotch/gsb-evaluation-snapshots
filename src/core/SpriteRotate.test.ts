import { describe, expect, mock, test } from 'bun:test';
import { rotate, unpackRgba, type Rect } from '~/core/Image';
import type { CelImage, Sprite as SpriteModel } from '~/core/Sprite';

mock.module('@vicimpa/decorators', () => ({
  prop: () => {},
  reactive: () => <T,>(value: T) => value,
}));

const { Sprite } = await import('~/core/Sprite');
const { lockedNotice } = await import('~/core/SpriteModel');

/** Distinct opaque color per pixel so every moved pixel can be traced. */
const pixel = (x: number, y: number, w: number) => (0xff000000 | (((y * w + x) * 2654435761) >>> 8)) >>> 0;

/** A canvas-covering cel whose pixels encode their own old position. */
const paintedCel = (w: number, h: number): CelImage => {
  const data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = pixel(x, y, w);
  return { x: 0, y: 0, w, h, data };
};

const canvasPixels = (sprite: SpriteModel, layer = 0, frame = 0) => sprite.canvasPixels(layer, frame);

const addBackground = (sprite: SpriteModel, cel: CelImage, fill = 0xff102030) => {
  sprite.backgroundFill = fill;
  sprite.layers = [{
    ...sprite.layers[0], name: 'Background', background: true,
    cels: [cel], celOpacity: [1],
  }, ...sprite.layers];
};

const sliceOf = (sprite: SpriteModel) => sprite.slices[0].keys[0];

describe('Rotating the whole canvas', () => {
  test('90° clockwise swaps the sides, turns every cel and moves slice boxes to their new place', () => {
    const sprite = new Sprite(5, 3);
    const cel = paintedCel(5, 3);
    sprite.setCel(cel);
    sprite.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    const before = canvasPixels(sprite);
    const depth = sprite.undoDepth;

    sprite.rotateSprite(1);

    expect([sprite.width, sprite.height]).toEqual([3, 5]);
    // Clockwise: old (0, 0) lands at (H - 1, 0)
    expect(canvasPixels(sprite)[0 * 3 + 2]).toBe(before[0]);
    expect(canvasPixels(sprite)).toEqual(rotate({ w: 5, h: 3, data: before }, 1).data);
    // Rect (1, 0, 2, 1) → (H - y - h, x, h, w)
    expect(sliceOf(sprite)).toMatchObject({ x: 2, y: 1, w: 1, h: 2 });
    // Quarter turns flip the sides of the box: 9-slice/pivot data can't keep its meaning, so it goes
    expect(sliceOf(sprite).center).toBeUndefined();
    expect(sliceOf(sprite).pivot).toBeUndefined();
    expect(sprite.undoDepth).toBe(depth + 1);
    expect(sprite.history.at(-1)).toBe('Rotate canvas');
  });

  test('270° clockwise (90° left) puts slices at the mirrored left edge and drops 9-slice data', () => {
    const sprite = new Sprite(5, 3);
    sprite.setCel(paintedCel(5, 3));
    sprite.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    sprite.slices[0].keys[0].center = { x: 0, y: 0, w: 1, h: 1 };
    sprite.slices[0].keys[0].pivot = { x: 1, y: 0 };
    const before = canvasPixels(sprite);

    sprite.rotateSprite(3);

    expect([sprite.width, sprite.height]).toEqual([3, 5]);
    expect(canvasPixels(sprite)).toEqual(rotate({ w: 5, h: 3, data: before }, 3).data);
    // Rect (1, 0, 2, 1) → (y, W - x - w, h, w)
    expect(sliceOf(sprite)).toMatchObject({ x: 0, y: 2, w: 1, h: 2 });
    expect(sliceOf(sprite).center).toBeUndefined();
    expect(sliceOf(sprite).pivot).toBeUndefined();
  });

  test('180° keeps the canvas size and mirrors cells across the canvas center', () => {
    const sprite = new Sprite(6, 4);
    sprite.setCel(paintedCel(6, 4));
    sprite.addSlice({ x: 0, y: 0, w: 4, h: 2 });
    sprite.slices[0].keys[0].center = { x: 1, y: 0, w: 2, h: 2 };
    sprite.slices[0].keys[0].pivot = { x: 3, y: 1 };
    const before = canvasPixels(sprite);
    const depth = sprite.undoDepth;

    sprite.rotateSprite(2);

    expect([sprite.width, sprite.height]).toEqual([6, 4]);
    expect(canvasPixels(sprite)).toEqual(rotate({ w: 6, h: 4, data: before }, 2).data);
    // Rect (0, 0, 4, 2) → (W - x - w, H - y - h, w, h)
    expect(sliceOf(sprite)).toMatchObject({ x: 2, y: 2, w: 4, h: 2 });
    // A half turn preserves the slice's own orientation: the middle box and pivot mirror inside it
    expect(sliceOf(sprite).center).toEqual({ x: 1, y: 0, w: 2, h: 2 });
    expect(sliceOf(sprite).pivot).toEqual({ x: 1, y: 1 });
    expect(sprite.undoDepth).toBe(depth + 1);
  });

  test('keeps cels that lie partly outside the canvas consistent with their rotated pixels', () => {
    const sprite = new Sprite(6, 4);
    const data = new Uint32Array(10 * 7);
    for (let i = 0; i < data.length; i++) data[i] = (0xff000000 | (i + 1)) >>> 0;
    sprite.layers[0].cels[0] = { x: -2, y: -1, w: 10, h: 7, data };

    sprite.rotateSprite(1);

    const cel = sprite.layers[0].cels[0]!;
    const expected = rotate({ w: 10, h: 7, data }, 1);
    expect([cel.x, cel.y, cel.w, cel.h]).toEqual([-2, -2, 7, 10]);
    expect([cel.w, cel.h]).toEqual([expected.w, expected.h]);
    expect([...cel.data]).toEqual([...expected.data]);
  });

  test('quarter turns compose back to the original, and 0 or multiples of 4 do nothing', () => {
    const sprite = new Sprite(5, 3);
    sprite.setCel(paintedCel(5, 3));
    sprite.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    const beforePixels = canvasPixels(sprite);
    const beforeSlice = { ...sliceOf(sprite) };
    const depth = sprite.undoDepth;

    for (let i = 0; i < 4; i++) sprite.rotateSprite(1);
    expect([sprite.width, sprite.height]).toEqual([5, 3]);
    expect(canvasPixels(sprite)).toEqual(beforePixels);
    expect(sliceOf(sprite)).toMatchObject(beforeSlice);
    expect(sprite.undoDepth).toBe(depth + 4);

    for (const turns of [0, 4, -4, 8]) sprite.rotateSprite(turns);
    expect(sprite.undoDepth).toBe(depth + 4);
    expect([sprite.width, sprite.height]).toEqual([5, 3]);

    const again = new Sprite(5, 3);
    again.setCel(paintedCel(5, 3));
    again.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    again.rotateSprite(1);
    again.rotateSprite(3);
    expect([again.width, again.height]).toEqual([5, 3]);
    expect(sliceOf(again)).toEqual(beforeSlice);
  });

  test('rotation is one undoable step that restores size, pixels, slices and background', () => {
    const sprite = new Sprite(5, 3);
    sprite.setCel(paintedCel(5, 3));
    sprite.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    addBackground(sprite, paintedCel(5, 3), 0xff102030);
    const original = {
      pixels: canvasPixels(sprite, 1),
      background: { ...sprite.layers[0].cels[0]! },
      slice: { ...sliceOf(sprite) },
    };
    const depth = sprite.undoDepth;

    sprite.rotateSprite(1);
    expect(sprite.undoDepth).toBe(depth + 1);
    expect(sprite.layers[0].cels[0]!.w).toBe(3);

    sprite.undo();
    expect(sprite.undoDepth).toBe(depth);
    expect([sprite.width, sprite.height]).toEqual([5, 3]);
    expect(canvasPixels(sprite, 1)).toEqual(original.pixels);
    expect(sliceOf(sprite)).toEqual(original.slice);
    expect(sprite.layers[0].cels[0]).toMatchObject({ x: 0, y: 0, w: 5, h: 3 });
    expect([...sprite.layers[0].cels[0]!.data]).toEqual([...original.background.data]);

    sprite.redo();
    expect([sprite.width, sprite.height]).toEqual([3, 5]);
    expect(sprite.undoDepth).toBe(depth + 1);
  });

  for (const turns of [1, 2, 3])
    test(`background cels cover the canvas exactly after ${turns * 90}°`, () => {
      for (const cel of [
        { x: 0, y: 0, w: 2, h: 2, data: new Uint32Array(4).fill(0xff00ff00) },
        { x: -2, y: -1, w: 9, h: 6, data: new Uint32Array(54).fill(0xff00ff00) },
      ]) {
        const sprite = new Sprite(5, 3);
        addBackground(sprite, cel, 0xff102030);
        const depth = sprite.undoDepth;

        sprite.rotateSprite(turns);

        const bg = sprite.layers[0].cels[0]!;
        const [w, h] = turns % 2 ? [3, 5] : [5, 3];
        expect([sprite.width, sprite.height]).toEqual([w, h]);
        expect([bg.x, bg.y, bg.w, bg.h]).toEqual([0, 0, w, h]);
        expect(bg.data).toHaveLength(w * h);
        expect(sprite.undoDepth).toBe(depth + 1);

        sprite.undo();
        expect(sprite.layers[0].cels[0]).toMatchObject(cel);
        expect(sprite.undoDepth).toBe(depth);
      }
    });

  test('a background cel that covered the canvas keeps its fill after a turn', () => {
    const sprite = new Sprite(5, 3);
    const filled = new Uint32Array(15).fill(0xff00ff00);
    addBackground(sprite, { x: 0, y: 0, w: 5, h: 3, data: filled }, 0xff102030);

    sprite.rotateSprite(1);

    const cel = sprite.layers[0].cels[0]!;
    expect([cel.x, cel.y, cel.w, cel.h]).toEqual([0, 0, 3, 5]);
    expect([...cel.data]).toEqual([...new Uint32Array(15).fill(0xff00ff00)]);
  });

  test('background cels refit fills uncovered area with the background color', () => {
    const sprite = new Sprite(5, 3);
    addBackground(sprite, { x: 0, y: 0, w: 2, h: 2, data: new Uint32Array(4).fill(0xff00ff00) }, 0xff102030);

    sprite.rotateSprite(1);

    const cel = sprite.layers[0].cels[0]!;
    // Old (0, 0) turns to (2, 0): the covered corner keeps its pixels, the rest gets the fill
    expect(unpackRgba(cel.data[2])).toEqual(unpackRgba(0xff00ff00));
    expect(unpackRgba(cel.data[5])).toEqual(unpackRgba(0xff00ff00));
    expect(cel.data[0]).toBe(0xff102030);
    expect(cel.data[14]).toBe(0xff102030);
  });

  test('a locked fixed canvas size rejects an odd turn without touching the document or history', () => {
    const sprite = new Sprite(5, 3);
    sprite.setCel(paintedCel(5, 3));
    sprite.addSlice({ x: 1, y: 0, w: 2, h: 1 });
    sprite.setLocks('test-extension', { constraints: { canvasSize: { w: 5, h: 3 } } });
    const pixels = canvasPixels(sprite);
    const slice = { ...sliceOf(sprite) };
    const depth = sprite.undoDepth;
    lockedNotice.value = null;

    sprite.rotateSprite(1);
    expect([sprite.width, sprite.height]).toEqual([5, 3]);
    expect(canvasPixels(sprite)).toEqual(pixels);
    expect(sliceOf(sprite)).toEqual(slice);
    expect(sprite.undoDepth).toBe(depth);
    expect(lockedNotice.value).toMatchObject({ kind: 'canvas' });

    // A half turn keeps the size, so the same lock allows it and records a step
    sprite.rotateSprite(2);
    expect([sprite.width, sprite.height]).toEqual([5, 3]);
    expect(canvasPixels(sprite)).toEqual(rotate({ w: 5, h: 3, data: pixels }, 2).data);
    expect(sprite.undoDepth).toBe(depth + 1);
  });

  test('a fixed size equal to the swapped sides allows the quarter turn', () => {
    const sprite = new Sprite(5, 3);
    sprite.setCel(paintedCel(5, 3));
    sprite.setLocks('test-extension', { constraints: { canvasSize: { w: 3, h: 5 } } });

    sprite.rotateSprite(1);
    expect([sprite.width, sprite.height]).toEqual([3, 5]);
    expect(sprite.undoDepth).toBe(1);
  });

  test('keeps slices hidden on a frame as zero-sized markers, without inventing geometry', () => {
    const sprite = new Sprite(4, 4);
    sprite.setCel(paintedCel(4, 4));
    sprite.addSlice({ x: 1, y: 1, w: 2, h: 2 });
    sprite.slices[0].keys.push({ frame: 1, x: 0, y: 0, w: 0, h: 0 });

    sprite.rotateSprite(2);

    expect(sprite.slices[0].keys[1]).toEqual({ frame: 1, x: 0, y: 0, w: 0, h: 0 });
    expect(sprite.slices[0].keys[0]).toMatchObject({ x: 1, y: 1, w: 2, h: 2 });
  });
});

describe('Slice boxes after turns land inside the turned art', () => {
  const rects: [number, number, Rect][] = [
    [5, 3, { x: 0, y: 0, w: 5, h: 3 }],
    [5, 3, { x: 1, y: 0, w: 2, h: 1 }],
    [5, 3, { x: 4, y: 2, w: 1, h: 1 }],
    [3, 5, { x: 0, y: 1, w: 1, h: 4 }],
    [6, 4, { x: 2, y: 1, w: 3, h: 2 }],
  ];

  for (const [w, h, r] of rects)
    for (const turns of [1, 2, 3])
      test(`${w}×${h} rect ${r.x},${r.y} ${r.w}×${r.h} after ${turns * 90}°`, () => {
        const sprite = new Sprite(w, h);
        const data = new Uint32Array(w * h);
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) data[y * w + x] = 0xff00ff00;
        sprite.setCel({ x: 0, y: 0, w, h, data });
        sprite.addSlice(r);

        sprite.rotateSprite(turns);

        const cel = sprite.layers[0].cels[0]!;
        const red: [number, number][] = [];
        for (let y = 0; y < cel.h; y++)
          for (let x = 0; x < cel.w; x++)
            if (cel.data[y * cel.w + x] === 0xff00ff00) red.push([x + cel.x, y + cel.y]);
        const k = sliceOf(sprite);
        expect(red).toHaveLength(r.w * r.h);
        for (const [x, y] of red) {
          expect(x).toBeGreaterThanOrEqual(k.x);
          expect(y).toBeGreaterThanOrEqual(k.y);
          expect(x).toBeLessThan(k.x + k.w);
          expect(y).toBeLessThan(k.y + k.h);
        }
        expect([k.w, k.h]).toEqual(turns % 2 ? [r.h, r.w] : [r.w, r.h]);
      });

  test('a slice on a frame-keyed slice rotates every key', () => {
    const sprite = new Sprite(6, 4);
    sprite.setCel(paintedCel(6, 4));
    sprite.frames.push({ duration: 100 });
    sprite.layers[0].cels.push(null);
    sprite.layers[0].celOpacity.push(1);
    sprite.addSlice({ x: 0, y: 0, w: 2, h: 1 });
    sprite.slices[0].keys.push({ frame: 1, x: 4, y: 2, w: 2, h: 2 });

    sprite.rotateSprite(1);

    expect(sprite.slices[0].keys).toEqual([
      { frame: 0, x: 3, y: 0, w: 1, h: 2 },
      { frame: 1, x: 0, y: 4, w: 2, h: 2 },
    ]);
  });
});
