/** Favor and Scale time on the selected keys (see core/keytools.ts). One step of the history each. */
import { KEY_EPS } from '@/core/edit';
import { favorKeys, neutralOf, scaledTimes } from '@/core/keytools';
import type { FavorMode } from '@/core/keytools';
import { decodeKey, encodeKey, resolveKeys } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { currentAnimation } from './actions';
import { docStore } from './doc';
import { createStore } from './store';
import { toast, uiStore } from './ui';

type TimeKey = { time: number; value?: number[] };

/** The selected keys, as refs that resolve in the animation. */
function selectedRefs(): KeyRef[] {
  return uiStore.get().selectedKeys.map(decodeKey);
}

/** Moves the values of the selected keys toward their neighbours (or the setup pose). Returns how many keys changed. */
export function favorSelectedKeys(mode: FavorMode, amount: number): number {
  const anim = currentAnimation();
  const refs = selectedRefs();
  if (!anim || !refs.length) {
    toast('Select keys in the timeline first');
    return 0;
  }
  let changed = 0;
  docStore.update('Favor keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const groups = new Map<TimeKey[], { ref: KeyRef; at: number[] }>();
    for (const ref of refs) {
      if (ref.kind === 'deform' || ref.kind === 'sequence' || ref.prop === 'reset' || ref.prop === 'attachment') continue;
      // a block moved as a whole can leave the range a value has (a colour channel under 0, a mix over 1): only bone values are free
      if ((mode === 'shiftPrevious' || mode === 'shiftNext') && ref.kind !== 'bone') continue;
      const keys = resolveKeys(a, ref);
      const i = keys?.findIndex((k) => Math.abs(k.time - ref.time) <= KEY_EPS) ?? -1;
      if (!keys || i < 0) continue;
      const g = groups.get(keys) ?? { ref, at: [] };
      g.at.push(i);
      groups.set(keys, g);
    }
    for (const [keys, { ref, at }] of groups) {
      const channels = keys[0]?.value?.length ?? 0;
      changed += favorKeys(keys, at, mode, amount, mode === 'neutral' ? neutralOf(ref.kind, ref.prop, channels) : undefined);
    }
  });
  if (!changed)
    toast(
      mode === 'neutral' || mode === 'shiftPrevious' || mode === 'shiftNext'
        ? 'Nothing to move: this works on bone keys'
        : 'Nothing to move: a key needs a neighbour on that side',
      'info',
    );
  return changed;
}

/** Stretches the times of the selected keys around the earliest one. Returns how many keys moved (0 when the result would cross other keys). */
export function scaleSelectedKeyTimes(factor: number): number {
  const anim = currentAnimation();
  const refs = selectedRefs();
  if (!anim || !refs.length) {
    toast('Select keys in the timeline first');
    return 0;
  }
  const pivot = Math.min(...refs.map((r) => r.time));
  const fps = docStore.get().skeleton.fps;
  let moved = 0;
  let refused = false;
  const next: KeyRef[] = [];
  docStore.update('Scale key times', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const groups = new Map<TimeKey[], { ref: KeyRef; at: number[] }>();
    for (const ref of refs) {
      const keys = resolveKeys(a, ref);
      const i = keys?.findIndex((k) => Math.abs(k.time - ref.time) <= KEY_EPS) ?? -1;
      if (!keys || i < 0) continue;
      const g = groups.get(keys) ?? { ref, at: [] };
      if (!g.at.includes(i)) g.at.push(i);
      groups.set(keys, g);
    }
    // every timeline has to work out, or nothing moves
    const plans = [...groups].map(([keys, g]) => ({ keys, ref: g.ref, at: g.at, times: scaledTimes(keys, g.at, factor, pivot, fps) }));
    if (plans.some((p) => !p.times)) {
      refused = true;
      return;
    }
    for (const { keys, ref, at, times } of plans) {
      at.forEach((i, n) => {
        if (Math.abs(keys[i].time - times![n]) > 1e-9) moved++;
        keys[i].time = times![n];
        next.push({ ...ref, time: times![n] });
      });
    }
    const last = Math.max(0, ...plans.flatMap((p) => p.keys.map((k) => k.time)));
    if (last > a.duration) a.duration = last;
  });
  if (refused) {
    toast('The keys would meet another key or go below 0: scale less, or select more keys', 'info');
    return 0;
  }
  uiStore.patch({ selectedKeys: next.map(encodeKey) });
  return moved;
}

export interface StoredKey {
  ref: KeyRef;
  value: number[];
}

/** The values set aside by Store, with the animation they belong to. */
export const keyStash = createStore<{ animId: string | null; items: StoredKey[] }>({ animId: null, items: [] });

/** Sets the values of the selected keys aside. Returns how many keys it kept. */
export function storeSelectedKeys(): number {
  const anim = currentAnimation();
  const refs = selectedRefs();
  if (!anim || !refs.length) {
    toast('Select keys in the timeline first');
    return 0;
  }
  const items: StoredKey[] = [];
  for (const ref of refs) {
    if (ref.kind === 'deform' || ref.kind === 'sequence' || ref.prop === 'reset' || ref.prop === 'attachment') continue;
    const keys = resolveKeys(anim, ref);
    const key = keys?.find((k) => Math.abs(k.time - ref.time) <= KEY_EPS);
    if (key?.value) items.push({ ref, value: key.value.slice() });
  }
  keyStash.set({ animId: anim.id, items });
  if (!items.length) toast('Nothing to store: these keys have no values to set aside', 'info');
  return items.length;
}

/**
 * Trades the stored values with the values the same keys hold now (the stored ones go into the keys, what the keys held is stored in their
 * place), so a pose can be compared with another and swapped back. Keys that are gone, or whose number of values changed, stay as they are.
 * Returns how many keys changed.
 */
export function swapStoredKeys(): number {
  const anim = currentAnimation();
  const stash = keyStash.get();
  if (!anim || stash.animId !== anim.id || !stash.items.length) {
    toast('Store some keys first, in this animation', 'info');
    return 0;
  }
  let changed = 0;
  const kept: StoredKey[] = [];
  docStore.update('Swap with stored keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const item of stash.items) {
      const keys = resolveKeys(a, item.ref);
      const key = keys?.find((k) => Math.abs(k.time - item.ref.time) <= KEY_EPS);
      if (!key?.value || key.value.length !== item.value.length) {
        kept.push(item);
        continue;
      }
      kept.push({ ref: item.ref, value: key.value.slice() });
      if (key.value.some((v, c) => Math.abs(v - item.value[c]) > 1e-12)) changed++;
      key.value = item.value.slice();
    }
  });
  keyStash.set({ animId: anim.id, items: kept });
  if (!changed) toast('The stored values are the same as the keys hold now', 'info');
  return changed;
}
