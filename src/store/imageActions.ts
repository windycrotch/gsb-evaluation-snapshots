/** Pictures of the project: rename, replace pixels, remove the unused ones. */
import { cleanImageName, renameImage, sequenceFrameOwner, unusedImages } from '@/core/images';
import { skeletonList } from '@/core/skeletons';
import { assets } from './assets';
import type { ImageAsset } from './assets';
import { docStore } from './doc';
import { toast } from './ui';
import { project } from './accessors';

/** Renames an image; every attachment that shows it follows. Returns the new name, or null when it was refused. */
export function renameImageAction(from: string, raw: string): string | null {
  const to = cleanImageName(raw);
  if (!to) {
    toast('An image needs a name', 'error');
    return null;
  }
  if (to === from) return from;
  if (skeletonList(project()).some((d) => sequenceFrameOwner(d, from))) {
    toast('This picture is a frame of a sequence: its name is the sequence path and a number, so it is renamed there', 'error');
    return null;
  }
  if (project().images.some((i) => i.name === to)) {
    toast(`There is already an image called "${to}"`, 'error');
    return null;
  }
  assets.alias(from, to);
  let ok = false;
  docStore.update('Rename image', (d) => {
    ok = renameImage(d, from, to).ok;
  });
  return ok ? to : null;
}

/** Makes Undo and Redo of the last step swap the pixels behind the pictures too (the document only holds their size). */
export function keepPixelsForUndo(changes: { name: string; before: ImageAsset | undefined; after: ImageAsset }[]) {
  docStore.attachEffect({
    undo: () => changes.forEach((c) => assets.swap(c.name, c.before)),
    redo: () => changes.forEach((c) => assets.swap(c.name, c.after)),
  });
}

/** Puts new pixels behind an image name. The attachments keep their size on screen; the atlas gets the new picture. */
export async function replaceImagePixels(name: string, file: File | Blob): Promise<void> {
  try {
    const asset = await assets.decode(name, file);
    const before = assets.get(name);
    assets.set(name, asset);
    docStore.update('Replace image', (d) => {
      const img = d.images.find((i) => i.name === name);
      if (img) {
        img.width = asset.width;
        img.height = asset.height;
        img.rev = (img.rev ?? 0) + 1; // a same-size repaint still counts as a step of its own
      }
    });
    keepPixelsForUndo([{ name, before, after: assets.get(name)! }]);
    toast(`Replaced "${name}" (${asset.width}×${asset.height})`, 'ok');
  } catch (e) {
    toast(`Could not read that image: ${(e as Error).message}`, 'error');
  }
}

/** Removes every image that no attachment shows. */
export function removeUnusedImages(): number {
  const names = unusedImages(project());
  if (!names.length) {
    toast('Every image is in use', 'info');
    return 0;
  }
  docStore.update('Remove unused images', (d) => {
    d.images = d.images.filter((i) => !names.includes(i.name));
  });
  // the pixels stay in memory so that undo brings the images back; a saved project only carries the images it lists
  toast(`Removed ${names.length} unused image${names.length === 1 ? '' : 's'}`, 'ok');
  return names.length;
}
