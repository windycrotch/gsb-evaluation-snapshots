/**
 * Checkpoints: a named copy of the skeleton kept for the session, to look back at ("before I touched the arm") and to compare with.
 * The copy costs almost nothing because the document is immutable (the checkpoint shares everything that was not edited since).
 * This file holds the pure part: what a checkpoint is and the comparison of two skeletons as a list of changes; the viewport draws the
 * checkpoint's pose under the current one, and the History window lists and restores them (src/store/checkpoints.ts).
 */
import { uid } from './ids';
import type { Animation, Bone, Id, ImageRef, Project, Skin, SkeletonDoc, Slot } from './model';

export interface Checkpoint {
  id: string;
  name: string;
  /** When it was marked, ms since 1970. */
  time: number;
  /** Which skeleton of the project it is a copy of (a project can hold several). */
  at: number;
  skeleton: SkeletonDoc;
  /** The picture list as it was: the skeleton's attachments name their pictures there (the pixels stay in memory, also after a rename or a removal). */
  images: ImageRef[];
  /** The crossfade table of the Preview window: it names animations of the skeleton, so it goes back with it. */
  mixes: Project['mixes'];
  /** The name of the project file this one was read from (a version to compare with, made by "Compare with a project file"); it cannot be restored. */
  fromFile?: string;
}

/** At most this many checkpoints are kept for one skeleton; marking another drops the oldest. */
export const MAX_CHECKPOINTS = 20;

export type ChangeArea = 'bone' | 'slot' | 'skin' | 'constraint' | 'event' | 'animation' | 'skeleton';
type ChangeKind = 'added' | 'removed' | 'changed';

export interface Change {
  area: ChangeArea;
  kind: ChangeKind;
  /** Name in the newer skeleton (in the older one for a removed thing). */
  name: string;
  /** The id of the thing (none for the skeleton's own settings): what "Take from the checkpoint" picks it by. */
  id?: Id;
  /** What differs in a changed bone, slot or skin: short words ("position", "rotation"), the way the person thinks of them. */
  fields?: string[];
  /** In a changed animation: how many keys were added, removed or changed. */
  keys?: { added: number; removed: number; changed: number };
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

function boneFields(a: Bone, b: Bone): string[] {
  const out: string[] = [];
  if (a.x !== b.x || a.y !== b.y) out.push('position');
  if (a.rotation !== b.rotation) out.push('rotation');
  if (a.scaleX !== b.scaleX || a.scaleY !== b.scaleY) out.push('scale');
  if (a.shearX !== b.shearX || a.shearY !== b.shearY) out.push('shear');
  if (a.length !== b.length) out.push('length');
  if (a.parent !== b.parent) out.push('parent');
  if (a.inherit !== b.inherit) out.push('inherit');
  if (!same(a.color, b.color)) out.push('color');
  if (a.skinRequired !== b.skinRequired || a.hidden !== b.hidden || a.locked !== b.locked) out.push('flags');
  return out;
}

function slotFields(a: Slot, b: Slot): string[] {
  const out: string[] = [];
  if (a.bone !== b.bone) out.push('bone');
  if (!same(a.color, b.color) || !same(a.dark, b.dark)) out.push('color');
  if (a.attachment !== b.attachment) out.push('attachment');
  if (a.blend !== b.blend) out.push('blend');
  if (a.hidden !== b.hidden) out.push('flags');
  return out;
}

function skinFields(a: Skin, b: Skin): string[] {
  const out: string[] = [];
  const slots = new Set([...Object.keys(a.attachments), ...Object.keys(b.attachments)]);
  let pictures = false;
  let count = false;
  for (const s of slots) {
    const x = a.attachments[s] ?? {};
    const y = b.attachments[s] ?? {};
    if (x === y) continue;
    const names = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const n of names) {
      if (!(n in x) || !(n in y)) count = true;
      else if (!same(x[n], y[n])) pictures = true;
    }
  }
  if (count) out.push('attachments');
  if (pictures) out.push('shapes');
  if (!same(a.bones, b.bones) || !same(a.constraints, b.constraints)) out.push('scope');
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKeys = (v: unknown): v is { time: number }[] => Array.isArray(v) && v.every((k) => isObject(k) && typeof k.time === 'number');

interface Tally {
  added: number;
  removed: number;
  changed: number;
}

/** How many keys a value holds: the length of a list of keys, 1 for a lone value, the sum of the parts of a record. */
function weight(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (isKeys(v)) return v.length;
  if (isObject(v)) {
    let n = 0;
    for (const k in v) n += weight(v[k]);
    return n;
  }
  return 1;
}

/** Counts the keys that differ between two animation values: records are walked, lists of keys are matched by time. */
function tally(a: unknown, b: unknown, t: Tally) {
  if (a === b) return;
  if (a === undefined || a === null) return void (t.added += weight(b));
  if (b === undefined || b === null) return void (t.removed += weight(a));
  if (isKeys(a) && isKeys(b)) {
    const byTime = new Map<number, unknown>();
    for (const k of a) byTime.set(Math.round(k.time * 1e5), k);
    const seen = new Set<number>();
    for (const k of b) {
      const at = Math.round(k.time * 1e5);
      seen.add(at);
      if (!byTime.has(at)) t.added++;
      else if (!same(byTime.get(at), k)) t.changed++;
    }
    for (const at of byTime.keys()) if (!seen.has(at)) t.removed++;
    return;
  }
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) tally(a[k], b[k], t);
    return;
  }
  if (!same(a, b)) t.changed++;
}

/** The keys of an animation that differ, or null when nothing but maybe the identity does. Names are not counted (they are listed on their own). */
function animationKeyChanges(a: Animation, b: Animation): Tally | null {
  const t: Tally = { added: 0, removed: 0, changed: 0 };
  tally({ ...a, name: undefined }, { ...b, name: undefined }, t);
  return t.added || t.removed || t.changed ? t : null;
}

function byId<T extends { id: Id }>(list: readonly T[]): Map<Id, T> {
  return new Map(list.map((x) => [x.id, x]));
}

/** Compares two lists of things with ids: what was added, removed, or changed (`describe` returns what differs, or null for "same"). */
function listChanges<T extends { id: Id; name: string }>(
  area: ChangeArea,
  before: readonly T[],
  after: readonly T[],
  describe: (a: T, b: T) => Partial<Change> | null,
  out: Change[],
) {
  if (before === after) return;
  const old = byId(before);
  const now = byId(after);
  for (const b of after) {
    const a = old.get(b.id);
    if (!a) out.push({ area, kind: 'added', name: b.name, id: b.id });
    else if (a !== b) {
      const diff = describe(a, b);
      if (diff) out.push({ area, kind: 'changed', name: b.name, id: b.id, ...diff });
    }
  }
  for (const a of before) if (!now.has(a.id)) out.push({ area, kind: 'removed', name: a.name, id: a.id });
}

/**
 * What changed between an older skeleton and a newer one, in the order a person reads: bones, slots, skins, constraints, events, animations,
 * then the skeleton's own settings. A thing renamed shows as changed with the field "name". Nothing is returned for equal skeletons.
 */
export function diffSkeletons(before: SkeletonDoc, after: SkeletonDoc): Change[] {
  const out: Change[] = [];
  if (before === after) return out;
  const named = <T extends { name: string }>(a: T, b: T, rest: string[]): Partial<Change> | null => {
    const fields = a.name !== b.name ? ['name', ...rest] : rest;
    return fields.length ? { fields } : null;
  };
  listChanges('bone', before.bones, after.bones, (a, b) => named(a, b, boneFields(a, b)), out);
  listChanges('slot', before.slots, after.slots, (a, b) => named(a, b, slotFields(a, b)), out);
  listChanges('skin', before.skins, after.skins, (a, b) => named(a, b, skinFields(a, b)), out);
  listChanges(
    'constraint',
    before.constraints,
    after.constraints,
    (a, b) => {
      if (same(a, b)) return null;
      return { fields: a.name !== b.name ? ['name', 'settings'] : ['settings'] };
    },
    out,
  );
  listChanges('event', before.events, after.events, (a, b) => (same(a, b) ? null : { fields: ['settings'] }), out);
  listChanges(
    'animation',
    before.animations,
    after.animations,
    (a, b) => {
      const keys = animationKeyChanges(a, b);
      const fields = a.name !== b.name ? ['name'] : [];
      return keys || fields.length ? { keys: keys ?? undefined, fields: fields.length ? fields : undefined } : null;
    },
    out,
  );
  const own: string[] = [];
  if (before.fps !== after.fps) own.push('frame rate');
  if ((before.referenceScale ?? 100) !== (after.referenceScale ?? 100)) own.push('reference scale');
  if (before.name !== after.name) own.push('name');
  if (own.length) out.push({ area: 'skeleton', kind: 'changed', name: after.name, fields: own });
  return out;
}

const AREA_NAME: Record<ChangeArea, string> = {
  bone: 'Bone',
  slot: 'Slot',
  skin: 'Skin',
  constraint: 'Constraint',
  event: 'Event',
  animation: 'Animation',
  skeleton: 'Skeleton',
};

/** The list of changes as plain text, one line each, to paste into a message or a review ("+ Bone arm", "~ Animation walk (12 keys: +2 -0 ~10)"). */
export function changesToText(changes: readonly Change[]): string {
  const sign = { added: '+', removed: '-', changed: '~' } as const;
  return changes
    .map((c) => {
      let line = `${sign[c.kind]} ${AREA_NAME[c.area]} ${c.name}`;
      if (c.fields?.length) line += ` (${c.fields.join(', ')})`;
      if (c.keys) line += ` ${c.keys.added + c.keys.removed + c.keys.changed} keys: +${c.keys.added} -${c.keys.removed} ~${c.keys.changed}`;
      return line;
    })
    .join('\n');
}

/** Counts of the added, removed and changed things in a list of changes. */
export function summarizeChanges(changes: readonly Change[]): Tally {
  const t: Tally = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) t[c.kind]++;
  return t;
}

/** The next free name "Checkpoint N" among the existing ones. */
export function nextCheckpointName(list: readonly Checkpoint[]): string {
  const used = new Set(list.map((c) => c.name));
  for (let n = 1; ; n++) if (!used.has(`Checkpoint ${n}`)) return `Checkpoint ${n}`;
}

/**
 * The picture list after a checkpoint is restored: the checkpoint's pictures (so every attachment of the restored skeleton finds its picture),
 * with the size of the current entry where the name is still there (the pixels are the current ones), then the pictures that came later
 * (other skeletons of the project may use them; "Remove unused images" clears what is not needed).
 */
export function restoredImages(checkpoint: readonly ImageRef[], current: readonly ImageRef[]): ImageRef[] {
  const now = new Map(current.map((i) => [i.name, i]));
  const out = checkpoint.map((i) => now.get(i.name) ?? i);
  const names = new Set(out.map((i) => i.name));
  const ids = new Set(out.map((i) => i.id));
  for (const i of current) {
    if (names.has(i.name)) continue;
    out.push(ids.has(i.id) ? { ...i, id: uid() } : i);
  }
  return out;
}
