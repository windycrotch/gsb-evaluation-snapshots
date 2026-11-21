/**
 * Set Parent (Spine: the Set Parent button or P): pick what should get a new parent, start the mode, then click the new parent bone in
 * the viewport or in the tree. A slot that is selected gets the bone as its bone, otherwise every selected bone becomes a child of it.
 * The bones stay where they are in the setup pose (reparentBone keeps the world transform). One step in the history.
 */
import type { Id } from '@/core/model';
import { reparentBone, setSlotBone } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

export function startSetParent(): boolean {
  const ui = uiStore.get();
  if (ui.mode !== 'setup') {
    toast('Set parent works in Setup mode');
    return false;
  }
  if (!ui.selection.slot && !ui.selection.bones.length) {
    toast('Select the bones or the slot to give a new parent first');
    return false;
  }
  uiStore.patch({ pickParent: true });
  return true;
}

export function cancelSetParent(): boolean {
  if (!uiStore.get().pickParent) return false;
  uiStore.patch({ pickParent: false });
  return true;
}

/** The click on the new parent. */
export function applyParent(target: Id) {
  const ui = uiStore.get();
  uiStore.patch({ pickParent: false });
  const doc = docStore.get().skeleton;
  const bone = doc.bones.find((b) => b.id === target);
  if (!bone) return;
  if (ui.selection.slot) {
    const slot = doc.slots.find((s) => s.id === ui.selection.slot);
    if (!slot) return;
    if (slot.bone === target) toast(`"${slot.name}" is already on "${bone.name}"`);
    else {
      setSlotBone(slot.id, target);
      toast(`Parent set to "${bone.name}"`, 'ok');
    }
    return;
  }
  const ids = ui.selection.bones.filter((id) => id !== target);
  const moving = ids.filter((id) => doc.bones.find((b) => b.id === id)?.parent !== target);
  if (!moving.length) {
    toast(`Already a child of "${bone.name}"`);
    return;
  }
  docStore.beginGesture('Set parent');
  try {
    for (const id of moving) reparentBone(id, target);
  } finally {
    docStore.endGesture();
  }
  const done = moving.filter((id) => docStore.get().skeleton.bones.find((b) => b.id === id)?.parent === target).length;
  if (done) toast(`Parent set to "${bone.name}"`, 'ok');
}
