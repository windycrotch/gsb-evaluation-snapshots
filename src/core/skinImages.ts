/**
 * Skins from pictures: a picture named like an attachment with a prefix in front ("arctic/head", "arctic-head") is the picture of that
 * attachment in the skin "arctic". A skin with forty slots is then one step instead of forty edits of the "in skin" field.
 */
import { current, isDraft } from 'immer';
import { dropDeformTimeline, freshName, pruneSequences } from './edit';
import { baseOf } from './images';
import { makeLink } from './links';
import { newSkin } from './model';
import type { Id, ImageRef, RegionAttachment, SkeletonDoc } from './model';

/** The characters that may stand between the prefix and the name of the attachment. */
const SEPARATORS = '/-_. ';

/** One attachment of the default skin that a picture of the skin replaces. */
export interface SkinPick {
  slotId: Id;
  /** Name of the attachment of the default skin (the placeholder). */
  placeholder: string;
  /** The picture the skin shows there. */
  image: string;
  /** A mesh keeps its shape, so a picture of another size does not fit its texture coordinates. */
  sizeDiffers: boolean;
}

/** The prefix without the separators the user may have typed at its end. */
export function cleanPrefix(raw: string): string {
  let end = raw.trim().length;
  const s = raw.trim();
  while (end > 0 && SEPARATORS.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/** The name a skin made from this prefix gets: the last part of it ("hero/arctic" -> "arctic"). */
export function skinNameOf(prefix: string): string {
  return baseOf(cleanPrefix(prefix)) || 'skin';
}

/** The attachments of the default skin a skin can replace the picture of: regions and meshes with one picture that are not linked meshes. */
function placeholders(doc: SkeletonDoc): Map<string, { slotId: Id; path: string; width: number; height: number; mesh: boolean }[]> {
  const map = new Map<string, { slotId: Id; path: string; width: number; height: number; mesh: boolean }[]>();
  const def = doc.skins[0];
  if (!def) return map;
  for (const [slotId, atts] of Object.entries(def.attachments)) {
    for (const [name, att] of Object.entries(atts)) {
      if ((att.type !== 'region' && att.type !== 'mesh') || att.sequence) continue;
      if (att.type === 'mesh' && att.link) continue;
      const list = map.get(name) ?? [];
      list.push({ slotId, path: att.path, width: att.width, height: att.height, mesh: att.type === 'mesh' });
      map.set(name, list);
    }
  }
  return map;
}

/** Which pictures of the skin with this prefix replace which attachments of the default skin. The first picture wins when two fit one attachment. */
export function planSkinImages(doc: SkeletonDoc, images: ImageRef[], rawPrefix: string): SkinPick[] {
  const prefix = cleanPrefix(rawPrefix);
  if (!prefix) return [];
  const targets = placeholders(doc);
  const picks: SkinPick[] = [];
  const taken = new Set<string>();
  for (const img of images) {
    if (img.name.length <= prefix.length + 1 || !img.name.startsWith(prefix) || !SEPARATORS.includes(img.name[prefix.length])) continue;
    const rest = img.name.slice(prefix.length + 1);
    for (const t of targets.get(rest) ?? []) {
      const key = `${t.slotId}\n${rest}`;
      if (taken.has(key) || t.path === img.name) continue; // the default skin already shows this picture
      taken.add(key);
      picks.push({
        slotId: t.slotId,
        placeholder: rest,
        image: img.name,
        sizeDiffers: t.mesh && (t.width !== img.width || t.height !== img.height),
      });
    }
  }
  return picks;
}

/** Prefixes of the pictures that fit at least `min` attachments: the skins the pictures of the project make up, the biggest first. */
export function suggestSkinPrefixes(doc: SkeletonDoc, images: ImageRef[], min = 2): { prefix: string; count: number }[] {
  const seen = new Set<string>();
  for (const img of images) {
    for (let i = 1; i < img.name.length - 1; i++) {
      if (SEPARATORS.includes(img.name[i])) seen.add(img.name.slice(0, i));
    }
  }
  const out: { prefix: string; count: number }[] = [];
  for (const prefix of seen) {
    const count = planSkinImages(doc, images, prefix).length;
    if (count >= min) out.push({ prefix, count });
  }
  return out.sort((a, b) => b.count - a.count || a.prefix.length - b.prefix.length || a.prefix.localeCompare(b.prefix)).slice(0, 8);
}

/**
 * Puts a picture in a skin in place of the attachment `placeholder` of the default skin. A mesh gets a linked mesh that keeps its shape,
 * weights and deform; a region gets a copy with the picture's size. Works on a draft. Returns false when there is nothing to replace.
 */
/** The deform and sequence keys a skin made for an attachment it is about to replace do not fit the new one. */
function dropReplacedTimelines(doc: SkeletonDoc, skinId: Id, slotId: Id, name: string) {
  if (!doc.skins.find((s) => s.id === skinId)?.attachments[slotId]?.[name]) return;
  for (const a of doc.animations) {
    dropDeformTimeline(a, skinId, slotId, name);
    if (a.sequence?.[skinId]?.[slotId]) {
      delete a.sequence[skinId][slotId][name];
      pruneSequences(a);
    }
  }
}

export function putSkinImage(
  doc: SkeletonDoc,
  skinId: Id,
  slotId: Id,
  placeholder: string,
  img: { name: string; width: number; height: number },
): boolean {
  const defSkin = doc.skins[0];
  const def = defSkin?.attachments[slotId]?.[placeholder];
  const skin = doc.skins.find((s) => s.id === skinId);
  if (!defSkin || !skin || !def) return false;
  if (def.type === 'mesh') {
    // a mesh keeps its shape, weights and deform: the skin gets a linked mesh that has the picture of its own
    if (def.link) return false;
    const shape = structuredClone(isDraft(def) ? current(def) : def);
    delete shape.sequence; // one picture
    delete shape.region;
    dropReplacedTimelines(doc, skin.id, slotId, placeholder);
    (skin.attachments[slotId] ??= {})[placeholder] = {
      ...shape,
      name: placeholder,
      path: img.name,
      color: [1, 1, 1, 1],
      link: makeLink(doc, slotId, { skinId: defSkin.id, slotId, name: placeholder }),
    };
    return true;
  }
  const base: Pick<RegionAttachment, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'> =
    def.type === 'region' ? def : { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  dropReplacedTimelines(doc, skin.id, slotId, placeholder);
  (skin.attachments[slotId] ??= {})[placeholder] = {
    type: 'region',
    name: placeholder,
    path: img.name,
    x: base.x,
    y: base.y,
    rotation: base.rotation,
    scaleX: base.scaleX,
    scaleY: base.scaleY,
    width: img.width,
    height: img.height,
    color: [1, 1, 1, 1],
  };
  return true;
}

/**
 * Makes the skin of a prefix: a skin of that name (the one that already has the name when there is one, so more pictures can be added
 * later) with the pictures of the plan. Works on a draft. Returns the skin and how many attachments it now replaces.
 */
export function applySkinPicks(doc: SkeletonDoc, prefix: string, picks: SkinPick[], images: ImageRef[]): { skinId: Id; placed: number } {
  const name = skinNameOf(prefix);
  let skin = doc.skins.slice(1).find((s) => s.name === name);
  if (!skin) {
    skin = newSkin(freshName(name, doc.skins));
    doc.skins.push(skin);
  }
  let placed = 0;
  for (const p of picks) {
    const img = images.find((i) => i.name === p.image);
    if (img && putSkinImage(doc, skin.id, p.slotId, p.placeholder, img)) placed++;
  }
  return { skinId: skin.id, placed };
}
