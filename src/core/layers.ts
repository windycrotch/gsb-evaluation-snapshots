/**
 * An animation layer put on top of another one (breathing over a walk), baked into a new animation.
 *
 * Spine plays layers at runtime (a second track with `MixBlend.add`); an export holds one animation per file entry, so the editor does the sum
 * once: every bone the layer moves gets keys that carry `base + weight * layer` on the frame grid. The sum is the one the official runtime
 * gives for an additive track: rotation, translation and shear are added, a scale is added as a multiplier (`1 + (layer - 1) * weight` on top
 * of the base). The layer repeats (its own length) or holds its last pose. Only bones are layered: slots, events, deform and the constraint
 * timelines stay those of the base animation.
 */
import { simplifyKeys, frameTimes, scaleTolerance, DEFAULT_TOLERANCE } from './bake';
import type { Tolerance } from './bake';
import { sampleKeys } from './curve';
import { uid } from './ids';
import type { Animation, BoneTimelines, Id, Key, Timeline } from './model';

export interface LayerOptions {
  /** How much of the layer is added: 1 = all of it. */
  weight: number;
  /** The layer starts again when it ends (breathing); otherwise it holds its last pose. */
  loop: boolean;
  /** Key every N-th frame (1 = every frame). */
  step: number;
  /** Simplify the keys afterwards (null: keep a key on every step). */
  simplify: Tolerance | null;
}

export const DEFAULT_LAYER: LayerOptions = { weight: 1, loop: true, step: 1, simplify: scaleTolerance(DEFAULT_TOLERANCE, 1) };
const MAX_LAYER_WEIGHT = 2;

/** What a bone's timelines ask for at one moment, relative to the setup pose (a scale is a multiplier). The split axes win over the combined ones. */
interface Local {
  rotate: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

const tmp: number[] = [0, 0, 0, 0, 0, 0, 0];
const has = (t: Timeline | undefined): t is Timeline => !!t && t.length > 0;

function localAt(tl: BoneTimelines | undefined, time: number): Local {
  const o: Local = { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  if (!tl) return o;
  if (has(tl.rotate) && sampleKeys(tl.rotate, time, tmp)) o.rotate = tmp[0];
  if (has(tl.translate) && sampleKeys(tl.translate, time, tmp)) [o.x, o.y] = [tmp[0], tmp[1]];
  if (has(tl.scale) && sampleKeys(tl.scale, time, tmp)) [o.scaleX, o.scaleY] = [tmp[0], tmp[1]];
  if (has(tl.shear) && sampleKeys(tl.shear, time, tmp)) [o.shearX, o.shearY] = [tmp[0], tmp[1]];
  if (has(tl.translatex) && sampleKeys(tl.translatex, time, tmp)) o.x = tmp[0];
  if (has(tl.translatey) && sampleKeys(tl.translatey, time, tmp)) o.y = tmp[0];
  if (has(tl.scalex) && sampleKeys(tl.scalex, time, tmp)) o.scaleX = tmp[0];
  if (has(tl.scaley) && sampleKeys(tl.scaley, time, tmp)) o.scaleY = tmp[0];
  if (has(tl.shearx) && sampleKeys(tl.shearx, time, tmp)) o.shearX = tmp[0];
  if (has(tl.sheary) && sampleKeys(tl.sheary, time, tmp)) o.shearY = tmp[0];
  return o;
}

/** The time of the layer for a time of the base animation. */
export const layerTime = (layer: Animation, time: number, loop: boolean): number =>
  loop && layer.duration > 0 ? time % layer.duration : time;

/** The pose the layered animation gives a bone at `time`: the base plus the weighted layer. Exposed for tests. */
export function layeredLocal(
  base: BoneTimelines | undefined,
  layer: BoneTimelines | undefined,
  time: number,
  layerAt: number,
  weight: number,
): Local {
  const b = localAt(base, time);
  const l = localAt(layer, layerAt);
  return {
    rotate: b.rotate + l.rotate * weight,
    x: b.x + l.x * weight,
    y: b.y + l.y * weight,
    scaleX: b.scaleX + (l.scaleX - 1) * weight,
    scaleY: b.scaleY + (l.scaleY - 1) * weight,
    shearX: b.shearX + l.shearX * weight,
    shearY: b.shearY + l.shearY * weight,
  };
}

/** The bones a layer moves (timelines with keys) that exist in the skeleton. */
export function layerBones(layer: Animation, boneIds: ReadonlySet<Id>): Id[] {
  return Object.keys(layer.bones).filter(
    (id) => boneIds.has(id) && Object.values(layer.bones[id] as Record<string, Timeline | undefined>).some((t) => has(t)),
  );
}

const FLAT = { rotate: 0, translate: 0, scale: 1, shear: 0 } as const;

/**
 * A copy of `base` in which every bone of `layer` carries `base + weight * layer`. The copy is as long as the base. `fps` is the frame rate
 * of the skeleton.
 */
export function stackLayer(
  base: Animation,
  layer: Animation,
  boneIds: ReadonlySet<Id>,
  fps: number,
  options: Partial<LayerOptions> = {},
): Animation {
  const opts = { ...DEFAULT_LAYER, ...options };
  const weight = Math.max(0, Math.min(MAX_LAYER_WEIGHT, Number.isFinite(opts.weight) ? opts.weight : 1));
  const step = Math.max(1, Math.round(opts.step));
  const all = frameTimes(base.duration, fps);
  const times = all.filter((_, i) => i % step === 0 || i === all.length - 1);

  const out: Animation = { ...structuredClone(base), id: uid(), name: `${base.name} + ${layer.name}` };
  for (const id of layerBones(layer, boneIds)) {
    const tl = (key: (l: Local) => number[]): Timeline =>
      times.map((t): Key => ({
        time: t,
        value: key(layeredLocal(base.bones[id], layer.bones[id], t, layerTime(layer, t, opts.loop), weight)),
      }));
    const channels: Record<'rotate' | 'translate' | 'scale' | 'shear', Timeline> = {
      rotate: tl((l) => [l.rotate]),
      translate: tl((l) => [l.x, l.y]),
      scale: tl((l) => [l.scaleX, l.scaleY]),
      shear: tl((l) => [l.shearX, l.shearY]),
    };
    const written: BoneTimelines = {};
    for (const ch of Object.keys(channels) as (keyof typeof channels)[]) {
      const keys = opts.simplify ? simplifyKeys(channels[ch], opts.simplify[ch], fps) : channels[ch];
      if (keys.every((k) => k.value.every((v) => Math.abs(v - FLAT[ch]) < 1e-6))) continue;
      written[ch] = keys;
    }
    if (Object.keys(written).length) out.bones[id] = written;
    else delete out.bones[id];
  }
  return out;
}
