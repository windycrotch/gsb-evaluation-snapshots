/** Curve operations on selected keys that need the neighbours of a key (see core/autocurve.ts). */
import { autoCurve } from '@/core/autocurve';
import type { AutoKey } from '@/core/autocurve';
import { KEY_EPS } from '@/core/edit';
import { resolveKeys } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { currentAnimation } from './actions';
import { docStore } from './doc';

/** Automatic handles for the selected keys: smooth through the neighbours, no overshoot. One step of the history. */
export function setKeysAutoCurve(refs: KeyRef[]): number {
  const anim = currentAnimation();
  if (!anim || !refs.length) return 0;
  let changed = 0;
  docStore.update('Automatic curve', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const groups = new Map<AutoKey[], number[]>();
    for (const ref of refs) {
      // a deform key has one shared curve for all its offsets, and the other kinds have no values to smooth
      if (
        ref.kind === 'deform' ||
        ref.kind === 'sequence' ||
        ref.kind === 'drawOrder' ||
        ref.kind === 'drawOrderFolder' ||
        ref.kind === 'event' ||
        ref.prop === 'attachment'
      )
        continue;
      const keys = resolveKeys(a, ref);
      if (!keys) continue;
      const i = keys.findIndex((k) => Math.abs(k.time - ref.time) <= KEY_EPS);
      if (i >= 0) groups.set(keys, [...(groups.get(keys) ?? []), i]);
    }
    for (const [keys, at] of groups) changed += autoCurve(keys, at);
  });
  return changed;
}
