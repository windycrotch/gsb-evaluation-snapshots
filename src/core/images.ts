/**
 * The images of a project: which attachments use them, renaming (the name is the atlas region name, so every attachment that shows
 * the image follows), and folders — Spine groups images by the part of the name before the last "/" ("hero/arm").
 */
import type { Project, SkeletonDoc } from './model';
import { attachmentPictures } from './sequence';
import { skeletonList } from './skeletons';

/** The folder part of an image name ("hero/arm" -> "hero"), or "" for an image in the root. */
export function folderOf(name: string): string {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

/** The name without its folder. */
export function baseOf(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** How many attachments (in every skin) show each image. Images nobody shows are not in the map. */
export function imageUsage(doc: SkeletonDoc): Map<string, number> {
  const uses = new Map<string, number>();
  for (const skin of doc.skins) {
    for (const slot of Object.values(skin.attachments)) {
      for (const att of Object.values(slot)) {
        for (const image of attachmentPictures(att)) uses.set(image, (uses.get(image) ?? 0) + 1);
      }
    }
  }
  return uses;
}

/** Names of the images that no attachment shows. */
export function unusedImages(project: Project): string[] {
  const used = new Set<string>();
  for (const doc of skeletonList(project)) for (const name of imageUsage(doc).keys()) used.add(name); // an image another skeleton of the project shows is in use
  return project.images.filter((i) => !used.has(i.name)).map((i) => i.name);
}

/** Cleans a name typed by the user: trimmed, no empty folder parts, no leading or trailing "/". Empty when nothing is left. */
export function cleanImageName(raw: string): string {
  return raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');
}

/** The name of an attachment whose sequence has this picture as a frame (its name is the path and a number, so it cannot be changed on its own), or null. */
export function sequenceFrameOwner(doc: SkeletonDoc, image: string): string | null {
  for (const skin of doc.skins) {
    for (const slot of Object.values(skin.attachments)) {
      for (const att of Object.values(slot)) {
        if (att.type !== 'region' && att.type !== 'mesh') continue;
        if (att.sequence && attachmentPictures(att).includes(image)) return att.name;
      }
    }
  }
  return null;
}

export type RenameResult = { ok: true; name: string } | { ok: false; reason: 'empty' | 'taken' | 'missing' | 'frame' };

/**
 * Renames an image and points every attachment that shows it at the new name. Works on a draft. Refuses an empty name and a name that
 * another image already has (two images with one name would become one atlas region).
 */
export function renameImage(project: Project, from: string, rawTo: string): RenameResult {
  const to = cleanImageName(rawTo);
  if (!to) return { ok: false, reason: 'empty' };
  const image = project.images.find((i) => i.name === from);
  if (!image) return { ok: false, reason: 'missing' };
  if (to === from) return { ok: true, name: to };
  if (project.images.some((i) => i.name === to)) return { ok: false, reason: 'taken' };
  const docs = skeletonList(project);
  if (docs.some((d) => sequenceFrameOwner(d, from))) return { ok: false, reason: 'frame' };
  image.name = to;
  for (const doc of docs) {
    for (const skin of doc.skins) {
      for (const slot of Object.values(skin.attachments)) {
        for (const att of Object.values(slot)) {
          // (the path of a sequence is the start of the names of its frames, not a picture)
          if ((att.type === 'region' || att.type === 'mesh') && att.path === from && !att.sequence) att.path = to;
        }
      }
    }
  }
  return { ok: true, name: to };
}

/** Groups image names by folder, folders sorted, the root first; the names inside keep their order. */
export function imageGroups(names: string[]): [string, string[]][] {
  const map = new Map<string, string[]>();
  for (const n of names) {
    const f = folderOf(n);
    map.set(f, [...(map.get(f) ?? []), n]);
  }
  return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
}
