/** Pure document edit helpers. They mutate the passed (draft) document in place, so they work under immer and in tests. */
import { parentFirst } from './boneorder';
import { pruneFolders } from './folders';
import { dropBonesFromSets } from './selsets';
import { uniqueName } from './ids';
import { remapDeformValues, vertexWorldPositions } from './mesh';
import type { BoneMats, VertexMap } from './mesh';
import { constraintBoneIds } from './model';
import type { Animation, Curve, Id, Key, MeshAttachment, RGB, SkeletonDoc, Timeline } from './model';
import { RAD2DEG, atan2Deg, matApply, matInvert } from './math';

export const KEY_EPS = 1e-4;

/** The key of a timeline at `time` (within KEY_EPS), if there is one. */
export function keyAt<K extends { time: number }>(keys: readonly K[] | undefined, time: number): K | undefined {
  return keys?.find((k) => Math.abs(k.time - time) < KEY_EPS);
}

export const hasKey = (keys: readonly { time: number }[] | undefined, time: number): boolean => keyAt(keys, time) !== undefined;

export type CurveKindName = 'linear' | 'bezier' | 'stepped';

/** Default normalized bezier used for newly created keys (a gentle ease in/out). */
const DEFAULT_BEZIER: [number, number, number, number] = [0.35, 0, 0.65, 1];

export function makeCurve(kind: CurveKindName, channels: number): Curve | undefined {
  if (kind === 'linear') return undefined;
  if (kind === 'stepped') return 'stepped';
  const out: number[] = [];
  for (let c = 0; c < channels; c++) out.push(...DEFAULT_BEZIER);
  return out;
}

export function descendantsOf(doc: SkeletonDoc, ids: Iterable<Id>): Set<Id> {
  const result = new Set<Id>(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of doc.bones) {
      if (b.parent && result.has(b.parent) && !result.has(b.id)) {
        result.add(b.id);
        grew = true;
      }
    }
  }
  return result;
}

/** Keeps parents before children (stable). */
export function normalizeBoneOrder(doc: SkeletonDoc) {
  doc.bones.splice(0, doc.bones.length, ...parentFirst(doc.bones));
}

export function removeSlots(doc: SkeletonDoc, slotIds: Set<Id>) {
  if (slotIds.size === 0) return;
  doc.slots = doc.slots.filter((s) => !slotIds.has(s.id));
  for (const skin of doc.skins) for (const id of slotIds) delete skin.attachments[id];
  // a path constraint needs the slot that holds its path
  const deadPaths = new Set(doc.constraints.filter((c) => c.type === 'path' && slotIds.has(c.target)).map((c) => c.id));
  if (deadPaths.size) {
    doc.constraints = doc.constraints.filter((c) => !deadPaths.has(c.id));
    for (const skin of doc.skins) skin.constraints = skin.constraints.filter((c) => !deadPaths.has(c));
    for (const a of doc.animations) for (const id of deadPaths) delete a.path?.[id];
  }
  // a clipping attachment that ended at a removed slot clips until the end of the draw order
  for (const skin of doc.skins) {
    for (const perSlot of Object.values(skin.attachments)) {
      for (const att of Object.values(perSlot)) if (att.type === 'clipping' && att.end && slotIds.has(att.end)) att.end = null;
    }
  }
  for (const a of doc.animations) {
    for (const id of slotIds) {
      delete a.slots[id];
      for (const skinId in a.deform) delete a.deform[skinId][id];
      for (const skinId in a.sequence ?? {}) delete a.sequence![skinId][id];
    }
    pruneSequences(a);
    a.drawOrder = a.drawOrder.map((k) => ({ ...k, order: k.order.filter((s) => !slotIds.has(s)) }));
    for (const id in a.drawOrderFolder ?? {})
      a.drawOrderFolder![id] = a.drawOrderFolder![id].map((k) => ({ ...k, order: k.order.filter((s) => !slotIds.has(s)) }));
  }
  for (const f of doc.drawOrderFolders ?? []) f.slots = f.slots.filter((s) => !slotIds.has(s));
  pruneFolders(doc);
}

/**
 * Removes bones (and descendants) and everything that depends on them. Returns the removed bone ids.
 * `bindPose` (setup-pose world matrices of ALL bones, before the removal) lets weighted vertices that lose every
 * influence stay where they are: they are re-bound to their slot's bone instead of collapsing to the origin.
 */
export function removeBones(doc: SkeletonDoc, ids: Iterable<Id>, bindPose?: BoneMats): Set<Id> {
  const gone = descendantsOf(doc, ids);
  // never delete the last remaining root
  doc.bones = doc.bones.filter((b) => !gone.has(b.id));
  removeSlots(doc, new Set(doc.slots.filter((s) => gone.has(s.bone)).map((s) => s.id)));
  const deadConstraints = new Set(doc.constraints.filter((c) => constraintBoneIds(c).some((b) => gone.has(b))).map((c) => c.id));
  doc.constraints = doc.constraints.filter((c) => !deadConstraints.has(c.id));
  const wasBone = new Set([...doc.bones.map((b) => b.id), ...gone]);
  doc.skins.forEach((skin) => {
    skin.bones = skin.bones.filter((b) => !gone.has(b));
    skin.constraints = skin.constraints.filter((c) => !deadConstraints.has(c));
    for (const slotId in skin.attachments) {
      const slot = doc.slots.find((s) => s.id === slotId);
      const slotMat = slot && bindPose?.get(slot.bone);
      for (const name in skin.attachments[slotId]) {
        const att = skin.attachments[slotId][name];
        if ((att.type === 'mesh' || att.type === 'clipping' || att.type === 'boundingbox' || att.type === 'path') && att.weights) {
          const before = att.type === 'mesh' ? ({ ...att } as MeshAttachment) : null;
          const touched = att.weights.some((list) => list.some((inf) => gone.has(inf[0])));
          const orphaned = att.weights.some((list) => list.every((inf) => gone.has(inf[0])));
          // where every vertex is right now (setup pose), measured before its influences disappear
          const world = orphaned && slotMat && bindPose ? vertexWorldPositions(att, att.weights.length, slotMat, bindPose) : null;
          att.weights = att.weights.map((list, vi) => {
            const kept = list.filter((inf) => !gone.has(inf[0]));
            if (kept.length === 0 && world && slot && slotMat) {
              const p = matApply(matInvert(slotMat), world[vi * 2], world[vi * 2 + 1]);
              return [[slot.bone, p[0], p[1], 1]] as typeof list;
            }
            const sum = kept.reduce((s, inf) => s + inf[3], 0);
            return sum > 0 ? kept.map((inf) => [inf[0], inf[1], inf[2], inf[3] / sum] as typeof inf) : kept;
          });
          // influences vanished: deform values follow the bones that stay
          if (before && att.type === 'mesh' && touched)
            reconcileDeform(doc, slotId, name, before, att, null, (id) => wasBone.has(id), skin.id);
          // a path whose influences changed can no longer use its deform keys (their layout is per influence)
          if (att.type === 'path' && touched)
            for (const a of doc.animations) for (const skinId of Object.keys(a.deform)) dropDeformTimeline(a, skinId, slotId, name);
        }
      }
    }
  });
  for (const a of doc.animations) {
    for (const id of gone) delete a.bones[id];
    for (const id of deadConstraints) {
      delete a.ik[id];
      if (a.transform) delete a.transform[id];
      if (a.slider) delete a.slider[id];
      if (a.path) delete a.path[id];
      if (a.physics) delete a.physics[id];
    }
  }
  dropBonesFromSets(doc, gone);
  return gone;
}

/** Removes the empty parts of the sequence timelines of an animation. */
export function pruneSequences(a: Animation) {
  if (!a.sequence) return;
  for (const skinId of Object.keys(a.sequence)) {
    const per = a.sequence[skinId];
    for (const slotId of Object.keys(per)) {
      for (const name of Object.keys(per[slotId])) if (!per[slotId][name].length) delete per[slotId][name];
      if (Object.keys(per[slotId]).length === 0) delete per[slotId];
    }
    if (Object.keys(per).length === 0) delete a.sequence[skinId];
  }
  if (Object.keys(a.sequence).length === 0) delete a.sequence;
}

/** Removes the sequence timeline of one attachment (in every skin). */
export function dropSequenceTimeline(a: Animation, slotId: Id, attName: string) {
  for (const skinId of Object.keys(a.sequence ?? {})) delete a.sequence![skinId][slotId]?.[attName];
  pruneSequences(a);
}

export function dropDeformTimeline(a: Animation, skinId: Id, slotId: Id, attName: string) {
  const perSlot = a.deform[skinId]?.[slotId];
  if (!perSlot) return;
  delete perSlot[attName];
  if (Object.keys(perSlot).length === 0) delete a.deform[skinId][slotId];
  if (Object.keys(a.deform[skinId]).length === 0) delete a.deform[skinId];
}

/**
 * Keeps the deform keys of a mesh of a skin (the default skin unless `skinId` says another) valid after the mesh changed from `before` to `after`
 * (vertices added / removed, influences changed). Keys follow their vertices when the layouts are compatible;
 * otherwise (bind / unbind, re-trace) the timelines are dropped. Returns true when timelines had to be dropped.
 */
export function reconcileDeform(
  doc: SkeletonDoc,
  slotId: Id,
  attName: string,
  before: MeshAttachment,
  after: MeshAttachment,
  map: VertexMap | 'drop' = null,
  hasBoneBefore?: (id: Id) => boolean,
  ofSkin?: Id,
): boolean {
  const skinId = ofSkin ?? doc.skins[0]?.id;
  if (!skinId) return false;
  const boneIds = new Set(doc.bones.map((b) => b.id));
  const hasBone = (id: Id) => boneIds.has(id);
  let dropped = false;
  for (const a of doc.animations) {
    const keys = a.deform[skinId]?.[slotId]?.[attName];
    if (!keys) continue;
    const next: number[][] = [];
    if (map !== 'drop') {
      for (const k of keys) {
        const v = remapDeformValues(before, after, map, hasBone, k.value, hasBoneBefore);
        if (!v) break;
        next.push(v);
      }
    }
    if (map === 'drop' || next.length !== keys.length) {
      dropDeformTimeline(a, skinId, slotId, attName);
      dropped = true;
      continue;
    }
    keys.forEach((k, i) => {
      const v = next[i];
      if (v.length !== k.value.length || v.some((x, j) => x !== k.value[j])) k.value = v;
    });
  }
  return dropped;
}

/** Removes everything that points at an attachment that no longer exists: deform timelines and attachment keys. */
export function purgeAttachment(doc: SkeletonDoc, slotId: Id, name: string) {
  for (const a of doc.animations) {
    for (const skinId of Object.keys(a.deform)) dropDeformTimeline(a, skinId, slotId, name);
    dropSequenceTimeline(a, slotId, name);
    // an attachment key naming a deleted attachment shows nothing, exactly like a hide key
    for (const k of a.slots[slotId]?.attachment ?? []) if (k.name === name) k.name = null;
  }
}

/** Inserts or replaces a key by time (keeps the list sorted). Returns the stored key. */
export function upsertKey<K extends { time: number }>(keys: K[], key: K, eps = KEY_EPS): K {
  for (let i = 0; i < keys.length; i++) {
    if (Math.abs(keys[i].time - key.time) <= eps) {
      keys[i] = { ...keys[i], ...key, time: keys[i].time };
      return keys[i];
    }
  }
  let at = keys.length;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].time > key.time) {
      at = i;
      break;
    }
  }
  keys.splice(at, 0, key);
  return key;
}

/** Whether two keys hold the same value (time and the curve do not count): numbers within a hair of each other, anything else equal. */
/**
 * Paste Keys - Hold (Spine 4.3.22: "use linear between same valued keys"): a segment between two keys that hold the same value is made
 * linear, so a copied curve cannot swing away from a value the segment starts and ends on. Only segments that touch one of `times` (the
 * keys that were just pasted) change. Returns how many segments were changed.
 */
export function linearBetweenEqual(keys: { time: number; value?: number[]; curve?: unknown }[], times: readonly number[]): number {
  let changed = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (a.curve === undefined || !Array.isArray(a.value) || !Array.isArray(b.value) || a.value.length !== b.value.length) continue; // no curve: already linear
    if (!times.some((t) => Math.abs(t - a.time) <= KEY_EPS || Math.abs(t - b.time) <= KEY_EPS)) continue;
    const bv = b.value;
    if (a.value.every((v, j) => Math.abs(v - bv[j]) <= 1e-6 * Math.max(1, Math.abs(v)))) {
      delete a.curve;
      changed++;
    }
  }
  return changed;
}

export function sameKeyValue(a: object, b: object): boolean {
  const same = (x: unknown, y: unknown): boolean => {
    if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => same(v, y[i]));
    if (x && y && typeof x === 'object' && typeof y === 'object') return sameKeyValue(x, y);
    return x === y;
  };
  const ka = Object.keys(a).filter((k) => k !== 'time' && k !== 'curve');
  const kb = Object.keys(b).filter((k) => k !== 'time' && k !== 'curve');
  return ka.length === kb.length && ka.every((k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function sortKeys<K extends { time: number }>(keys: K[]) {
  keys.sort((a, b) => a.time - b.time);
}

/** How many steps a frame is cut into when times snap: 1 whole frames, 2 / 4 / 10 let keys sit between frames. Follows the Settings. */
export const keyGrid = { steps: 1 };

/** The step times snap to, in seconds. */
export const keyStep = (fps: number, steps: number = keyGrid.steps): number => 1 / (Math.max(1, fps) * Math.max(1, Math.round(steps)));

export function snapTime(t: number, fps: number, steps: number = keyGrid.steps): number {
  const f = Math.max(1, fps) * Math.max(1, Math.round(steps));
  return Math.max(0, Math.round(t * f) / f);
}

/** Decomposes a 2x2 matrix into rotation / scale / shearY (shearX = 0), same convention as Spine's applied transform. */
export function decompose(a: number, b: number, c: number, d: number) {
  const x = a * a + c * c;
  const y = b * b + d * d;
  let rotation = 0;
  let scaleX = 0;
  let scaleY = Math.sqrt(y);
  let shearY = 0;
  if (x > 1e-10) {
    const r = atan2Deg(c, a);
    rotation = r;
    scaleX = Math.sqrt(x);
    if (y > 1e-10) {
      shearY = atan2Deg(d, b);
      if (a * d - b * c < 0) {
        scaleY = -scaleY;
        shearY += 90 - r;
      } else shearY -= 90 + r;
      if (shearY > 180) shearY -= 360;
      else if (shearY <= -180) shearY += 360;
    }
  } else {
    rotation = y > 1e-10 ? Math.atan2(d, b) * RAD2DEG - 90 : 0;
  }
  return { rotation, scaleX, scaleY, shearX: 0, shearY };
}

export function findAnimation(doc: SkeletonDoc, id: Id | null): Animation | undefined {
  return id ? doc.animations.find((a) => a.id === id) : undefined;
}

function names(list: { name: string }[]): Set<string> {
  return new Set(list.map((x) => x.name));
}

export function freshName(base: string, list: { name: string }[]): string {
  return uniqueName(base, names(list));
}

/** Drops the dark channels of two-color keys: rgba2 -> rgba. */
export function rgba2ToRgba(keys: Timeline): Timeline {
  return keys.map((k) => {
    const out: Key = { time: k.time, value: k.value.slice(0, 4) };
    if (Array.isArray(k.curve)) out.curve = k.curve.slice(0, 16);
    else if (k.curve !== undefined) out.curve = k.curve;
    return out;
  });
}

/** Adds a constant dark color to light-only keys: rgba -> rgba2. The new channels get a linear-looking curve. */
export function rgbaToRgba2(keys: Timeline, dark: RGB): Timeline {
  return keys.map((k) => {
    const out: Key = { time: k.time, value: [k.value[0], k.value[1], k.value[2], k.value[3], dark[0], dark[1], dark[2]] };
    if (Array.isArray(k.curve))
      out.curve = [...k.curve.slice(0, 16), 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1 / 3, 1 / 3, 2 / 3, 2 / 3];
    else if (k.curve !== undefined) out.curve = k.curve;
    return out;
  });
}

/**
 * Sets the setup dark color of a slot (null = no two-color tinting) and keeps the animations valid: two-color keys need a dark
 * color, so removing it turns them back into plain color keys.
 */
export function setSlotDarkColor(doc: SkeletonDoc, slotId: Id, dark: RGB | null) {
  const slot = doc.slots.find((s) => s.id === slotId);
  if (!slot) return;
  slot.dark = dark ? [dark[0], dark[1], dark[2]] : null;
  if (dark) return;
  for (const a of doc.animations) {
    const tl = a.slots[slotId];
    if (!tl?.rgba2) continue;
    tl.rgba = rgba2ToRgba(tl.rgba2);
    delete tl.rgba2;
  }
}
