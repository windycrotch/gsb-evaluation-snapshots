/**
 * Two tools for the selected keys of a timeline: Favor (move the values of the keys toward a neighbour, the average of both, or the setup
 * pose: Spine's Favor slider of the graph) and Scale time (stretch or squeeze the times of the keys around the first one, like dragging
 * the edge of the selection in the dopesheet). Pure functions over key arrays.
 */
import { KEY_EPS, snapTime } from './edit';

/** 'shiftPrevious' / 'shiftNext' move the selected keys of a timeline as one block (their differences kept) until the first / last one meets the key before / after it. */
export type FavorMode = 'previous' | 'next' | 'average' | 'neutral' | 'shiftPrevious' | 'shiftNext';

interface ValueKey {
  time: number;
  value?: number[];
}

/**
 * Moves the values of the keys at `indices` toward a target by `amount` (0 = not at all, 1 = all the way). The target is the value of the key before
 * ('previous'), after ('next'), the mean of both ('average': a smoothing; at an end it is the one neighbour there is), or `neutral` (the setup
 * pose of the timeline: 0, or 1 for a scale). Every key is measured against the values the keys had before the call, so keys next to each
 * other do not pull each other along. Returns how many keys changed.
 */
export function favorKeys(
  keys: ValueKey[],
  indices: readonly number[],
  mode: FavorMode,
  amount: number,
  neutral?: readonly number[],
): number {
  if (!keys.every((k) => Array.isArray(k.value))) return 0;
  const a = Math.min(1, Math.max(0, amount));
  if (a === 0) return 0;
  const was = keys.map((k) => k.value!.slice());
  let changed = 0;
  if (mode === 'shiftPrevious' || mode === 'shiftNext') {
    const picked = [...new Set(indices)].filter((i) => i >= 0 && i < keys.length);
    if (!picked.length) return 0;
    const anchor = mode === 'shiftPrevious' ? Math.min(...picked) : Math.max(...picked);
    const target = was[mode === 'shiftPrevious' ? anchor - 1 : anchor + 1];
    if (!target || target.length !== was[anchor].length) return 0;
    const delta = target.map((v, c) => (v - was[anchor][c]) * a);
    for (const i of picked) {
      if (was[i].length !== delta.length) continue;
      const value = was[i].map((v, c) => v + delta[c]);
      if (value.some((v, c) => Math.abs(v - was[i][c]) > 1e-12)) {
        keys[i].value = value;
        changed++;
      }
    }
    return changed;
  }
  for (const i of new Set(indices)) {
    if (i < 0 || i >= keys.length) continue;
    const prev = was[i - 1];
    const next = was[i + 1];
    let target: number[] | undefined;
    if (mode === 'previous') target = prev;
    else if (mode === 'next') target = next;
    else if (mode === 'average') target = prev && next ? prev.map((v, c) => (v + next[c]) / 2) : (prev ?? next);
    else target = neutral ? [...neutral] : undefined;
    if (!target || target.length !== was[i].length) continue;
    const value = was[i].map((v, c) => v + (target[c] - v) * a);
    if (value.some((v, c) => Math.abs(v - was[i][c]) > 1e-12)) {
      keys[i].value = value;
      changed++;
    }
  }
  return changed;
}

/** The value a timeline rests on in the setup pose (its keys are relative to the setup): 1 for a scale, 0 for the rest, nothing for what has no such value. */
export function neutralOf(kind: string, prop: string, channels: number): number[] | undefined {
  if (kind !== 'bone') return undefined;
  if (prop === 'rotate' || prop === 'translate' || prop === 'shear' || /^(translate|shear)[xy]$/.test(prop))
    return new Array<number>(channels).fill(0);
  if (prop === 'scale' || prop === 'scalex' || prop === 'scaley') return new Array<number>(channels).fill(1);
  return undefined;
}

/**
 * New times for the keys at `indices`: `pivot + (time - pivot) * factor`, on the frame grid. Returns the new times in the order of `indices`, or
 * null when the result would be wrong (a time below 0, two keys on one frame, or the keys crossing a key that is not selected). Nothing is changed.
 */
export function scaledTimes(
  keys: readonly { time: number }[],
  indices: readonly number[],
  factor: number,
  pivot: number,
  fps: number,
): number[] | null {
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  const picked = new Set(indices);
  const raw = indices.map((i) => pivot + (keys[i].time - pivot) * factor);
  if (raw.some((t) => t < -KEY_EPS)) return null;
  const out = raw.map((t) => snapTime(t, fps));
  const all = keys.map((k, i) => (picked.has(i) ? out[indices.indexOf(i)] : k.time));
  if (all.some((t) => !(t >= 0))) return null;
  const order = keys.map((_, i) => i);
  // the keys keep their order, and no two share a time
  for (let i = 1; i < order.length; i++) if (!(all[i] > all[i - 1] + KEY_EPS)) return null;
  return out;
}
