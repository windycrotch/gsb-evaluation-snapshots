/** Photoshop files: the layers become pictures and slots, in the order of the file, with groups as folders. */
import { describe, expect, it } from 'vitest';
import { initializeCanvas, writePsd } from 'ag-psd';
import type { Layer, Psd } from 'ag-psd';
import { blendOf, flattenPsd, layerCenter, pictureName, readPsdFile } from '../src/core/import/psd';

// node has no canvas: ag-psd only needs a way to make plain pixel buffers (the browser build uses its own canvas)
initializeCanvas(
  () => {
    throw new Error('no canvas in tests');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }),
);

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function layer(name: string, left: number, top: number, w: number, h: number, extra: Partial<Layer> = {}): Layer {
  return { name, left, top, right: left + w, bottom: top + h, imageData: solid(w, h, [200, 40, 40, 255]), ...extra };
}

function file(children: Layer[]): ArrayBuffer {
  const psd: Psd = { width: 100, height: 80, children };
  return writePsd(psd, { generateThumbnail: false, noBackground: true });
}

describe('PSD import', () => {
  it('reads the layers back to front, groups as folders, hidden ones skipped', async () => {
    const psd = await readPsdFile(
      file([
        layer('back', 0, 0, 100, 80),
        {
          name: 'arm',
          children: [layer('upper', 10, 20, 20, 30, { opacity: 0.5, blendMode: 'multiply' }), layer('ghost', 0, 0, 4, 4, { hidden: true })],
        },
        { name: 'off', hidden: true, children: [layer('inside', 0, 0, 4, 4)] },
        layer('top', 40, 10, 8, 8),
      ]),
    );
    expect(psd.width).toBe(100);
    expect(psd.height).toBe(80);
    expect(psd.layers.map((l) => l.name)).toEqual(['back', 'arm/upper', 'top']);
    expect(psd.skipped.hidden).toBe(2);
    const upper = psd.layers[1];
    expect([upper.left, upper.top, upper.width, upper.height]).toEqual([10, 20, 20, 30]);
    expect(upper.opacity).toBeCloseTo(0.5, 1);
    expect(upper.blend).toBe('multiply');
    expect(upper.pixels.data.length).toBe(20 * 30 * 4);
    expect(Array.from(upper.pixels.data.slice(0, 4))).toEqual([200, 40, 40, 255]);
  });

  it('puts the origin in the middle of the bottom edge, y up', () => {
    const doc = { width: 100, height: 80 };
    expect(layerCenter(doc, { left: 0, top: 0, width: 100, height: 80 })).toEqual([0, 40]);
    expect(layerCenter(doc, { left: 10, top: 60, width: 20, height: 20 })).toEqual([-30, 10]);
  });

  it('multiplies the opacity of the groups in, and leaves out empty layers', () => {
    const out = flattenPsd(10, 10, [
      {
        name: 'g',
        opacity: 0.5,
        children: [
          { name: 'a', opacity: 0.5, left: 0, top: 0, imageData: solid(2, 2, [1, 2, 3, 4]) },
          { name: 'empty', left: 0, top: 0 },
        ],
      },
    ]);
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0].opacity).toBeCloseTo(0.25, 5);
    expect(out.skipped.empty).toBe(1);
  });

  it('maps the blend modes Spine has and cleans the names', () => {
    expect(blendOf('multiply')).toBe('multiply');
    expect(blendOf('screen')).toBe('screen');
    expect(blendOf('linear dodge')).toBe('additive');
    expect(blendOf('overlay')).toBe('normal');
    expect(blendOf(undefined)).toBe('normal');
    expect(pictureName('arm / left', 'x')).toBe('arm - left');
    expect(pictureName('  ', 'layer 3')).toBe('layer 3');
  });
});

describe('the shift a bigger canvas gives every layer', () => {
  it('is what most layers agree on, and nothing for a few or scattered moves', async () => {
    const { commonShift } = await import('../src/core/import/psd');
    expect(
      commonShift([
        [-50, 0],
        [-50.2, 0],
        [-49.9, 0.1],
        [12, 0],
      ]),
    ).toEqual([expect.closeTo(-50.03, 1), expect.closeTo(0.03, 1)]);
    expect(
      commonShift([
        [-50, 0],
        [-50, 0],
      ]),
    ).toEqual([0, 0]); // two layers prove nothing
    expect(
      commonShift([
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
    ).toEqual([0, 0]); // no majority
    expect(commonShift([null, null, [0, 0.2]])).toEqual([0, 0]);
    expect(commonShift([[-50, 0], [-50, 0], [-50, 0], null])).toEqual([-50, 0]);
  });
});
