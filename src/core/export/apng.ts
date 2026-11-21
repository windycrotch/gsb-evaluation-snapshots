/**
 * Animated PNG: the frames are ordinary PNG files (each one as a canvas writes it), and this puts their image data into one file with the
 * animation chunks of the APNG format (acTL, fcTL, fdAT). Full colour and soft transparency, unlike GIF; browsers play it like a picture.
 */
import { crc32 } from './zip';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  type: string;
  data: Uint8Array;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const readU32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** The chunks of a PNG file. */
export function pngChunks(png: Uint8Array): Chunk[] {
  if (png.length < 8 || SIGNATURE.some((v, i) => png[i] !== v)) throw new Error('Not a PNG file');
  const out: Chunk[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = readU32(png, at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    out.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

function chunk(type: string, data: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(be32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ApngOptions {
  /** Time one frame stays, as a fraction of a second: `delayNum / delayDen`. */
  delayNum: number;
  delayDen: number;
  /** How many times it plays; 0 is forever. */
  plays: number;
}

/** One APNG from the PNG files of its frames (all the same size and colour format). Throws when they differ or there are none. */
export function encodeApng(frames: Uint8Array[], opts: ApngOptions): Uint8Array {
  if (!frames.length) throw new Error('No frames');
  const parsed = frames.map(pngChunks);
  const head = parsed[0].find((c) => c.type === 'IHDR');
  if (!head) throw new Error('A frame has no header');
  const same = (ihdr: Chunk | undefined) =>
    !!ihdr && ihdr.data.length === head.data.length && ihdr.data.every((v, i) => v === head.data[i]);
  if (!parsed.every((p) => same(p.find((c) => c.type === 'IHDR')))) throw new Error('The frames differ in size or colour format');
  const width = readU32(head.data, 0);
  const height = readU32(head.data, 4);
  const out: Uint8Array[] = [Uint8Array.from(SIGNATURE), chunk('IHDR', head.data)];
  // colour tables of an indexed picture have to come before the image data
  for (const c of parsed[0]) if (c.type === 'PLTE' || c.type === 'tRNS') out.push(chunk(c.type, c.data));
  out.push(chunk('acTL', [...be32(frames.length), ...be32(opts.plays)]));
  let sequence = 0;
  parsed.forEach((p, i) => {
    const fctl = [
      ...be32(sequence++),
      ...be32(width),
      ...be32(height),
      ...be32(0),
      ...be32(0),
      (opts.delayNum >> 8) & 255,
      opts.delayNum & 255,
      (opts.delayDen >> 8) & 255,
      opts.delayDen & 255,
      0,
      0,
    ];
    out.push(chunk('fcTL', fctl));
    for (const c of p) {
      if (c.type !== 'IDAT') continue;
      if (i === 0) out.push(chunk('IDAT', c.data));
      else {
        const body = new Uint8Array(4 + c.data.length);
        body.set(be32(sequence++), 0);
        body.set(c.data, 4);
        out.push(chunk('fdAT', body));
      }
    }
  });
  out.push(chunk('IEND', []));
  return join(out);
}

/** The delay of a frame rate as the two numbers of an fcTL chunk (`fps` frames a second). */
export function frameDelay(fps: number): { delayNum: number; delayDen: number } {
  const den = Math.max(1, Math.min(65535, Math.round(fps * 1000)));
  return { delayNum: 1000, delayDen: den };
}
