/**
 * Duplicate and mirror: copies bones with everything under them (child bones, their slots, the images in the slots in every skin).
 * A mirrored copy is the reflection of the original across the vertical axis of the setup pose (a left arm made from the right one).
 * Works on a draft of the skeleton; the caller supplies the setup-pose world matrices.
 */
import { decompose, freshName, normalizeBoneOrder } from './edit';
import { uid } from './ids';
import { matInvert, matMul } from './math';
import type { Mat } from './math';
import type { Attachment, Bone, Constraint, Id, SkeletonDoc, Slot } from './model';

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

/** The name of the mirrored twin: left ⇄ right, L ⇄ R, near ⇄ far; anything else gets " copy". */
export function mirrorName(name: string): string {
  const swap = (s: string, pairs: [RegExp, string][]): string | null => {
    for (const [re, to] of pairs) if (re.test(s)) return s.replace(re, to);
    return null;
  };
  const out = swap(name, [
    [/Left/, 'Right'],
    [/Right/, 'Left'],
    [/left/, 'right'],
    [/right/, 'left'],
    [/(?<=[a-z0-9_. -])L(?=[0-9]*$|[_. -])/, 'R'],
    [/(?<=[a-z0-9_. -])R(?=[0-9]*$|[_. -])/, 'L'],
    [/(^|[_. -])l(?=[0-9]*$|[_. -])/, '$1r'],
    [/(^|[_. -])r(?=[0-9]*$|[_. -])/, '$1l'],
    [/near/, 'far'],
    [/far/, 'near'],
  ]);
  return out ?? `${name} copy`;
}

export interface Duplicated {
  bones: Id[];
  slots: Id[];
  /** The constraints that were copied along (see `duplicateBones`). */
  constraints: Id[];
}

/**
 * Copies the bones (and their subtrees) in `ids`. `mats` are the setup-pose world matrices of the bones of `doc`.
 * A constraint whose constrained bones are all copied is copied too, onto the copies (Spine: duplicating a bone brings its constraints). Its
 * target (IK, path) or source (transform) is the copy when that bone or slot was copied as well, and the original otherwise. A mirrored
 * copy flips the bend direction of an IK constraint. Sliders are not copied. The keys of the constraints are not copied, like the keys of the bones.
 */
export function duplicateBones(doc: SkeletonDoc, mats: Map<Id, Mat>, ids: Id[], mirror: boolean): Duplicated {
  const byId = new Map(doc.bones.map((b) => [b.id, b] as const));
  const picked = new Set(ids.filter((id) => byId.has(id)));
  // the set to copy: the picked bones and everything below them (the root bone is never copied)
  const copy = new Set<Id>();
  for (const b of doc.bones) {
    if (b.parent === null) continue;
    if (picked.has(b.id) || (b.parent && copy.has(b.parent))) copy.add(b.id);
  }
  const clones = new Map<Id, Bone>(); // original id -> clone
  const added: Bone[] = [];
  const newWorld = new Map<Id, Mat>();
  for (const src of doc.bones) {
    if (!copy.has(src.id)) continue;
    const world = mats.get(src.id) ?? IDENTITY;
    const w2: Mat = mirror ? { a: -world.a, b: -world.b, c: world.c, d: world.d, x: -world.x, y: world.y } : world;
    const parentCopy = src.parent ? clones.get(src.parent) : undefined;
    const clone: Bone = {
      ...src,
      id: uid(),
      parent: parentCopy ? parentCopy.id : src.parent,
      name: freshName(mirror ? mirrorName(src.name) : `${src.name} copy`, [...doc.bones, ...added]),
    };
    if (mirror) {
      const parentWorld = parentCopy ? newWorld.get(src.parent!)! : (src.parent && mats.get(src.parent)) || IDENTITY;
      const local = matMul(matInvert(parentWorld), w2);
      const dec = decompose(local.a, local.b, local.c, local.d);
      Object.assign(clone, {
        x: local.x,
        y: local.y,
        rotation: dec.rotation,
        scaleX: dec.scaleX,
        scaleY: dec.scaleY,
        shearX: dec.shearX,
        shearY: dec.shearY,
        inherit: 'normal',
      });
    }
    clones.set(src.id, clone);
    newWorld.set(src.id, w2);
    added.push(clone);
  }
  doc.bones.push(...added);
  normalizeBoneOrder(doc);

  // slots of the copied bones: right after the original in the draw order, with the images of every skin
  const newSlots: Slot[] = [];
  const slotClone = new Map<Id, Slot>();
  const slotsBefore = [...doc.slots];
  for (const slot of slotsBefore) {
    const bone = clones.get(slot.bone);
    if (!bone) continue;
    const s: Slot = {
      ...slot,
      id: uid(),
      bone: bone.id,
      name: freshName(mirror ? mirrorName(slot.name) : `${slot.name} copy`, [...doc.slots, ...newSlots]),
    };
    slotClone.set(slot.id, s);
    newSlots.push(s);
  }
  const order: Slot[] = [];
  for (const slot of doc.slots) {
    order.push(slot);
    const c = slotClone.get(slot.id);
    if (c) order.push(c);
  }
  doc.slots.splice(0, doc.slots.length, ...order);
  const boneOf = (id: Id) => clones.get(id)?.id ?? id;
  const consClones = new Map<Id, Constraint>();
  for (const c of [...doc.constraints]) {
    if (c.type === 'slider') continue;
    const constrained = c.type === 'physics' ? [c.bone] : c.bones;
    if (!constrained.length || !constrained.every((b) => clones.has(b))) continue;
    const base = {
      id: uid(),
      name: freshName(mirror ? mirrorName(c.name) : `${c.name} copy`, [...doc.constraints, ...consClones.values()]),
    };
    const n = JSON.parse(JSON.stringify(c)) as Exclude<Constraint, { type: 'slider' }>;
    Object.assign(n, base);
    if (n.type === 'physics') n.bone = boneOf(n.bone);
    else {
      n.bones = n.bones.map(boneOf);
      if (n.type === 'ik') {
        n.target = boneOf(n.target);
        if (mirror) n.bendPositive = !n.bendPositive;
      } else if (n.type === 'transform') n.source = boneOf(n.source);
      else n.target = slotClone.get(n.target)?.id ?? n.target;
    }
    consClones.set(c.id, n);
  }
  doc.constraints.push(...consClones.values());
  for (const skin of doc.skins) {
    for (const [slotId, c] of slotClone) {
      const atts = skin.attachments[slotId];
      if (!atts) continue;
      const copied: Record<string, Attachment> = {};
      for (const [name, a] of Object.entries(atts)) {
        const n = JSON.parse(JSON.stringify(a)) as Attachment; // a plain copy (the document may be an immer draft)
        if ('weights' in n && n.weights)
          n.weights = n.weights.map((vertex) => vertex.map(([b, x, y, w]) => [boneOf(b), x, y, w] as [Id, number, number, number]));
        copied[name] = n;
      }
      skin.attachments[c.id] = copied;
    }
    for (const [from, c] of clones) if (skin.bones.includes(from)) skin.bones.push(c.id);
    for (const [from, c] of consClones) if (skin.constraints.includes(from)) skin.constraints.push(c.id);
  }
  return { bones: added.map((b) => b.id), slots: newSlots.map((s) => s.id), constraints: [...consClones.values()].map((c) => c.id) };
}
