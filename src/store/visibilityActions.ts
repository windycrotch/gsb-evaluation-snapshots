import { hiddenOf, isolation } from '@/core/treeFilter';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Shows every bone and slot that was hidden in the viewport. Returns how many were shown. */
export function showAll(): number {
  const hidden = hiddenOf(docStore.get().skeleton);
  const count = hidden.bones.length + hidden.slots.length;
  if (!count) {
    toast('Nothing is hidden', 'info');
    return 0;
  }
  docStore.update('Show all', (d) => {
    for (const b of d.skeleton.bones) b.hidden = false;
    for (const s of d.skeleton.slots) s.hidden = false;
  });
  return count;
}

/** Hides everything except the selection (a selected slot, or the selected bones with their children and slots). Returns how many were hidden, or -1 when nothing is selected. */
export function isolateSelection(): number {
  const ui = uiStore.get();
  const plan = isolation(docStore.get().skeleton, ui.selection.bones, ui.selection.slot);
  if (!plan) {
    toast('Select a bone or a slot to show only it', 'info');
    return -1;
  }
  docStore.update('Show only the selection', (d) => {
    for (const b of d.skeleton.bones) b.hidden = plan.bones.has(b.id);
    for (const s of d.skeleton.slots) s.hidden = plan.slots.has(s.id);
  });
  return plan.bones.size + plan.slots.size;
}
