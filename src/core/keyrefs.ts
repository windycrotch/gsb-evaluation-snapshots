/** Addressing keyframes inside an animation (used by timeline selection, copy/paste, move, delete). */
import { KEY_EPS, sortKeys } from './edit';
import type { Animation, Curve, Id } from './model';

export type KeyKind =
  'bone' | 'slot' | 'ik' | 'deform' | 'sequence' | 'drawOrder' | 'drawOrderFolder' | 'event' | 'slider' | 'transform' | 'path' | 'physics';

export interface KeyRef {
  kind: KeyKind;
  /** bone id / slot id / constraint id / slot id (deform) / '' */
  target: Id;
  /** timeline name: rotate|translate|scale|shear|attachment|rgba|'' ; deform: "skinId\u0001attachment" */
  prop: string;
  time: number;
}

export function encodeKey(r: KeyRef): string {
  return JSON.stringify([r.kind, r.target, r.prop, Math.round(r.time * 10000) / 10000]);
}

export function decodeKey(s: string): KeyRef {
  const [kind, target, prop, time] = JSON.parse(s) as [KeyKind, Id, string, number];
  return { kind, target, prop, time };
}

type AnyKeys = { time: number; value?: number[]; curve?: Curve }[];

/** The live key array a ref points to (creating nothing). */
export function resolveKeys(anim: Animation, ref: Pick<KeyRef, 'kind' | 'target' | 'prop'>): AnyKeys | undefined {
  switch (ref.kind) {
    case 'bone':
      return (anim.bones[ref.target] as Record<string, AnyKeys | undefined> | undefined)?.[ref.prop];
    case 'slot':
      return (anim.slots[ref.target] as Record<string, AnyKeys | undefined> | undefined)?.[ref.prop];
    case 'ik':
      return anim.ik[ref.target];
    case 'transform':
      return anim.transform?.[ref.target];
    case 'slider':
      return (anim.slider?.[ref.target] as Record<string, AnyKeys | undefined> | undefined)?.[ref.prop];
    case 'path':
      return (anim.path?.[ref.target] as Record<string, AnyKeys | undefined> | undefined)?.[ref.prop];
    case 'deform': {
      const [skinId, att] = ref.prop.split('\u0001');
      return anim.deform[skinId]?.[ref.target]?.[att];
    }
    case 'sequence': {
      const [skinId, att] = ref.prop.split('');
      return anim.sequence?.[skinId]?.[ref.target]?.[att];
    }
    case 'physics':
      return (anim.physics?.[ref.target] as Record<string, AnyKeys | undefined> | undefined)?.[ref.prop];
    case 'drawOrder':
      return anim.drawOrder;
    case 'drawOrderFolder':
      return anim.drawOrderFolder?.[ref.target];
    case 'event':
      return anim.events;
  }
}

/** The key of a timeline at `time` (within the key tolerance). */
export function keyAtTime<T extends { time: number }>(keys: readonly T[] | undefined, time: number): T | undefined {
  return keys?.find((k) => Math.abs(k.time - time) <= KEY_EPS);
}

export function deformProp(skinId: Id, attachment: string): string {
  return `${skinId}\u0001${attachment}`;
}

export function removeKeys(anim: Animation, refs: KeyRef[]) {
  for (const ref of refs) {
    const keys = resolveKeys(anim, ref);
    if (!keys) continue;
    const i = keys.findIndex((k) => Math.abs(k.time - ref.time) <= KEY_EPS);
    if (i >= 0) keys.splice(i, 1);
  }
  pruneEmpty(anim);
}

/**
 * Shifts the referenced keys by dt (clamped to >= 0). Keys landing on an unmoved key replace it. Returns the refs after the move.
 * With `wrap` (the animation's duration) the keys travel around the loop instead — Spine's Offset keys: what leaves the end comes back at the start.
 */
export function moveKeys(anim: Animation, refs: KeyRef[], dt: number, ripple = false, wrap = 0): KeyRef[] {
  const groups = new Map<AnyKeys, { kind: KeyKind; times: number[]; moved: Map<number, number> }>();
  for (const ref of refs) {
    const keys = resolveKeys(anim, ref);
    if (!keys) continue;
    const g = groups.get(keys) ?? { kind: ref.kind, times: [], moved: new Map<number, number>() };
    g.times.push(ref.time);
    groups.set(keys, g);
  }
  let minTime = Infinity;
  for (const r of refs) minTime = Math.min(minTime, r.time);
  const looping = wrap > KEY_EPS && !ripple;
  const shift = looping ? dt : Math.max(dt, -minTime);
  const at = (t: number) => (looping ? ((t % wrap) + wrap) % wrap : Math.max(0, t));
  for (const [keys, g] of groups) {
    const moved = new Set<{ time: number }>();
    // ripple: the keys after the last moved one of this timeline travel with them (Spine's Shift)
    const last = Math.max(...g.times);
    const later = ripple ? keys.filter((k) => k.time > last + KEY_EPS) : [];
    for (const k of keys) {
      const from = g.times.find((t) => Math.abs(t - k.time) <= KEY_EPS);
      if (from !== undefined) {
        k.time = at(k.time + shift);
        g.moved.set(from, k.time);
        moved.add(k);
      }
    }
    for (const key of later) {
      key.time = Math.max(0, key.time + shift);
      moved.add(key);
    }
    // a key that lands on an unmoved key replaces it (event keys may legitimately share a time)
    if (g.kind !== 'event') {
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        if (!moved.has(k) && [...moved].some((m) => Math.abs(m.time - k.time) <= KEY_EPS)) keys.splice(i, 1);
      }
    }
    sortKeys(keys);
    // going round the loop two moved keys can meet (the key at 0 and the one at the end are the same moment): one of them goes
    if (looping && g.kind !== 'event') {
      for (let i = keys.length - 1; i > 0; i--) {
        if (moved.has(keys[i]) && moved.has(keys[i - 1]) && Math.abs(keys[i].time - keys[i - 1].time) <= KEY_EPS) keys.splice(i, 1);
      }
    }
  }
  // one result per input ref, in the input order; a ref whose key was not found is returned unchanged
  return refs.map((ref) => {
    const keys = resolveKeys(anim, ref);
    const to = keys ? groups.get(keys)?.moved.get(ref.time) : undefined;
    return { ...ref, time: to ?? ref.time };
  });
}

/** Removes empty timelines so the dopesheet and export stay clean. */
function pruneEmpty(anim: Animation) {
  for (const id in anim.bones) {
    const t = anim.bones[id] as Record<string, AnyKeys | undefined>;
    for (const p of Object.keys(t)) if (!t[p] || t[p].length === 0) delete t[p];
    if (Object.keys(t).length === 0) delete anim.bones[id];
  }
  for (const id in anim.slots) {
    const t = anim.slots[id] as Record<string, AnyKeys | undefined>;
    for (const p of Object.keys(t)) if (!t[p] || t[p].length === 0) delete t[p];
    if (Object.keys(t).length === 0) delete anim.slots[id];
  }
  for (const id in anim.ik) if (anim.ik[id].length === 0) delete anim.ik[id];
  for (const id in anim.transform ?? {}) if (anim.transform[id].length === 0) delete anim.transform[id];
  for (const id in anim.slider ?? {}) {
    const t = anim.slider[id] as Record<string, AnyKeys | undefined>;
    for (const p of Object.keys(t)) if (!t[p] || t[p].length === 0) delete t[p];
    if (Object.keys(t).length === 0) delete anim.slider[id];
  }
  for (const id in anim.path ?? {}) {
    const t = anim.path[id] as Record<string, AnyKeys | undefined>;
    for (const p of Object.keys(t)) if (!t[p] || t[p].length === 0) delete t[p];
    if (Object.keys(t).length === 0) delete anim.path[id];
  }
  for (const id in anim.physics ?? {}) {
    const t = anim.physics[id] as Record<string, AnyKeys | undefined>;
    for (const p of Object.keys(t)) if (!t[p] || t[p].length === 0) delete t[p];
    if (Object.keys(t).length === 0) delete anim.physics[id];
  }
  for (const skin in anim.sequence ?? {}) {
    const per = anim.sequence![skin];
    for (const slot in per) {
      for (const att in per[slot]) if (per[slot][att].length === 0) delete per[slot][att];
      if (Object.keys(per[slot]).length === 0) delete per[slot];
    }
    if (Object.keys(per).length === 0) delete anim.sequence![skin];
  }
  if (anim.sequence && Object.keys(anim.sequence).length === 0) delete anim.sequence;
  for (const id in anim.drawOrderFolder ?? {}) if (anim.drawOrderFolder![id].length === 0) delete anim.drawOrderFolder![id];
  if (anim.drawOrderFolder && Object.keys(anim.drawOrderFolder).length === 0) delete anim.drawOrderFolder;
  for (const skin in anim.deform) {
    for (const slot in anim.deform[skin]) {
      for (const att in anim.deform[skin][slot]) if (anim.deform[skin][slot][att].length === 0) delete anim.deform[skin][slot][att];
      if (Object.keys(anim.deform[skin][slot]).length === 0) delete anim.deform[skin][slot];
    }
    if (Object.keys(anim.deform[skin]).length === 0) delete anim.deform[skin];
  }
}

/**
 * Where copied keys go when they are pasted: onto the bone (or slot) that is selected now, when the copy came from one other bone (slot).
 * So the swing of one arm can be pasted onto the other. A copy from several bones, or a paste with the same bone selected, stays where it was.
 * Several selected bones each get a copy of the keys.
 *
 * A copy from several bones goes onto as many other selected bones, one for one (Spine 4.3: "copying keys from multiple bones and pasting to
 * different bones, like when pasting bone transforms"): both lists are put in the order of the bones in the document (`boneOrder`), so the
 * first copied bone goes to the first selected bone, and so on: the swing of a whole left arm chain onto the right one.
 * When the number of selected bones is another one, or they are the very bones the keys came from, the keys stay where they were.
 */
export function retargetClip<T extends { kind: KeyKind; target: Id }>(
  clip: readonly T[],
  selectedBones: readonly Id[],
  selectedSlot: Id | null,
  boneOrder?: readonly Id[],
): T[] {
  let out = [...clip];
  const bones = [...new Set(clip.filter((c) => c.kind === 'bone').map((c) => c.target))];
  if (bones.length === 1 && selectedBones.length && !(selectedBones.length === 1 && selectedBones[0] === bones[0])) {
    out = out.flatMap((c) => (c.kind !== 'bone' ? [c] : selectedBones.map((b) => ({ ...c, target: b }))));
  } else if (bones.length >= 2 && selectedBones.length === bones.length && new Set(selectedBones).size === bones.length) {
    const rank = (id: Id) => (boneOrder ? boneOrder.indexOf(id) : 0);
    const byOrder = (ids: readonly Id[]) => (boneOrder ? [...ids].sort((a, b) => rank(a) - rank(b)) : [...ids]);
    const from = byOrder(bones);
    const to = byOrder(selectedBones);
    if (from.some((id, i) => id !== to[i])) {
      const to_ = new Map(from.map((id, i) => [id, to[i]] as const));
      out = out.map((c) => (c.kind === 'bone' ? { ...c, target: to_.get(c.target) ?? c.target } : c));
    }
  }
  const slots = [...new Set(clip.filter((c) => c.kind === 'slot').map((c) => c.target))];
  if (slots.length === 1 && selectedSlot && selectedSlot !== slots[0])
    out = out.map((c) => (c.kind === 'slot' ? { ...c, target: selectedSlot } : c));
  return out;
}
