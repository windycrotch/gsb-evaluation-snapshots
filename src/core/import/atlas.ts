/** Parser for Spine texture atlas text (the 4.x `bounds:` format and the older `xy:` / `size:` one). Pure logic. */

export interface ParsedRegion {
  name: string;
  /** Rectangle in the page image, in the orientation of the *unrotated* region (see `rotate`). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0, or 90 / 270 when the packer stored the region rotated (then the page rectangle is `height` wide and `width` tall). */
  rotate: 0 | 90 | 270;
  /** Trimmed whitespace: offset of the region inside the original image (measured from its bottom-left) and the original size. */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
}

export interface ParsedPage {
  file: string;
  width: number;
  height: number;
  pma: boolean;
  regions: ParsedRegion[];
}

const nums = (v: string): number[] => v.split(',').map((x) => parseFloat(x.trim()));

export function parseAtlas(text: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let page: ParsedPage | null = null;
  let region: ParsedRegion | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // a blank line ends the page: the next plain line names a new page
      page = null;
      region = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      if (!page) {
        page = { file: line, width: 0, height: 0, pma: false, regions: [] };
        pages.push(page);
        region = null;
      } else {
        region = { name: line, x: 0, y: 0, width: 0, height: 0, rotate: 0, offsetX: 0, offsetY: 0, originalWidth: 0, originalHeight: 0 };
        page.regions.push(region);
      }
      continue;
    }
    if (!page) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!region) {
      if (key === 'size') [page.width, page.height] = nums(value);
      else if (key === 'pma') page.pma = value === 'true';
      continue;
    }
    switch (key) {
      case 'bounds': {
        const [x, y, w, h] = nums(value);
        Object.assign(region, { x, y, width: w, height: h });
        break;
      }
      case 'xy': {
        const [x, y] = nums(value);
        Object.assign(region, { x, y });
        break;
      }
      case 'size': {
        const [w, h] = nums(value);
        Object.assign(region, { width: w, height: h });
        break;
      }
      case 'offsets': {
        const [ox, oy, ow, oh] = nums(value);
        Object.assign(region, { offsetX: ox, offsetY: oy, originalWidth: ow, originalHeight: oh });
        break;
      }
      case 'orig': {
        const [ow, oh] = nums(value);
        Object.assign(region, { originalWidth: ow, originalHeight: oh });
        break;
      }
      case 'offset': {
        const [ox, oy] = nums(value);
        Object.assign(region, { offsetX: ox, offsetY: oy });
        break;
      }
      case 'rotate':
        region.rotate = value === 'true' || value === '90' ? 90 : value === '270' ? 270 : 0;
        break;
    }
  }
  for (const p of pages) {
    for (const r of p.regions) {
      if (!r.originalWidth) r.originalWidth = r.width;
      if (!r.originalHeight) r.originalHeight = r.height;
    }
  }
  return pages.filter((p) => p.regions.length > 0 || p.width > 0);
}
