/** APNG: the frames go in as plain PNGs and come out of the animation chunks as the same pictures. */
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../cli/png';
import { encodeApng, frameDelay, pngChunks } from '../src/core/export/apng';
import { crc32 } from '../src/core/export/zip';

function frame(seed: number, w = 9, h = 7): { png: Uint8Array; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * 7 + seed * 31) % 256, (i * 3 + seed) % 256, seed * 40, 100 + ((i + seed) % 150)], i * 4);
  return { png: new Uint8Array(encodePng(w, h, data)), data };
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

describe('encodeApng', () => {
  const frames = [frame(1), frame(2), frame(3)];
  const apng = encodeApng(
    frames.map((f) => f.png),
    { delayNum: 1000, delayDen: 30000, plays: 0 },
  );
  const chunks = pngChunks(apng);

  it('has the animation chunks in the order the format wants, with valid checksums', () => {
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
    const act = chunks[1].data;
    expect(u32(act, 0)).toBe(3);
    expect(u32(act, 4)).toBe(0);
    // every checksum is the crc of type + data
    for (let at = 8; at < apng.length;) {
      const len = u32(apng, at);
      expect(u32(apng, at + 8 + len)).toBe(crc32(apng.subarray(at + 4, at + 8 + len)));
      at += 12 + len;
    }
  });

  it('numbers the fcTL and fdAT chunks one after another from 0', () => {
    const seq = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => u32(c.data, 0));
    expect(seq).toEqual(seq.map((_, i) => i));
    const fctl = chunks.find((c) => c.type === 'fcTL')!.data;
    expect(u32(fctl, 4)).toBe(9);
    expect(u32(fctl, 8)).toBe(7);
    expect((fctl[20] << 8) | fctl[21]).toBe(1000);
    expect((fctl[22] << 8) | fctl[23]).toBe(30000);
  });

  it('each frame comes back out of its chunks as the picture it was', () => {
    const header = chunks[0];
    const rebuild = (data: Uint8Array) => {
      const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const add = (type: string, body: Uint8Array) => {
        const buf = new Uint8Array(12 + body.length);
        buf[0] = (body.length >>> 24) & 255;
        buf[1] = (body.length >>> 16) & 255;
        buf[2] = (body.length >>> 8) & 255;
        buf[3] = body.length & 255;
        for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
        buf.set(body, 8);
        const c = crc32(buf.subarray(4, 8 + body.length));
        buf[8 + body.length] = (c >>> 24) & 255;
        buf[9 + body.length] = (c >>> 16) & 255;
        buf[10 + body.length] = (c >>> 8) & 255;
        buf[11 + body.length] = c & 255;
        parts.push(...buf);
      };
      add('IHDR', header.data);
      add('IDAT', data);
      add('IEND', new Uint8Array(0));
      return Uint8Array.from(parts);
    };
    const datas = [chunks[3].data, chunks[5].data.subarray(4), chunks[7].data.subarray(4)];
    datas.forEach((d, i) => expect(Array.from(decodePng(Buffer.from(rebuild(d)))!.data), `frame ${i}`).toEqual(Array.from(frames[i].data)));
  });

  it('a first frame alone still works as an ordinary PNG, and bad input is refused', () => {
    expect(decodePng(Buffer.from(apng))!.width).toBe(9);
    expect(() => encodeApng([], { delayNum: 1, delayDen: 10, plays: 0 })).toThrow(/No frames/);
    expect(() => encodeApng([frame(1).png, frame(2, 5, 5).png], { delayNum: 1, delayDen: 10, plays: 0 })).toThrow(/differ/);
    expect(() => pngChunks(new Uint8Array([1, 2, 3]))).toThrow(/Not a PNG/);
  });

  it('turns a frame rate into the two numbers of the delay', () => {
    expect(frameDelay(30)).toEqual({ delayNum: 1000, delayDen: 30000 });
    expect(frameDelay(12).delayDen).toBe(12000);
    expect(frameDelay(0).delayDen).toBe(1);
    expect(frameDelay(1e6).delayDen).toBe(65535);
  });
});
