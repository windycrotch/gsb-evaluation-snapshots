/**
 * Tween: a pose between the keys on either side of the playhead (an animator's breakdown). 0 is the previous key, 1 the next one, and a value
 * outside 0..1 overshoots, which is how a motion gets its anticipation or its settle.
 */
import { KEY_EPS } from './edit';
import { BONE_PROPS } from './model';
import type { Animation, BoneProp, Id } from './model';

interface TimeValue {
  time: number;
  value: number[];
}

/** The keys just before and just after `t` (a key at `t` itself is neither). With a key on one side only, that key stands for both. */
export function neighbours(keys: readonly TimeValue[] | undefined, t: number, eps = KEY_EPS): { prev: TimeValue; next: TimeValue } | null {
  if (!keys?.length) return null;
  let prev: TimeValue | null = null;
  let next: TimeValue | null = null;
  for (const k of keys) {
    if (k.time < t - eps) prev = k;
    else if (k.time > t + eps && !next) next = k;
  }
  if (!prev && !next) return null;
  return { prev: (prev ?? next)!, next: (next ?? prev)! };
}

/** `amount` of the way from `prev` to `next`, per number. */
export function tweenValue(prev: number[], next: number[], amount: number): number[] {
  return prev.map((v, i) => v + ((next[i] ?? v) - v) * amount);
}

/** The values a bone gets at time `t`, per channel it has keys on: its previous and next key blended by `amount`. A channel with no neighbours is left out. */
export function tweenBone(
  anim: Animation,
  bone: Id,
  t: number,
  amount: number,
  rotateFrom: Id = bone,
): Partial<Record<BoneProp, number[]>> {
  const out: Partial<Record<BoneProp, number[]>> = {};
  for (const prop of BONE_PROPS) {
    const tl = (prop === 'rotate' ? anim.bones[rotateFrom] : anim.bones[bone])?.[prop];
    const n = neighbours(tl, t);
    if (n) out[prop] = tweenValue(n.prev.value, n.next.value, amount);
  }
  return out;
}
