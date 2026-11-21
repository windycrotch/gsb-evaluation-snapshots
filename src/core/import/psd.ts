/**
 * Photoshop files (.psd): every layer becomes a picture and a slot with a region attachment, in the order of the layers (the bottom
 * layer is drawn first), so a character painted in layers arrives as a skeleton-ready stack. The reading is `ag-psd`; what comes out of
 * here has no DOM in it, so it can be tested and planned without a canvas.
 *
 * - groups are folders: a layer "arm" in the group "left" becomes the picture "left/arm" (the Images window shows folders);
 * - hidden layers (and everything in a hidden group) are left out, empty layers too;
 * - opacity becomes the alpha of the slot colour, and the blend modes Spine has (multiply, screen, additive) are kept;
 * - the scene origin is the middle of the bottom edge of the document, y up: a character standing on the bottom of the canvas stands on y = 0.
 *   Masks, clipping layers, layer effects and adjustment layers are not applied.
 */
import type { BlendMode } from '../model';

export interface PsdPixels {
  width: number;
  height: number;
  /** RGBA, straight (not premultiplied) alpha. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface PsdLayer {
  /** The name of the picture: the groups it sits in and its own name, joined with "/". */
  name: string;
  /** Pixels of the document the layer's left edge is at. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0..1, group opacities multiplied in. */
  opacity: number;
  blend: BlendMode;
  pixels: PsdPixels;
}

export interface PsdFile {
  width: number;
  height: number;
  /** Back to front. */
  layers: PsdLayer[];
  /** How many layers were left out, by reason. */
  skipped: { hidden: number; empty: number };
}

/** A layer of the file in the shape `ag-psd` gives it (only what is read). */
interface RawLayer {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  imageData?: PsdPixels;
  children?: RawLayer[];
}

/** The Spine blend mode closest to a Photoshop one (what Spine has not got is drawn normally). */
export function blendOf(mode: string | undefined): BlendMode {
  switch (mode) {
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'linear dodge':
      return 'additive';
    default:
      return 'normal';
  }
}

/** A layer name that is safe as the name of a picture: no "/" inside (it would make a folder), no edge spaces, never empty. */
export function pictureName(name: string | undefined, fallback: string): string {
  const clean = (name ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return clean || fallback;
}

/** Flattens the layer tree of a document into the pictures to import. */
export function flattenPsd(width: number, height: number, roots: RawLayer[]): PsdFile {
  const layers: PsdLayer[] = [];
  const skipped = { hidden: 0, empty: 0 };
  let unnamed = 0;
  const walk = (list: RawLayer[], path: string[], hidden: boolean, opacity: number) => {
    for (const raw of list) {
      const name = pictureName(raw.name, `layer ${++unnamed}`);
      const isHidden = hidden || !!raw.hidden;
      const alpha = opacity * (typeof raw.opacity === 'number' ? Math.min(1, Math.max(0, raw.opacity)) : 1);
      if (raw.children) {
        walk(raw.children, [...path, name], isHidden, alpha);
        continue;
      }
      const px = raw.imageData;
      if (isHidden) {
        skipped.hidden++;
        continue;
      }
      if (!px || px.width < 1 || px.height < 1) {
        skipped.empty++;
        continue;
      }
      layers.push({
        name: [...path, name].join('/'),
        left: raw.left ?? 0,
        top: raw.top ?? 0,
        width: px.width,
        height: px.height,
        opacity: alpha,
        blend: blendOf(raw.blendMode),
        pixels: px,
      });
    }
  };
  walk(roots, [], false, 1);
  return { width, height, layers, skipped };
}

/** Reads a .psd file. `ag-psd` is loaded when it is needed, the editor does not carry it otherwise. */
export async function readPsdFile(buffer: ArrayBuffer): Promise<PsdFile> {
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  return flattenPsd(psd.width, psd.height, (psd.children ?? []) as RawLayer[]);
}

/** Where the middle of a layer is in the scene: x from the middle of the document, y up from its bottom edge. */
export function layerCenter(
  file: { width: number; height: number },
  layer: { left: number; top: number; width: number; height: number },
): [number, number] {
  return [layer.left + layer.width / 2 - file.width / 2, file.height - (layer.top + layer.height / 2)];
}

/**
 * The shift that nearly all layers of a re-imported file share. When the canvas of the document grows (or shrinks) with an anchor, every layer
 * "moves" by the same amount although nothing in the artwork moved; that amount is what most layers agree on. Returns [0, 0] unless at least
 * three layers moved and more than half of them by the same vector (within half a pixel).
 */
export function commonShift(moves: readonly ([number, number] | null)[]): [number, number] {
  const list = moves.filter((m): m is [number, number] => !!m && (Math.abs(m[0]) > 0.5 || Math.abs(m[1]) > 0.5));
  if (list.length < 3) return [0, 0];
  let best: { m: [number, number]; n: number } | null = null;
  for (const a of list) {
    const group = list.filter((b) => Math.abs(b[0] - a[0]) <= 0.5 && Math.abs(b[1] - a[1]) <= 0.5);
    if (!best || group.length > best.n)
      best = {
        m: [group.reduce((t, g) => t + g[0], 0) / group.length, group.reduce((t, g) => t + g[1], 0) / group.length],
        n: group.length,
      };
  }
  return best && best.n * 2 > moves.filter(Boolean).length ? best.m : [0, 0];
}

export function isPsd(file: { name: string; type?: string }): boolean {
  return /\.psd$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}
