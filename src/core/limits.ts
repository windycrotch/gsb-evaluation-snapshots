/**
 * Rotation limit of a bone (a sector it may swing in).
 *
 * Spine has no limit on a bone, but 4.3's transform constraint can clamp: a control bone is read by its local rotation and a transform
 * constraint writes it to the limited bone's local rotation, clamped to min..max. Nothing here is a new kind of data: a limit is recognized
 * by the shape of that constraint, so it is exported (and runs in every runtime) exactly like one built by hand.
 *
 * The animator moves the control bone; the limited bone follows inside the sector.
 */
import { freshName, normalizeBoneOrder, removeBones } from './edit';
import type { Bone, Id, SkeletonDoc, TransformConstraint } from './model';
import { newBone, newTransformConstraint } from './model';

export interface RotationLimit {
  constraint: Id;
  /** The bone that is limited and the bone that drives it. */
  bone: Id;
  control: Id;
  min: number;
  max: number;
}

/** Whether a transform constraint is shaped like a rotation limit: one bone, local rotation to local rotation, 1:1, clamped. */
export function limitOfConstraint(c: TransformConstraint): RotationLimit | null {
  if (!c.clamp || !c.localSource || !c.localTarget || c.additive || c.bones.length !== 1) return null;
  if (c.properties.length !== 1) return null;
  const from = c.properties[0];
  if (from.prop !== 'rotate' || from.to.length !== 1) return null;
  const to = from.to[0];
  if (to.prop !== 'rotate' || to.scale !== 1 || from.offset !== to.offset || !(to.max > to.offset)) return null;
  if (c.offsets.rotation !== 0 || c.mix.rotate !== 1) return null;
  return { constraint: c.id, bone: c.bones[0], control: c.source, min: to.offset, max: to.max };
}

export function rotationLimitOf(doc: SkeletonDoc, bone: Id): RotationLimit | null {
  for (const c of doc.constraints) {
    if (c.type !== 'transform') continue;
    const l = limitOfConstraint(c);
    if (l && l.bone === bone) return l;
  }
  return null;
}

/** The limit whose control bone is `bone`. */
export function limitDrivenBy(doc: SkeletonDoc, bone: Id): RotationLimit | null {
  for (const c of doc.constraints) {
    if (c.type !== 'transform') continue;
    const l = limitOfConstraint(c);
    if (l && l.control === bone) return l;
  }
  return null;
}

/** Every rotation limit of a document. */
export function rotationLimits(doc: SkeletonDoc): RotationLimit[] {
  const out: RotationLimit[] = [];
  for (const c of doc.constraints) {
    if (c.type !== 'transform') continue;
    const l = limitOfConstraint(c);
    if (l) out.push(l);
  }
  return out;
}

/** Why a bone cannot get a limit, or null when it can. */
export function limitRefusal(doc: SkeletonDoc, bone: Id): string | null {
  const b = doc.bones.find((x) => x.id === bone);
  if (!b) return 'The bone is gone';
  if (!b.parent) return 'The root bone has nothing to swing against: add the limit to a child bone';
  if (rotationLimitOf(doc, bone)) return `"${b.name}" already has a rotation limit`;
  if (limitDrivenBy(doc, bone)) return `"${b.name}" is the control bone of a rotation limit`;
  return null;
}

/** The rotation clamped to the sector. */
function clampToSector(r: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, r));
}

/**
 * Adds a limit (to a draft of the document): a control bone beside `boneId` and the constraint. The bone's rotation keys move to the control bone,
 * so every animation plays as before, inside the sector. Returns the control bone, or null when it is refused.
 */
export function addRotationLimit(doc: SkeletonDoc, boneId: Id, min: number, max: number): Id | null {
  if (limitRefusal(doc, boneId)) return null;
  if (!(max > min)) return null;
  const bone = doc.bones.find((b) => b.id === boneId)!;
  const control: Bone = newBone({
    name: freshName(`${bone.name} control`, doc.bones),
    parent: bone.parent,
    x: bone.x,
    y: bone.y,
    rotation: bone.rotation,
    length: Math.max(8, bone.length * 0.5),
    color: [...bone.color] as Bone['color'],
  });
  doc.bones.push(control);
  const c = newTransformConstraint({
    name: freshName(`${bone.name} limit`, doc.constraints),
    bones: [boneId],
    source: control.id,
    localSource: true,
    localTarget: true,
    clamp: true,
    properties: [{ prop: 'rotate', offset: min, to: [{ prop: 'rotate', offset: min, max, scale: 1 }] }],
  });
  doc.constraints.push(c);
  bone.rotation = clampToSector(bone.rotation, min, max);
  for (const a of doc.animations) {
    const tl = a.bones[boneId];
    if (tl?.rotate?.length) {
      (a.bones[control.id] ??= {}).rotate = tl.rotate;
      delete tl.rotate;
    }
  }
  normalizeBoneOrder(doc);
  return control.id;
}

/** Changes the sector of a limited bone (to a draft). */
export function setRotationLimitRange(doc: SkeletonDoc, boneId: Id, min: number, max: number): boolean {
  if (!(max > min)) return false;
  const l = rotationLimitOf(doc, boneId);
  if (!l) return false;
  const c = doc.constraints.find((x) => x.id === l.constraint);
  if (!c || c.type !== 'transform') return false;
  c.properties[0].offset = min;
  c.properties[0].to[0].offset = min;
  c.properties[0].to[0].max = max;
  return true;
}

/**
 * Removes the limit (from a draft): the control bone goes and the animations' rotation keys go back to the limited bone.
 */
export function removeRotationLimit(doc: SkeletonDoc, boneId: Id): boolean {
  const l = rotationLimitOf(doc, boneId);
  if (!l) return false;
  const control = doc.bones.find((b) => b.id === l.control);
  const bone = doc.bones.find((b) => b.id === boneId);
  // the keys that move back are relative to the control bone's setup rotation, so the bone takes it over
  if (control && bone) bone.rotation = control.rotation;
  for (const a of doc.animations) {
    const tl = a.bones[l.control];
    if (tl?.rotate?.length) (a.bones[boneId] ??= {}).rotate = tl.rotate;
  }
  doc.constraints = doc.constraints.filter((c) => c.id !== l.constraint);
  for (const skin of doc.skins) skin.constraints = skin.constraints.filter((c) => c !== l.constraint);
  for (const a of doc.animations) delete a.transform?.[l.constraint];
  if (control) removeBones(doc, [control.id]);
  return true;
}
