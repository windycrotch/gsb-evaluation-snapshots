/** Shared, memoized "what the document looks like right now": the posed skeleton for the current mode/animation/time. */
import { applyAnimation, applyPhysicsResets } from '@/core/animate';
import { withoutMuted } from '@/core/mute';
import { steppedTime } from '@/core/playback';
import type { Animation, Id, SkeletonDoc } from '@/core/model';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { PhysicsMode, Skeleton, SkeletonData } from '@/core/skeleton';
import { docStore } from '@/store/doc';
import { uiStore } from '@/store/ui';
import type { Camera, PoseOverride } from '@/store/ui';

export interface Scene {
  doc: SkeletonDoc;
  data: SkeletonData;
  skeleton: Skeleton;
  animation: Animation | null;
}

let cache: {
  doc: SkeletonDoc;
  skinId: Id | null;
  skinMix: Id[];
  anim: Animation | null;
  time: number;
  overrides: Record<Id, PoseOverride>;
  muted: string[];
  scene: Scene;
} | null = null;

/** Forgets the posed skeleton, and with it the state of the physics simulation: the next frame starts from rest. */
export function restartScene() {
  cache = null;
}

/** Longest stretch of time one frame may advance the physics by; a longer gap (a stalled tab, a jump) restarts the simulation. */
const MAX_PHYSICS_STEP = 0.25;

export function getScene(): Scene {
  const project = docStore.get();
  const ui = uiStore.get();
  const doc = project.skeleton;
  const anim = ui.mode === 'animate' ? (doc.animations.find((a) => a.id === ui.animationId) ?? null) : null;
  const time = anim ? (ui.stepped ? steppedTime(ui.time, doc.fps) : ui.time) : 0;
  const overrides = ui.mode === 'animate' ? ui.overrides : EMPTY;
  const c = cache;
  if (
    c &&
    c.doc === doc &&
    c.skinId === ui.skinId &&
    c.skinMix === ui.skinMix &&
    c.anim === anim &&
    c.time === time &&
    c.overrides === overrides &&
    c.muted === ui.muted
  )
    return c.scene;

  const data = compileSkeleton(doc);
  const reuse = !!c && c.scene.data === data && c.skinId === ui.skinId && c.skinMix === ui.skinMix;
  const skeleton = reuse
    ? c.scene.skeleton
    : createSkeleton(data, ui.skinId && doc.skins.some((s) => s.id === ui.skinId) ? ui.skinId : null, ui.skinMix);
  poseSkeleton(skeleton, anim, time, overrides, ui.muted);
  // Physics only simulates while an animation plays: a step forward advances it, the same frame again keeps what it has
  // computed (pause, a bone dragged), any other time starts it again from rest. In Setup mode it does not run at all.
  let physics: PhysicsMode = 'none';
  if (anim && data.constraints.some((x) => x.kind === 'physics')) {
    physics = 'reset';
    let dt = 0;
    if (reuse && c.anim === anim) {
      if (time === c.time) physics = 'pose';
      else if (ui.playing) {
        let d = time - c.time;
        if (d < 0 && ui.loop) d += anim.duration;
        if (d > 0 && d <= MAX_PHYSICS_STEP) {
          physics = 'update';
          dt = d;
          if (time < c.time) {
            applyPhysicsResets(skeleton, anim, c.time, anim.duration);
            applyPhysicsResets(skeleton, anim, -1, time);
          } else applyPhysicsResets(skeleton, anim, c.time, time);
        }
      }
    }
    skeleton.update(dt);
  }
  skeleton.updateWorldTransform(physics);
  const scene: Scene = { doc, data, skeleton, animation: anim };
  cache = { doc, skinId: ui.skinId, skinMix: ui.skinMix, anim, time, overrides, muted: ui.muted, scene };
  return scene;
}

const EMPTY: Record<Id, PoseOverride> = {};

/** Puts a skeleton into the pose the editor shows: the animation at the time (without the muted timelines), then the bones being dragged. The world transform is not updated. */
export function poseSkeleton(
  skeleton: Skeleton,
  anim: Animation | null,
  time: number,
  overrides: Record<Id, PoseOverride>,
  muted: readonly string[],
) {
  applyAnimation(skeleton, anim && muted.length ? withoutMuted(anim, new Set(muted)) : anim, time);
  for (const id in overrides) {
    const b = skeleton.boneById(id);
    if (!b) continue;
    const o = overrides[id];
    if (o.x !== undefined) b.x = o.x;
    if (o.y !== undefined) b.y = o.y;
    if (o.rotation !== undefined) b.rotation = o.rotation;
    if (o.scaleX !== undefined) b.scaleX = o.scaleX;
    if (o.scaleY !== undefined) b.scaleY = o.scaleY;
    if (o.shearX !== undefined) b.shearX = o.shearX;
    if (o.shearY !== undefined) b.shearY = o.shearY;
  }
}

let probeCache: { data: SkeletonData; skinId: Id | null; skinMix: Id[]; skeleton: Skeleton } | null = null;
/**
 * A second skeleton in the pose of the scene, for looking at without touching the one on screen (the constraint numbers of a bone run the update
 * again with a look between the steps, and a second update of the shown skeleton could move a physics or path bone). Physics starts from rest here.
 */
export function getProbeSkeleton(): Skeleton {
  const scene = getScene();
  const ui = uiStore.get();
  const skinId = ui.skinId && scene.doc.skins.some((s) => s.id === ui.skinId) ? ui.skinId : null;
  if (!probeCache || probeCache.data !== scene.data || probeCache.skinId !== skinId || probeCache.skinMix !== ui.skinMix) {
    probeCache = { data: scene.data, skinId, skinMix: ui.skinMix, skeleton: createSkeleton(scene.data, skinId, ui.skinMix) };
  }
  const skeleton = probeCache.skeleton;
  const animate = ui.mode === 'animate';
  poseSkeleton(skeleton, scene.animation, animate ? ui.time : 0, animate ? ui.overrides : EMPTY, ui.muted);
  return skeleton;
}

let setupCache: { doc: SkeletonDoc; skeleton: Skeleton } | null = null;
/** The skeleton in its pure setup pose (no animation, no overrides). */
export function getSetupSkeleton(doc: SkeletonDoc = docStore.get().skeleton): Skeleton {
  if (setupCache && setupCache.doc === doc) return setupCache.skeleton;
  const skeleton = createSkeleton(compileSkeleton(doc));
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform();
  setupCache = { doc, skeleton };
  return skeleton;
}

/** -1 for a flipped viewport (mirrored left to right), else 1. */
export const flipSign = <T extends object>(cam: T & { flip?: boolean }): 1 | -1 => (cam.flip ? -1 : 1);

export function worldToScreen(cam: Camera, w: number, h: number, wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.zoom * flipSign(cam) + w / 2, h / 2 - (wy - cam.y) * cam.zoom];
}

export function screenToWorld(cam: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [((sx - w / 2) / cam.zoom) * flipSign(cam) + cam.x, (h / 2 - sy) / cam.zoom + cam.y];
}
