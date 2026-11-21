/**
 * The Preview window: plays animations the way a game would, one after another with a crossfade (Spine's mix duration) between them.
 * The mix table (a default time and times for pairs of animations) is editor data like the pose library: not part of the Spine export,
 * because Spine keeps it in the runtime code (`AnimationStateData.setMix`).
 * Pure functions and a small player here; the panel draws.
 */
import { applyAnimation, eventsBetween } from './animate';
import { findKeyIndex } from './curve';
import type { Animation, BoneTimelines, EventKey, Id, Project } from './model';
import type { Skeleton } from './skeleton';

export interface MixTable {
  /** Seconds the crossfade lasts for a pair that has no entry. */
  default: number;
  pairs: { from: Id; to: Id; time: number }[];
}

const MAX_MIX = 10;

/** The crossfade time from one animation to another. */
export function mixTime(m: MixTable | undefined, from: Id, to: Id): number {
  if (!m) return 0;
  const p = m.pairs.find((x) => x.from === from && x.to === to);
  return p ? p.time : m.default;
}

const clampTime = (t: unknown) => (typeof t === 'number' && isFinite(t) ? Math.max(0, Math.min(MAX_MIX, t)) : 0);

/** A mix table from anything (a loaded file): only known animations, one entry per pair, times in range; undefined when nothing is left. */
export function cleanMixes(raw: unknown, animIds: ReadonlySet<Id>): MixTable | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { default?: unknown; pairs?: unknown };
  const out: MixTable = { default: clampTime(r.default), pairs: [] };
  const seen = new Set<string>();
  if (Array.isArray(r.pairs)) {
    for (const p of r.pairs as { from?: unknown; to?: unknown; time?: unknown }[]) {
      if (!p || typeof p.from !== 'string' || typeof p.to !== 'string' || !animIds.has(p.from) || !animIds.has(p.to)) continue;
      const key = `${p.from}\u0000${p.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.pairs.push({ from: p.from, to: p.to, time: clampTime(p.time) });
    }
  }
  return out.default === 0 && !out.pairs.length ? undefined : out;
}

/** The table with the time of one pair set; a time equal to the default removes the entry. */
export function withMix(m: MixTable | undefined, from: Id, to: Id, time: number): MixTable {
  const base: MixTable = m
    ? { default: m.default, pairs: m.pairs.filter((p) => !(p.from === from && p.to === to)) }
    : { default: 0, pairs: [] };
  const t = clampTime(time);
  if (t !== base.default) base.pairs.push({ from, to, time: t });
  return base;
}

export function withDefaultMix(m: MixTable | undefined, time: number): MixTable {
  const t = clampTime(time);
  const base: MixTable = m ? { default: t, pairs: m.pairs.filter((p) => p.time !== t) } : { default: t, pairs: [] };
  return base;
}

/** The table without the entries of an animation (it was deleted). */
export function withoutAnimation(m: MixTable | undefined, id: Id): MixTable | undefined {
  if (!m) return m;
  const pairs = m.pairs.filter((p) => p.from !== id && p.to !== id);
  return pairs.length === m.pairs.length ? m : { default: m.default, pairs };
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Which of the seven values of a bone an animation keys (a split translate keys one axis). */
export function keyedChannels(tl: BoneTimelines | undefined) {
  const has = (k: keyof BoneTimelines) => !!tl?.[k]?.length;
  return {
    rotation: has('rotate'),
    x: has('translate') || has('translatex'),
    y: has('translate') || has('translatey'),
    scaleX: has('scale') || has('scalex'),
    scaleY: has('scale') || has('scaley'),
    shearX: has('shear') || has('shearx'),
    shearY: has('shear') || has('sheary'),
  };
}

/**
 * Poses the bones as `to` at `toTime` crossfaded with `from` at `fromTime` (alpha 0 = all `from`, 1 = all `to`); slots, deform and constraints
 * follow `to`. Rotation takes the short way round, as the Spine runtime does. Does not compute world transforms.
 * `hold` is Spine's Hold Previous: a value `to` does not key stays as `from` has it, instead of fading to the setup pose.
 */
export function poseMixed(
  sk: Skeleton,
  from: { anim: Animation | null; time: number } | null,
  to: { anim: Animation | null; time: number },
  alpha: number,
  hold = false,
) {
  if (!from || alpha >= 1) {
    applyAnimation(sk, to.anim, to.time);
    return;
  }
  applyAnimation(sk, from.anim, from.time);
  const was = sk.bones.map((b) => [b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY]);
  applyAnimation(sk, to.anim, to.time);
  const a = Math.max(0, alpha);
  sk.bones.forEach((b, i) => {
    const f = was[i];
    // a value the new animation does not key is held where the old one had it (Hold Previous), not faded to the setup pose
    const k = hold ? keyedChannels(to.anim?.bones[b.data.id]) : null;
    const mix = (key: keyof ReturnType<typeof keyedChannels>, from: number, now: number, turn = false) =>
      k && !k[key] ? from : from + (turn ? wrap180(now - from) : now - from) * a;
    b.x = mix('x', f[0], b.x);
    b.y = mix('y', f[1], b.y);
    b.rotation = mix('rotation', f[2], b.rotation, true);
    b.scaleX = mix('scaleX', f[3], b.scaleX);
    b.scaleY = mix('scaleY', f[4], b.scaleY);
    b.shearX = mix('shearX', f[5], b.shearX);
    b.shearY = mix('shearY', f[6], b.shearY);
  });
}

/** An animation played on top of the main one, with its own time (Spine's tracks above the first). */
export interface PreviewLayer {
  anim: Animation | null;
  time: number;
  /** 0..1: how much of the layer shows. */
  alpha: number;
  /** Adds the layer's change from the setup pose instead of blending toward its pose. */
  additive: boolean;
  loop: boolean;
}

/** The moment of a layer's animation: wrapped round when it loops, held on the last frame otherwise. */
export function layerTime(l: Pick<PreviewLayer, 'anim' | 'time' | 'loop'>): number {
  const d = l.anim?.duration ?? 0;
  if (!(d > 0)) return 0;
  return l.loop ? l.time % d : Math.min(l.time, d);
}

/**
 * Puts the layers over the pose `sk` already has (bones, attachments and slot colours; world transforms are not computed). A layer touches
 * only what its animation keys: a bone it does not key stays as the lower layers left it. `scratch` is a second skeleton of the same data,
 * used to sample each layer. Layers apply in order, the last one on top.
 */
export function poseLayers(sk: Skeleton, scratch: Skeleton, layers: readonly PreviewLayer[]) {
  for (const l of layers) {
    const anim = l.anim;
    const a = Math.min(1, l.alpha);
    if (!anim || !(a > 0)) continue;
    const t = layerTime(l);
    applyAnimation(scratch, anim, t);
    for (const id in anim.bones) {
      const b = sk.boneById(id);
      const s = scratch.boneById(id);
      if (!b || !s || !b.active) continue;
      const k = keyedChannels(anim.bones[id]);
      const d = b.data;
      const put = (cur: number, now: number, setup: number, turn = false) =>
        l.additive ? cur + (now - setup) * a : cur + (turn ? wrap180(now - cur) : now - cur) * a;
      if (k.rotation) b.rotation = put(b.rotation, s.rotation, d.rotation, true);
      if (k.x) b.x = put(b.x, s.x, d.x);
      if (k.y) b.y = put(b.y, s.y, d.y);
      if (k.scaleX) b.scaleX = put(b.scaleX, s.scaleX, d.scaleX);
      if (k.scaleY) b.scaleY = put(b.scaleY, s.scaleY, d.scaleY);
      if (k.shearX) b.shearX = put(b.shearX, s.shearX, d.shearX);
      if (k.shearY) b.shearY = put(b.shearY, s.shearY, d.shearY);
    }
    for (const id in anim.slots) {
      const slot = sk.slotById(id);
      const from = scratch.slotById(id);
      if (!slot || !from || !slot.bone.active) continue;
      const tl = anim.slots[id];
      // a picture cannot be half there: it changes once the layer is at least half in (and not for an additive layer)
      if (tl.attachment?.length && !l.additive && a >= 0.5 && findKeyIndex(tl.attachment, t) >= 0) {
        slot.attachmentName = from.attachmentName;
        slot.deform = [];
      }
      if (tl.rgba?.length || tl.rgba2?.length) {
        slot.color = slot.color.map((c, i) =>
          l.additive ? c + (from.color[i] - slot.data.color[i]) * a : c + (from.color[i] - c) * a,
        ) as typeof slot.color;
      }
    }
  }
}

/** Plays one animation at a time and crossfades to the next. */
export class PreviewPlayer {
  anim: Animation | null = null;
  time = 0;
  loop = true;
  speed = 1;
  playing = true;
  /** Hold Previous for the crossfade: what the new animation does not key stays as the old one had it. */
  hold = false;
  /** Animations played over the main one. */
  layers: PreviewLayer[] = [];
  private from: { anim: Animation | null; time: number } | null = null;
  private mixLeft = 0;
  private mixLength = 0;

  /** Starts `next` (null = the setup pose); the crossfade lasts the time the table says for the pair. */
  play(next: Animation | null, mixes?: MixTable) {
    const t = this.anim && next && this.anim.id !== next.id ? mixTime(mixes, this.anim.id, next.id) : 0;
    this.from = t > 0 ? { anim: this.anim, time: this.time } : null;
    this.mixLength = this.mixLeft = t;
    this.anim = next;
    this.time = 0;
  }

  /** How far the crossfade is (1 = finished or none). */
  get alpha(): number {
    return this.mixLength > 0 && this.from ? 1 - this.mixLeft / this.mixLength : 1;
  }

  /** Moves time forward by `dt` real seconds; returns the events that fired. */
  advance(dt: number): EventKey[] {
    if (!this.playing) return [];
    const step = dt * this.speed;
    for (const l of this.layers) l.time += step;
    if (this.from) {
      this.from.time += step;
      this.mixLeft -= dt;
      if (this.mixLeft <= 0) this.from = null;
    }
    const a = this.anim;
    if (!a) return [];
    const last = this.time;
    const next = last + step;
    const fired: EventKey[] = [];
    if (a.duration <= 0) {
      this.time = 0;
      return fired;
    }
    if (next > a.duration) {
      fired.push(...eventsBetween(a, last, a.duration));
      if (this.loop) {
        this.time = next % a.duration;
        fired.push(...eventsBetween(a, -1, this.time));
      } else this.time = a.duration;
    } else {
      this.time = next;
      fired.push(...eventsBetween(a, last, next));
    }
    return fired;
  }

  /** Poses the skeleton for the current moment. */
  pose(sk: Skeleton, scratch?: Skeleton | null) {
    poseMixed(sk, this.from, { anim: this.anim, time: this.time }, this.alpha, this.hold);
    if (scratch && this.layers.length) poseLayers(sk, scratch, this.layers);
  }

  /** Puts an animation on a layer above the main one (it starts at its first frame). Returns the layer. */
  addLayer(anim: Animation | null, opts: Partial<Pick<PreviewLayer, 'alpha' | 'additive' | 'loop'>> = {}): PreviewLayer {
    const layer: PreviewLayer = { anim, time: 0, alpha: opts.alpha ?? 1, additive: opts.additive ?? false, loop: opts.loop ?? true };
    this.layers.push(layer);
    return layer;
  }
}

/** The sound of an event is looked up by the file name without folders and extension: "sfx/step.ogg" and "step" are the same sound. */
export function soundKey(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  return name.replace(/\.[^.]+$/, '').toLowerCase();
}

export function repairMixes(project: Project): boolean {
  const ids = new Set(project.skeleton.animations.map((a) => a.id));
  const clean = cleanMixes(project.mixes, ids);
  const changed = JSON.stringify(clean) !== JSON.stringify(project.mixes);
  if (clean) project.mixes = clean;
  else delete project.mixes;
  return changed;
}
