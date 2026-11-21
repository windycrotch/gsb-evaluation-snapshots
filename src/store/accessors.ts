/** Small readers of the open document and of what is being edited. */
import { findAnimation } from '@/core/edit';
import type { Animation, Id } from '@/core/model';
import { docStore } from './doc';
import { uiStore } from './ui';

export const project = () => docStore.get();
export const skeletonDoc = () => docStore.get().skeleton;
export const boneById = (id: Id) => skeletonDoc().bones.find((b) => b.id === id);
export const slotById = (id: Id) => skeletonDoc().slots.find((s) => s.id === id);

export function currentAnimation(): Animation | undefined {
  return findAnimation(skeletonDoc(), uiStore.get().animationId);
}
