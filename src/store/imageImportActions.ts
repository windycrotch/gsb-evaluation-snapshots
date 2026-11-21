/** Bringing pictures in: files, dropped folders, Photoshop files. */
import { freshName } from '@/core/edit';
import { atan2Deg } from '@/core/math';
import { newBone, newSlot } from '@/core/model';
import type { Id, ImageRef } from '@/core/model';
import { commonShift, isPsd, layerCenter, readPsdFile } from '@/core/import/psd';
import type { PsdLayer, PsdPixels } from '@/core/import/psd';
import { fitRegion, planPsdSync } from '@/core/import/psdSync';
import { cleanImageName } from '@/core/images';
import { getSetupSkeleton } from '@/store/scene';
import { assets } from './assets';
import type { ImageAsset } from './assets';
import { entriesOf, pathedFromInput, readEntries } from './dropped';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import { setSelection } from './sessionActions';
import { project, skeletonDoc } from './accessors';
import { keepPixelsForUndo } from './imageActions';

export async function importImageFiles(files: File[], paths?: string[]): Promise<string[]> {
  const refs: ImageRef[] = [];
  for (const [i, f] of files.entries()) {
    if (isPsd(f)) {
      await importPsd(f);
      continue;
    }
    if (!/^image\/(png|jpeg|webp|gif)/.test(f.type) && !/\.(png|jpe?g|webp|gif)$/i.test(f.name)) continue;
    try {
      const path = paths?.[i] ? cleanImageName(paths[i]) : '';
      refs.push(await assets.addFile(f, path || undefined));
    } catch (e) {
      toast(`Could not read ${f.name}`, 'error');
      console.error(e);
    }
  }
  if (refs.length) {
    // a whole folder is one step of the history
    docStore.update(refs.length > 1 ? 'Import images' : 'Import image', (d) => {
      d.images.push(...refs);
    });
    toast(`Imported ${refs.length} image${refs.length > 1 ? 's' : ''}`, 'ok');
  }
  return refs.map((r) => r.name);
}

/** Imports what was dropped: files, or folders of files (their folders become folders of pictures). Call it inside the drop event. */
export async function importDropped(dt: DataTransfer): Promise<{ names: string[]; folder: boolean }> {
  const entries = entriesOf(dt);
  const loose = [...dt.files];
  if (!entries.some((e) => e.isDirectory)) return { names: await importImageFiles(loose), folder: false };
  const { files } = await readEntries(entries);
  return {
    names: await importImageFiles(
      files.map((f) => f.file),
      files.map((f) => f.path),
    ),
    folder: true,
  };
}

/** Imports the files of a "choose a folder" input. */
export async function importFolderFiles(list: File[]): Promise<string[]> {
  const files = pathedFromInput(list);
  return importImageFiles(
    files.map((f) => f.file),
    files.map((f) => f.path),
  );
}

/** Where an attachment goes on a bone so that it sits at a scene position (and stays upright in the scene). */
function placeOnBone(
  live: { worldToLocal(x: number, y: number): [number, number]; a: number; b: number; c: number; d: number } | undefined,
  wx: number,
  wy: number,
): { x: number; y: number; rotation: number } {
  if (!live) return { x: wx, y: wy, rotation: 0 };
  const [x, y] = live.worldToLocal(wx, wy);
  const det = live.a * live.d - live.b * live.c;
  const rot = det < 0 ? atan2Deg(live.c, live.a) : -atan2Deg(live.c, live.a);
  return { x, y, rotation: det < 0 ? -rot : rot };
}

function pixelsToPng(px: PsdPixels): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = px.width;
  canvas.height = px.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the layer'))), 'image/png'),
  );
}

/**
 * Imports a Photoshop file: every visible layer becomes a picture (groups are folders) and a slot with a region attachment, bottom layer
 * first, so the stack of the file is the draw order. The slots go on the selected bone (the first one, or a new root when there is none).
 * One step in the history. Returns the number of layers imported.
 */
export async function importPsd(file: File): Promise<number> {
  let psd;
  try {
    psd = await readPsdFile(await file.arrayBuffer());
  } catch (e) {
    toast(`Could not read ${file.name}`, 'error');
    console.error(e);
    return 0;
  }
  if (!psd.layers.length) {
    toast(`${file.name} has no visible pixel layers`, 'info');
    return 0;
  }
  const refs: { ref: ImageRef; layer: (typeof psd.layers)[number] }[] = [];
  for (const layer of psd.layers) {
    try {
      refs.push({ ref: await assets.addFile(await pixelsToPng(layer.pixels), layer.name), layer });
    } catch (e) {
      toast(`Could not read the layer "${layer.name}"`, 'error');
      console.error(e);
    }
  }
  const doc = skeletonDoc();
  const selected = uiStore.get().selection.bones[0] ?? doc.bones[0]?.id;
  const setup = getSetupSkeleton();
  const live = selected ? setup.boneById(selected) : undefined;
  const root = live ? null : newBone({ name: freshName('root', doc.bones) });
  const boneId = live ? live.data.id : root!.id;
  const slotIds: Id[] = [];
  docStore.update('Import PSD', (d) => {
    if (root) d.skeleton.bones.push(root);
    const skin = d.skeleton.skins[0];
    for (const { ref, layer } of refs) {
      const center = layerCenter(psd, layer);
      const { x: lx, y: ly, rotation } = placeOnBone(live, center[0], center[1]);
      const slot = newSlot({
        name: freshName(ref.name.split('/').pop() ?? ref.name, d.skeleton.slots),
        bone: boneId,
        attachment: ref.name,
        color: [1, 1, 1, layer.opacity],
        blend: layer.blend,
      });
      d.images.push({ ...ref, psd: center });
      d.skeleton.slots.push(slot);
      skin.attachments[slot.id] = {
        [ref.name]: {
          type: 'region',
          name: ref.name,
          path: ref.name,
          x: lx,
          y: ly,
          rotation,
          scaleX: 1,
          scaleY: 1,
          width: ref.width,
          height: ref.height,
          color: [1, 1, 1, 1],
        },
      };
      slotIds.push(slot.id);
    }
  });
  if (slotIds.length) setSelection({ slot: slotIds[slotIds.length - 1], bones: [boneId] });
  toast(
    psd.skipped.hidden
      ? `Imported layers: ${slotIds.length} from ${file.name} (${psd.skipped.hidden} hidden skipped)`
      : `Imported layers: ${slotIds.length} from ${file.name}`,
    'ok',
  );
  return slotIds.length;
}

/**
 * "Update from PSD": the layers of a (repainted) Photoshop file are matched to the pictures of the project by name. The matched pictures get
 * the new pixels (a region attachment follows the new size and the way the layer moved; meshes keep their shape, so a repaint of the same
 * size drops in), the layers the project has not got become new slots in their place of the stack, and nothing is removed. One step.
 */
export async function reimportPsd(file: File): Promise<{ updated: number; added: number }> {
  const none = { updated: 0, added: 0 };
  let psd;
  try {
    psd = await readPsdFile(await file.arrayBuffer());
  } catch (e) {
    toast(`Could not read ${file.name}`, 'error');
    console.error(e);
    return none;
  }
  const plan = planPsdSync(psd.layers, project().images);
  if (!plan.updates.length && !plan.added.length) {
    toast(`${file.name} has no visible pixel layers`, 'info');
    return none;
  }
  const fresh = new Map<string, { asset: ImageAsset; layer: PsdLayer }>();
  const refs = new Map<string, ImageRef>();
  try {
    for (const { layer, image } of plan.updates)
      fresh.set(image.name, { asset: await assets.decode(image.name, await pixelsToPng(layer.pixels)), layer });
    for (const layer of plan.added) refs.set(layer.name, await assets.addFile(await pixelsToPng(layer.pixels), layer.name));
  } catch (e) {
    toast(`Could not read the layers of ${file.name}`, 'error');
    console.error(e);
    return none;
  }
  const doc = skeletonDoc();
  const selected = uiStore.get().selection.bones[0] ?? doc.bones[0]?.id;
  const setup = getSetupSkeleton();
  const live = selected ? setup.boneById(selected) : undefined;
  const root = live ? null : newBone({ name: freshName('root', doc.bones) });
  const boneId = live ? live.data.id : root!.id;
  let meshes = 0;
  const pixelChanges: { name: string; before: ImageAsset | undefined; after: ImageAsset }[] = [];
  for (const { asset } of fresh.values()) {
    const before = assets.get(asset.name);
    assets.set(asset.name, asset);
    pixelChanges.push({ name: asset.name, before, after: assets.get(asset.name)! });
  }
  // a canvas that was made bigger (or smaller) moves every layer by the same amount: that part is not an edit of the artwork
  const common = commonShift(
    plan.updates.map(({ layer, image }) => {
      if (!image.psd) return null;
      const c = layerCenter(psd, layer);
      return [c[0] - image.psd[0], c[1] - image.psd[1]] as [number, number];
    }),
  );
  docStore.update('Update from PSD', (d) => {
    if (root && plan.added.length) d.skeleton.bones.push(root);
    const skin0 = d.skeleton.skins[0];
    // 1. the pictures that exist: pixels, size, and the attachments that show them
    for (const { image } of plan.updates) {
      const entry = fresh.get(image.name)!;
      const img = d.images.find((i) => i.id === image.id);
      if (!img) continue;
      const from = { width: img.width, height: img.height };
      const to = { width: entry.asset.width, height: entry.asset.height };
      const center = layerCenter(psd, entry.layer);
      const moved: [number, number] | null = img.psd ? [center[0] - img.psd[0] - common[0], center[1] - img.psd[1] - common[1]] : null;
      img.width = to.width;
      img.height = to.height;
      img.psd = center;
      img.rev = (img.rev ?? 0) + 1;
      for (const skin of d.skeleton.skins) {
        for (const [slotId, byName] of Object.entries(skin.attachments)) {
          const bone = setup.boneById(d.skeleton.slots.find((s) => s.id === slotId)?.bone ?? '');
          for (const att of Object.values(byName)) {
            if ((att.type !== 'region' && att.type !== 'mesh') || (att.path ?? att.name) !== image.name) continue;
            if (att.type === 'mesh') {
              meshes++;
              continue;
            }
            let shift: [number, number] = [0, 0];
            if (moved && bone) {
              const o = bone.worldToLocal(0, 0);
              const t = bone.worldToLocal(moved[0], moved[1]);
              shift = [t[0] - o[0], t[1] - o[1]];
            }
            Object.assign(att, fitRegion(att, from, to, shift));
          }
        }
      }
    }
    // 2. the layers that are new: a slot each, right above the slot of the layer under them in the file
    let anchor: Id | null = null;
    for (const layer of psd.layers) {
      const ref = refs.get(layer.name);
      if (!ref) {
        anchor = d.skeleton.slots.find((s) => s.attachment === layer.name)?.id ?? anchor;
        continue;
      }
      const center = layerCenter(psd, layer);
      const at = placeOnBone(live, center[0], center[1]);
      const slot = newSlot({
        name: freshName(ref.name.split('/').pop() ?? ref.name, d.skeleton.slots),
        bone: boneId,
        attachment: ref.name,
        color: [1, 1, 1, layer.opacity],
        blend: layer.blend,
      });
      d.images.push({ ...ref, psd: center });
      const at0 = anchor ? d.skeleton.slots.findIndex((s) => s.id === anchor) + 1 : 0;
      d.skeleton.slots.splice(at0, 0, slot);
      skin0.attachments[slot.id] = {
        [ref.name]: {
          type: 'region',
          name: ref.name,
          path: ref.name,
          x: at.x,
          y: at.y,
          rotation: at.rotation,
          scaleX: 1,
          scaleY: 1,
          width: ref.width,
          height: ref.height,
          color: [1, 1, 1, 1],
        },
      };
      anchor = slot.id;
    }
  });
  if (pixelChanges.length) keepPixelsForUndo(pixelChanges);
  const head = `Update from ${file.name}: ${plan.updates.length} updated, ${plan.added.length} new, ${plan.gone.length} not in the file`;
  toast(meshes ? `${head} (${meshes} meshes keep their shape)` : head, 'ok');
  return { updated: plan.updates.length, added: plan.added.length };
}
