/**
 * A small GIF89a encoder: one shared palette (median cut), optional transparency (index 0), LZW as the format wants it.
 * Pure data in, bytes out, so it runs in tests; the editor feeds it frames read back from the canvas.
 */

export interface GifOptions {
  width: number;
  height: number;
  /** Delay between frames in hundredths of a second (the format cannot go below 2 in most viewers). */
  delayCs: number;
  /** 0 = forever, n = n times. */
  loops?: number;
  /** Pixels with alpha below 128 become transparent. */
  transparent?: boolean;
  /** Called after every frame is encoded (the slow part), with the frames done and the number of frames. */
  onProgress?: (done: number, total: number) => void;
}

/** Median-cut: up to `count` representative colors of the given RGB samples (packed r, g, b triples). */
export function medianCut(samples: Uint8Array, count: number): [number, number, number][] {
  const n = samples.length / 3;
  if (n === 0) return [[0, 0, 0]];
  type Box = { idx: Uint32Array };
  const all = new Uint32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  const boxes: Box[] = [{ idx: all }];
  const range = (b: Box): [number, number] => {
    // [channel with the widest spread, that spread]
    let best = 0;
    let spread = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < b.idx.length; i++) {
        const v = samples[b.idx[i] * 3 + c];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > spread) {
        spread = hi - lo;
        best = c;
      }
    }
    return [best, spread];
  };
  while (boxes.length < count) {
    // split the box with the largest spread (and more than one sample)
    let pick = -1;
    let pickSpread = 0;
    let pickChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].idx.length < 2) continue;
      const [c, s] = range(boxes[i]);
      if (s > pickSpread) {
        pickSpread = s;
        pick = i;
        pickChannel = c;
      }
    }
    if (pick < 0) break;
    const b = boxes[pick];
    const sorted = Array.from(b.idx).sort((x, y) => samples[x * 3 + pickChannel] - samples[y * 3 + pickChannel]);
    const mid = sorted.length >> 1;
    boxes.splice(pick, 1, { idx: Uint32Array.from(sorted.slice(0, mid)) }, { idx: Uint32Array.from(sorted.slice(mid)) });
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (let i = 0; i < b.idx.length; i++) {
      r += samples[b.idx[i] * 3];
      g += samples[b.idx[i] * 3 + 1];
      bl += samples[b.idx[i] * 3 + 2];
    }
    const k = b.idx.length || 1;
    return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)] as [number, number, number];
  });
}

/** LZW with the variable code length of GIF. `minCode` is the number of bits of a raw pixel index (at least 2). */
export function lzwEncode(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode;
  const end = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const put = (code: number, size: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let size = minCode + 1;
  let next = end + 1;
  let dict = new Map<number, number>();
  put(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = prefix * 256 + c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      put(clear, size);
      dict = new Map();
      size = minCode + 1;
      next = end + 1;
    }
    prefix = c;
  }
  put(prefix, size);
  put(end, size);
  if (bits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

function blocks(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const part = data.subarray(i, i + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

/** Frames are RGBA bytes, `width * height * 4` each. */
export function encodeGif(frames: Uint8ClampedArray[] | Uint8Array[], opts: GifOptions): Uint8Array {
  const { width, height } = opts;
  const transparent = !!opts.transparent;
  // a palette for the whole animation, built from a sample of its opaque pixels
  const sample: number[] = [];
  const step = Math.max(1, Math.floor((frames.length * width * height) / 60000));
  let seen = 0;
  for (const f of frames) {
    for (let p = 0; p < width * height; p++) {
      if (f[p * 4 + 3] < 128 && transparent) continue;
      if (seen++ % step === 0) sample.push(f[p * 4], f[p * 4 + 1], f[p * 4 + 2]);
    }
  }
  const colors = medianCut(Uint8Array.from(sample), transparent ? 255 : 256);
  const palette: [number, number, number][] = transparent ? [[0, 0, 0], ...colors] : colors;
  const bitsPerPixel = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  while (palette.length < 1 << bitsPerPixel) palette.push([0, 0, 0]);
  const first = transparent ? 1 : 0;
  const cache = new Int16Array(1 << 18).fill(-1); // by the top 6 bits of each channel
  const nearest = (r: number, g: number, b: number): number => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = first;
    let bestD = Infinity;
    for (let i = first; i < first + colors.length; i++) {
      const dr = palette[i][0] - r;
      const dg = palette[i][1] - g;
      const db = palette[i][2] - b;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };

  const out: number[] = [];
  const word = (v: number) => out.push(v & 255, (v >> 8) & 255);
  out.push(...Array.from('GIF89a', (c) => c.charCodeAt(0)));
  word(width);
  word(height);
  out.push(0x80 | 0x70 | (bitsPerPixel - 1), 0, 0); // global table, 8 bits of colour, background 0
  for (const [r, g, b] of palette) out.push(r, g, b);
  out.push(0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1);
  word(opts.loops ?? 0);
  out.push(0);
  let done = 0;
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, (transparent ? 2 << 2 : 1 << 2) | (transparent ? 1 : 0)); // dispose to background, transparency flag
    word(Math.max(2, Math.round(opts.delayCs)));
    out.push(0, 0);
    out.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    out.push(0);
    const idx = new Uint8Array(width * height);
    for (let p = 0; p < idx.length; p++) idx[p] = transparent && f[p * 4 + 3] < 128 ? 0 : nearest(f[p * 4], f[p * 4 + 1], f[p * 4 + 2]);
    const min = Math.max(2, bitsPerPixel);
    out.push(min);
    for (const byte of blocks(lzwEncode(idx, min))) out.push(byte); // not a spread: a frame can be longer than the argument limit
    opts.onProgress?.(++done, frames.length);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
