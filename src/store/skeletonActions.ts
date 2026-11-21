/** Several skeletons in one project: switch, add, copy, rename, delete. Each is one step of the history. */
import {
  activeIndex,
  blankSkeleton,
  copyOfSkeleton,
  addSkeleton,
  duplicateSkeleton,
  newSkeletonName,
  removeSkeleton,
  renameSkeleton,
  skeletonList,
  switchSkeleton,
} from '@/core/skeletons';
import { docStore } from './doc';
import { emptySelection, toast, uiStore } from './ui';

/** What the editor shows is about the skeleton that was edited: after a change of skeleton it starts again from its first animation. */
function resetView() {
  const doc = docStore.get().skeleton;
  uiStore.patch({
    mode: 'setup',
    selection: emptySelection,
    animationId: doc.animations[0]?.id ?? null,
    skinId: null,
    time: 0,
    playing: false,
    overrides: {},
    selectedKeys: [],
  });
}

export function switchToSkeleton(index: number) {
  const p = docStore.get();
  if (!Number.isInteger(index) || index < 0 || index >= skeletonList(p).length || index === activeIndex(p)) return;
  docStore.update('Switch skeleton', (d) => void switchSkeleton(d, index));
  resetView();
}

export function createSkeleton(name = 'skeleton') {
  const doc = blankSkeleton(newSkeletonName(docStore.get(), name), docStore.get().skeleton.fps);
  docStore.update('New skeleton', (d) => void addSkeleton(d, doc));
  resetView();
}

export function copySkeleton() {
  const copy = copyOfSkeleton(docStore.get());
  docStore.update('Duplicate skeleton', (d) => void duplicateSkeleton(d, copy));
  resetView();
}

export function renameSkeletonAt(index: number, name: string) {
  docStore.update('Rename skeleton', (d) => void renameSkeleton(d, index, name));
}

export function deleteSkeletonAt(index: number) {
  if (skeletonList(docStore.get()).length < 2) {
    toast('A project keeps at least one skeleton', 'info');
    return;
  }
  const wasEdited = skeletonList(docStore.get())[index] === docStore.get().skeleton;
  docStore.update('Delete skeleton', (d) => void removeSkeleton(d, index));
  if (wasEdited) resetView();
}
