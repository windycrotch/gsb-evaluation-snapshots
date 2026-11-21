/**
 * Close the loop: makes the end of an animation the same as its start, so a cycle (a walk, an idle) repeats without a jump.
 * Every timeline of numbers with two keys or more gets the value of its first key on its last key (or the other way round); a timeline
 * whose last key is before the end of the animation gets a key at the end. Keys that are not numbers (attachments, events, draw order) stay.
 */
import { keyListsIn } from './keylists';
import { SAME_EPS } from './math';
import type { Animation, Id, Key } from './model';

const isNumberKey = (k: unknown): k is Key =>
  !!k && typeof k === 'object' && typeof (k as Key).time === 'number' && Array.isArray((k as Key).value);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= SAME_EPS);

export interface CloseLoopOptions {
  /** Which end is the one to keep: the first key's value is copied to the end (default), or the last key's value to the start. */
  keep?: 'first' | 'last';
  /** Only the timelines of these bones. Without it the whole animation is closed (slots, deform and the constraints too). */
  bones?: readonly Id[];
}

/** Closes one timeline; true when a key changed or was added. */
function closeTimeline(keys: Key[], duration: number, keep: 'first' | 'last'): boolean {
  if (keys.length < 2) return false;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (keep === 'last') {
    if (same(first.value, last.value)) return false;
    first.value = [...last.value];
    return true;
  }
  if (last.time < duration - SAME_EPS) {
    if (same(first.value, last.value)) return false; // already at rest on the value of the start
    keys.push({ time: duration, value: [...first.value] });
    return true;
  }
  if (same(first.value, last.value)) return false;
  last.value = [...first.value];
  return true;
}

/** Closes the loop of an animation in place. Returns how many timelines were changed. */
export function closeLoop(anim: Animation, options: CloseLoopOptions = {}): number {
  const keep = options.keep ?? 'first';
  const scope = options.bones
    ? options.bones.map((id) => anim.bones[id])
    : [anim.bones, anim.slots, anim.deform, anim.transform, anim.slider, anim.path, anim.physics];
  let changed = 0;
  for (const list of keyListsIn(scope)) if (list.every(isNumberKey) && closeTimeline(list, anim.duration, keep)) changed++;
  return changed;
}

/** How far the end may be from the start before a seam shows (degrees, pixels, a multiplier: a tenth of any is hard to see). */
const SEAM_TOLERANCE = 0.1;

/** How many timelines of a cycle end on another value than they start on (a jump when it repeats). Changes nothing. */
export function openSeams(anim: Animation, tolerance = SEAM_TOLERANCE): number {
  const scope = [anim.bones, anim.slots, anim.deform, anim.transform, anim.slider, anim.path, anim.physics];
  let open = 0;
  for (const list of keyListsIn(scope)) {
    if (list.length < 2 || !list.every(isNumberKey)) continue;
    const first = list[0].value;
    const last = list[list.length - 1].value;
    if (first.length !== last.length || first.some((v, i) => Math.abs(v - last[i]) > tolerance)) open++;
  }
  return open;
}

/** The most copies of one key the Dopesheet draws on each side (zoomed far out a short animation would otherwise repeat thousands of times). */
export const MAX_LOOP_GHOSTS = 6;

/**
 * The times a key of a looping animation comes back at: `time` plus or minus whole lengths of the animation, inside the visible stretch
 * [from, to] and outside the animation itself (0 to `duration`). The Dopesheet draws them faint before 0 and after the end, so the seam of a
 * loop can be checked on the timeline (Rive users ask for the time before 0:00 to be visible when they build loops by hand).
 */
export function loopGhostTimes(time: number, duration: number, from: number, to: number): number[] {
  if (!(duration > 0) || !Number.isFinite(time) || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const out: number[] = [];
  const first = Math.ceil((from - time) / duration - 1e-9);
  for (let n = first, count = 0; time + n * duration <= to + 1e-9 && count < 4 * MAX_LOOP_GHOSTS; n++, count++) {
    if (n === 0) continue;
    const t = Math.round((time + n * duration) * 1e6) / 1e6;
    if (t >= -1e-9 && t <= duration + 1e-9) continue; // inside the animation: not a copy, the animation itself
    out.push(t);
    if (out.length >= 2 * MAX_LOOP_GHOSTS) break;
  }
  return out;
}
