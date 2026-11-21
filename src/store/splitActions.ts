/** Split bone (see core/split.ts): one history step, the new parts are selected with the original. */
import type { Id } from '@/core/model';
import { splitBoneInDoc } from '@/core/split';
import type { SplitOptions } from '@/core/split';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Returns the ids of the new parts (empty when refused). */
export function splitBone(id: Id, count: number, opts: SplitOptions): Id[] {
  // checked on a copy first, so a refusal leaves no empty history step
  const probe = splitBoneInDoc(structuredClone(docStore.get().skeleton), id, count, opts);
  if ('error' in probe) {
    toast(probe.error, 'error');
    return [];
  }
  let ids: Id[] = [];
  docStore.update('Split bone', (d) => {
    const r = splitBoneInDoc(d.skeleton, id, count, opts);
    if ('ids' in r) ids = [...r.ids];
  });
  uiStore.patch({ selection: { ...uiStore.get().selection, bones: [id, ...ids], slot: null, attachment: null } });
  toast(`Bone split into ${ids.length + 1}`, 'ok');
  return ids;
}
