/** The GIF encoder, checked by decoding its own output with an independent, minimal LZW decoder. */
import { describe, expect, it } from 'vitest';
import { encodeGif, lzwEncode, medianCut } from '../src/core/export/gif';

/** Decodes the LZW data of one image (blocks already joined) back into palette indices. */
function lzwDecode(data: Uint8Array, minCode: number, count: number): number[] {
  const clear = 1 << minCode;
  const end = clear + 1;
  let size = minCode + 1;
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push([], []);
    size = minCode + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;
  while (out.length < count) {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += size;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad code');
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    if (table.length === 1 << size && size < 12) size++;
  }
  return out.slice(0, count);
}

describe('lzw', () => {
  it('round-trips pixels, including runs long enough to fill the table and force a clear code', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (const [n, bits] of [
      [10, 2],
      [500, 4],
      [30000, 8],
    ] as const) {
      const px = new Uint8Array(n).map(() => Math.floor(rnd() * (1 << bits) * (rnd() < 0.5 ? 1 : 0.2)));
      expect(lzwDecode(lzwEncode(px, Math.max(2, bits)), Math.max(2, bits), n)).toEqual(Array.from(px));
    }
    const flat = new Uint8Array(20000).fill(3);
    expect(lzwDecode(lzwEncode(flat, 2), 2, flat.length)).toEqual(Array.from(flat));
  });
});

describe('median cut', () => {
  it('finds the colors that are there', () => {
    const samples = Uint8Array.from([255, 0, 0, 250, 5, 0, 0, 0, 255, 0, 5, 250]);
    const c = medianCut(samples, 2);
    expect(c.length).toBe(2);
    const reds = c.filter((x) => x[0] > 200);
    const blues = c.filter((x) => x[2] > 200);
    expect(reds.length).toBe(1);
    expect(blues.length).toBe(1);
  });

  it('gives back fewer colors than asked when there are fewer', () => {
    expect(medianCut(Uint8Array.from([10, 20, 30]), 16)).toEqual([[10, 20, 30]]);
  });
});

describe('gif', () => {
  const w = 6;
  const h = 4;
  const frame = (rgba: [number, number, number, number]) => {
    const f = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) f.set(rgba, p * 4);
    return f;
  };

  it('writes a valid stream: header, size, frames, trailer', () => {
    const gif = encodeGif([frame([200, 30, 30, 255]), frame([30, 30, 200, 255])], { width: w, height: h, delayCs: 4 });
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[6] | (gif[7] << 8)).toBe(w);
    expect(gif[8] | (gif[9] << 8)).toBe(h);
    expect(gif[gif.length - 1]).toBe(0x3b);
    let images = 0;
    for (let i = 0; i < gif.length; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) images++;
    expect(images).toBe(2);
  });

  it('decodes to the same picture: colors within the palette error, transparent pixels stay transparent', () => {
    const f = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) f.set(p % 2 ? [20, 180, 60, 255] : [0, 0, 0, 0], p * 4);
    const gif = encodeGif([f], { width: w, height: h, delayCs: 3, transparent: true });
    // walk the stream: header, global table, extensions, then the image
    const tableBytes = 3 << ((gif[10] & 7) + 1);
    let at = 13 + tableBytes;
    while (gif[at] === 0x21) {
      at += 2;
      while (gif[at] !== 0) at += gif[at] + 1;
      at++;
    }
    expect(gif[at]).toBe(0x2c);
    const min = gif[at + 10];
    const data: number[] = [];
    let i = at + 11;
    while (gif[i] !== 0) {
      data.push(...gif.subarray(i + 1, i + 1 + gif[i]));
      i += gif[i] + 1;
    }
    const px = lzwDecode(Uint8Array.from(data), min, w * h);
    px.forEach((idx, p) => {
      if (p % 2 === 0)
        expect(idx).toBe(0); // the transparent index
      else {
        expect(idx).toBeGreaterThan(0);
        const pal = gif.subarray(13 + idx * 3, 13 + idx * 3 + 3); // the global table starts right after the 13-byte header
        expect(Math.abs(pal[0] - 20) + Math.abs(pal[1] - 180) + Math.abs(pal[2] - 60)).toBeLessThan(12);
      }
    });
  });
});
