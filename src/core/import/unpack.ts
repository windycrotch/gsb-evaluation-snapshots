/**
 * Texture unpacker: the pictures an atlas holds, cut back out of its pages. Pure logic over straight RGBA pixels, so the editor (pixels from a canvas)
 * and the command line (pixels from a PNG) share it. A region that was trimmed gets its empty border back (the picture has its original size),
 * a turned region is turned back, and a page that is premultiplied can be put back to straight alpha.
 */
import { parseAtlas } from './atlas';
import type { ParsedRegion } from './atlas';

export interface Picture {
  width: number;
  height: number;
  /** Straight RGBA, row by row. */
  data: Uint8ClampedArray;
}

/** One region cut out of a page, as a picture of its original size. */
export function cutRegion(page: Picture, r: ParsedRegion): Picture {
  const width = Math.max(1, r.originalWidth);
  const height = Math.max(1, r.originalHeight);
  const data = new Uint8ClampedArray(width * height * 4);
  // the offsets are measured from the bottom of the original picture
  const destX = r.offsetX;
  const destY = height - r.offsetY - r.height;
  for (let iy = 0; iy < r.height; iy++) {
    for (let ix = 0; ix < r.width; ix++) {
      // the page pixel of this region pixel: a turned region (rotate 90) runs its top edge up the left side of its rectangle
      const px = r.rotate === 90 ? r.x + iy : r.rotate === 270 ? r.x + (r.height - 1 - iy) : r.x + ix;
      const py = r.rotate === 90 ? r.y + (r.width - 1 - ix) : r.rotate === 270 ? r.y + ix : r.y + iy;
      const tx = destX + ix;
      const ty = destY + iy;
      if (px < 0 || py < 0 || px >= page.width || py >= page.height || tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      const from = (py * page.width + px) * 4;
      const to = (ty * width + tx) * 4;
      data[to] = page.data[from];
      data[to + 1] = page.data[from + 1];
      data[to + 2] = page.data[from + 2];
      data[to + 3] = page.data[from + 3];
    }
  }
  return { width, height, data };
}

/** Premultiplied to straight alpha, in place (what an atlas with pma:true needs before its pictures are used on their own). */
export function unpremultiplyAlpha(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0 || a === 255) continue;
    rgba[i] = Math.min(255, Math.round((rgba[i] * 255) / a));
    rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / a));
    rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / a));
  }
}

export interface Unpacked {
  name: string;
  picture: Picture;
}

/**
 * Every picture of an atlas. `readPage` gives the pixels of a page by its file name (null when the file is missing: its regions are listed in
 * `warnings` and skipped). Two regions with the same name keep the first.
 */
export function unpackAtlas(
  atlasText: string,
  readPage: (file: string) => Picture | null,
  opts: { unpremultiply?: boolean } = {},
): { pictures: Unpacked[]; warnings: string[] } {
  const pictures: Unpacked[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const page of parseAtlas(atlasText)) {
    const pixels = readPage(page.file);
    if (!pixels) {
      warnings.push(`the page "${page.file}" was not found, its ${page.regions.length} regions are left out`);
      continue;
    }
    const straight = page.pma && opts.unpremultiply !== false ? { ...pixels, data: new Uint8ClampedArray(pixels.data) } : pixels;
    if (straight !== pixels) unpremultiplyAlpha(straight.data);
    for (const r of page.regions) {
      if (seen.has(r.name)) {
        warnings.push(`the name "${r.name}" is used twice, the first one is kept`);
        continue;
      }
      seen.add(r.name);
      pictures.push({ name: r.name, picture: cutRegion(straight, r) });
    }
  }
  return { pictures, warnings };
}
