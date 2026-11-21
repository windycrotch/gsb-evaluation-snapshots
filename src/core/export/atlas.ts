/** MaxRects texture atlas packer + Spine atlas text writer. Pure logic; pixels are composed by composePage. */

export interface PackInput {
  name: string;
  /** The size that is packed: the picture without its empty border when it was trimmed. */
  width: number;
  height: number;
  /** A trimmed picture: where the packed part sits in the whole one (offsetY from the bottom, as the atlas file says it) and the whole size. */
  offsetX?: number;
  offsetY?: number;
  originalWidth?: number;
  originalHeight?: number;
  /** Name of a picture with exactly the same pixels: this one is not packed, its region takes the place of that one (Spine's alias). */
  aliasOf?: string;
}

export interface PackedRegion {
  name: string;
  /** The top left corner of the region on the page. A turned region takes height × width there. */
  x: number;
  y: number;
  /** The size of the region as it is in the picture (before turning). */
  width: number;
  height: number;
  /** Turned a quarter turn (rotate:90 in the atlas file) to fit better. */
  rotated: boolean;
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
}

export interface AtlasPage {
  index: number;
  width: number;
  height: number;
  regions: PackedRegion[];
}

export interface PackOptions {
  maxSize?: number;
  /** Transparent/extruded border around every region. */
  padding?: number;
  /** Power-of-two page sizes (default true). */
  pot?: boolean;
  /** Allow a quarter turn of a region when it fits better. */
  rotate?: boolean;
  /** Pages that are as wide as they are tall. */
  square?: boolean;
  /** Page sizes that are multiples of four (without power of two: some compressed texture formats want it). */
  multipleOf4?: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class MaxRects {
  free: Rect[];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  /** Best short side fit; with `turn` the quarter-turned size is tried too (the rect then is h × w and `turned` is set). */
  insert(w: number, h: number, turn = false): (Rect & { turned: boolean }) | null {
    let best: (Rect & { turned: boolean }) | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    const sizes: [number, number, boolean][] =
      turn && w !== h
        ? [
            [w, h, false],
            [h, w, true],
          ]
        : [[w, h, false]];
    for (const [rw, rh, turned] of sizes) {
      for (const f of this.free) {
        if (f.w >= rw && f.h >= rh) {
          const lw = f.w - rw;
          const lh = f.h - rh;
          const short = Math.min(lw, lh);
          const long = Math.max(lw, lh);
          if (short < bestShort || (short === bestShort && long < bestLong)) {
            best = { x: f.x, y: f.y, w: rw, h: rh, turned };
            bestShort = short;
            bestLong = long;
          }
        }
      }
    }
    if (!best) return null;
    this.place(best);
    return best;
  }

  private place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // prune contained rects
    this.free = next.filter(
      (a, i) =>
        !next.some(
          (b, j) =>
            i !== j &&
            a.x >= b.x &&
            a.y >= b.y &&
            a.x + a.w <= b.x + b.w &&
            a.y + a.h <= b.y + b.h &&
            (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || i > j),
        ),
    );
  }
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/** The width and height a region takes on its page. */
export const footprint = (r: Pick<PackedRegion, 'width' | 'height' | 'rotated'>): [number, number] =>
  r.rotated ? [r.height, r.width] : [r.width, r.height];

function tryPack(items: PackInput[], size: [number, number], pad: number, rotate: boolean): { placed: PackedRegion[]; rest: PackInput[] } {
  const packer = new MaxRects(size[0], size[1]);
  const placed: PackedRegion[] = [];
  const rest: PackInput[] = [];
  for (const it of items) {
    const r = packer.insert(it.width + pad * 2, it.height + pad * 2, rotate);
    if (r) {
      placed.push({
        name: it.name,
        x: r.x + pad,
        y: r.y + pad,
        width: it.width,
        height: it.height,
        rotated: r.turned,
        offsetX: it.offsetX ?? 0,
        offsetY: it.offsetY ?? 0,
        originalWidth: it.originalWidth ?? it.width,
        originalHeight: it.originalHeight ?? it.height,
      });
    } else rest.push(it);
  }
  return { placed, rest };
}

export function packAtlas(inputs: PackInput[], options: PackOptions = {}): AtlasPage[] {
  const maxSize = options.maxSize ?? 2048;
  const pad = options.padding ?? 2;
  const pot = options.pot ?? true;
  const rotate = options.rotate ?? false;
  const square = options.square ?? false;
  const mult4 = options.multipleOf4 ?? false;
  const aliases = inputs.filter((i) => i.aliasOf);
  const items = inputs
    .filter((i) => !i.aliasOf)
    .slice()
    .sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || b.width * b.height - a.width * a.height);
  for (const it of items) {
    const fits = (w: number, h: number) => w + pad * 2 <= maxSize && h + pad * 2 <= maxSize;
    if (!fits(it.width, it.height) && !(rotate && fits(it.height, it.width))) {
      throw new Error(`Image "${it.name}" (${it.width}x${it.height}) does not fit the ${maxSize}px atlas page`);
    }
  }
  const pages: AtlasPage[] = [];
  let remaining = items;
  while (remaining.length) {
    const area = remaining.reduce((s, i) => s + (i.width + pad * 2) * (i.height + pad * 2), 0);
    const widest = Math.max(...remaining.map((i) => i.width + pad * 2));
    const tallest = Math.max(...remaining.map((i) => i.height + pad * 2));
    // never start above the page limit: a page that holds everything but is bigger than maxSize is not allowed
    let side = Math.min(maxSize, Math.max(nextPow2(Math.ceil(Math.sqrt(area))), nextPow2(widest), nextPow2(tallest), 16));
    let result: { placed: PackedRegion[]; rest: PackInput[] } | null = null;
    let w = 0;
    let h = 0;
    while (true) {
      const sizes: [number, number][] =
        pot && !square
          ? [
              [side, side >> 1 >= Math.max(1, nextPow2(tallest)) ? side >> 1 : side],
              [side, side],
            ]
          : [[side, side]];
      let done = false;
      for (const s of sizes) {
        const r = tryPack(remaining, s, pad, rotate);
        if (r.rest.length === 0) {
          result = r;
          w = s[0];
          h = s[1];
          done = true;
          break;
        }
      }
      if (done) break;
      if (side >= maxSize) {
        const r = tryPack(remaining, [maxSize, maxSize], pad, rotate);
        result = r;
        w = maxSize;
        h = maxSize;
        break;
      }
      side <<= 1;
    }
    const r = result!;
    const usedW = Math.max(...r.placed.map((p) => p.x + footprint(p)[0] + pad));
    const usedH = Math.max(...r.placed.map((p) => p.y + footprint(p)[1] + pad));
    if (!pot) {
      // shrink to used bounds
      w = usedW;
      h = usedH;
      if (mult4) {
        w = Math.min(maxSize, Math.ceil(w / 4) * 4);
        h = Math.min(maxSize, Math.ceil(h / 4) * 4);
      }
    } else {
      w = Math.min(w, nextPow2(usedW));
      h = Math.min(h, nextPow2(usedH));
    }
    if (square) w = h = Math.max(w, h);
    pages.push({ index: pages.length, width: w, height: h, regions: r.placed });
    remaining = r.rest;
  }
  // a picture with the same pixels as another one has a region at the same place
  for (const alias of aliases) {
    for (const page of pages) {
      const target = page.regions.find((x) => x.name === alias.aliasOf);
      if (target) {
        page.regions.push({ ...target, name: alias.name });
        break;
      }
    }
  }
  return pages;
}

/** Straight alpha to premultiplied, in place (the pixels of a page for an atlas that says pma:true). */
export function premultiplyAlpha(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) continue;
    rgba[i] = Math.round((rgba[i] * a) / 255);
    rgba[i + 1] = Math.round((rgba[i + 1] * a) / 255);
    rgba[i + 2] = Math.round((rgba[i + 2] * a) / 255);
  }
}

export type AtlasFilter = 'Linear' | 'Nearest';

/** Spine 4.x atlas text for the given pages. `pageFile(i)` supplies each page's image file name. */
export function writeAtlas(
  pages: AtlasPage[],
  pageFile: (index: number) => string,
  opts: { pma?: boolean; filter?: AtlasFilter } = {},
): string {
  const lines: string[] = [];
  const filter = opts.filter ?? 'Linear';
  for (const p of pages) {
    lines.push(pageFile(p.index));
    lines.push(`size:${p.width},${p.height}`);
    lines.push(`filter:${filter},${filter}`);
    lines.push(`pma:${opts.pma ? 'true' : 'false'}`);
    for (const r of p.regions) {
      lines.push(r.name);
      lines.push(`bounds:${r.x},${r.y},${r.width},${r.height}`);
      if (r.offsetX || r.offsetY || r.originalWidth !== r.width || r.originalHeight !== r.height)
        lines.push(`offsets:${r.offsetX},${r.offsetY},${r.originalWidth},${r.originalHeight}`);
      if (r.rotated) lines.push('rotate:90');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---- trimming and the pixels of a page

/** The part of a picture that is not transparent: left, top, width and height. A picture with nothing in it keeps one pixel, so it still has a region. */
export function trimBounds(rgba: ArrayLike<number>, width: number, height: number): { x: number; y: number; w: number; h: number } {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The pixels a region is made of: straight RGBA, row by row, width × height of the region as it is in the picture. */
export interface RegionPixels {
  data: ArrayLike<number>;
}

/**
 * The pixels of one page: every region put where the atlas file says (a turned one as rotate:90 means: its top edge runs up the left
 * side), with the padding filled by the region's own edge pixels so smoothing never picks up transparent black. Returns RGBA, row by row.
 */
export function composePage(page: AtlasPage, pixels: (name: string) => RegionPixels | undefined, padding: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(page.width * page.height * 4);
  const pad = Math.min(Math.max(0, padding), 4);
  for (const r of page.regions) {
    const src = pixels(r.name);
    if (!src) continue;
    const [pw, ph] = footprint(r);
    // the region as laid on the page, before it is copied
    const patch = new Uint8ClampedArray(pw * ph * 4);
    for (let iy = 0; iy < r.height; iy++) {
      for (let ix = 0; ix < r.width; ix++) {
        const px = r.rotated ? iy : ix;
        const py = r.rotated ? r.width - 1 - ix : iy;
        const from = (iy * r.width + ix) * 4;
        const to = (py * pw + px) * 4;
        for (let k = 0; k < 4; k++) patch[to + k] = src.data[from + k];
      }
    }
    for (let y = -pad; y < ph + pad; y++) {
      for (let x = -pad; x < pw + pad; x++) {
        const dx = r.x + x;
        const dy = r.y + y;
        if (dx < 0 || dy < 0 || dx >= page.width || dy >= page.height) continue;
        const sx = Math.min(pw - 1, Math.max(0, x));
        const sy = Math.min(ph - 1, Math.max(0, y));
        const from = (sy * pw + sx) * 4;
        const to = (dy * page.width + dx) * 4;
        for (let k = 0; k < 4; k++) out[to + k] = patch[from + k];
      }
    }
  }
  return out;
}
