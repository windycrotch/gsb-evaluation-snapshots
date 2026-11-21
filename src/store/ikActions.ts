/** IK constraint creation and editing. */
import { freshName, makeCurve, upsertKey } from '@/core/edit';
import { uid } from '@/core/ids';
import type { Id, IkConstraint, IkKey } from '@/core/model';
import { newBone } from '@/core/model';
import { getScene, getSetupSkeleton } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

export function isDescendant(boneId: Id, ancestorId: Id): boolean {
  const doc = docStore.get().skeleton;
  let cur = doc.bones.find((b) => b.id === boneId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parent ? doc.bones.find((b) => b.id === cur!.parent) : undefined;
  }
  return false;
}

/**
 * IK from a drag gesture: `endBone` is the tip of the chain, the target is an existing bone or a new bone at (x, y).
 * Chains two bones when the end bone's parent is not the root (limbs), unless `single` is set.
 */
export function createIkFromDrag(endBone: Id, targetBone: Id | null, x: number, y: number, single = false): Id | null {
  const doc = docStore.get().skeleton;
  const end = doc.bones.find((b) => b.id === endBone);
  if (!end) return null;
  const parent = end.parent ? doc.bones.find((b) => b.id === end.parent) : undefined;
  const chain = !single && parent && parent.parent ? [parent.id, end.id] : [end.id];
  if (!doc.bones.find((b) => b.id === chain[0])?.parent) {
    // the official runtimes load such a file and then crash on the first frame (the IK solver reads the bone's parent)
    toast('The root bone cannot be constrained by IK', 'error');
    return null;
  }
  if (targetBone && chain.some((b) => isDescendant(targetBone, b))) {
    toast('The target cannot be a child of the constrained bones', 'error');
    return null;
  }
  const rootId = doc.bones.find((b) => !b.parent)?.id ?? null;
  let target = targetBone;
  const constraintId = uid();
  const setup = getSetupSkeleton();
  // choose the bend direction that matches the current pose
  const bendPositive = chain.length === 2 ? (setup.boneById(chain[1])?.rotation ?? 0) >= 0 : true;
  const cname = freshName(`${end.name} ik`, doc.constraints);
  let newTarget: ReturnType<typeof newBone> | null = null;
  if (!target) {
    const rootSetup = rootId ? setup.boneById(rootId) : undefined;
    const [lx, ly] = rootSetup ? rootSetup.worldToLocal(x, y) : [x, y];
    newTarget = newBone({
      name: freshName(`${end.name} target`, doc.bones),
      parent: rootId,
      x: lx,
      y: ly,
      length: 0,
      color: [1, 0.48, 0.35, 1],
    });
    target = newTarget.id;
  }
  const c: IkConstraint = {
    id: constraintId,
    type: 'ik',
    name: cname,
    bones: chain,
    target,
    mix: 1,
    softness: 0,
    bendPositive,
    compress: false,
    stretch: false,
    scaleY: 'none',
    skinRequired: false,
  };
  docStore.update('Create IK', (d) => {
    if (newTarget) d.skeleton.bones.push(newTarget);
    d.skeleton.constraints.push(c);
  });
  setSelection({ constraint: c.id });
  toast(`IK constraint "${cname}" created`, 'ok');
  return c.id;
}

export function deleteConstraint(id: Id) {
  docStore.update('Delete constraint', (d) => {
    d.skeleton.constraints = d.skeleton.constraints.filter((c) => c.id !== id);
    for (const s of d.skeleton.skins) s.constraints = s.constraints.filter((x) => x !== id);
    for (const a of d.skeleton.animations) {
      delete a.ik[id];
      delete a.transform[id];
      delete a.slider[id];
      delete a.path?.[id];
      delete a.physics?.[id];
    }
  });
  setSelection({});
}

export function moveConstraint(id: Id, dir: -1 | 1) {
  docStore.update('Reorder constraint', (d) => {
    const list = d.skeleton.constraints;
    const i = list.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  });
}

export function renameConstraint(id: Id, name: string) {
  const clean = name.trim();
  if (!clean) return;
  const doc = docStore.get().skeleton;
  const unique = freshName(
    clean,
    doc.constraints.filter((c) => c.id !== id),
  );
  docStore.update('Rename constraint', (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (c) c.name = unique;
  });
}

/** Structural properties (target / chain) are setup-only. */
export function setConstraintSetup(id: Id, patch: Partial<IkConstraint>, label = 'Edit constraint') {
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  });
}

export interface IkValues {
  mix: number;
  softness: number;
  bendPositive: boolean;
  compress: boolean;
  stretch: boolean;
}

/** Current (animated) values of a constraint. */
export function currentIkValues(id: Id): IkValues | null {
  const c = getScene().skeleton.ikById(id);
  if (!c) return null;
  return { mix: c.mix, softness: c.softness, bendPositive: c.bendDirection > 0, compress: c.compress, stretch: c.stretch };
}

/** Edits IK values: setup defaults in Setup mode, a key at the playhead in Animate mode. */
export function setIkValues(id: Id, patch: Partial<IkValues>, label = 'Edit IK') {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    setConstraintSetup(id, patch, label);
    return;
  }
  const scene = getScene();
  const anim = scene.animation;
  const cur = currentIkValues(id);
  if (!anim || !cur) return;
  const v = { ...cur, ...patch };
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const keys = (a.ik[id] ??= []);
    const exist = keys.find((k) => Math.abs(k.time - ui.time) < 1e-4);
    if (exist) {
      exist.value = [v.mix, v.softness];
      exist.bendPositive = v.bendPositive;
      exist.compress = v.compress;
      exist.stretch = v.stretch;
    } else {
      const curve = makeCurve(ui.defaultCurve, 2);
      const key: IkKey = {
        time: ui.time,
        value: [v.mix, v.softness],
        bendPositive: v.bendPositive,
        compress: v.compress,
        stretch: v.stretch,
        ...(curve !== undefined ? { curve } : {}),
      };
      upsertKey(keys, key);
    }
    if (ui.time > a.duration) a.duration = ui.time;
  });
}
