/**
 * Compensation (Spine's Compensation buttons of the Setup tools): when a bone is moved, rotated or scaled in Setup mode, its child bones can stay
 * where they are in the scene, and so can the pictures on it. Without it the whole branch follows the bone, which is what a hierarchy does.
 * Pure functions over the document; the caller hands over the document before the edit and the one after it.
 */
import { decompose } from './edit';
import { matInvert, matMul } from './math';
import type { Mat } from './math';
import type { Attachment, Id, SkeletonDoc } from './model';
import { compileSkeleton, createSkeleton } from './skeleton';

export interface Compensation {
  /** Children of the edited bone keep their place in the scene. */
  bones: boolean;
  /** The pictures (and points, meshes, outlines) on the edited bone keep their place in the scene. */
  images: boolean;
}

export const NO_COMPENSATION: Compensation = { bones: false, images: false };

const RAD = Math.PI / 180;

/**
 * The world matrix of every bone in the setup pose, by id, from the bone hierarchy alone: the constraints are left out, because what a bone
 * keeps in place is its own place in the hierarchy (an IK that moves it afterwards would be counted twice).
 */
export function setupWorlds(doc: SkeletonDoc): Map<Id, Mat> {
  const bare: SkeletonDoc = { ...doc, constraints: [], skins: doc.skins.map((k) => ({ ...k, constraints: [] })) };
  const sk = createSkeleton(compileSkeleton(bare));
  sk.setToSetupPose();
  sk.updateWorldTransform('none');
  return new Map(
    doc.bones.map((b) => {
      const live = sk.boneById(b.id)!;
      return [b.id, { a: live.a, b: live.b, c: live.c, d: live.d, x: live.worldX, y: live.worldY }] as const;
    }),
  );
}

/** A matrix that can be undone: finite, and not flat. */
const invertible = (m: Mat) => [m.a, m.b, m.c, m.d, m.x, m.y].every(Number.isFinite) && Math.abs(m.a * m.d - m.b * m.c) > 1e-9;
const finiteMat = (m: Mat) => [m.a, m.b, m.c, m.d, m.x, m.y].every(Number.isFinite);

const apply = (m: Mat, x: number, y: number): [number, number] => [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];

/** Moves the points of an attachment by the matrix `m` (old bone space to new bone space). Weighted shapes follow their bones and are left alone. */
function moveAttachment(att: Attachment, m: Mat) {
  if (att.type === 'region') {
    const r = att.rotation * RAD;
    const local: Mat = {
      a: Math.cos(r) * att.scaleX,
      b: -Math.sin(r) * att.scaleY,
      c: Math.sin(r) * att.scaleX,
      d: Math.cos(r) * att.scaleY,
      x: att.x,
      y: att.y,
    };
    const next = matMul(m, local);
    const dec = decompose(next.a, next.b, next.c, next.d);
    att.x = next.x;
    att.y = next.y;
    att.rotation = dec.rotation;
    att.scaleX = dec.scaleX;
    att.scaleY = dec.scaleY;
    return;
  }
  if (att.type === 'point') {
    const [x, y] = apply(m, att.x, att.y);
    att.x = x;
    att.y = y;
    att.rotation += Math.atan2(m.c, m.a) / RAD;
    return;
  }
  const shape = att as { vertices?: number[]; weights?: unknown };
  if (shape.weights || !Array.isArray(shape.vertices)) return;
  for (let i = 0; i + 1 < shape.vertices.length; i += 2)
    [shape.vertices[i], shape.vertices[i + 1]] = apply(m, shape.vertices[i], shape.vertices[i + 1]);
}

/**
 * After the bones `edited` got new local values in `after` (a document that is changed in place), puts back what `comp` asks to keep:
 * the child bones that are not edited themselves get the local transform that leaves their world matrix as `before` had it (only
 * the ones that inherit normally: the other inherit modes do not follow a simple matrix product), and the attachments on the edited
 * bones are moved by the opposite of what the bone did.
 */
export function compensateEdit(before: SkeletonDoc, after: SkeletonDoc, edited: readonly Id[], comp: Compensation): void {
  if (!comp.bones && !comp.images) return;
  const was = setupWorlds(before);
  const now = setupWorlds(JSON.parse(JSON.stringify(after)) as SkeletonDoc);
  const set = new Set(edited);
  if (comp.bones) {
    for (const child of after.bones) {
      if (!child.parent || !set.has(child.parent) || set.has(child.id) || child.inherit !== 'normal') continue;
      const parent = now.get(child.parent);
      const world = was.get(child.id);
      if (!parent || !world || !invertible(parent)) continue;
      const local = matMul(matInvert(parent), world);
      if (!finiteMat(local)) continue;
      const dec = decompose(local.a, local.b, local.c, local.d);
      child.x = local.x;
      child.y = local.y;
      child.rotation = dec.rotation;
      child.scaleX = dec.scaleX;
      child.scaleY = dec.scaleY;
      child.shearX = dec.shearX;
      child.shearY = dec.shearY;
    }
  }
  if (comp.images) {
    for (const id of set) {
      const w0 = was.get(id);
      const w1 = now.get(id);
      if (!w0 || !w1 || !invertible(w1)) continue;
      const m = matMul(matInvert(w1), w0);
      if (!finiteMat(m)) continue;
      const slots = new Set(after.slots.filter((s) => s.bone === id).map((s) => s.id));
      for (const skin of after.skins)
        for (const slotId of slots) for (const att of Object.values(skin.attachments[slotId] ?? {})) moveAttachment(att, m);
    }
  }
}
