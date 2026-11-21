/** Rotation limit: a clamped transform constraint plus a control bone; same result in the official runtime, edits go to the control bone. */
import { beforeEach, describe, expect, it } from 'vitest';
import { limitOfConstraint, limitRefusal, rotationLimitOf, rotationLimits } from '@/core/limits';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import { validateProject } from '@/core/validate';
import { setBonePose } from '@/store/actions';
import { addLimit, removeLimit, setLimit } from '@/store/limitActions';
import { docStore } from '@/store/doc';
import { getSetupSkeleton } from '@/store/scene';
import { uiStore } from '@/store/ui';
import { exportAndLoad } from './official';
import { parityMismatch } from './fuzzkit';

function rig() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const arm = newBone({ name: 'arm', parent: root.id, x: 10, rotation: 20, length: 80 });
  const hand = newBone({ name: 'hand', parent: arm.id, x: 80, length: 30 });
  p.skeleton.bones.push(root, arm, hand);
  const a = newAnimation('swing');
  a.duration = 2;
  a.bones[arm.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [150] },
      { time: 2, value: [-150] },
    ],
  };
  p.skeleton.animations.push(a);
  docStore.replace(p);
  uiStore.patch({ mode: 'setup', animationId: a.id });
  return { root, arm, hand, anim: a };
}

describe('rotation limit', () => {
  beforeEach(() => void rig());

  it('adds a control bone and a clamped constraint, moves the rotation keys, one undo step', () => {
    const { arm } = rig();
    const control = addLimit(arm.id, 40)!;
    expect(control).toBeTruthy();
    const doc = docStore.get().skeleton;
    const lim = rotationLimitOf(doc, arm.id)!;
    expect(lim).toMatchObject({ bone: arm.id, control, min: -20, max: 60 });
    expect(rotationLimits(doc)).toHaveLength(1);
    const anim = doc.animations[0];
    expect(anim.bones[arm.id]?.rotate).toBeUndefined();
    expect(anim.bones[control].rotate!.length).toBe(3);
    const c = doc.constraints[0];
    expect(c.type === 'transform' && c.clamp && c.localSource && c.localTarget).toBe(true);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    const back = docStore.get().skeleton;
    expect(back.constraints).toHaveLength(0);
    expect(back.bones).toHaveLength(3);
    expect(back.animations[0].bones[arm.id].rotate!.length).toBe(3);
  });

  it('keeps the limited bone inside the sector in the solver and in the official runtime', () => {
    const { arm } = rig();
    addLimit(arm.id, 40);
    expect(parityMismatch(docStore.get())).toBeNull();
  });

  it('a bone edit goes to the control bone: dragging past the sector keeps turning the control', () => {
    const { arm } = rig();
    const control = addLimit(arm.id, 40)!;
    setBonePose([{ id: arm.id, props: { rotation: 100 } }]);
    const doc = docStore.get().skeleton;
    expect(doc.bones.find((b) => b.id === control)!.rotation).toBe(100);
    const s = getSetupSkeleton();
    expect(s.boneById(arm.id)!.arotation).toBeCloseTo(60, 9);
    setBonePose([{ id: arm.id, props: { rotation: 30 } }]);
    expect(getSetupSkeleton().boneById(arm.id)!.arotation).toBeCloseTo(30, 9);
  });

  it('keys in Animate mode land on the control bone', () => {
    const { arm } = rig();
    const control = addLimit(arm.id, 40)!;
    uiStore.patch({ mode: 'animate', time: 0.5, autoKey: true });
    setBonePose([{ id: arm.id, props: { rotation: 90 } }]);
    const anim = docStore.get().skeleton.animations[0];
    expect(anim.bones[arm.id]?.rotate).toBeUndefined();
    expect(anim.bones[control].rotate!.some((k) => Math.abs(k.time - 0.5) < 1e-6)).toBe(true);
  });

  it('changes the sector, and the export is a plain transform constraint with clamp', () => {
    const { arm } = rig();
    addLimit(arm.id, 40);
    setLimit(arm.id, -10, 100);
    expect(rotationLimitOf(docStore.get().skeleton, arm.id)).toMatchObject({ min: -10, max: 100 });
    const exported = exportAndLoad(docStore.get());
    expect(exported.skeletonData.constraints.length).toBe(1);
    const json = exported.json as { constraints?: { type: string; clamp?: boolean; localSource?: boolean; localTarget?: boolean }[] };
    expect(json.constraints?.[0]).toMatchObject({ type: 'transform', clamp: true, localSource: true, localTarget: true });
    expect(parityMismatch(docStore.get())).toBeNull();
  });

  it('refuses the root bone and a second limit; remove gives the keys back', () => {
    const { root, arm } = rig();
    expect(limitRefusal(docStore.get().skeleton, root.id)).toMatch(/root/);
    const control = addLimit(arm.id, 40)!;
    expect(limitRefusal(docStore.get().skeleton, arm.id)).toMatch(/already/);
    expect(limitRefusal(docStore.get().skeleton, control)).toBeTruthy();
    removeLimit(arm.id);
    const doc = docStore.get().skeleton;
    expect(doc.constraints).toHaveLength(0);
    expect(doc.bones.some((b) => b.id === control)).toBe(false);
    expect(doc.animations[0].bones[arm.id].rotate!.length).toBe(3);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('only the exact shape counts as a limit', () => {
    const { arm } = rig();
    addLimit(arm.id, 40);
    const c = docStore.get().skeleton.constraints[0];
    if (c.type !== 'transform') throw new Error('transform expected');
    expect(limitOfConstraint(c)).not.toBeNull();
    expect(limitOfConstraint({ ...c, additive: true })).toBeNull();
    expect(limitOfConstraint({ ...c, clamp: false })).toBeNull();
    expect(limitOfConstraint({ ...c, bones: [c.bones[0], c.source] })).toBeNull();
  });
});
