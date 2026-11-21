/** Selection sets: keep the selected bones under a name, select them again with one click. The model is in core/selsets. */
import { newSelectionSet, newSetName, pickSet } from '@/core/selsets';
import type { Id } from '@/core/model';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Keeps the selected bones as a new set. Returns it, or null when no bone is selected. */
export function saveSelectionSet(name?: string): Id | null {
  const doc = docStore.get().skeleton;
  const bones = uiStore.get().selection.bones;
  const entry = newSelectionSet(doc, bones, name);
  if (!entry.bones.length) {
    toast('Select some bones first, then keep them as a set');
    return null;
  }
  docStore.update('Save selection set', (d) => {
    (d.skeleton.selectionSets ??= []).push(entry);
  });
  return entry.id;
}

/** Selects the bones of a set; `additive` (Shift) adds them to the selection, or takes them out when they are all selected already. */
export function selectSet(id: Id, additive = false) {
  const doc = docStore.get().skeleton;
  const set = doc.selectionSets?.find((s) => s.id === id);
  if (!set) return;
  const bones = pickSet(doc, set, uiStore.get().selection.bones, additive);
  if (!bones.length && !additive) {
    toast('Every bone of this set is gone');
    return;
  }
  setSelection({ bones });
}

/** Replaces the bones of a set with the selected ones. */
export function updateSelectionSet(id: Id) {
  const doc = docStore.get().skeleton;
  const bones = [...new Set(uiStore.get().selection.bones)].filter((b) => doc.bones.some((x) => x.id === b));
  if (!bones.length) {
    toast('Select the bones the set should have now');
    return;
  }
  docStore.update('Update selection set', (d) => {
    const s = d.skeleton.selectionSets?.find((x) => x.id === id);
    if (s) s.bones = bones;
  });
}

export function renameSelectionSet(id: Id, name: string) {
  const list = docStore.get().skeleton.selectionSets ?? [];
  const entry = list.find((s) => s.id === id);
  const wanted = name.trim();
  if (!entry || !wanted || wanted === entry.name) return;
  const next = newSetName(
    list.filter((s) => s.id !== id),
    wanted,
  );
  docStore.update('Rename selection set', (d) => {
    const s = d.skeleton.selectionSets?.find((x) => x.id === id);
    if (s) s.name = next;
  });
}

export function deleteSelectionSet(id: Id) {
  docStore.update('Delete selection set', (d) => {
    const list = d.skeleton.selectionSets;
    if (!list) return;
    d.skeleton.selectionSets = list.filter((s) => s.id !== id);
    if (!d.skeleton.selectionSets.length) delete d.skeleton.selectionSets;
  });
}
