/**
 * Clean Up: removes the keys that change nothing. A key in the middle of a run of keys with the same value is dead weight
 * (the value is constant across it whatever the curves are). The first and the last key of a timeline are kept: they hold the pose at
 * the ends of the animation, and a timeline that rests on the setup pose is kept too, because a layered animation (a runtime's upper track) relies on it.
 */
import { keyListsIn } from './keylists';
import { SAME_EPS } from './math';
import type { Animation, Key } from './model';

const sameValue = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= SAME_EPS);

const isNumberKey = (k: unknown): k is Key =>
  !!k && typeof k === 'object' && typeof (k as Key).time === 'number' && Array.isArray((k as Key).value);

/** Removes the middle key of every run of three or more equal keys. Returns how many were removed. */
export function dropFlatKeys(keys: Key[]): number {
  let removed = 0;
  for (let i = keys.length - 2; i >= 1; i--) {
    if (sameValue(keys[i - 1].value, keys[i].value) && sameValue(keys[i].value, keys[i + 1].value)) {
      keys.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/** The document with every animation cleaned up, for an export: the document itself is not touched (the animations are copies). */
export function withCleanAnimations<T extends { animations: Animation[] }>(doc: T): T {
  return {
    ...doc,
    animations: doc.animations.map((a) => {
      const copy = JSON.parse(JSON.stringify(a)) as Animation;
      cleanUpAnimation(copy);
      return copy;
    }),
  };
}

/** Cleans an animation in place; returns the number of keys removed. */
export function cleanUpAnimation(anim: Animation): number {
  let removed = 0;
  for (const list of keyListsIn([anim.bones, anim.slots, anim.deform, anim.transform, anim.slider, anim.path, anim.physics]))
    if (list.every(isNumberKey)) removed += dropFlatKeys(list);
  return removed;
}
