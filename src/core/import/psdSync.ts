/**
 * "Update from PSD": the artist repaints the layers, the rig stays. A layer of the file is matched to a picture of the project by name
 * (`group/layer`, exactly as the first import named it); the matched pictures get the new pixels, a layer the project has not got yet is
 * added, and a picture whose layer is gone is left alone (nothing is removed behind the user's back).
 */
import type { ImageRef } from '../model';
import type { PsdLayer } from './psd';

export interface PsdSyncPlan {
  /** Layers that have a picture by the same name. */
  updates: { layer: PsdLayer; image: ImageRef }[];
  /** Layers with no picture yet, back to front. */
  added: PsdLayer[];
  /** Pictures that came from a PSD (they have a recorded position) and whose layer is not in the file any more. */
  gone: string[];
}

export function planPsdSync(layers: PsdLayer[], images: ImageRef[]): PsdSyncPlan {
  const byName = new Map(images.map((i) => [i.name, i] as const));
  const updates: PsdSyncPlan['updates'] = [];
  const added: PsdLayer[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    seen.add(layer.name);
    const image = byName.get(layer.name);
    if (image) updates.push({ layer, image });
    else added.push(layer);
  }
  const gone = images.filter((i) => i.psd && !seen.has(i.name)).map((i) => i.name);
  return { updates, added, gone };
}

/**
 * The region attachment after its picture got new pixels. The picture keeps the scale the user gave it (the drawn size follows the pixel
 * size), and the attachment moves by the way the layer moved, `shift` being that movement in the bone's own space.
 */
export function fitRegion(
  att: { x: number; y: number; width: number; height: number },
  from: { width: number; height: number },
  to: { width: number; height: number },
  shift: [number, number],
): { x: number; y: number; width: number; height: number } {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  return { x: att.x + shift[0], y: att.y + shift[1], width: att.width * sx, height: att.height * sy };
}
