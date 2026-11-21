/**
 * Tools for finished motion that Spine does not have: wiggle (noise on a timeline), mirror a half cycle into a whole one (left step ->
 * right step), a foot-slide check (where a planted foot drags along the ground) and the bones an animation does not touch.
 */
import { sampleKeys } from './curve';
import { poseFrames, frameTimes } from './bake';
import { uid } from './ids';
import { makeCurve } from './edit';
import { BONE_PROPS } from './model';
import type { Animation, Id, Key, SkeletonDoc, Timeline } from './model';

/** A small deterministic random generator (mulberry32): the same seed always gives the same shake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WiggleOptions {
  /** How far a value strays, in the unit of the channel (degrees, units, a scale factor). */
  amount: number;
  /** A key every this many frames. */
  every: number;
  fps: number;
  seed: number;
  /** Smooth (bezier) between the keys instead of straight lines. */
  smooth: boolean;
  /** The first and the last key keep their value, so a loop still closes. */
  keepEnds: boolean;
}

/**
 * Noise on top of a number timeline: a key every few frames between its first and last key, each moved by a random amount of up to
 * ±`amount` from what the timeline was there. Needs two keys or more (a single key has no stretch to shake).
 */
export function wiggleKeys(keys: Timeline, o: WiggleOptions): Timeline {
  if (keys.length < 2 || !(o.amount > 0)) return keys;
  const n = keys[0].value.length;
  const rand = seeded(o.seed);
  const first = keys[0].time;
  const last = keys[keys.length - 1].time;
  const step = Math.max(1, Math.round(o.every)) / Math.max(1, o.fps);
  const times: number[] = [];
  for (let t = first; t < last - 1e-9; t += step) times.push(t);
  times.push(last);
  const tmp: number[] = [];
  return times.map((time, i) => {
    sampleKeys(keys, time, tmp);
    const isEnd = i === 0 || i === times.length - 1;
    const value = Array.from({ length: n }, (_, c) => tmp[c] + (o.keepEnds && isEnd ? 0 : (rand() * 2 - 1) * o.amount));
    const key: Key = { time: Math.round(time * 1e6) / 1e6, value };
    if (i < times.length - 1 && o.smooth) key.curve = makeCurve('bezier', n);
    return key;
  });
}

const PAIRS: [string, string][] = [
  ['near', 'far'],
  ['left', 'right'],
  ['l', 'r'],
  ['lft', 'rgt'],
  ['front', 'back'],
];

const matchCase = (from: string, to: string) =>
  from === from.toUpperCase() && from.length > 1
    ? to.toUpperCase()
    : from[0] === from[0].toUpperCase() && from[0] !== from[0].toLowerCase()
      ? to[0].toUpperCase() + to.slice(1)
      : to;

/**
 * The name of the other side: "arm near 1" -> "arm far 1", "Leg_L" -> "Leg_R", "handLeft" -> "handRight". Whole words and the ends of a
 * name (a single L / R after a separator or a lowercase letter) swap; null when the name has no side.
 */
export function counterpartName(name: string): string | null {
  const swapWord = (w: string): string | null => {
    const lower = w.toLowerCase();
    for (const [a, b] of PAIRS) {
      if (lower === a) return matchCase(w, b);
      if (lower === b) return matchCase(w, a);
    }
    return null;
  };
  const parts = name.split(/([ _\-.]+)/);
  for (let i = 0; i < parts.length; i++) {
    const s = swapWord(parts[i]);
    if (s !== null) {
      parts[i] = s;
      return parts.join('');
    }
  }
  // camelCase: armL, handLeft, LArm
  const tail = /^(.*[a-z0-9])(Left|Right|L|R)$/.exec(name);
  if (tail) return tail[1] + (swapWord(tail[2]) as string);
  const head = /^(Left|Right|L|R)([A-Z].*)$/.exec(name);
  if (head) return (swapWord(head[1]) as string) + head[2];
  return null;
}

/** How a name writes its side: left/right words, single letters, short forms, near/far or front/back; null when it shows none. */
export type SideStyle = 'near-far' | 'left-right' | 'l-r' | 'lft-rgt' | 'front-back';
const STYLES: SideStyle[] = ['near-far', 'left-right', 'l-r', 'lft-rgt', 'front-back'];

export function sideStyle(name: string): SideStyle | null {
  const word = (w: string): SideStyle | null => {
    const lower = w.toLowerCase();
    const at = PAIRS.findIndex(([a, b]) => lower === a || lower === b);
    return at < 0 ? null : STYLES[at];
  };
  for (const part of name.split(/[ _\-.]+/)) {
    const s = word(part);
    if (s) return s;
  }
  const tail = /^(.*[a-z0-9])(Left|Right|L|R)$/.exec(name);
  if (tail) return word(tail[2]);
  const head = /^(Left|Right|L|R)([A-Z].*)$/.exec(name);
  return head ? word(head[1]) : null;
}

/** For each item the id of the one on the other side (items without a side, or whose other side does not exist, are left out). */
export function sidePairs(items: { id: Id; name: string }[]): Map<Id, Id> {
  const byName = new Map(items.map((i) => [i.name, i.id] as const));
  const out = new Map<Id, Id>();
  for (const i of items) {
    const other = counterpartName(i.name);
    const id = other ? byName.get(other) : undefined;
    if (id && id !== i.id) out.set(i.id, id);
  }
  return out;
}

export interface MirrorOptions {
  /** Centre bones (no side) repeat their motion with the rotation turned the other way, as a hip twist does on the next step. */
  flipCentre: boolean;
}

const shifted = <T extends { time: number }>(keys: T[], dt: number): T[] => keys.map((k) => ({ ...structuredClone(k), time: k.time + dt }));

/** The keys of the first half, then those of the other half (moved on by `dt`); a key of the second half at the time of the last of the first is dropped. */
function joinHalves<T extends { time: number }>(own: T[] | undefined, other: T[] | undefined, dt: number): T[] {
  const first = (own ?? []).map((k) => structuredClone(k));
  const second = shifted(other ?? [], dt).filter((k) => !first.some((f) => Math.abs(f.time - k.time) < 1e-6));
  return [...first, ...second];
}

const negate = (keys: Key[]): Key[] =>
  keys.map((k) => ({
    ...k,
    value: k.value.map((v) => -v),
    curve: Array.isArray(k.curve) ? k.curve.map((v, i) => (i % 4 === 1 || i % 4 === 3 ? -v : v)) : k.curve,
  }));

/**
 * A whole cycle from a half one: the animation is the first half, and the second half is the same motion with the two sides swapped (the
 * left leg does what the right did, "arm near" what "arm far" did). Everything else (bones with no side, colours, constraints, events)
 * simply repeats. The result is twice as long; a new animation, the original is not changed.
 */
export function mirrorCycle(doc: SkeletonDoc, anim: Animation, name: string, options: MirrorOptions = { flipCentre: true }): Animation {
  const half = anim.duration;
  const out: Animation = { ...structuredClone(anim), id: uid(), name, duration: half * 2 };
  delete out.markers;
  const sides = sidePairs(doc.bones);
  for (const bone of doc.bones) {
    const own = anim.bones[bone.id];
    const otherId = sides.get(bone.id);
    const src = otherId ? anim.bones[otherId] : own;
    const piece: Record<string, Key[]> = {};
    for (const prop of BONE_PROPS) {
      let other = src?.[prop];
      if (!otherId && options.flipCentre && prop === 'rotate' && other) other = negate(other);
      const joined = joinHalves(own?.[prop], other, half);
      if (joined.length) piece[prop] = joined;
    }
    if (Object.keys(piece).length) out.bones[bone.id] = piece;
    else delete out.bones[bone.id];
  }
  const slotSides = sidePairs(doc.slots);
  for (const slot of doc.slots) {
    const own = anim.slots[slot.id];
    const src = anim.slots[slotSides.get(slot.id) ?? slot.id];
    const piece: Record<string, unknown[]> = {};
    for (const prop of ['attachment', 'rgba', 'rgba2'] as const) {
      const joined = joinHalves(own?.[prop] as { time: number }[] | undefined, src?.[prop] as { time: number }[] | undefined, half);
      if (joined.length) piece[prop] = joined;
    }
    if (Object.keys(piece).length) out.slots[slot.id] = piece;
    else delete out.slots[slot.id];
  }
  const ikSides = sidePairs(doc.constraints.filter((c) => c.type === 'ik'));
  for (const c of doc.constraints) {
    if (c.type !== 'ik') continue;
    const joined = joinHalves(anim.ik[c.id], anim.ik[ikSides.get(c.id) ?? c.id], half);
    if (joined.length) out.ik[c.id] = joined;
    else delete out.ik[c.id];
  }
  // the rest repeats as it is
  const repeat = <T extends { time: number }>(keys: T[] | undefined) => joinHalves(keys, keys, half);
  for (const [id, keys] of Object.entries(anim.transform ?? {})) out.transform[id] = repeat(keys);
  for (const group of ['slider', 'path', 'physics'] as const) {
    for (const [id, tl] of Object.entries(anim[group] ?? {})) {
      const piece: Record<string, Key[]> = {};
      for (const [prop, keys] of Object.entries(tl as Record<string, Key[] | undefined>)) if (keys?.length) piece[prop] = repeat(keys);
      (out[group] as Record<Id, unknown>)[id] = piece;
    }
  }
  for (const [skin, perSlot] of Object.entries(anim.deform ?? {})) {
    for (const [slot, perAtt] of Object.entries(perSlot))
      for (const [att, keys] of Object.entries(perAtt)) out.deform[skin][slot][att] = repeat(keys);
  }
  for (const [skin, perSlot] of Object.entries(anim.sequence ?? {})) {
    for (const [slot, perAtt] of Object.entries(perSlot))
      for (const [att, keys] of Object.entries(perAtt)) out.sequence![skin][slot][att] = repeat(keys);
  }
  out.drawOrder = repeat(anim.drawOrder);
  for (const [id, keys] of Object.entries(anim.drawOrderFolder ?? {})) out.drawOrderFolder![id] = repeat(keys);
  out.events = [...anim.events.map((k) => ({ ...k })), ...shifted(anim.events, half).filter((k) => k.time < half * 2 + 1e-9)];
  return out;
}

export interface SlideOptions {
  /** A foot counts as planted while it is within this many units of its lowest point in the animation. */
  ground: number;
  /** How fast the body travels along the ground, in units a second (0 for an animation with the movement in the root bone). A planted foot should move back by exactly this. */
  bodySpeed: number;
  /** A foot slides when it moves along the ground this much faster or slower than it should, in units a second. */
  tolerance: number;
}

export const DEFAULT_SLIDE: SlideOptions = { ground: 2, bodySpeed: 0, tolerance: 8 };

export interface Slide {
  bone: Id;
  /** Frames (inclusive) the foot is planted and slides. */
  from: number;
  to: number;
  /** The worst error in units a second: how fast the foot drags over the ground, +forward. */
  worst: number;
}

/** The stretches of the animation where a planted foot (a bone that touches its lowest height) drags along the ground. */
export function footSlides(doc: SkeletonDoc, anim: Animation, boneIds: Id[], opts: SlideOptions = DEFAULT_SLIDE): Slide[] {
  if (!boneIds.length || anim.duration <= 0) return [];
  const frames = poseFrames(doc, anim);
  const times = frameTimes(anim.duration, doc.fps);
  const out: Slide[] = [];
  for (const id of boneIds) {
    const index = doc.bones.findIndex((b) => b.id === id);
    if (index < 0 || frames.length < 2) continue;
    const ys = frames.map((f) => f[index][5]);
    const low = Math.min(...ys);
    // error of the horizontal travel from frame i to i+1 (the foot should move back by the body speed)
    const err = (i: number) => (frames[i + 1][index][4] - frames[i][index][4]) / Math.max(1e-9, times[i + 1] - times[i]) + opts.bodySpeed;
    let run: { from: number; to: number; worst: number } | null = null;
    for (let i = 0; i < frames.length - 1; i++) {
      const planted = ys[i] - low <= opts.ground && ys[i + 1] - low <= opts.ground;
      const e = err(i);
      if (planted && Math.abs(e) > opts.tolerance) {
        if (!run) run = { from: i, to: i + 1, worst: e };
        else {
          run.to = i + 1;
          if (Math.abs(e) > Math.abs(run.worst)) run.worst = e;
        }
      } else if (run) {
        out.push({ bone: id, ...run });
        run = null;
      }
    }
    if (run) out.push({ bone: id, ...run });
  }
  return out;
}

/** The bones with no key of any kind in an animation. */
export function unkeyedBones(doc: SkeletonDoc, anim: Animation | null | undefined): Id[] {
  if (!anim) return [];
  return doc.bones.filter((b) => !BONE_PROPS.some((p) => anim.bones[b.id]?.[p]?.length)).map((b) => b.id);
}
