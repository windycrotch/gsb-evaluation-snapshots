/**
 * PNG for the command line, which has no canvas: a decoder (every colour type and bit depth, interlaced or not) and an encoder for 8-bit RGBA,
 * on Node's zlib; and a resize that averages straight alpha the way a smoothing canvas does (colours weighted by alpha, so no dark fringes).
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, row by row. */
  data: Uint8ClampedArray;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: ArrayLike<number>): Buffer {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter 1 (Sub) packs the flat areas of a texture page better than none
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = (rgba[y * stride + x] - (x >= 4 ? rgba[y * stride + x - 4] : 0)) & 0xff;
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undoes the row filters of a (sub)image in place; returns the unfiltered rows without the filter bytes. */
function unfilter(raw: Uint8Array, at: number, rowBytes: number, rows: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const type = raw[at + y * (rowBytes + 1)];
    const src = at + y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[dst - rowBytes + x - bpp] : 0;
      let v = raw[src + x];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) v += paeth(left, up, upLeft);
      else if (type !== 0) throw new Error('bad PNG filter');
      out[dst + x] = v & 0xff;
    }
  }
  return out;
}

/** Decodes a PNG file to straight RGBA, or null when the bytes are not a PNG this decoder reads. */
export function decodePng(file: Uint8Array): Pixels | null {
  try {
    if (file.length < 33 || SIGNATURE.some((b, i) => file[i] !== b)) return null;
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    for (let at = 8; at + 8 <= file.length;) {
      const len = view.getUint32(at);
      const type = String.fromCharCode(file[at + 4], file[at + 5], file[at + 6], file[at + 7]);
      const body = file.subarray(at + 8, at + 8 + len);
      if (type === 'IHDR') {
        width = view.getUint32(at + 8);
        height = view.getUint32(at + 12);
        depth = file[at + 16];
        colour = file[at + 17];
        interlace = file[at + 20];
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      at += 12 + len;
    }
    const channels = CHANNELS[colour];
    if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth) || !idat.length || width * height > 1 << 28) return null;
    if (colour === 3 && !palette) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const bits = channels * depth;
    const bpp = Math.max(1, bits >> 3);
    const out = new Uint8ClampedArray(width * height * 4);
    const max = (1 << Math.min(depth, 8)) - 1;
    const sample = (row: Uint8Array, rowAt: number, index: number): number => {
      // the index-th sample of a row, as 0..255 (a 16-bit sample keeps its high byte); `trnsValue` below needs the raw value, so it reads it itself
      if (depth === 8) return row[rowAt + index];
      if (depth === 16) return row[rowAt + index * 2];
      const bit = index * depth;
      return (row[rowAt + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
    };
    const rawSample = (row: Uint8Array, rowAt: number, index: number): number =>
      depth === 16 ? (row[rowAt + index * 2] << 8) | row[rowAt + index * 2 + 1] : sample(row, rowAt, index);
    const scale = depth < 8 ? 255 / max : 1;
    const put = (rows: Uint8Array, rowBytes: number, w: number, h: number, place: (x: number, y: number) => number) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const base = y * rowBytes;
          const o = place(x, y);
          if (colour === 3) {
            const i = sample(rows, base, x);
            out[o] = palette![i * 3] ?? 0;
            out[o + 1] = palette![i * 3 + 1] ?? 0;
            out[o + 2] = palette![i * 3 + 2] ?? 0;
            out[o + 3] = trns && i < trns.length ? trns[i] : 255;
          } else if (colour === 0 || colour === 4) {
            const g = Math.round(sample(rows, base, x * channels) * scale);
            out[o] = out[o + 1] = out[o + 2] = g;
            if (colour === 4) out[o + 3] = Math.round(sample(rows, base, x * channels + 1) * scale);
            else {
              const key = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
              out[o + 3] = key >= 0 && rawSample(rows, base, x) === key ? 0 : 255;
            }
          } else {
            out[o] = sample(rows, base, x * channels);
            out[o + 1] = sample(rows, base, x * channels + 1);
            out[o + 2] = sample(rows, base, x * channels + 2);
            if (colour === 6) out[o + 3] = sample(rows, base, x * channels + 3);
            else {
              const hit =
                trns &&
                trns.length >= 6 &&
                rawSample(rows, base, x * 3) === ((trns[0] << 8) | trns[1]) &&
                rawSample(rows, base, x * 3 + 1) === ((trns[2] << 8) | trns[3]) &&
                rawSample(rows, base, x * 3 + 2) === ((trns[4] << 8) | trns[5]);
              out[o + 3] = hit ? 0 : 255;
            }
          }
        }
      }
    };
    if (!interlace) {
      const rowBytes = (width * bits + 7) >> 3;
      put(unfilter(raw, 0, rowBytes, height, bpp), rowBytes, width, height, (x, y) => (y * width + x) * 4);
    } else {
      const passes = [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ];
      let at = 0;
      for (const [x0, y0, dx, dy] of passes) {
        const w = Math.ceil((width - x0) / dx);
        const h = Math.ceil((height - y0) / dy);
        if (w <= 0 || h <= 0) continue;
        const rowBytes = (w * bits + 7) >> 3;
        put(unfilter(raw, at, rowBytes, h, bpp), rowBytes, w, h, (x, y) => ((y0 + y * dy) * width + x0 + x * dx) * 4);
        at += (rowBytes + 1) * h;
      }
    }
    return { width, height, data: out };
  } catch {
    return null;
  }
}

/**
 * The picture at another size, from straight RGBA: each new pixel is the average of the old area it covers (a box filter, so shrinking is smooth;
 * enlarging blends the nearest four). Colours are weighted by alpha so a transparent border does not darken the edge.
 */
export function resizePixels(src: Pixels, width: number, height: number): Pixels {
  if (width === src.width && height === src.height) return src;
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  const at = (x: number, y: number, k: number) =>
    src.data[(Math.min(src.height - 1, Math.max(0, y)) * src.width + Math.min(src.width - 1, Math.max(0, x))) * 4 + k];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let w = 0;
      const add = (px: number, py: number, weight: number) => {
        const alpha = at(px, py, 3) * weight;
        r += at(px, py, 0) * alpha;
        g += at(px, py, 1) * alpha;
        b += at(px, py, 2) * alpha;
        a += alpha;
        w += weight;
      };
      if (sx > 1 || sy > 1) {
        const x0 = x * sx;
        const x1 = (x + 1) * sx;
        const y0 = y * sy;
        const y1 = (y + 1) * sy;
        for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
          const wy = Math.min(py + 1, y1) - Math.max(py, y0);
          for (let px = Math.floor(x0); px < Math.ceil(x1); px++) add(px, py, wy * (Math.min(px + 1, x1) - Math.max(px, x0)));
        }
      } else {
        const fx = (x + 0.5) * sx - 0.5;
        const fy = (y + 0.5) * sy - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        add(ix, iy, (1 - tx) * (1 - ty));
        add(ix + 1, iy, tx * (1 - ty));
        add(ix, iy + 1, (1 - tx) * ty);
        add(ix + 1, iy + 1, tx * ty);
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / w);
    }
  }
  return { width, height, data: out };
}
