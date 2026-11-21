/**
 * Insert time / Delete time: the whole animation is cut at the playhead and pulled apart or pushed together. Every key of every timeline
 * (bones, slots, constraints, deform, sequences, draw order, events), the markers and the play range after the cut move by the same amount.
 * Making a pause in the middle of a walk, or closing the hole a deleted pose left, is one step instead of selecting every key and shifting them.
 * Asked for by animators of other editors (Live2D: "insert and delete empty keyframes on the timeline, later keys shifting to fill or close the gap").
 *
 */
import { keyLists } from './keylists';
import { KEY_EPS } from './edit';
import type { Animation } from './model';

export interface TimeShift {
  /** How many keys moved, were removed, or markers moved. */
  moved: number;
  removed: number;
  /** The animation got this long (or short). */
  duration: number;
}

/**
 * Inserts `seconds` of empty time at `at`: everything at `at` or later moves `seconds` later and the animation grows by as much.
 * Keys and markers before `at` stay. Returns what changed.
 */
export function insertTime(anim: Animation, at: number, seconds: number): TimeShift {
  let moved = 0;
  if (!(seconds > 0) || !Number.isFinite(at) || at < 0) return { moved, removed: 0, duration: anim.duration };
  for (const keys of keyLists(anim)) {
    for (const k of keys) {
      if (k.time >= at - KEY_EPS) {
        k.time = k.time + seconds;
        moved++;
      }
    }
  }
  for (const m of anim.markers ?? []) {
    if (m.time >= at - KEY_EPS) {
      m.time = m.time + seconds;
      moved++;
    }
  }
  const range = anim.play?.range;
  if (range) {
    // a play range that spans the cut gets longer; one that starts after it moves
    anim.play!.range = [range[0] >= at - KEY_EPS ? range[0] + seconds : range[0], range[1] >= at - KEY_EPS ? range[1] + seconds : range[1]];
  }
  anim.duration = anim.duration + seconds;
  return { moved, removed: 0, duration: anim.duration };
}

/**
 * Deletes `seconds` of time from `at`: the keys inside [at, at + seconds) are removed, the later ones move `seconds` earlier, and the
 * animation gets shorter by as much (never below `minDuration`, so a last key is never cut off). Markers inside the span collapse onto `at`.
 * The span is cut to what the animation has after `at`.
 */
export function deleteTime(anim: Animation, at: number, seconds: number, minDuration: number): TimeShift {
  if (!(seconds > 0) || !Number.isFinite(at) || at < 0 || at >= anim.duration) return { moved: 0, removed: 0, duration: anim.duration };
  const span = Math.min(seconds, anim.duration - at);
  const end = at + span;
  let moved = 0;
  let removed = 0;
  for (const keys of keyLists(anim)) {
    for (let i = keys.length - 1; i >= 0; i--) {
      const t = keys[i].time;
      if (t >= at - KEY_EPS && t < end - KEY_EPS) {
        keys.splice(i, 1);
        removed++;
      } else if (t >= end - KEY_EPS) {
        keys[i].time = Math.max(at, t - span);
        moved++;
      }
    }
  }
  for (const m of anim.markers ?? []) {
    if (m.time >= end - KEY_EPS) {
      m.time = m.time - span;
      moved++;
    } else if (m.time > at) {
      m.time = at;
      moved++;
    }
  }
  const range = anim.play?.range;
  if (range) {
    const pull = (t: number) => (t >= end - KEY_EPS ? t - span : t > at ? at : t);
    const next: [number, number] = [pull(range[0]), pull(range[1])];
    anim.play!.range = next[1] - next[0] > KEY_EPS ? next : null;
  }
  anim.duration = Math.max(minDuration, anim.duration - span);
  // nothing lies beyond the end (float noise in the sums could leave a time a hair past it)
  for (const m of anim.markers ?? []) m.time = Math.min(m.time, anim.duration);
  if (anim.play?.range) {
    const [a, b] = [Math.min(anim.play.range[0], anim.duration), Math.min(anim.play.range[1], anim.duration)];
    anim.play.range = b - a > KEY_EPS ? [a, b] : null;
  }
  return { moved, removed, duration: anim.duration };
}
