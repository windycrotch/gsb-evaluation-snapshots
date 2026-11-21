/**
 * The animation check: what looks wrong in the animations and in the names of a rig, found without anyone looking at the screen. These are
 * hints, not errors: a wheel may turn a whole circle between two keys on purpose and a one-sided character may have only a left hand. So
 * each finding says what was seen and where, and never blocks an export. The checks that need no knowledge of intent run here; the
 * ones that do (is that pose meant to be held?) are left to the eye.
 */
import { keyLists } from './keylists';
import { counterpartName, sideStyle } from './animtools';
import { openSeams } from './loops';
import type { Animation, BoneTimelines, Id, Key, Project } from './model';

type LintKind = 'loopSeam' | 'longSpin' | 'keyAfterEnd' | 'duplicateKey' | 'unpairedSide' | 'mixedSides' | 'denseKeys';

export interface Finding {
  kind: LintKind;
  /** What it is about, for the list: an animation name, or the bone names of a naming finding. */
  subject: string;
  /** Where to go on a click. */
  animation?: Id;
  bone?: Id;
  time?: number;
  /** How many places (timelines, keys, bones) the finding covers. */
  count: number;
}

/** A turn of more than this between two rotate keys (degrees) is shown as a hint. */
export const SPIN_LIMIT = 180;
/** An animation whose timelines have a key on nearly every frame is shown as dense. */
const DENSE_SHARE = 0.5;
const DENSE_MIN_KEYS = 8;
/** Names of animations that are cycles when the person has not said so (the Playback window has the real switch). */
const CYCLE_NAME = /idle|walk|run|loop|cycle|breath|hover|float|sway|bob/i;

/** The timelines of a bone that hold numbers by channel: the three that can turn a long way are the rotate ones. */
function boneLists(bt: BoneTimelines): { prop: string; keys: Key[] }[] {
  const out: { prop: string; keys: Key[] }[] = [];
  for (const [prop, keys] of Object.entries(bt)) if (Array.isArray(keys)) out.push({ prop, keys: keys as Key[] });
  return out;
}

const isCycle = (a: Animation) => (a.play ? a.play.loop : CYCLE_NAME.test(a.name));

/** The checks of one animation; `fps` is the frame rate of the skeleton. */
export function lintAnimation(a: Animation, fps: number): Finding[] {
  const out: Finding[] = [];
  const subject = a.name;
  const base = { subject, animation: a.id };

  // a turn of more than half a circle between two keys
  let spins = 0;
  let spin: { bone: Id; time: number } | null = null;
  // keys beyond the end, and two keys at one time
  let late = 0;
  let lateAt: { bone?: Id; time: number } | null = null;
  let twins = 0;
  let twinAt: { bone?: Id; time: number } | null = null;
  for (const [bone, bt] of Object.entries(a.bones)) {
    for (const { prop, keys } of boneLists(bt)) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.time > a.duration + 1e-6) {
          late++;
          lateAt ??= { bone, time: k.time };
        }
        const prev = keys[i - 1];
        if (!prev) continue;
        if (Math.abs(k.time - prev.time) < 1e-6) {
          twins++;
          twinAt ??= { bone, time: k.time };
        }
        if (prop === 'rotate' && prev.curve !== 'stepped' && prev.value && k.value && Math.abs(k.value[0] - prev.value[0]) > SPIN_LIMIT) {
          spins++;
          spin ??= { bone, time: prev.time };
        }
      }
    }
  }
  if (spins) out.push({ kind: 'longSpin', ...base, bone: spin!.bone, time: spin!.time, count: spins });
  if (late) out.push({ kind: 'keyAfterEnd', ...base, bone: lateAt?.bone, time: lateAt?.time, count: late });
  if (twins) out.push({ kind: 'duplicateKey', ...base, bone: twinAt?.bone, time: twinAt?.time, count: twins });

  // an open seam of a cycle
  if (isCycle(a)) {
    const seams = openSeams(a);
    if (seams) out.push({ kind: 'loopSeam', ...base, count: seams });
  }

  // a key on nearly every frame: the animation was baked or imported frame by frame
  const lists = keyLists(a).filter((l) => l.length >= DENSE_MIN_KEYS);
  if (lists.length) {
    const frame = 1 / Math.max(1, fps);
    const dense = lists.filter((l) => {
      const gaps: number[] = [];
      for (let i = 1; i < l.length; i++) gaps.push(l[i].time - l[i - 1].time);
      gaps.sort((x, y) => x - y);
      return gaps[Math.floor(gaps.length / 2)] <= frame * 1.2;
    }).length;
    if (dense / lists.length >= DENSE_SHARE) out.push({ kind: 'denseKeys', ...base, count: dense });
  }
  return out;
}

/** The names that show a side ("arm_L", "handLeft") and how they are written: the pairing tools (Swap sides, Mirror) work by these names. */
function lintNames(project: Project): Finding[] {
  const out: Finding[] = [];
  const bones = project.skeleton.bones;
  const names = new Set(bones.map((b) => b.name));
  const lonely = bones.filter((b) => {
    const other = counterpartName(b.name);
    return other !== null && !names.has(other);
  });
  if (lonely.length)
    out.push({
      kind: 'unpairedSide',
      subject:
        lonely
          .slice(0, 4)
          .map((b) => b.name)
          .join(', ') + (lonely.length > 4 ? ', …' : ''),
      bone: lonely[0].id,
      count: lonely.length,
    });
  const styles = new Set(bones.map((b) => sideStyle(b.name)).filter((s): s is NonNullable<ReturnType<typeof sideStyle>> => s !== null));
  // left/right words, single letters and the short forms say the same thing three ways; near/far and front/back mean something else
  const lr = ['left-right', 'l-r', 'lft-rgt'].filter((s) => styles.has(s as never));
  if (lr.length > 1) out.push({ kind: 'mixedSides', subject: lr.join(' / '), count: lr.length });
  return out;
}

/** Every finding of the project: the animations and the names. */
export function lintProject(project: Project): Finding[] {
  const out: Finding[] = [];
  for (const a of project.skeleton.animations) out.push(...lintAnimation(a, project.skeleton.fps));
  out.push(...lintNames(project));
  return out;
}
