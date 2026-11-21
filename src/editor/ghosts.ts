/**
 * Onion skin (Spine calls it ghosting): the poses of the frames before and after the playhead, drawn faded under the current one,
 * so the motion can be judged without playing it.
 */
import { keyLists, keyListsIn } from '@/core/keylists';
import { applyAnimation } from '@/core/animate';
import type { Animation, SkeletonDoc } from '@/core/model';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { Skeleton, SkeletonData } from '@/core/skeleton';
import type { Scene } from '@/store/scene';

type OnionStyle = 'image' | 'silhouette' | 'xray';
type OnionMode = 'frames' | 'keys';

export interface OnionConfig {
  before: number;
  after: number;
  /** Frames between two ghosts. */
  gap: number;
  /** 'frames': a ghost every `gap` frames; 'keys': a ghost at each key before and after the playhead. */
  mode?: OnionMode;
  /** How far each ghost is moved from the pose, per step away from the playhead (scene units). Before the playhead it goes the other way. */
  offsetX?: number;
  offsetY?: number;
  /** 'image': the pictures faded and tinted; 'silhouette': flat colour; 'xray': a flat colour drawn over the pose, so the pose shows through. */
  style?: OnionStyle;
  /** Draw the ghosts over the pose instead of under it (always so for 'xray'). */
  top?: boolean;
  colorBefore?: [number, number, number];
  colorAfter?: [number, number, number];
}

/** The distinct times at which an animation has a key (of the given bones and their slots only, when `bones` is given), sorted. */
export function keyTimes(anim: Animation, only?: { bones: readonly string[]; slots?: readonly string[] } | null): number[] {
  const scope =
    only && (only.bones.length || only.slots?.length)
      ? [...only.bones.map((id) => anim.bones[id]), ...(only.slots ?? []).map((id) => anim.slots[id])]
      : keyLists(anim);
  const times = new Set<number>();
  for (const list of keyListsIn(scope)) for (const k of list) times.add(k.time);
  return [...times].sort((a, b) => a - b);
}

/** Ghosts at the keys around `time`: the nearest `before` keys before it and `after` keys after it (a time on the playhead is not a ghost). */
export function keyGhostTimes(time: number, keys: readonly number[], cfg: OnionConfig): GhostTime[] {
  const out: GhostTime[] = [];
  const before = keys.filter((t) => t < time - 1e-6).reverse();
  const after = keys.filter((t) => t > time + 1e-6);
  before.slice(0, cfg.before).forEach((t, i) => out.push({ time: t, side: 'before', index: i + 1 }));
  after.slice(0, cfg.after).forEach((t, i) => out.push({ time: t, side: 'after', index: i + 1 }));
  return out;
}

export interface GhostTime {
  time: number;
  side: 'before' | 'after';
  /** 1 = the ghost next to the current frame, 2 = the next one, ... */
  index: number;
}

/** The times of the ghosts around `time`. A ghost that would fall outside the animation wraps around when it loops, and is left out otherwise. */
export function ghostTimes(time: number, duration: number, fps: number, cfg: OnionConfig, loop: boolean): GhostTime[] {
  const out: GhostTime[] = [];
  const step = Math.max(1, cfg.gap) / Math.max(1, fps);
  const place = (t: number): number | null => {
    if (duration <= 0) return null;
    if (t >= -1e-9 && t <= duration + 1e-9) return Math.min(duration, Math.max(0, t));
    if (!loop) return null;
    return ((t % duration) + duration) % duration;
  };
  for (let i = 1; i <= cfg.before; i++) {
    const t = place(time - i * step);
    if (t !== null && Math.abs(t - time) > 1e-6) out.push({ time: t, side: 'before', index: i });
  }
  for (let i = 1; i <= cfg.after; i++) {
    const t = place(time + i * step);
    if (t !== null && Math.abs(t - time) > 1e-6) out.push({ time: t, side: 'after', index: i });
  }
  return out;
}

export interface Ghost {
  skeleton: Skeleton;
  alpha: number;
  tint: [number, number, number, number];
  /** Where the ghost is moved to (scene units). */
  offset?: [number, number];
  /** Only the shape, filled with the tint. */
  flat?: boolean;
  /** Drawn over the pose, not under it. */
  top?: boolean;
  /** Which side of the playhead the ghost is on and how far from it (1 = the nearest); onion ghosts only. */
  side?: 'before' | 'after';
  index?: number;
}

const TINT_BEFORE: Ghost['tint'] = [1, 0.62, 0.55, 1];
const TINT_AFTER: Ghost['tint'] = [0.55, 0.82, 1, 1];

let pool: { data: Scene['data']; skinId: string | null; skeletons: Skeleton[] } | null = null;

/** Skeletons posed at the ghost times (kept between frames, they are only re-posed). */
export function ghostsFor(
  scene: Scene,
  anim: Animation,
  time: number,
  fps: number,
  cfg: OnionConfig,
  loop: boolean,
  skinId: string | null,
  only?: { bones: readonly string[]; slots?: readonly string[] } | null,
): Ghost[] {
  const times = cfg.mode === 'keys' ? keyGhostTimes(time, keyTimes(anim, only), cfg) : ghostTimes(time, anim.duration, fps, cfg, loop);
  const style = cfg.style ?? 'image';
  const flat = style !== 'image';
  const top = style === 'xray' || !!cfg.top;
  if (!pool || pool.data !== scene.data || pool.skinId !== skinId) pool = { data: scene.data, skinId, skeletons: [] };
  const physics = scene.data.constraints.some((c) => c.kind === 'physics') ? 'reset' : 'none';
  return times.map((g, i) => {
    const skeleton = (pool!.skeletons[i] ??= createSkeleton(scene.data, skinId));
    applyAnimation(skeleton, anim, g.time);
    skeleton.updateWorldTransform(physics);
    const reach = g.side === 'before' ? cfg.before : cfg.after;
    const rgb = (g.side === 'before' ? cfg.colorBefore : cfg.colorAfter) ?? (g.side === 'before' ? TINT_BEFORE : TINT_AFTER).slice(0, 3);
    const sign = g.side === 'before' ? -1 : 1;
    const offset: [number, number] | undefined =
      cfg.offsetX || cfg.offsetY ? [sign * g.index * (cfg.offsetX ?? 0), sign * g.index * (cfg.offsetY ?? 0)] : undefined;
    // the nearest ghost is the strongest
    return {
      skeleton,
      alpha: 0.42 * (1 - (g.index - 1) / Math.max(1, reach + 0.5)),
      tint: [rgb[0], rgb[1], rgb[2], 1],
      offset,
      flat,
      top,
      side: g.side,
      index: g.index,
    };
  });
}

export interface MotionArrow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 'before': the way into the pose (ends at the pose or earlier); 'after': the way on from it. */
  side: 'before' | 'after';
}

/**
 * The motion of bones through the ghosts: for each bone the points where its tip is in the before-ghosts (farthest first), the pose and the
 * after-ghosts, joined by arrows that point the way time goes. A step shorter than `min` scene units is left out (the bone does not move there).
 */
export function motionArrows(pose: Skeleton, ghosts: readonly Ghost[], bones: readonly string[], min = 0.5): MotionArrow[] {
  const out: MotionArrow[] = [];
  const before = ghosts.filter((g) => g.side === 'before').sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  const after = ghosts.filter((g) => g.side === 'after').sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const id of bones) {
    const points: { x: number; y: number; side: 'before' | 'after' }[] = [];
    const at = (sk: Skeleton, offset: [number, number] | undefined, side: 'before' | 'after') => {
      const b = sk.boneById(id);
      if (b) points.push({ x: b.tipX + (offset?.[0] ?? 0), y: b.tipY + (offset?.[1] ?? 0), side });
    };
    for (const g of before) at(g.skeleton, g.offset, 'before');
    at(pose, undefined, 'before');
    for (const g of after) at(g.skeleton, g.offset, 'after');
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]];
      if (Math.hypot(b.x - a.x, b.y - a.y) < min) continue;
      out.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, side: b.side });
    }
  }
  return out;
}

const TINT_REFERENCE: Ghost['tint'] = [0.62, 1, 0.66, 1];

/**
 * The moment of the reference animation that goes with the playhead: the same time, wrapped round a loop when the reference is shorter,
 * held at its last frame otherwise. An animation with no length shows its first frame.
 */
export function referenceTime(time: number, duration: number, loop: boolean): number {
  if (!(duration > 0)) return 0;
  if (time <= duration) return Math.max(0, time);
  return loop ? ((time % duration) + duration) % duration : duration;
}

let refPool: { data: Scene['data']; skinId: string | null; skeleton: Skeleton } | null = null;

/** The skeleton posed as the reference animation is at the moment that goes with the playhead (`anim` null: the setup pose), faded and tinted green. */
export function referenceGhost(scene: Scene, anim: Animation | null, time: number, loop: boolean, skinId: string | null): Ghost {
  if (!refPool || refPool.data !== scene.data || refPool.skinId !== skinId)
    refPool = { data: scene.data, skinId, skeleton: createSkeleton(scene.data, skinId) };
  const skeleton = refPool.skeleton;
  skeleton.setToSetupPose();
  if (anim) applyAnimation(skeleton, anim, referenceTime(time, anim.duration, loop));
  skeleton.updateWorldTransform(scene.data.constraints.some((c) => c.kind === 'physics') ? 'reset' : 'none');
  return { skeleton, alpha: 0.45, tint: TINT_REFERENCE };
}

const TINT_CHECKPOINT: Ghost['tint'] = [0.74, 0.64, 1, 1];

let cpPool: { doc: SkeletonDoc; skinId: string | null; data: SkeletonData; skeleton: Skeleton } | null = null;

/**
 * The checkpoint's skeleton posed like the one being edited: the animation with the same id at the same time (the setup pose when the animation
 * is not in the checkpoint, or in Setup mode), faded and tinted violet. Null when the checkpoint cannot be posed.
 */
export function checkpointGhost(
  doc: SkeletonDoc,
  animationId: string | null,
  time: number,
  loop: boolean,
  skinId: string | null,
): Ghost | null {
  const skin = skinId && doc.skins.some((s) => s.id === skinId) ? skinId : null;
  if (!cpPool || cpPool.doc !== doc || cpPool.skinId !== skin) {
    const data = compileSkeleton(doc);
    cpPool = { doc, skinId: skin, data, skeleton: createSkeleton(data, skin) };
  }
  const { skeleton, data } = cpPool;
  skeleton.setToSetupPose();
  const anim = animationId ? doc.animations.find((a) => a.id === animationId) : undefined;
  if (anim) applyAnimation(skeleton, anim, referenceTime(time, anim.duration, loop));
  skeleton.updateWorldTransform(data.constraints.some((c) => c.kind === 'physics') ? 'reset' : 'none');
  return { skeleton, alpha: 0.5, tint: TINT_CHECKPOINT };
}
