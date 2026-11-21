/**
 * Two tools for finished animations that Spine does not have in the editor:
 *  - `simplifyKeys` drops the keys a curve does not need (a hand-keyed or baked animation with a key on every frame);
 *  - `bakeAnimation` writes what the constraints (IK, transform, path, physics, sliders) do into plain bone keys, so the result plays the
 *    same where a game runtime has no such constraint, or an animator wants to tweak the motion by hand.
 */
import { sampleKeys } from './curve';
import { uid } from './ids';
import { BONE_PROPS, axisGroupOf } from './model';
import type { Animation, Id, IkKey, Key, Project, Timeline } from './model';
import { applyAnimation, applyPhysicsResets } from './animate';
import { compileSkeleton, createSkeleton } from './skeleton';
import type { Bone, Skeleton, SkeletonData } from './skeleton';

type SkeletonDoc = Project['skeleton'];

/** How far (in the unit of each channel) a simplified curve may stray from the original. */
export interface Tolerance {
  /** degrees */
  rotate: number;
  /** world units */
  translate: number;
  /** ratio of the setup scale */
  scale: number;
  /** degrees */
  shear: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { rotate: 0.25, translate: 0.25, scale: 0.005, shear: 0.25 };

export const scaleTolerance = (t: Tolerance, k: number): Tolerance => ({
  rotate: t.rotate * k,
  translate: t.translate * k,
  scale: t.scale * k,
  shear: t.shear * k,
});

type Channel = keyof Tolerance;
const CHANNELS: Channel[] = ['rotate', 'translate', 'scale', 'shear'];

const scratch: number[] = [0, 0, 0, 0, 0, 0, 0];

/**
 * The keys of a timeline that are needed to stay within `tolerance` of it (measured on every frame and at every original key).
 * The first and the last key always stay. The rest go one at a time, the cheapest first, so the error of a removal is always measured
 * against the ORIGINAL curve and never accumulates unseen.
 */
export function simplifyKeys(keys: Timeline, tolerance: number, fps: number): Timeline {
  if (keys.length < 3 || !(tolerance > 0)) return keys;
  const n = keys[0].value.length;
  const first = keys[0].time;
  const last = keys[keys.length - 1].time;
  const step = 1 / Math.max(1, fps);

  // sample times: the frame grid plus every key time, and the original value at each
  const times: number[] = [];
  for (let t = first; t < last - 1e-9; t += step) times.push(t);
  for (const k of keys) times.push(k.time);
  times.push(last);
  times.sort((a, b) => a - b);
  const ts = times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-9);
  const orig = ts.map((t) => {
    sampleKeys(keys, t, scratch);
    return scratch.slice(0, n);
  });
  const at = keys.map((k) => ts.findIndex((t) => Math.abs(t - k.time) <= 1e-9));

  const prev = keys.map((_, i) => i - 1);
  const next = keys.map((_, i) => i + 1);
  const alive = keys.map(() => true);
  const pair: Key[] = [keys[0], keys[1]];
  const errorOf = (i: number): number => {
    const p = prev[i];
    const q = next[i];
    pair[0] = keys[p];
    pair[1] = keys[q];
    let worst = 0;
    for (let s = at[p] + 1; s < at[q]; s++) {
      sampleKeys(pair, ts[s], scratch);
      for (let c = 0; c < n; c++) worst = Math.max(worst, Math.abs(scratch[c] - orig[s][c]));
    }
    return worst;
  };
  const err: number[] = keys.map((_, i) => (i === 0 || i === keys.length - 1 ? Infinity : errorOf(i)));

  for (;;) {
    let best = -1;
    for (let i = 1; i < keys.length - 1; i++) if (alive[i] && err[i] <= tolerance && (best < 0 || err[i] < err[best])) best = i;
    if (best < 0) break;
    alive[best] = false;
    const p = prev[best];
    const q = next[best];
    next[p] = q;
    prev[q] = p;
    if (p > 0) err[p] = errorOf(p);
    if (q < keys.length - 1) err[q] = errorOf(q);
  }
  return keys.filter((_, i) => alive[i]).map((k) => ({ ...k, value: k.value.slice() }));
}

/** Simplifies the bone timelines of an animation in place (all bones, or just `boneIds`). Returns how many keys went. */
export function simplifyAnimation(anim: Animation, tolerance: Tolerance, fps: number, boneIds?: Iterable<Id>): number {
  const only = boneIds ? new Set(boneIds) : null;
  let removed = 0;
  for (const id in anim.bones) {
    if (only && !only.has(id)) continue;
    const tl = anim.bones[id];
    for (const ch of BONE_PROPS) {
      const keys = tl[ch];
      if (!keys || keys.length < 3) continue;
      const out = simplifyKeys(keys, tolerance[axisGroupOf(ch) ?? 'rotate'], fps);
      removed += keys.length - out.length;
      tl[ch] = out;
    }
  }
  return removed;
}

/** How many keys `simplifyAnimation` would remove, without changing the animation. */
export function countSimplifiable(anim: Animation, tolerance: Tolerance, fps: number, boneIds?: Iterable<Id>): number {
  return simplifyAnimation(structuredClone(anim), tolerance, fps, boneIds);
}

export interface BakeOptions {
  /** `constrained`: the bones a constraint moves; `all`: every bone; or an explicit list. */
  bones: 'constrained' | 'all' | Id[];
  /** Key every N-th frame (1 = every frame). The physics simulation still runs every frame. */
  step: number;
  /** Turn the constraints off in the result (their mix goes to 0), so the baked keys are not applied twice. */
  mute: boolean;
  /** Simplify the baked keys with this tolerance afterwards (null: keep a key on every step). */
  simplify: Tolerance | null;
  skinId: Id | null;
}

export const DEFAULT_BAKE: BakeOptions = { bones: 'constrained', step: 1, mute: true, simplify: DEFAULT_TOLERANCE, skinId: null };

/** The bones a constraint moves: IK chains, transform and path targets, physics bones and what a slider animates. */
export function constrainedBoneIndices(data: SkeletonData): number[] {
  const out = new Set<number>();
  for (const c of data.constraints) {
    if (c.kind === 'physics') out.add(c.bone);
    else if (c.kind === 'slider') for (const b of c.animatedBones) out.add(b);
    else for (const b of c.bones) out.add(b);
  }
  return [...out].sort((a, b) => a - b);
}

/** True when the skeleton has anything to bake. */
/**
 * The path constraints whose bones a bake cannot carry over: a path constraint does nothing while its slot shows no path (no attachment, or
 * something that is not a path), and a bone it moved before stays in the world pose of the last frame that solved. That is the same in the
 * official runtime, and a local pose cannot say it. The names, one per constraint.
 */
export function bakeSkips(doc: SkeletonDoc, anim: Animation): string[] {
  const isPath = (slotId: string, name: string | null | undefined) =>
    name != null && doc.skins[0]?.attachments[slotId]?.[name]?.type === 'path';
  const out: string[] = [];
  for (const c of doc.constraints) {
    if (c.type !== 'path') continue;
    const slot = doc.slots.find((x) => x.id === c.target);
    const keys = anim.slots[c.target]?.attachment ?? [];
    if (!isPath(c.target, slot?.attachment) || keys.some((k) => !isPath(c.target, k.name))) out.push(c.name);
  }
  return out;
}

const norm360 = (v: number) => ((v % 360) + 360) % 360;

/** `v` shifted by whole turns so that it is the closest equivalent of `near`. */
function nearTo(v: number, near: number): number {
  return near + (norm360(v - near + 180) - 180);
}

/** The frame times of an animation: every frame, ending exactly at the duration. */
export function frameTimes(duration: number, fps: number): number[] {
  const frames = Math.max(1, Math.round(duration * fps));
  const out: number[] = [];
  for (let i = 0; i < frames; i++) out.push(Math.min(duration, i / fps));
  out.push(duration);
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-9);
}

/**
 * Poses `skeleton` for every time of `times` the way the viewport and the renderer do: from the setup pose, with the physics
 * simulation carried from one frame to the next (the first frame resets it). `each` runs after every solve.
 */
function walkFrames(skeleton: Skeleton, anim: Animation, times: number[], each: (time: number, frame: number) => void) {
  const hasPhysics = skeleton.data.constraints.some((c) => c.kind === 'physics');
  let last = -1;
  times.forEach((t, frame) => {
    applyAnimation(skeleton, anim, t);
    if (!hasPhysics) skeleton.updateWorldTransform('none');
    else if (frame === 0) {
      applyPhysicsResets(skeleton, anim, last, t);
      skeleton.updateWorldTransform('reset');
    } else {
      applyPhysicsResets(skeleton, anim, last, t);
      skeleton.update(t - last);
      skeleton.updateWorldTransform('update');
    }
    last = t;
    each(t, frame);
  });
}

/** The world matrices [a, b, c, d, worldX, worldY] of every bone on every frame (see `walkFrames`). */
export function poseFrames(doc: SkeletonDoc, anim: Animation, skinId: Id | null = null): number[][][] {
  const data = compileSkeleton(structuredClone(doc));
  const skeleton = createSkeleton(data, skinId);
  const out: number[][][] = [];
  walkFrames(skeleton, anim, frameTimes(anim.duration, doc.fps), () =>
    out.push(skeleton.bones.map((b) => [b.a, b.b, b.c, b.d, b.worldX, b.worldY])),
  );
  return out;
}

/**
 * A copy of `anim` in which the chosen bones carry the pose the constraints give them as ordinary keys. The bones are read after the
 * whole solve (IK, transform, path, physics, sliders), frame by frame, so what is baked is exactly what the viewport shows.
 */
export function bakeAnimation(doc: SkeletonDoc, anim: Animation, options: Partial<BakeOptions> = {}): Animation {
  const opts = { ...DEFAULT_BAKE, ...options };
  const fps = doc.fps;
  const data = compileSkeleton(structuredClone(doc));
  const skeleton = createSkeleton(data, opts.skinId);

  let targets: number[];
  if (opts.bones === 'constrained') targets = constrainedBoneIndices(data);
  else if (opts.bones === 'all') targets = data.bones.map((_, i) => i);
  else targets = opts.bones.map((id) => data.boneIndex.get(id)).filter((i): i is number => i !== undefined);
  targets = targets.filter((i) => skeleton.bones[i].active);

  const times = frameTimes(anim.duration, fps);
  const step = Math.max(1, Math.round(opts.step));
  type Sample = { time: number; rotate: number; translate: [number, number]; scale: [number, number]; shear: [number, number] };
  const samples = new Map<number, Sample[]>(targets.map((i) => [i, []]));
  const lastRotation = new Map<number, number>();

  walkFrames(skeleton, anim, times, (t, frame) => {
    if (frame % step !== 0 && frame !== times.length - 1) return;
    for (const i of targets) {
      const bone: Bone = skeleton.bones[i];
      bone.validateApplied();
      const d = bone.data;
      const before = lastRotation.get(i);
      let rotate = bone.arotation - d.rotation;
      rotate = before === undefined ? norm360(rotate + 180) - 180 : nearTo(rotate, before);
      lastRotation.set(i, rotate);
      samples.get(i)!.push({
        time: t,
        rotate,
        translate: [bone.ax - d.x, bone.ay - d.y],
        scale: [d.scaleX === 0 ? 1 : bone.ascaleX / d.scaleX, d.scaleY === 0 ? 1 : bone.ascaleY / d.scaleY],
        shear: [bone.ashearX - d.shearX, bone.ashearY - d.shearY],
      });
    }
  });

  const out: Animation = { ...structuredClone(anim), id: uid() };
  const FLAT = { rotate: 0, translate: 0, scale: 1, shear: 0 } as const;
  for (const i of targets) {
    const id = data.bones[i].id;
    const list = samples.get(i)!;
    const tl: Record<Channel, Timeline> = {
      rotate: list.map((s) => ({ time: s.time, value: [s.rotate] })),
      translate: list.map((s) => ({ time: s.time, value: [...s.translate] })),
      scale: list.map((s) => ({ time: s.time, value: [...s.scale] })),
      shear: list.map((s) => ({ time: s.time, value: [...s.shear] })),
    };
    const written: Record<string, Timeline> = {};
    for (const ch of CHANNELS) {
      let keys = tl[ch];
      if (opts.simplify) keys = simplifyKeys(keys, opts.simplify[ch], fps);
      // a channel that never leaves the setup pose needs no keys
      if (keys.every((k) => k.value.every((v) => Math.abs(v - FLAT[ch]) < 1e-6))) continue;
      written[ch] = keys;
    }
    if (Object.keys(written).length) out.bones[id] = written;
    else delete out.bones[id];
  }

  if (opts.mute) muteConstraints(out, data);
  return out;
}

/** Keys that switch every constraint off (mix 0) from the first moment. */
function muteConstraints(anim: Animation, data: SkeletonData) {
  const off = (value: number[]): Timeline => [{ time: 0, value }];
  let physics = false;
  for (const c of data.constraints) {
    if (c.kind === 'ik') {
      const key: IkKey = { time: 0, value: [0, c.softness], bendPositive: c.bendDirection === 1, compress: c.compress, stretch: c.stretch };
      anim.ik[c.id] = [key];
    } else if (c.kind === 'transform') anim.transform[c.id] = off([0, 0, 0, 0, 0, 0]);
    else if (c.kind === 'path') anim.path[c.id] = { ...(anim.path[c.id] ?? {}), mix: off([0, 0, 0]) };
    else if (c.kind === 'slider') anim.slider[c.id] = { ...(anim.slider[c.id] ?? {}), mix: off([0]) };
    else {
      physics = true;
      anim.physics[c.id] = { ...(anim.physics[c.id] ?? {}), mix: off([0]) };
    }
  }
  // the global timeline drives every constraint that follows it, so it has to say the same
  if (physics && anim.physics['*']) anim.physics['*'] = { ...anim.physics['*'], mix: off([0]) };
}
