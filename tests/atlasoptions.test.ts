/** Packer options: square pages, sizes in multiples of four, aliases for identical pictures, premultiplied alpha. */
import { describe, expect, it } from 'vitest';
import { composePage, footprint, packAtlas, premultiplyAlpha, writeAtlas } from '../src/core/export/atlas';
import type { PackInput } from '../src/core/export/atlas';
import { findAliases } from '../src/core/export/atlasBuild';
import { S } from './official';

const input = (name: string, width: number, height: number, extra: Partial<PackInput> = {}): PackInput => ({
  name,
  width,
  height,
  ...extra,
});
const inside = (pages: ReturnType<typeof packAtlas>) => {
  for (const p of pages)
    for (const r of p.regions) {
      const [w, h] = footprint(r);
      expect(r.x + w).toBeLessThanOrEqual(p.width);
      expect(r.y + h).toBeLessThanOrEqual(p.height);
    }
};

describe('square pages', () => {
  const inputs = [input('a', 100, 30), input('b', 90, 40), input('c', 20, 20), input('d', 60, 33)];
  it('are as wide as they are tall, with and without power of two', () => {
    for (const pot of [true, false]) {
      const pages = packAtlas(inputs, { pot, square: true, padding: 2 });
      for (const p of pages) expect(p.width).toBe(p.height);
      inside(pages);
      expect(
        pages
          .flatMap((p) => p.regions)
          .map((r) => r.name)
          .sort(),
      ).toEqual(['a', 'b', 'c', 'd']);
    }
  });
  it('a plain pot page may be a rectangle, a square one never is', () => {
    const wide = ['a', 'b', 'c', 'd'].map((n) => input(n, 60, 14));
    expect(packAtlas(wide, { pot: true }).some((p) => p.width !== p.height)).toBe(true);
    expect(packAtlas(wide, { pot: true, square: true }).every((p) => p.width === p.height)).toBe(true);
  });
});

describe('multiples of four', () => {
  it('every page side divides by four when power of two is off', () => {
    const pages = packAtlas([input('a', 37, 21), input('b', 18, 55), input('c', 9, 9)], { pot: false, multipleOf4: true, padding: 1 });
    for (const p of pages) {
      expect(p.width % 4).toBe(0);
      expect(p.height % 4).toBe(0);
    }
    inside(pages);
  });
});

describe('aliases', () => {
  it('finds pictures with exactly the same pixels and size, and nothing else', () => {
    const a = new Uint8Array(4 * 4 * 4).fill(7);
    const b = new Uint8Array(a);
    const c = new Uint8Array(a);
    c[10] = 8;
    const aliases = findAliases([
      { name: 'a', width: 4, height: 4, data: a },
      { name: 'b', width: 4, height: 4, data: b },
      { name: 'c', width: 4, height: 4, data: c },
      { name: 'd', width: 2, height: 8, data: a }, // the same bytes, another shape
    ]);
    expect([...aliases]).toEqual([['b', 'a']]);
  });

  it('an alias is not packed: its region sits where the original is, and the official atlas reads both', () => {
    const pages = packAtlas([input('hand', 30, 30), input('hand2', 30, 30, { aliasOf: 'hand' }), input('other', 20, 40)], { padding: 2 });
    const regions = pages.flatMap((p) => p.regions);
    expect(regions.map((r) => r.name).sort()).toEqual(['hand', 'hand2', 'other']);
    const a = regions.find((r) => r.name === 'hand')!;
    const b = regions.find((r) => r.name === 'hand2')!;
    expect([b.x, b.y, b.width, b.height, b.rotated]).toEqual([a.x, a.y, a.width, a.height, a.rotated]);
    // the page needs room for two pictures only
    const alone = packAtlas([input('hand', 30, 30), input('other', 20, 40)], { padding: 2 });
    expect(pages.map((p) => [p.width, p.height])).toEqual(alone.map((p) => [p.width, p.height]));
    const atlas = new S.TextureAtlas(writeAtlas(pages, () => 'a.png'));
    expect(atlas.findRegion('hand').x).toBe(atlas.findRegion('hand2').x);
    expect(atlas.findRegion('hand2').width).toBe(30);
  });

  it('a page is composed with the alias in place', () => {
    const pages = packAtlas([input('p', 2, 2), input('q', 2, 2, { aliasOf: 'p' })], { padding: 0, pot: false });
    const px = new Uint8ClampedArray(2 * 2 * 4).fill(200);
    const out = composePage(pages[0], (n) => (n === 'p' || n === 'q' ? { data: px } : undefined), 0);
    expect(out[0]).toBe(200);
  });
});

describe('premultiplied alpha', () => {
  it('multiplies the colour by the alpha and leaves an opaque pixel alone', () => {
    const px = new Uint8ClampedArray([200, 100, 50, 128, 10, 20, 30, 255, 255, 255, 255, 0]);
    premultiplyAlpha(px);
    expect([...px]).toEqual([100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it('the atlas says pma:true and the official reader sees it', () => {
    const pages = packAtlas([input('a', 8, 8)], {});
    const on = new S.TextureAtlas(writeAtlas(pages, () => 'a.png', { pma: true }));
    const off = new S.TextureAtlas(writeAtlas(pages, () => 'a.png', { pma: false }));
    expect(on.pages[0].pma).toBe(true);
    expect(off.pages[0].pma).toBe(false);
  });
});
