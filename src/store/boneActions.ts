/** Bones and their pose: create, rename, delete, reparent, pose edits and keys of a bone. */
import type { Draft } from 'immer';
import { compensateEdit } from '@/core/compensate';
import { decompose, freshName, keyAt, makeCurve, normalizeBoneOrder, removeBones, upsertKey } from '@/core/edit';
import type { BoneMats } from '@/core/mesh';
import { RAD2DEG, atan2Deg, matInvert, matMul } from '@/core/math';
import type { Mat } from '@/core/math';
import { AXIS_GROUPS, newBone } from '@/core/model';
import type { Animation, AxisGroup, Bone, BoneProp, Id, Project } from '@/core/model';
import { rotationLimitOf } from '@/core/limits';
import { getScene, getSetupSkeleton } from '@/store/scene';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import type { PoseOverride } from './ui';
import { setSelection } from './sessionActions';
import { currentAnimation, skeletonDoc } from './accessors';

export interface CreateBoneInput {
  parent: Id | null;
  /** World position of the bone origin (setup pose). */
  x: number;
  y: number;
  /** World position of the bone tip. */
  tipX: number;
  tipY: number;
  name?: string;
}

/** Creates a bone from world coordinates in the setup pose. Returns its id. */
export function createBoneWorld(input: CreateBoneInput): Id | null {
  const doc = skeletonDoc();
  const parentId = input.parent ?? doc.bones[0]?.id ?? null;
  const setup = getSetupSkeleton();
  const pb = parentId ? setup.boneById(parentId) : undefined;
  let lx = input.x;
  let ly = input.y;
  const worldLen = Math.hypot(input.tipX - input.x, input.tipY - input.y);
  const worldAngle = Math.atan2(input.tipY - input.y, input.tipX - input.x);
  let rotation = worldAngle * RAD2DEG;
  let length = worldLen;
  if (pb) {
    [lx, ly] = pb.worldToLocal(input.x, input.y);
    // express the desired world direction in the parent's local frame (works for scaled / flipped / sheared parents)
    const det = pb.a * pb.d - pb.b * pb.c || 1e-9;
    const ux = Math.cos(worldAngle);
    const uy = Math.sin(worldAngle);
    const vx = (ux * pb.d - uy * pb.b) / det;
    const vy = (uy * pb.a - ux * pb.c) / det;
    rotation = atan2Deg(vy, vx);
    const r = rotation / RAD2DEG;
    const wx = pb.a * Math.cos(r) + pb.b * Math.sin(r);
    const wy = pb.c * Math.cos(r) + pb.d * Math.sin(r);
    length = worldLen / Math.max(1e-6, Math.hypot(wx, wy));
  }
  const b = newBone({
    name: input.name?.trim() ? freshName(input.name.trim(), doc.bones) : freshName('bone', doc.bones),
    parent: parentId,
    x: lx,
    y: ly,
    rotation,
    length,
  });
  docStore.update('Create bone', (d) => {
    d.skeleton.bones.push(b);
  });
  return b.id;
}

export function setBoneProps(id: Id, patch: Partial<Bone>, label = 'Edit bone') {
  docStore.update(label, (d) => {
    const b = d.skeleton.bones.find((x) => x.id === id);
    if (b) Object.assign(b, patch);
  });
}

export function renameBone(id: Id, name: string) {
  const doc = skeletonDoc();
  const clean = name.trim();
  if (!clean) return;
  const unique = freshName(
    clean,
    doc.bones.filter((b) => b.id !== id),
  );
  setBoneProps(id, { name: unique }, 'Rename bone');
}

export function deleteBones(ids: Id[]) {
  const doc = skeletonDoc();
  const roots = doc.bones.filter((b) => !b.parent).map((b) => b.id);
  const targets = ids.filter((id) => !(roots.length === 1 && roots[0] === id));
  if (!targets.length) {
    toast('The root bone cannot be deleted');
    return;
  }
  // setup-pose placement of every bone, so weighted vertices that lose all their bones stay where they are
  const bindPose: BoneMats = new Map(
    getSetupSkeleton().bones.map((b) => [b.data.id, { a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY }] as const),
  );
  docStore.update('Delete bones', (d) => {
    removeBones(d.skeleton, targets, bindPose);
  });
  const doc2 = skeletonDoc();
  const sel = uiStore.get().selection;
  setSelection({
    bones: sel.bones.filter((b) => doc2.bones.some((x) => x.id === b)),
    slot: sel.slot && doc2.slots.some((s) => s.id === sel.slot) ? sel.slot : null,
    attachment: sel.slot && doc2.slots.some((s) => s.id === sel.slot) ? sel.attachment : null,
  });
}

/** Reparents keeping the setup pose world transform. */
export function reparentBone(id: Id, newParent: Id | null) {
  const doc = skeletonDoc();
  const bone = doc.bones.find((b) => b.id === id);
  if (!bone || bone.parent === newParent) return;
  // the second bone of a two-bone IK must stay a child of the first one
  const chain = doc.constraints.find((c) => c.type === 'ik' && c.bones.length === 2 && c.bones[1] === id);
  if (chain) {
    toast(`"${bone.name}" is part of the IK constraint "${chain.name}" — remove the constraint to move it`, 'error');
    return;
  }
  if (newParent === null && doc.bones.some((b) => !b.parent && b.id !== id))
    newParent = doc.bones.find((b) => !b.parent && b.id !== id)!.id;
  // cycles
  if (newParent) {
    let p: Bone | undefined = doc.bones.find((b) => b.id === newParent);
    while (p) {
      if (p.id === id) {
        toast('A bone cannot become its own descendant', 'error');
        return;
      }
      p = p.parent ? doc.bones.find((b) => b.id === p!.parent) : undefined;
    }
  }
  const setup = getSetupSkeleton();
  const sb = setup.boneById(id);
  const sp = newParent ? setup.boneById(newParent) : undefined;
  if (!sb) return;
  const world: Mat = { a: sb.a, b: sb.b, c: sb.c, d: sb.d, x: sb.worldX, y: sb.worldY };
  const parent: Mat = sp ? { a: sp.a, b: sp.b, c: sp.c, d: sp.d, x: sp.worldX, y: sp.worldY } : { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
  const local = matMul(matInvert(parent), world);
  const dec = decompose(local.a, local.b, local.c, local.d);
  docStore.update('Reparent bone', (d) => {
    const b = d.skeleton.bones.find((x) => x.id === id)!;
    b.parent = newParent;
    b.x = local.x;
    b.y = local.y;
    b.rotation = dec.rotation;
    b.scaleX = dec.scaleX;
    b.scaleY = dec.scaleY;
    b.shearX = dec.shearX;
    b.shearY = dec.shearY;
    b.inherit = 'normal';
    normalizeBoneOrder(d.skeleton);
  });
}

export type PoseProps = PoseOverride;

/** The timeline a pose property is keyed on: one axis each, which a bone with a combined timeline keys together with the other axis. */
const POSE_TIMELINE: Record<keyof PoseProps, BoneProp> = {
  rotation: 'rotate',
  x: 'translatex',
  y: 'translatey',
  scaleX: 'scalex',
  scaleY: 'scaley',
  shearX: 'shearx',
  shearY: 'sheary',
};

export function ensureBoneTimelines(a: Draft<Animation>, id: Id) {
  return (a.bones[id] ??= {});
}

/** Writes keys for the given bone pose props at `time` into an animation draft. */
function keyBoneInDraft(
  d: Draft<Project>,
  anim: Draft<Animation>,
  boneId: Id,
  pose: Required<PoseProps>,
  touched: Set<BoneProp>,
  time: number,
  curveKind: 'linear' | 'bezier' | 'stepped',
) {
  const setup = d.skeleton.bones.find((b) => b.id === boneId);
  if (!setup) return;
  // a bone with a rotation limit is rotated by its control bone: the key goes there (the limited bone's own rotation is overwritten by the constraint)
  const limit = touched.has('rotate') ? rotationLimitOf(d.skeleton, boneId) : null;
  if (limit) {
    const cp = currentPose(limit.control);
    if (cp)
      keyBoneInDraft(
        d,
        anim,
        limit.control,
        { ...cp, ...uiStore.get().overrides[limit.control] },
        new Set<BoneProp>(['rotate']),
        time,
        curveKind,
      );
    touched = new Set([...touched].filter((t) => t !== 'rotate'));
    if (!touched.size) return;
  }
  const tl = ensureBoneTimelines(anim, boneId);
  const key = (channels: number, value: number[]) => ({
    time,
    value,
    ...(makeCurve(curveKind, channels) !== undefined ? { curve: makeCurve(curveKind, channels) } : {}),
  });
  const put = (prop: BoneProp, value: number[]) => {
    const keys = (tl[prop] ??= []);
    const k = key(value.length, value);
    const exist = keyAt(keys, time);
    if (exist) exist.value = value;
    else upsertKey(keys, k);
  };
  if (touched.has('rotate')) put('rotate', [pose.rotation - setup.rotation]);
  const values: Record<AxisGroup, [number, number]> = {
    translate: [pose.x - setup.x, pose.y - setup.y],
    scale: [setup.scaleX !== 0 ? pose.scaleX / setup.scaleX : 1, setup.scaleY !== 0 ? pose.scaleY / setup.scaleY : 1],
    shear: [pose.shearX - setup.shearX, pose.shearY - setup.shearY],
  };
  for (const g of Object.keys(AXIS_GROUPS) as AxisGroup[]) {
    const [ax, ay] = AXIS_GROUPS[g];
    const all = touched.has(g);
    const wantX = all || touched.has(ax);
    const wantY = all || touched.has(ay);
    if (!wantX && !wantY) continue;
    // a bone whose group was split keys the axes on their own timelines; otherwise the combined timeline takes both values
    if (tl[ax]?.length || tl[ay]?.length) {
      if (wantX) put(ax, [values[g][0]]);
      if (wantY) put(ay, [values[g][1]]);
    } else put(g, values[g]);
  }
}

/**
 * The rotation of a bone with a rotation limit is the control bone's, clamped by the constraint: an edit of that rotation is applied to the control
 * bone, so dragging past the sector keeps turning the control (the bone waits at the end of its sector and follows as soon as the control is back).
 */
function routeLimited(updates: { id: Id; props: PoseProps }[]): { id: Id; props: PoseProps }[] {
  const doc = skeletonDoc();
  if (!updates.some((u) => u.props.rotation !== undefined)) return updates;
  const out: { id: Id; props: PoseProps }[] = [];
  for (const u of updates) {
    const limit = u.props.rotation !== undefined ? rotationLimitOf(doc, u.id) : null;
    if (!limit) {
      out.push(u);
      continue;
    }
    const { rotation, ...rest } = u.props;
    if (Object.keys(rest).length) out.push({ id: u.id, props: rest });
    const existing = out.find((x) => x.id === limit.control);
    if (existing) existing.props = { ...existing.props, rotation };
    else out.push({ id: limit.control, props: { rotation } });
  }
  return out;
}

/** Current local pose of a bone (setup + animation + overrides). */
export function currentPose(id: Id): Required<PoseProps> | null {
  const b = getScene().skeleton.boneById(id);
  if (!b) return null;
  return { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY };
}

/**
 * Sets local pose values of bones. In Setup mode edits the setup pose; in Animate mode writes keyframes at the playhead
 * (auto-key) or holds a temporary override until keyed.
 */
export function setBonePose(updates: { id: Id; props: PoseProps }[], label = 'Edit pose') {
  const ui = uiStore.get();
  if (!updates.length) return;
  updates = routeLimited(updates);
  if (ui.mode === 'setup') {
    const before = skeletonDoc();
    const comp = ui.compensate;
    docStore.update(label, (d) => {
      for (const u of updates) {
        const b = d.skeleton.bones.find((x) => x.id === u.id);
        if (b) Object.assign(b, u.props);
      }
      // Compensation: the children and the pictures that were asked to stay in place get new local values
      if (comp.bones || comp.images)
        compensateEdit(
          before,
          d.skeleton,
          updates.map((u) => u.id),
          comp,
        );
    });
    return;
  }
  const anim = currentAnimation();
  if (!anim) {
    toast('Create an animation first');
    return;
  }
  if (!ui.autoKey) {
    const overrides = { ...ui.overrides };
    for (const u of updates) overrides[u.id] = { ...overrides[u.id], ...u.props };
    uiStore.patch({ overrides });
    return;
  }
  const time = ui.time;
  const prepared = updates
    .map((u) => {
      const cur = currentPose(u.id);
      if (!cur) return null;
      const pose = { ...cur, ...u.props };
      const touched = new Set<BoneProp>();
      for (const k of Object.keys(u.props) as (keyof PoseProps)[]) touched.add(POSE_TIMELINE[k]);
      return { id: u.id, pose, touched };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const p of prepared) keyBoneInDraft(d, a, p.id, p.pose, p.touched, time, ui.defaultCurve);
    extendDuration(a, time);
  });
}

export function extendDuration(a: Draft<Animation>, time: number) {
  if (time > a.duration) a.duration = time;
}

type Channel = BoneProp;

/** The transform channels a temporary pose edit touched (an override holds only the properties that were changed). */
export function editedChannels(o: PoseProps | undefined): Set<Channel> {
  const out = new Set<Channel>();
  if (o) for (const k of Object.keys(o) as (keyof PoseProps)[]) if (o[k] !== undefined) out.add(POSE_TIMELINE[k]);
  return out;
}

/**
 * Key Edited (Spine's K): keys only the channels that were changed since the last key, for the bones that have such edits (with Auto-key off an edit
 * is a pending pose until keyed). Rotating a bone keys its rotation and leaves translate, scale and shear alone. With nothing pending it keys
 * every channel of the selected bones, like Key Shown, so the key still does something when Auto-key has already keyed everything.
 */
export function keyEditedBones() {
  const ui = uiStore.get();
  if (!currentAnimation() || ui.mode !== 'animate') return;
  const pending = Object.keys(ui.overrides).filter((id) => editedChannels(ui.overrides[id]).size > 0);
  if (!pending.length) {
    keySelectedBones();
    return;
  }
  keyBonesChannels(
    pending.map((id) => ({ id, channels: editedChannels(ui.overrides[id]) })),
    'Key edited',
  );
}

function keyBonesChannels(list: { id: Id; channels: Set<Channel> }[], label: string) {
  const ui = uiStore.get();
  const anim = currentAnimation();
  if (!anim || ui.mode !== 'animate') return;
  const time = ui.time;
  const prepared = list
    .map(({ id, channels }) => {
      const cur = currentPose(id);
      return cur ? { id, channels, pose: { ...cur, ...ui.overrides[id] } } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!prepared.length) return;
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const p of prepared) keyBoneInDraft(d, a, p.id, p.pose, p.channels, time, ui.defaultCurve);
    extendDuration(a, time);
  });
  uiStore.patch({ overrides: {} });
}

/**
 * Key Constrained: keys the pose the selected bones have after the constraints (IK, transform, path, physics, sliders), as the viewport shows
 * it now, instead of their own local pose. With it a physics motion or an IK pose is baked into ordinary keys one frame at a time.
 */
export function keyConstrainedBones() {
  const ui = uiStore.get();
  const anim = currentAnimation();
  if (!anim || ui.mode !== 'animate') return;
  if (!ui.selection.bones.length) {
    toast('Select a bone to key');
    return;
  }
  const time = ui.time;
  const skeleton = getScene().skeleton;
  const prepared = ui.selection.bones
    .map((id) => {
      const b = skeleton.boneById(id);
      if (!b) return null;
      b.validateApplied();
      // the turn nearest to the rotation the bone has on its own, so that a key does not spin the bone a whole turn
      const rotation = b.rotation + ((((b.arotation - b.rotation + 180) % 360) + 360) % 360) - 180;
      return { id, pose: { x: b.ax, y: b.ay, rotation, scaleX: b.ascaleX, scaleY: b.ascaleY, shearX: b.ashearX, shearY: b.ashearY } };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!prepared.length) return;
  docStore.update('Key constrained', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const p of prepared)
      keyBoneInDraft(d, a, p.id, p.pose, new Set<BoneProp>(['rotate', 'translate', 'scale', 'shear']), time, ui.defaultCurve);
    extendDuration(a, time);
  });
  uiStore.patch({ overrides: {} });
}

/** Keys the current pose of the selected bones (all four transform timelines or a subset). */
export function keySelectedBones(which: BoneProp[] = ['rotate', 'translate', 'scale', 'shear']) {
  const ui = uiStore.get();
  const anim = currentAnimation();
  if (!anim || ui.mode !== 'animate') return;
  const ids = ui.selection.bones;
  if (!ids.length) {
    toast('Select a bone to key');
    return;
  }
  const time = ui.time;
  const prepared = ids
    .map((id) => {
      const cur = currentPose(id);
      return cur ? { id, pose: { ...cur, ...ui.overrides[id] } } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  docStore.update('Key bones', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const p of prepared) keyBoneInDraft(d, a, p.id, p.pose, new Set(which), time, ui.defaultCurve);
    extendDuration(a, time);
  });
  uiStore.patch({ overrides: {} });
}
