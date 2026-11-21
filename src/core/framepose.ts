/**
 * Posing an animation frame by frame, as the exporters of pictures do it: the same solver and the same physics stepping as the viewport, forward in
 * time (physics keeps its state from the frame before). Warm up runs the animation for a while before the first frame, as if it had been looping,
 * so the physics bones have settled when the recording starts (Spine's Warm Up).
 */
import { applyAnimation, applyPhysicsResets } from './animate';
import type { Animation } from './model';
import type { Skeleton } from './skeleton';

export interface FramePoser {
  /** Poses the skeleton at frame `i` (any order: a frame that is not the next one starts again from the beginning). */
  pose: (i: number) => void;
  /** How many frames of warm up run before frame 0. */
  readonly warmFrames: number;
}

/** The frames a warm up of `seconds` makes at `fps`: none without physics, never more than 20 seconds' worth. */
export function warmUpFrames(seconds: number, fps: number, hasPhysics: boolean): number {
  if (!hasPhysics || !(seconds > 0) || !(fps > 0)) return 0;
  return Math.min(Math.round(20 * fps), Math.round(seconds * fps));
}

export function makePoser(skeleton: Skeleton, anim: Animation, fps: number, hasPhysics: boolean, warmSeconds = 0): FramePoser {
  const warmFrames = warmUpFrames(warmSeconds, fps, hasPhysics);
  const dt = 1 / fps;
  const wrap = (t: number) => (anim.duration > 0 ? ((t % anim.duration) + anim.duration) % anim.duration : 0);
  /** One step of the physics from `prev` to `t` (a step that goes round the loop point applies the resets on both sides of it). */
  const step = (prev: number, t: number) => {
    if (t < prev) {
      applyPhysicsResets(skeleton, anim, prev, anim.duration);
      applyPhysicsResets(skeleton, anim, -1, t);
    } else applyPhysicsResets(skeleton, anim, prev, t);
    skeleton.update(dt);
    skeleton.updateWorldTransform('update');
  };
  let at = -1;
  const pose = (i: number) => {
    if (i !== at + 1) {
      // asked out of order: start again from the first frame (cheap, and the only way physics gives the same picture)
      at = -1;
      if (i > 0) for (let k = 0; k < i; k++) pose(k);
    }
    const t = i / fps;
    applyAnimation(skeleton, anim, t);
    if (!hasPhysics) skeleton.updateWorldTransform('none');
    else if (i > 0) {
      applyPhysicsResets(skeleton, anim, (i - 1) / fps, t);
      skeleton.update(dt);
      skeleton.updateWorldTransform('update');
    } else if (!warmFrames) skeleton.updateWorldTransform('reset');
    else {
      // the animation as it would be just before its first frame, round the loop, then the first frame itself
      for (let k = 0; k < warmFrames; k++) {
        const w = wrap((k - warmFrames) / fps);
        applyAnimation(skeleton, anim, w);
        if (k === 0) skeleton.updateWorldTransform('reset');
        else step(wrap((k - 1 - warmFrames) / fps), w);
      }
      applyAnimation(skeleton, anim, 0);
      step(wrap(-1 / fps), 0);
    }
    at = i;
  };
  return { pose, warmFrames };
}
