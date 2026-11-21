/**
 * Skin operations on a skeleton document (a draft or a plain object): copy a skin, choose which bones and constraints belong to it
 * ("skin scope", Spine's skin bones / skin constraints) and which of its attachments override the default skin's ones.
 */
import { freshName } from './edit';
import { uid } from './ids';
import type { Attachment, Id, SkeletonDoc, Skin } from './model';
import { attachmentPictures } from './sequence';

export type ScopeKind = 'bone' | 'constraint';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The default skin is the first one; it is never a scope or an override. */
const isDefaultSkin = (doc: SkeletonDoc, skinId: Id): boolean => doc.skins[0]?.id === skinId;

/**
 * Copies a skin: every attachment, the scope and the deform timelines of every animation. The copy goes right after the original
 * (never in front of the default skin). Returns the new skin, or null when there is no such skin or it is the default one.
 */
export interface DuplicateSkinOptions {
  /** The name of the copy (made unique); default "<name> copy". */
  name?: string;
  /** Copy the bones and constraints the skin brings (default true). */
  scope?: boolean;
  /** Copy the deform and sequence keys of every animation (default true). */
  animations?: boolean;
  /** A linked mesh that follows a mesh of the skin follows the one of the copy (default true); off, it keeps following the original skin. */
  relink?: boolean;
}

export function duplicateSkin(doc: SkeletonDoc, skinId: Id, opts: DuplicateSkinOptions = {}): Skin | null {
  const index = doc.skins.findIndex((s) => s.id === skinId);
  if (index <= 0) return null;
  const src = doc.skins[index];
  const wanted = opts.name?.trim();
  const keepScope = opts.scope ?? true;
  const copy: Skin = {
    id: uid(),
    name: freshName(wanted || `${src.name} copy`, doc.skins),
    attachments: clone(src.attachments),
    bones: keepScope ? [...src.bones] : [],
    constraints: keepScope ? [...src.constraints] : [],
  };
  doc.skins.splice(index + 1, 0, copy);
  // a linked mesh that follows a mesh of the skin that is copied follows the one of the copy
  if (opts.relink ?? true) {
    for (const slotId in copy.attachments)
      for (const name in copy.attachments[slotId]) {
        const att = copy.attachments[slotId][name];
        if (att.type === 'mesh' && att.link?.skin === src.id) att.link.skin = copy.id;
      }
  }
  if (!(opts.animations ?? true)) return copy;
  for (const anim of doc.animations) {
    const deform = anim.deform[src.id];
    if (deform) anim.deform[copy.id] = clone(deform);
    const sequence = anim.sequence?.[src.id];
    if (sequence) (anim.sequence ??= {})[copy.id] = clone(sequence);
  }
  return copy;
}

/**
 * Points the pictures of a skin at other pictures: `find` inside a picture name becomes `replace` (every attachment of the skin that shows a
 * region or mesh). It happens only where the new name is a picture that exists (`have`) for every picture the attachment shows, so a
 * copy of a skin never ends up with a missing picture. Returns how many attachments changed.
 */
export function repointSkinPictures(doc: SkeletonDoc, skinId: Id, find: string, replace: string, have: ReadonlySet<string>): number {
  const skin = doc.skins.find((s) => s.id === skinId);
  if (!skin || !find) return 0;
  let n = 0;
  for (const slotId in skin.attachments) {
    for (const name in skin.attachments[slotId]) {
      const att = skin.attachments[slotId][name];
      if (att.type !== 'region' && att.type !== 'mesh') continue;
      const path = att.path.split(find).join(replace);
      if (path === att.path) continue;
      if (!attachmentPictures({ ...att, path }).every((p) => have.has(p))) continue;
      att.path = path;
      n++;
    }
  }
  return n;
}

/** True when the bone, or a bone above it, is "skin required": a bone below a required one is required too (the runtime has no matrix for it otherwise). */
function boneRequiresSkin(doc: SkeletonDoc, boneId: Id): boolean {
  const byId = new Map(doc.bones.map((b) => [b.id, b] as const));
  let cur = byId.get(boneId);
  for (let steps = 0; cur && steps <= doc.bones.length; steps++) {
    if (cur.skinRequired) return true;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return false;
}

/**
 * Marks a bone or constraint as one that is only active in the skins that list it (or lifts the mark and removes it from every skin).
 * A bone drags its children along when marked, and its parents when freed, so a bone is never left active below one that is not.
 */
export function setSkinRequired(doc: SkeletonDoc, kind: ScopeKind, id: Id, required: boolean): void {
  if (kind === 'constraint') {
    const c = doc.constraints.find((x) => x.id === id);
    if (!c) return;
    c.skinRequired = required;
    if (!required) for (const skin of doc.skins) removeFrom(skin.constraints, id);
    return;
  }
  const byId = new Map(doc.bones.map((b) => [b.id, b] as const));
  const bone = byId.get(id);
  if (!bone) return;
  const touched = new Set<Id>();
  if (required) {
    // the bone and everything below it (bones come parents first)
    for (const b of doc.bones) if (b.id === id || (b.parent && touched.has(b.parent))) touched.add(b.id);
    for (const b of doc.bones) if (touched.has(b.id)) b.skinRequired = true;
  } else {
    // the bone and every bone above it
    for (let cur: typeof bone | undefined = bone, steps = 0; cur && steps <= doc.bones.length; steps++) {
      touched.add(cur.id);
      cur.skinRequired = false;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    for (const skin of doc.skins) skin.bones = skin.bones.filter((b) => !touched.has(b));
  }
}

function removeFrom(list: Id[], id: Id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Lists a bone or constraint in a skin's scope, or removes it. Only a "skin required" item can be in a scope. */
export function setSkinScope(doc: SkeletonDoc, skinId: Id, kind: ScopeKind, id: Id, on: boolean): void {
  if (isDefaultSkin(doc, skinId)) return;
  const skin = doc.skins.find((s) => s.id === skinId);
  if (!skin) return;
  const list = kind === 'bone' ? skin.bones : skin.constraints;
  if (on) {
    const allowed = kind === 'bone' ? boneRequiresSkin(doc, id) : !!doc.constraints.find((c) => c.id === id)?.skinRequired;
    if (!allowed) return;
    if (!list.includes(id)) list.push(id);
  } else {
    removeFrom(list, id);
  }
}

/** Whether a slot's attachment is overridden by a skin, comes from the default skin, or does not exist at all. */
export type OverrideState = 'own' | 'inherited' | 'none';

export function overrideState(doc: SkeletonDoc, skinId: Id, slotId: Id, name: string): OverrideState {
  const skin = doc.skins.find((s) => s.id === skinId);
  if (skin && skin !== doc.skins[0] && skin.attachments[slotId]?.[name]) return 'own';
  return doc.skins[0]?.attachments[slotId]?.[name] ? 'inherited' : 'none';
}

/**
 * Gives a skin its own copy of a default attachment (to edit or to swap its image), or drops the copy so the default shows again.
 * Returns the new state.
 */
export function toggleOverride(doc: SkeletonDoc, skinId: Id, slotId: Id, name: string): OverrideState {
  const skin = doc.skins.find((s) => s.id === skinId);
  const state = overrideState(doc, skinId, slotId, name);
  if (!skin || skin === doc.skins[0] || state === 'none') return state;
  if (state === 'own') {
    const slotAtts = skin.attachments[slotId];
    delete slotAtts[name];
    if (!Object.keys(slotAtts).length) delete skin.attachments[slotId];
    return 'inherited';
  }
  const source: Attachment = doc.skins[0].attachments[slotId][name];
  (skin.attachments[slotId] ??= {})[name] = clone(source);
  return 'own';
}

/** How many attachments a skin overrides. */
export function overrideCount(skin: Skin): number {
  let n = 0;
  for (const atts of Object.values(skin.attachments)) n += Object.keys(atts).length;
  return n;
}

export interface MergeSkinOptions {
  /** An attachment of the target with the same slot and name is replaced (default false: the one in the target stays). */
  overwrite?: boolean;
  /** The bones and constraints the skin brings join the target's (default true; the default skin has no scope). */
  scope?: boolean;
  /** The deform and sequence keys of every animation come along for the attachments that came over (default true). */
  animations?: boolean;
}

/**
 * Merges a skin into another (Spine: dropping a skin on a skin): its attachments are copied into the target, where the target has none of
 * that slot and name, or everywhere with `overwrite`. The source skin stays as it is. Returns how many attachments were added and replaced,
 * or null when a skin is missing or both are the same one.
 */
export function mergeSkin(
  doc: SkeletonDoc,
  fromId: Id,
  intoId: Id,
  opts: MergeSkinOptions = {},
): { added: number; replaced: number } | null {
  const from = doc.skins.find((s) => s.id === fromId);
  const into = doc.skins.find((s) => s.id === intoId);
  if (!from || !into || from === into) return null;
  let added = 0;
  let replaced = 0;
  const came: { slotId: Id; name: string; replaced: boolean }[] = [];
  for (const slotId of Object.keys(from.attachments)) {
    for (const name of Object.keys(from.attachments[slotId])) {
      const there = into.attachments[slotId]?.[name] !== undefined;
      if (there && !opts.overwrite) continue;
      (into.attachments[slotId] ??= {})[name] = clone(from.attachments[slotId][name]);
      if (there) replaced++;
      else added++;
      came.push({ slotId, name, replaced: there });
    }
  }
  if ((opts.scope ?? true) && !isDefaultSkin(doc, into.id)) {
    for (const b of from.bones) if (!into.bones.includes(b)) into.bones.push(b);
    for (const c of from.constraints) if (!into.constraints.includes(c)) into.constraints.push(c);
  }
  for (const anim of doc.animations) {
    for (const c of came) {
      // keys that were made for the attachment that is replaced do not fit the new one: they go, whether or not the new keys come along
      if (c.replaced) {
        if (anim.deform[into.id]?.[c.slotId]) delete anim.deform[into.id][c.slotId][c.name];
        if (anim.sequence?.[into.id]?.[c.slotId]) delete anim.sequence[into.id][c.slotId][c.name];
      }
      if (!(opts.animations ?? true)) continue;
      const deform = anim.deform[from.id]?.[c.slotId]?.[c.name];
      if (deform) ((anim.deform[into.id] ??= {})[c.slotId] ??= {})[c.name] = clone(deform);
      const seq = anim.sequence?.[from.id]?.[c.slotId]?.[c.name];
      if (seq) (((anim.sequence ??= {})[into.id] ??= {})[c.slotId] ??= {})[c.name] = clone(seq);
    }
  }
  return { added, replaced };
}
