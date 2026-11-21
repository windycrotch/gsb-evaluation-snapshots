/** Slots and attachments: put an image in the scene, slot properties, draw order, colors. */
import { folderOrderAfterMove } from '@/core/folders';
import { freshName, keyAt, makeCurve, purgeAttachment, removeSlots, rgbaToRgba2, setSlotDarkColor, upsertKey } from '@/core/edit';
import { atan2Deg } from '@/core/math';
import { newSlot } from '@/core/model';
import type { Id, RGB, RGBA, Slot } from '@/core/model';
import { getScene, getSetupSkeleton } from '@/store/scene';
import { docStore } from './doc';
import { uiStore } from './ui';
import { setSelection } from './sessionActions';
import { currentAnimation, project, skeletonDoc } from './accessors';
import { extendDuration } from './boneActions';

/** Creates a slot + region attachment for an image, centered at the given world position (setup pose). */
export function addImageToScene(imageName: string, worldX: number, worldY: number, boneId?: Id | null): { slotId: Id } | null {
  const img = project().images.find((i) => i.name === imageName);
  if (!img) return null;
  const doc = skeletonDoc();
  const bid = boneId ?? uiStore.get().selection.bones[0] ?? doc.bones[0]?.id;
  const setup = getSetupSkeleton();
  const bone = bid ? setup.boneById(bid) : undefined;
  if (!bone) return null;
  const [lx, ly] = bone.worldToLocal(worldX, worldY);
  const det = bone.a * bone.d - bone.b * bone.c;
  const rot = det < 0 ? atan2Deg(bone.c, bone.a) : -atan2Deg(bone.c, bone.a);
  const slot = newSlot({ name: freshName(img.name, doc.slots), bone: bone.data.id, attachment: img.name });
  docStore.update('Add image', (d) => {
    const sel = uiStore.get().selection.slot;
    const idx = sel ? d.skeleton.slots.findIndex((s) => s.id === sel) : -1;
    if (idx >= 0) d.skeleton.slots.splice(idx + 1, 0, slot);
    else d.skeleton.slots.push(slot);
    const skin = d.skeleton.skins[0];
    skin.attachments[slot.id] = {
      [img.name]: {
        type: 'region',
        name: img.name,
        path: img.name,
        x: lx,
        y: ly,
        rotation: det < 0 ? -rot : rot,
        scaleX: 1,
        scaleY: 1,
        width: img.width,
        height: img.height,
        color: [1, 1, 1, 1],
      },
    };
  });
  setSelection({ slot: slot.id, attachment: img.name, bones: [bone.data.id] });
  return { slotId: slot.id };
}

export function setSlotProps(id: Id, patch: Partial<Slot>, label = 'Edit slot') {
  docStore.update(label, (d) => {
    const s = d.skeleton.slots.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    if ('dark' in patch) setSlotDarkColor(d.skeleton, id, patch.dark ?? null); // two-color keys follow the dark color
  });
}

export function renameSlot(id: Id, name: string) {
  const clean = name.trim();
  if (!clean) return;
  setSlotProps(
    id,
    {
      name: freshName(
        clean,
        skeletonDoc().slots.filter((s) => s.id !== id),
      ),
    },
    'Rename slot',
  );
}

export function deleteSlots(ids: Id[]) {
  docStore.update('Delete slots', (d) => {
    removeSlots(d.skeleton, new Set(ids));
  });
  setSelection({ bones: uiStore.get().selection.bones });
}

/** Animate mode: keys the draw order with `id` moved to `toIndex`. */
function keyDrawOrder(id: Id, toIndex: number) {
  const anim = currentAnimation();
  const ui = uiStore.get();
  if (!anim) return;
  const order = getScene().skeleton.drawOrder.map((s) => s.data.id);
  const i = order.indexOf(id);
  if (i < 0) return;
  // a slot in a folder reorders its folder only: the folder's slots swap places, the others stay
  const inFolder = folderOrderAfterMove(skeletonDoc(), order, id, toIndex);
  if (inFolder) {
    docStore.update('Key draw order', (d) => {
      const a = d.skeleton.animations.find((x) => x.id === anim.id);
      if (!a) return;
      upsertKey(((a.drawOrderFolder ??= {})[inFolder.folder.id] ??= []), { time: ui.time, order: inFolder.order });
      extendDuration(a, ui.time);
    });
    return;
  }
  order.splice(i, 1);
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id);
  docStore.update('Key draw order', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    upsertKey(a.drawOrder, { time: ui.time, order });
    extendDuration(a, ui.time);
  });
}

export function moveSlot(id: Id, toIndex: number) {
  if (uiStore.get().mode === 'animate') {
    keyDrawOrder(id, toIndex);
    return;
  }
  docStore.update('Reorder slot', (d) => {
    const list = d.skeleton.slots;
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, s);
  });
}

export function setSlotBone(id: Id, boneId: Id) {
  // keep the slot's attachments visually in place by re-expressing them in the new bone's frame (region attachments only)
  const doc = skeletonDoc();
  const slot = doc.slots.find((s) => s.id === id);
  if (!slot || slot.bone === boneId) return;
  const setup = getSetupSkeleton();
  const from = setup.boneById(slot.bone);
  const to = setup.boneById(boneId);
  if (!from || !to) return;
  docStore.update('Change slot bone', (d) => {
    const s = d.skeleton.slots.find((x) => x.id === id)!;
    s.bone = boneId;
    for (const skin of d.skeleton.skins) {
      const atts = skin.attachments[id];
      if (!atts) continue;
      for (const name in atts) {
        const a = atts[name];
        if (a.type === 'region') {
          const [wx, wy] = from.localToWorld(a.x, a.y);
          const [lx, ly] = to.worldToLocal(wx, wy);
          a.x = lx;
          a.y = ly;
        } else if (a.type === 'point') {
          const [wx, wy] = from.localToWorld(a.x, a.y);
          const [lx, ly] = to.worldToLocal(wx, wy);
          a.x = lx;
          a.y = ly;
          a.rotation += from.worldRotationX - to.worldRotationX; // keep pointing the same way
        } else if ((a.type === 'mesh' || a.type === 'boundingbox' || a.type === 'clipping') && !a.weights) {
          for (let i = 0; i < a.vertices.length; i += 2) {
            const [wx, wy] = from.localToWorld(a.vertices[i], a.vertices[i + 1]);
            const [lx, ly] = to.worldToLocal(wx, wy);
            a.vertices[i] = lx;
            a.vertices[i + 1] = ly;
          }
        }
      }
    }
  });
}

export function setAttachmentProps(slotId: Id, name: string, patch: Record<string, unknown>, label = 'Edit attachment') {
  docStore.update(label, (d) => {
    const skin = d.skeleton.skins[0];
    const a = skin.attachments[slotId]?.[name];
    if (a) Object.assign(a, patch);
  });
}

export function deleteAttachment(slotId: Id, name: string) {
  docStore.update('Delete attachment', (d) => {
    for (const skin of d.skeleton.skins) delete skin.attachments[slotId]?.[name];
    const s = d.skeleton.slots.find((x) => x.id === slotId);
    if (s && s.attachment === name) s.attachment = null;
    purgeAttachment(d.skeleton, slotId, name); // deform timelines of a missing mesh make the official loader throw
  });
}

/** Switches the visible attachment of a slot: setup pose in Setup mode, a key in Animate mode. */
export function setSlotAttachment(slotId: Id, name: string | null) {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    setSlotProps(slotId, { attachment: name }, 'Set attachment');
    return;
  }
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Key attachment', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const tl = (a.slots[slotId] ??= {});
    const keys = (tl.attachment ??= []);
    upsertKey(keys, { time: ui.time, name });
    extendDuration(a, ui.time);
  });
}

/**
 * Setup: sets the slot color. Animate: keys it at the playhead. A slot with a dark color (two-color tinting) is keyed in an rgba2
 * timeline: `dark` is the dark color to key with the light one (default: the setup dark color).
 */
export function setSlotColor(slotId: Id, color: RGBA, dark?: RGB) {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    setSlotProps(slotId, { color, ...(dark ? { dark } : {}) }, dark ? 'Slot colors' : 'Slot color');
    return;
  }
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Key color', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const setupDark = d.skeleton.slots.find((s) => s.id === slotId)?.dark ?? null;
    const tl = (a.slots[slotId] ??= {});
    let keys;
    let value: number[];
    if (setupDark) {
      if (tl.rgba) {
        tl.rgba2 = rgbaToRgba2(tl.rgba, setupDark); // light-only keys become two-color ones
        delete tl.rgba;
      }
      keys = tl.rgba2 ??= [];
      value = [color[0], color[1], color[2], color[3], ...(dark ?? setupDark)];
    } else {
      keys = tl.rgba ??= [];
      value = [color[0], color[1], color[2], color[3]];
    }
    const exist = keyAt(keys, ui.time);
    if (exist) exist.value = value;
    else {
      const curve = makeCurve(ui.defaultCurve, value.length);
      upsertKey(keys, { time: ui.time, value, ...(curve !== undefined ? { curve } : {}) });
    }
    extendDuration(a, ui.time);
  });
}
