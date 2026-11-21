/** The unpacker is the inverse of the packer: what composePage puts on a page comes back out of it, trimmed, turned and premultiplied or not. */
import { describe, expect, it } from 'vitest';
import { composePage, packAtlas, premultiplyAlpha, writeAtlas } from '../src/core/export/atlas';
import type { PackInput } from '../src/core/export/atlas';
import { makeRegion } from '../src/core/export/atlasBuild';
import { cutRegion, unpackAtlas, unpremultiplyAlpha } from '../src/core/import/unpack';
import type { Picture } from '../src/core/import/unpack';

/** A picture whose every pixel is different (so a wrong mapping shows), with a transparent border. */
function pic(seed: number, width: number, height: number, border: number): Picture {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = x >= border && x < width - border && y >= border && y < height - border;
      data.set(
        inside ? [(x * 7 + seed) % 256, (y * 11 + seed * 3) % 256, (x + y + seed * 5) % 256, 255] : [0, 0, 0, 0],
        (y * width + x) * 4,
      );
    }
  return { width, height, data };
}

function page(pictures: Record<string, Picture>, opts: { trim: boolean; rotate: boolean; pma?: boolean }) {
  const pixels = new Map<string, Uint8ClampedArray>();
  const inputs: PackInput[] = [];
  for (const [name, p] of Object.entries(pictures)) {
    const region = makeRegion(name, false, p.width, p.height, p.data, opts.trim);
    pixels.set(name, region.pixels);
    inputs.push(region.input);
  }
  const pages = packAtlas(inputs, { maxSize: 128, padding: 0, rotate: opts.rotate });
  const sheets = pages.map((pg) => {
    const data = composePage(pg, (n) => ({ data: pixels.get(n)! }), 0);
    if (opts.pma) premultiplyAlpha(data);
    return { width: pg.width, height: pg.height, data };
  });
  const text = writeAtlas(pages, (i) => `page${i}.png`, { pma: !!opts.pma });
  return { pages, sheets, text };
}

const same = (a: Picture, b: Picture) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);
const sheetOf = (built: { sheets: Picture[] }) => (file: string) => built.sheets[Number(/page(\d+)/.exec(file)![1])];

describe('unpackAtlas', () => {
  const pictures = { a: pic(1, 20, 12, 3), b: pic(2, 9, 30, 0), 'parts/c': pic(3, 40, 7, 2), d: pic(4, 25, 25, 5) };

  for (const trim of [false, true]) {
    for (const rotate of [false, true]) {
      it(`gives every picture back as it was (trim ${trim}, rotate ${rotate})`, () => {
        const built = page(pictures, { trim, rotate });
        if (rotate) expect(built.pages.flatMap((p) => p.regions).some((r) => r.rotated)).toBe(true);
        const out = unpackAtlas(built.text, sheetOf(built));
        expect(out.warnings).toEqual([]);
        expect(out.pictures.map((p) => p.name).sort()).toEqual(Object.keys(pictures).sort());
        for (const u of out.pictures) expect(same(u.picture, pictures[u.name as keyof typeof pictures]), `${u.name}`).toBe(true);
      });
    }
  }

  it('puts a premultiplied page back to straight alpha (opaque pixels exactly, half transparent ones within a step)', () => {
    const half: Picture = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    for (let i = 0; i < 64; i += 4) half.data.set([200, 100, 50, 128], i);
    const built = page({ half, solid: pic(5, 8, 8, 0) }, { trim: false, rotate: false, pma: true });
    const out = unpackAtlas(built.text, sheetOf(built));
    const back = out.pictures.find((p) => p.name === 'half')!.picture;
    for (let i = 0; i < 64; i += 4) {
      expect(Math.abs(back.data[i] - 200)).toBeLessThanOrEqual(2);
      expect(back.data[i + 3]).toBe(128);
    }
    expect(same(out.pictures.find((p) => p.name === 'solid')!.picture, pic(5, 8, 8, 0))).toBe(true);
    const keep = unpackAtlas(built.text, sheetOf(built), { unpremultiply: false });
    expect(keep.pictures.find((p) => p.name === 'half')!.picture.data[0]).toBe(100);
  });

  it('lists a missing page and a name used twice, and keeps going', () => {
    const text =
      'a.png\nsize:8,8\nfilter:Linear,Linear\npma:false\nr\nbounds:0,0,4,4\nr\nbounds:4,0,4,4\n\nmissing.png\nsize:8,8\nfilter:Linear,Linear\npma:false\nz\nbounds:0,0,4,4\n';
    const sheet: Picture = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(9) };
    const out = unpackAtlas(text, (f) => (f === 'a.png' ? sheet : null));
    expect(out.pictures.map((p) => p.name)).toEqual(['r']);
    expect(out.warnings.join('|')).toMatch(/missing.png/);
    expect(out.warnings.join('|')).toMatch(/"r" is used twice/);
  });

  it('cutRegion stays inside the page and the picture even for a region that points outside', () => {
    const sheet: Picture = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
    const out = cutRegion(sheet, {
      name: 'x',
      x: 2,
      y: 2,
      width: 6,
      height: 6,
      rotate: 0,
      offsetX: 0,
      offsetY: 0,
      originalWidth: 6,
      originalHeight: 6,
    });
    expect(out.data.length).toBe(6 * 6 * 4);
    const pm = new Uint8ClampedArray([100, 50, 25, 128, 7, 7, 7, 0]);
    unpremultiplyAlpha(pm);
    expect([...pm]).toEqual([199, 100, 50, 128, 7, 7, 7, 0]);
  });
});
