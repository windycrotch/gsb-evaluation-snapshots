/**
 * A crossfade between the pictures of a slot (a face that changes its mouth or eyes without a hard cut).
 *
 * A Spine slot shows one attachment at a time, so no runtime fades one into another. The way that works everywhere is two slots: the slot
 * keeps the new picture and fades it in (its alpha goes 0 -> 1), and a partner slot drawn right above it shows the old picture and fades it
 * out (alpha 1 -> 0, then no attachment). This writes that into one animation, for one slot, from the attachment keys the slot already has.
 * The partner is an ordinary slot ("<slot> fade") with copies of the region and mesh attachments of the slot, so it exports like any other.
 */
import { uid } from './ids';
import { KEY_EPS, freshName } from './edit';
import type { Animation, AttachmentKey, Id, Key, Project, Slot } from './model';

type SkeletonDoc = Project['skeleton'];

const MAX_FADE = 5;

/** One change of picture, with how long its fade lasts (0 = a hard cut stays). */
export interface FadeStep {
  time: number;
  from: string | null;
  to: string | null;
  seconds: number;
}

export type FadeRefusal = 'no-keys' | 'two-color' | 'color-keys' | 'no-pictures';

/**
 * The changes of picture of a slot in an animation and the fade each can have: `seconds`, but no longer than the time to the next change or to
 * the end of the animation. A change to the picture that is already showing is not a change.
 */
export function fadeSteps(slot: Slot, anim: Animation, seconds: number): FadeStep[] {
  const keys = [...(anim.slots[slot.id]?.attachment ?? [])].sort((a, b) => a.time - b.time);
  const want = Math.max(0, Math.min(MAX_FADE, Number.isFinite(seconds) ? seconds : 0));
  const out: FadeStep[] = [];
  let shown = slot.attachment;
  keys.forEach((k, i) => {
    if (k.name === shown) return;
    const next = keys.slice(i + 1).find((n) => n.time > k.time + 1e-9)?.time ?? anim.duration;
    out.push({ time: k.time, from: shown, to: k.name, seconds: Math.max(0, Math.min(want, next - k.time, anim.duration - k.time)) });
    shown = k.name;
  });
  return out;
}

/** Why a slot cannot be faded in this animation, or null when it can. */
export function fadeRefusal(doc: SkeletonDoc, slot: Slot, anim: Animation): FadeRefusal | null {
  if (!anim.slots[slot.id]?.attachment?.length) return 'no-keys';
  if (slot.dark || anim.slots[slot.id]?.rgba2?.length) return 'two-color';
  if (anim.slots[slot.id]?.rgba?.length) return 'color-keys';
  if (!fadeSteps(slot, anim, 1).some((s) => s.from !== null || s.to !== null)) return 'no-pictures';
  return null;
}

/** Keeps one key per time (keys closer than the editor tells apart count as one): the later ones win, so the start of a fade replaces the end of the fade before it. */
function byTime<T extends { time: number }>(keys: T[]): T[] {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const out: T[] = [];
  for (const k of sorted) {
    if (out.length && Math.abs(out[out.length - 1].time - k.time) <= KEY_EPS) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

export interface Crossfade {
  /** The partner slot, the one that shows the old pictures. */
  partner: Id;
  /** How many changes of picture got a fade. */
  fades: number;
}

/**
 * Writes the crossfade into the document (edit a draft of it): makes the partner slot (or reuses "<slot> fade" of an earlier run when it
 * belongs to the same bone), copies the pictures into it, and keys both slots in `animId`. Returns null when nothing can fade.
 */
export function applyCrossfade(doc: SkeletonDoc, animId: Id, slotId: Id, seconds: number): Crossfade | null {
  const anim = doc.animations.find((a) => a.id === animId);
  const slot = doc.slots.find((s) => s.id === slotId);
  if (!anim || !slot || fadeRefusal(doc, slot, anim)) return null;
  // only pictures fade: a change that involves a path, a clip or a box stays a hard cut
  const pics = new Set<string>();
  for (const skin of doc.skins)
    for (const [name, att] of Object.entries(skin.attachments[slot.id] ?? {}))
      if (att.type === 'region' || att.type === 'mesh') pics.add(name);
  const steps = fadeSteps(slot, anim, seconds).filter(
    (s) => s.seconds > 2 * KEY_EPS && (s.from === null || pics.has(s.from)) && (s.to === null || pics.has(s.to)),
  );
  if (!steps.length) return null;

  const wanted = `${slot.name} fade`;
  let partner = doc.slots.find((s) => s.name === wanted && s.bone === slot.bone && s.id !== slot.id);
  if (!partner) {
    partner = {
      id: uid(),
      name: freshName(wanted, doc.slots),
      bone: slot.bone,
      color: [...slot.color],
      dark: null,
      attachment: null,
      blend: slot.blend,
      hidden: slot.hidden,
    };
    const at = doc.slots.findIndex((s) => s.id === slot.id);
    doc.slots.splice(at + 1, 0, partner);
    for (const f of doc.drawOrderFolders ?? []) {
      const i = f.slots.indexOf(slot.id);
      if (i >= 0) f.slots.splice(i + 1, 0, partner.id);
    }
  }
  // the pictures of the slot, copied: the partner shows the ones that fade out
  for (const skin of doc.skins) {
    const own = skin.attachments[slot.id];
    if (!own) continue;
    const mine = (skin.attachments[partner.id] ??= {});
    for (const name in own) {
      const att = own[name];
      if (att.type === 'region' || att.type === 'mesh') mine[name] = JSON.parse(JSON.stringify(att)) as typeof att; // not structuredClone: the document may be an immer draft
    }
  }

  const [r, g, b, a] = slot.color;
  const main: Key[] = [];
  const part: Key[] = [];
  const partPic: AttachmentKey[] = [];
  let fades = 0;
  for (const s of steps) {
    const end = Math.round((s.time + s.seconds) * 1e6) / 1e6; // no float noise in the key times
    if (s.to !== null) {
      main.push({ time: s.time, value: [r, g, b, 0] });
      main.push({ time: end, value: [r, g, b, a], curve: 'stepped' });
    }
    if (s.from !== null) {
      part.push({ time: s.time, value: [r, g, b, a] });
      part.push({ time: end, value: [r, g, b, 0], curve: 'stepped' });
      partPic.push({ time: s.time, name: s.from });
      partPic.push({ time: end, name: null });
    }
    fades++;
  }
  const mine = (anim.slots[slot.id] ??= {});
  mine.rgba = byTime(main);
  anim.slots[partner.id] = { ...(anim.slots[partner.id] ?? {}), attachment: byTime(partPic), rgba: byTime(part) };
  if (!mine.rgba.length) delete mine.rgba;
  return { partner: partner.id, fades };
}
