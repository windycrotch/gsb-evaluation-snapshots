/**
 * Split axes (Spine's translatex / translatey, scalex / scaley, shearx / sheary): one timeline per axis with its own key times and curves,
 * instead of the combined x + y timeline. Splitting keeps the motion exactly; merging samples both axes at every key time of either.
 */
import { SAME_EPS } from './math';
import { sampleKeys } from './curve';
import { AXIS_GROUPS } from './model';
import type { AxisGroup, BoneTimelines, Curve, Key, Timeline } from './model';

/** What a group rests at when a timeline has no key yet (identity of translate / shear, 1 for a scale). */
const NEUTRAL: Record<AxisGroup, number> = { translate: 0, scale: 1, shear: 0 };

/** True when the group is keyed per axis (one of its two split timelines has keys). */
export function isSplit(tl: BoneTimelines | undefined, g: AxisGroup): boolean {
  return !!tl && AXIS_GROUPS[g].some((p) => !!tl[p]?.length);
}

const curvePart = (curve: Curve | undefined, channel: number): Curve | undefined => {
  if (curve === undefined || curve === 'stepped') return curve;
  const part = curve.slice(channel * 4, channel * 4 + 4);
  return part.length === 4 ? part : undefined;
};

/**
 * Turns the combined timeline of a group into its two axis timelines (same key times, the curve of each channel on its axis). Returns false when
 * there is nothing to split or the group is split already.
 */
export function splitGroup(tl: BoneTimelines, g: AxisGroup): boolean {
  const keys = tl[g];
  const [ax, ay] = AXIS_GROUPS[g];
  if (!keys?.length || isSplit(tl, g)) return false;
  const axis = (channel: number): Timeline =>
    keys.map((k) => {
      const out: Key = { time: k.time, value: [k.value[channel]] };
      const curve = curvePart(k.curve, channel);
      if (curve !== undefined) out.curve = curve;
      return out;
    });
  tl[ax] = axis(0);
  tl[ay] = axis(1);
  delete tl[g];
  return true;
}

/**
 * Joins the two axis timelines of a group into one combined timeline. It gets a key at every time either axis has one, valued by sampling both
 * axes there (a missing axis rests on its neutral value). Curves survive where the two agree: stepped on both stays stepped, otherwise each
 * channel keeps its own bezier (linear where it had none). Returns false when the group is not split.
 */
export function mergeGroup(tl: BoneTimelines, g: AxisGroup): boolean {
  const [ax, ay] = AXIS_GROUPS[g];
  if (!isSplit(tl, g)) return false;
  const lines: (Timeline | undefined)[] = [tl[ax], tl[ay]];
  const times: number[] = [];
  for (const line of lines) for (const k of line ?? []) if (!times.some((t) => Math.abs(t - k.time) <= SAME_EPS)) times.push(k.time);
  times.sort((a, b) => a - b);
  const tmp = [0];
  const keyAt = (line: Timeline | undefined, time: number) => line?.find((k) => Math.abs(k.time - time) <= SAME_EPS);
  const out: Timeline = times.map((time, i) => {
    const value = lines.map((line) => (line?.length && sampleKeys(line, time, tmp) ? tmp[0] : NEUTRAL[g]));
    const here = lines.map((line) => keyAt(line, time)?.curve);
    const isLast = i === times.length - 1;
    const key: Key = { time, value };
    if (!isLast) {
      if (here.every((c) => c === 'stepped')) key.curve = 'stepped';
      else if (here.some((c) => Array.isArray(c)))
        key.curve = here.flatMap((c) => (Array.isArray(c) ? c.slice(0, 4) : [1 / 3, 1 / 3, 2 / 3, 2 / 3]));
    }
    return key;
  });
  tl[g] = out;
  delete tl[ax];
  delete tl[ay];
  return true;
}
