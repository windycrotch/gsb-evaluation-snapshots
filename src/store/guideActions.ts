import { cleanGuides } from '@/core/snap';
import { docStore } from './doc';

export type GuideAxis = 'x' | 'y';

/** Lays a guide (axis x: a vertical line at x; y: a horizontal line at y). A line that is already there stays one. Returns its index. */
export function addGuide(axis: GuideAxis, value: number): number {
  if (!Number.isFinite(value)) return -1;
  const v = Math.round(value * 1000) / 1000;
  const existing = docStore.get().guides?.[axis].indexOf(v) ?? -1;
  if (existing >= 0) return existing;
  docStore.update('Add guide', (d) => {
    const g = cleanGuides(d.guides);
    g[axis] = cleanGuides({ [axis]: [...g[axis], v] })[axis];
    d.guides = g;
  });
  return docStore.get().guides![axis].indexOf(v);
}

/** Moves a guide to a new place (the live drag of the person does not call this; only its end does). */
export function moveGuide(axis: GuideAxis, index: number, value: number) {
  const list = docStore.get().guides?.[axis];
  if (!list || !(index in list) || !Number.isFinite(value)) return;
  docStore.update('Move guide', (d) => {
    const g = cleanGuides(d.guides);
    g[axis] = cleanGuides({ [axis]: g[axis].map((x, i) => (i === index ? value : x)) })[axis];
    d.guides = g;
  });
}

export function removeGuide(axis: GuideAxis, index: number) {
  const list = docStore.get().guides?.[axis];
  if (!list || !(index in list)) return;
  docStore.update('Remove guide', (d) => {
    const g = cleanGuides(d.guides);
    g[axis] = g[axis].filter((_, i) => i !== index);
    d.guides = g;
  });
}

/** Takes every guide away. Returns how many there were. */
export function clearGuides(): number {
  const g = docStore.get().guides;
  const count = (g?.x.length ?? 0) + (g?.y.length ?? 0);
  if (!count) return 0;
  docStore.update('Clear guides', (d) => void delete d.guides);
  return count;
}
