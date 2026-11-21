/** The command line's PNG codec: round trips, every colour type and filter, interlacing, and the resize. */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, decodePng, encodePng, resizePixels } from '../cli/png';

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG made by hand: header fields, optional chunks, and raw scanline bytes (each row already starting with its filter byte). */
function png(
  width: number,
  height: number,
  depth: number,
  colour: number,
  raw: number[],
  extra: [string, number[]][] = [],
  interlace = 0,
): Uint8Array {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = depth;
  head[9] = colour;
  head[12] = interlace;
  return Buffer.concat([
    SIG,
    chunk('IHDR', head),
    ...extra.map(([t, d]) => chunk(t, Uint8Array.from(d))),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const pixelsOf = (p: ReturnType<typeof decodePng>) => Array.from(p!.data);

describe('encode and decode', () => {
  it('round trips RGBA with every byte value', () => {
    const w = 23;
    const h = 17;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3)) & 255;
    const back = decodePng(encodePng(w, h, data))!;
    expect([back.width, back.height]).toEqual([w, h]);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });
  it('knows a PNG when it sees one', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodePng(Buffer.concat([SIG, Buffer.from('garbage')]))).toBeNull();
  });
});

describe('colour types and depths', () => {
  it('8-bit RGB gets full alpha, a tRNS colour key makes that colour clear', () => {
    const raw = [0, 10, 20, 30, 1, 2, 3];
    expect(pixelsOf(decodePng(png(2, 1, 8, 2, raw)))).toEqual([10, 20, 30, 255, 1, 2, 3, 255]);
    expect(pixelsOf(decodePng(png(2, 1, 8, 2, raw, [['tRNS', [0, 1, 0, 2, 0, 3]]])))).toEqual([10, 20, 30, 255, 1, 2, 3, 0]);
  });
  it('grey 8, grey with alpha, and 1-bit grey (scaled to 0..255)', () => {
    expect(pixelsOf(decodePng(png(2, 1, 8, 0, [0, 50, 200])))).toEqual([50, 50, 50, 255, 200, 200, 200, 255]);
    expect(pixelsOf(decodePng(png(1, 1, 8, 4, [0, 90, 128])))).toEqual([90, 90, 90, 128]);
    expect(pixelsOf(decodePng(png(3, 1, 1, 0, [0, 0b10100000])))).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });
  it('palette with 4-bit indices and a tRNS table', () => {
    const plte = [255, 0, 0, 0, 255, 0, 0, 0, 255];
    const out = pixelsOf(
      decodePng(
        png(
          3,
          1,
          4,
          3,
          [0, 0x01, 0x20],
          [
            ['PLTE', plte],
            ['tRNS', [128]],
          ],
        ),
      ),
    );
    expect(out).toEqual([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255]);
  });
  it('16-bit keeps the high byte', () => {
    expect(pixelsOf(decodePng(png(1, 1, 16, 6, [0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0])))).toEqual([0x12, 0x56, 0x9a, 0xde]);
  });
});

describe('filters and interlacing', () => {
  it('Sub, Up, Average and Paeth rows undo to the same picture', () => {
    const w = 5;
    const h = 5;
    const rgba: number[] = [];
    for (let i = 0; i < w * h * 4; i++) rgba.push((i * 53 + 7) & 255);
    const bpp = 4;
    const stride = w * 4;
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const raw: number[] = [];
    for (let y = 0; y < h; y++) {
      const type = y % 5;
      raw.push(type);
      for (let x = 0; x < stride; x++) {
        const cur = rgba[y * stride + x];
        const left = x >= bpp ? rgba[y * stride + x - bpp] : 0;
        const up = y ? rgba[(y - 1) * stride + x] : 0;
        const ul = y && x >= bpp ? rgba[(y - 1) * stride + x - bpp] : 0;
        const pred = type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : type === 4 ? paeth(left, up, ul) : 0;
        raw.push((cur - pred) & 255);
      }
    }
    expect(pixelsOf(decodePng(png(w, h, 8, 6, raw)))).toEqual(rgba);
  });
  it('an Adam7 interlaced picture comes out in the right places', () => {
    const w = 5;
    const h = 5;
    const grey = (x: number, y: number) => y * 10 + x;
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    const raw: number[] = [];
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((w - x0) / dx);
      const ph = Math.ceil((h - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      for (let y = 0; y < ph; y++) {
        raw.push(0);
        for (let x = 0; x < pw; x++) raw.push(grey(x0 + x * dx, y0 + y * dy));
      }
    }
    const got = decodePng(png(w, h, 8, 0, raw, [], 1))!;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(got.data[(y * w + x) * 4]).toBe(grey(x, y));
  });
});

describe('resizePixels', () => {
  const solid = (w: number, h: number, c: [number, number, number, number]) => ({
    width: w,
    height: h,
    data: new Uint8ClampedArray(Array.from({ length: w * h }, () => c).flat()),
  });
  it('keeps the size it is given and a flat colour when it shrinks or grows', () => {
    const p = solid(8, 6, [10, 200, 30, 255]);
    expect(resizePixels(p, 8, 6)).toBe(p);
    for (const [w, h] of [
      [4, 3],
      [3, 2],
      [16, 12],
      [5, 7],
    ] as const) {
      const r = resizePixels(p, w, h);
      expect([r.width, r.height]).toEqual([w, h]);
      for (let i = 0; i < w * h; i++) expect(Array.from(r.data.subarray(i * 4, i * 4 + 4))).toEqual([10, 200, 30, 255]);
    }
  });
  it('averages a checker into the middle value and does not darken a transparent edge', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    const r = resizePixels({ width: 2, height: 2, data }, 1, 1);
    expect(Array.from(r.data)).toEqual([128, 128, 128, 255]);
    const edge = resizePixels({ width: 2, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0]) }, 1, 1);
    expect(Array.from(edge.data)).toEqual([200, 100, 50, 128]);
  });
});
