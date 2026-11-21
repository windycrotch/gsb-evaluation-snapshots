/**
 * Motion trails: the path a point of a bone travels while an animation plays, sampled frame by frame. Spine has nothing like it;
 * it shows at a glance whether a swing is smooth, an arc is an arc and a foot lifts straight.
 */
import { applyAnimation } from './animate';
import type { Animation, Id } from './model';
import { createSkeleton } from './skeleton';
import type { SkeletonData } from './skeleton';

interface TrailPoint {
  time: number;
  x: number;
  y: number;
}

export interface Trail {
  boneId: Id;
  points: TrailPoint[];
}

/** Which point of the bone is followed. */
export type TrailAnchor = 'origin' | 'tip';

/** The sample times: every frame from 0 to the duration (a coarser step when that would be more than `maxSamples`). */
export function trailTimes(duration: number, fps: number, maxSamples = 240): number[] {
  if (!(duration > 0) || !(fps > 0)) return [0];
  const frames = Math.max(1, Math.round(duration * fps));
  const stride = Math.max(1, Math.ceil(frames / maxSamples));
  const out: number[] = [];
  for (let f = 0; f < frames; f += stride) out.push(f / fps);
  out.push(duration);
  return out;
}

/** Poses the skeleton at every sample time and records where each of the bones is. A bone the skin leaves out has no trail. */
export function sampleTrails(
  data: SkeletonData,
  anim: Animation,
  boneIds: Id[],
  fps: number,
  skinId: Id | null,
  anchor: TrailAnchor = 'origin',
  maxSamples = 240,
): Trail[] {
  const skeleton = createSkeleton(data, skinId);
  const physics = data.constraints.some((c) => c.kind === 'physics') ? 'reset' : 'none';
  const times = trailTimes(anim.duration, fps, maxSamples);
  const picked = boneIds
    .map((id) => ({ id, index: data.boneIndex.get(id) }))
    .filter((b): b is { id: Id; index: number } => b.index !== undefined);
  const trails: Trail[] = picked.map((b) => ({ boneId: b.id, points: [] }));
  for (const time of times) {
    applyAnimation(skeleton, anim, time);
    skeleton.updateWorldTransform(physics);
    picked.forEach((b, i) => {
      const bone = skeleton.bones[b.index];
      if (!bone.active) return;
      const length = anchor === 'tip' ? bone.data.length : 0;
      trails[i].points.push({ time, x: bone.worldX + bone.a * length, y: bone.worldY + bone.c * length });
    });
  }
  return trails;
}

/** Total length of a trail (world units): how far the point travels. */
export function trailLength(trail: Trail): number {
  let sum = 0;
  for (let i = 1; i < trail.points.length; i++)
    sum += Math.hypot(trail.points[i].x - trail.points[i - 1].x, trail.points[i].y - trail.points[i - 1].y);
  return sum;
}

/**
 * Where the point is at `time`, between the samples (the trail is a polyline of them). Used to put the marker of the playhead on it.
 */
export function trailAt(trail: Trail, time: number): [number, number] | null {
  const p = trail.points;
  if (p.length === 0) return null;
  if (time <= p[0].time) return [p[0].x, p[0].y];
  for (let i = 1; i < p.length; i++) {
    if (time <= p[i].time) {
      const span = p[i].time - p[i - 1].time;
      const t = span > 1e-9 ? (time - p[i - 1].time) / span : 0;
      return [p[i - 1].x + (p[i].x - p[i - 1].x) * t, p[i - 1].y + (p[i].y - p[i - 1].y) * t];
    }
  }
  const last = p[p.length - 1];
  return [last.x, last.y];
}
