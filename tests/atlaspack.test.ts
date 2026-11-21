/**
 * The packer with trimming and quarter turns: the atlas file we write is read by the OFFICIAL runtime (spine-core TextureAtlas and
 * RegionAttachment.computeUVs), and every sample point of every region must land on the same picture pixel that the whole,
 * untrimmed, unturned picture has there.
 */
import * as S from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';
import { composePage, footprint, packAtlas, trimBounds, writeAtlas } from '../src/core/export/atlas';
import type { PackInput } from '../src/core/export/atlas';

interface Picture {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A picture with a transparent border; every pixel of the opaque part is unique (x, y and the picture in the three colour channels). */
function picture(index: number, width: number, height: number, border: { l: number; t: number; r: number; b: number }): Picture {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= border.l && x < width - border.r && y >= border.t && y < height - border.b;
      const at = (y * width + x) * 4;
      data[at] = x;
      data[at + 1] = y;
      data[at + 2] = index + 1;
      data[at + 3] = inside ? 255 : 0;
    }
  }
  return { name: `img${index}`, width, height, data };
}

const PICTURES = [
  picture(0, 40, 24, { l: 4, t: 2, r: 6, b: 3 }),
  picture(1, 17, 50, { l: 0, t: 5, r: 2, b: 0 }),
  picture(2, 33, 33, { l: 8, t: 8, r: 8, b: 8 }),
  picture(3, 60, 9, { l: 1, t: 1, r: 1, b: 1 }),
  picture(4, 12, 44, { l: 3, t: 10, r: 3, b: 10 }),
  picture(5, 25, 25, { l: 0, t: 0, r: 0, b: 0 }),
];

function crop(p: Picture, b: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) for (let k = 0; k < 4; k++) out[(y * b.w + x) * 4 + k] = p.data[((b.y + y) * p.width + b.x + x) * 4 + k];
  return out;
}

function build(opts: { trim: boolean; rotate: boolean; padding: number; pot?: boolean }) {
  const pixels = new Map<string, Uint8ClampedArray>();
  const inputs: PackInput[] = PICTURES.map((p) => {
    const b = opts.trim ? trimBounds(p.data, p.width, p.height) : { x: 0, y: 0, w: p.width, h: p.height };
    pixels.set(p.name, crop(p, b));
    return {
      name: p.name,
      width: b.w,
      height: b.h,
      offsetX: b.x,
      offsetY: p.height - (b.y + b.h),
      originalWidth: p.width,
      originalHeight: p.height,
    };
  });
  const pages = packAtlas(inputs, { maxSize: 256, padding: opts.padding, pot: opts.pot ?? true, rotate: opts.rotate });
  const text = writeAtlas(pages, (i) => `page${i}.png`);
  const composed = pages.map((pg) => composePage(pg, (n) => ({ data: pixels.get(n)! }), opts.padding));
  return { pages, text, composed };
}

/** Looks every sample point of every region up through the official runtime. Returns how many points were compared. */
function checkThroughOfficial(built: ReturnType<typeof build>): number {
  const atlas = new S.TextureAtlas(built.text);
  let compared = 0;
  for (const p of PICTURES) {
    const region = atlas.findRegion(p.name)!;
    expect(region).toBeTruthy();
    const page = built.pages[atlas.pages.indexOf(region.page)];
    const pagePixels = built.composed[page.index];
    expect([region.originalWidth, region.originalHeight]).toEqual([p.width, p.height]);
    const offset = new Array<number>(8).fill(0);
    const uvs = new Array<number>(8).fill(0);
    S.RegionAttachment.computeUVs(region, 0, 0, 1, 1, 0, p.width, p.height, offset, uvs);
    // corners: 0 bottom left, 1 top left, 2 top right, 3 bottom right
    const at = (arr: number[], i: number) => [arr[i * 2], arr[i * 2 + 1]];
    const [bl, tl, br] = [at(offset, 0), at(offset, 1), at(offset, 3)];
    const [ubl, utl, ubr] = [at(uvs, 0), at(uvs, 1), at(uvs, 3)];
    for (let j = 0; j < region.height; j++) {
      for (let i = 0; i < region.width; i++) {
        const s = (i + 0.5) / region.width;
        const t = (j + 0.5) / region.height;
        const lx = bl[0] + s * (br[0] - bl[0]) + t * (tl[0] - bl[0]);
        const ly = bl[1] + s * (br[1] - bl[1]) + t * (tl[1] - bl[1]);
        const u = ubl[0] + s * (ubr[0] - ubl[0]) + t * (utl[0] - ubl[0]);
        const v = ubl[1] + s * (ubr[1] - ubl[1]) + t * (utl[1] - ubl[1]);
        const ix = Math.floor(lx + p.width / 2 + 1e-6);
        const iy = Math.floor(p.height / 2 - ly + 1e-6);
        const px = Math.floor(u * page.width + 1e-6);
        const py = Math.floor(v * page.height + 1e-6);
        const want = (iy * p.width + ix) * 4;
        const got = (py * page.width + px) * 4;
        expect([ix, iy]).toEqual([ix, Math.min(Math.max(iy, 0), p.height - 1)]); // inside the picture
        expect([pagePixels[got], pagePixels[got + 1], pagePixels[got + 2], pagePixels[got + 3]], `${p.name} sample ${i},${j}`).toEqual([
          p.data[want],
          p.data[want + 1],
          p.data[want + 2],
          p.data[want + 3],
        ]);
        compared++;
      }
    }
  }
  return compared;
}

describe('trimBounds', () => {
  it('finds the opaque part', () => {
    expect(trimBounds(PICTURES[0].data, 40, 24)).toEqual({ x: 4, y: 2, w: 30, h: 19 });
    expect(trimBounds(PICTURES[5].data, 25, 25)).toEqual({ x: 0, y: 0, w: 25, h: 25 });
  });
  it('keeps one pixel of a picture with nothing in it', () => {
    expect(trimBounds(new Uint8ClampedArray(4 * 3 * 3), 3, 3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('the atlas file as the official runtime reads it', () => {
  for (const trim of [false, true]) {
    for (const rotate of [false, true]) {
      it(`trim ${trim}, rotate ${rotate}: every point lands on the pixel it should`, () => {
        const built = build({ trim, rotate, padding: 2 });
        const n = checkThroughOfficial(built);
        expect(n).toBeGreaterThan(1000);
      });
    }
  }

  it('turns at least one region when turning is allowed and the pictures are long', () => {
    const built = build({ trim: false, rotate: true, padding: 1 });
    const regions = built.pages.flatMap((p) => p.regions);
    expect(regions.some((r) => r.rotated)).toBe(true);
    expect(built.text).toContain('rotate:90');
  });

  it('never turns without the option, and writes offsets only for trimmed pictures', () => {
    const plain = build({ trim: false, rotate: false, padding: 2 });
    expect(plain.text).not.toContain('rotate:');
    expect(plain.text).not.toContain('offsets:');
    const trimmed = build({ trim: true, rotate: false, padding: 2 });
    expect(trimmed.text).toContain('offsets:');
  });

  it('trimming makes the pages smaller or equal', () => {
    const area = (b: ReturnType<typeof build>) => b.pages.reduce((s, p) => s + p.width * p.height, 0);
    expect(area(build({ trim: true, rotate: false, padding: 2 }))).toBeLessThanOrEqual(
      area(build({ trim: false, rotate: false, padding: 2 })),
    );
  });

  it('keeps regions apart and inside the page, with or without power-of-two sizes', () => {
    for (const pot of [true, false]) {
      const built = build({ trim: true, rotate: true, padding: 2, pot });
      for (const page of built.pages) {
        const boxes = page.regions.map((r) => ({ r, f: footprint(r) }));
        for (const { r, f } of boxes) {
          expect(r.x).toBeGreaterThanOrEqual(2);
          expect(r.y).toBeGreaterThanOrEqual(2);
          expect(r.x + f[0] + 2).toBeLessThanOrEqual(page.width);
          expect(r.y + f[1] + 2).toBeLessThanOrEqual(page.height);
        }
        for (let a = 0; a < boxes.length; a++)
          for (let b = a + 1; b < boxes.length; b++) {
            const A = boxes[a];
            const B = boxes[b];
            const apart =
              A.r.x + A.f[0] + 2 <= B.r.x - 2 ||
              B.r.x + B.f[0] + 2 <= A.r.x - 2 ||
              A.r.y + A.f[1] + 2 <= B.r.y - 2 ||
              B.r.y + B.f[1] + 2 <= A.r.y - 2;
            expect(apart).toBe(true);
          }
      }
    }
  });

  it('fills the padding with the edge pixels of the region', () => {
    const built = build({ trim: false, rotate: false, padding: 2 });
    const page = built.pages[0];
    const r = page.regions.find((x) => x.name === 'img2')!;
    const pix = built.composed[0];
    const at = (x: number, y: number) => [...pix.subarray((y * page.width + x) * 4, (y * page.width + x) * 4 + 4)];
    expect(at(r.x - 2, r.y + 5)).toEqual(at(r.x, r.y + 5));
    expect(at(r.x + r.width + 1, r.y + 5)).toEqual(at(r.x + r.width - 1, r.y + 5));
    expect(at(r.x + 5, r.y - 1)).toEqual(at(r.x + 5, r.y));
  });

  it('writes the filter the person chose', () => {
    const built = build({ trim: false, rotate: false, padding: 0 });
    expect(writeAtlas(built.pages, (i) => `p${i}.png`, { filter: 'Nearest' })).toContain('filter:Nearest,Nearest');
    expect(built.text).toContain('filter:Linear,Linear');
  });

  it('still refuses a picture that cannot fit even turned', () => {
    expect(() => packAtlas([{ name: 'big', width: 300, height: 10 }], { maxSize: 256, padding: 0, rotate: true })).toThrow(/does not fit/);
    expect(() => packAtlas([{ name: 'long', width: 300, height: 10 }], { maxSize: 512, padding: 0, rotate: true })).not.toThrow();
  });
});

describe('page limit', () => {
  it('no page is bigger than maxSize, however many pictures there are', () => {
    const inputs: PackInput[] = Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, width: 90, height: 90 }));
    for (const maxSize of [128, 256, 512]) {
      const pages = packAtlas(inputs, { maxSize, padding: 1, pot: true });
      expect(pages.length).toBeGreaterThan(1);
      for (const p of pages) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(maxSize);
      expect(pages.reduce((n, p) => n + p.regions.length, 0)).toBe(40);
    }
  });
});
