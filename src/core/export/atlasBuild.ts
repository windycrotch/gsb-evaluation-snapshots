/**
 * What the editor export and the command line share when they build an atlas: which pictures the skeleton uses, and one picture turned into a
 * region (trimmed or not) for the packer. Pure: the pixels come in as straight RGBA, however they were read.
 */
import { attachmentPictures } from '../sequence';
import type { SkeletonDoc } from '../model';
import { trimBounds } from './atlas';
import type { PackInput } from './atlas';

/** The images the skeleton uses; `mesh` marks those a mesh uses too (a mesh can sample outside the opaque part, so such a picture is never trimmed). */
export function usedImages(doc: Pick<SkeletonDoc, 'skins'>): { name: string; mesh: boolean }[] {
  const used = new Map<string, boolean>();
  for (const skin of doc.skins) {
    for (const slot of Object.values(skin.attachments)) {
      for (const att of Object.values(slot)) {
        for (const image of attachmentPictures(att)) used.set(image, (used.get(image) ?? false) || att.type === 'mesh');
      }
    }
  }
  return [...used].map(([name, mesh]) => ({ name, mesh }));
}

/**
 * Pictures that are the same: for each picture whose pixels (and size) equal those of an earlier one, the name of that earlier one. Used with
 * the packer's `aliasOf`, so identical pictures (a left hand that is the right one copied) take one place in the atlas.
 */
export function findAliases(
  list: { name: string; width: number; height: number; data: ArrayLike<number>; extra?: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, typeof list>();
  for (const item of list) {
    let h = 2166136261;
    for (let i = 0; i < item.data.length; i++) h = Math.imul(h ^ item.data[i], 16777619);
    const key = `${item.width}x${item.height}:${item.extra ?? ''}:${h >>> 0}`;
    const same = (seen.get(key) ?? []).find((o) => {
      for (let i = 0; i < item.data.length; i++) if (o.data[i] !== item.data[i]) return false;
      return true;
    });
    if (same) out.set(item.name, same.name);
    else seen.set(key, [...(seen.get(key) ?? []), item]);
  }
  return out;
}

/** The size a picture has at an export scale (never below one pixel). */
export const scaledSize = (width: number, height: number, scale: number): [number, number] => [
  Math.max(1, Math.round(width * scale)),
  Math.max(1, Math.round(height * scale)),
];

/**
 * One picture, already at its export size, as a region: the pixels of the part that is packed (the picture without its empty border when `trim`
 * is on and no mesh uses it) and what the packer is told about it.
 */
export function makeRegion(
  name: string,
  mesh: boolean,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  trim: boolean,
): { pixels: Uint8ClampedArray; input: PackInput } {
  const b = trim && !mesh ? trimBounds(rgba, width, height) : { x: 0, y: 0, w: width, h: height };
  let pixels = rgba;
  if (b.w !== width || b.h !== height) {
    pixels = new Uint8ClampedArray(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++)
      pixels.set(rgba.subarray(((b.y + y) * width + b.x) * 4, ((b.y + y) * width + b.x + b.w) * 4), y * b.w * 4);
  }
  return {
    pixels,
    input: { name, width: b.w, height: b.h, offsetX: b.x, offsetY: height - (b.y + b.h), originalWidth: width, originalHeight: height },
  };
}

/** One atlas of an export with an atlas per skin: the file name without its extension, and the pictures packed into it. */
export interface SkinAtlas {
  skinId: string;
  stem: string;
  names: string[];
}

/**
 * The atlases of an export with an atlas per skin (Spine 4.3: "texture packing can create a separate atlas for each skin"). The default skin
 * keeps the plain name; each other skin gets `<base>-<skin>` with only the pictures the default skin does not use, so a game loads the
 * atlas of the default skin and the atlas of the skin it shows. A picture two other skins share is in both of their atlases.
 * The file names are ours: nothing in the Spine documentation fixes them.
 */
export function skinAtlasGroups(doc: Pick<SkeletonDoc, 'skins'>, base: string): SkinAtlas[] {
  const first = doc.skins.slice(0, 1);
  const defaultNames = new Set(usedImages({ skins: first }).map((i) => i.name));
  const out: SkinAtlas[] = [];
  if (defaultNames.size) out.push({ skinId: first[0].id, stem: base, names: [...defaultNames] });
  const stems = new Set([base]);
  for (const skin of doc.skins.slice(1)) {
    const names = usedImages({ skins: [skin] })
      .map((i) => i.name)
      .filter((n) => !defaultNames.has(n));
    if (!names.length) continue;
    let stem = `${base}-${skin.name.replace(/[^\w-]+/g, '_') || 'skin'}`;
    while (stems.has(stem)) stem += '_';
    stems.add(stem);
    out.push({ skinId: skin.id, stem, names });
  }
  return out;
}
