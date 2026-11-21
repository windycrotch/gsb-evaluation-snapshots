/** The pose library: blending, repairing a damaged one, and the editor actions that keep, apply and change poses. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BonePose } from '../src/core/model';
import { blendPose, newPoseName, repairPoses } from '../src/core/poses';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as PO from '../src/store/poseActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const pose = (over: Partial<BonePose> = {}): BonePose => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, ...over });

describe('blendPose', () => {
  it('is the current pose at 0 and the kept pose at 1', () => {
    const a = pose({ x: 10, rotation: 20 });
    const b = pose({ x: 30, rotation: 60, scaleX: 2 });
    expect(blendPose(a, b, 0)).toEqual(a);
    expect(blendPose(a, b, 1)).toEqual(b);
    const half = blendPose(a, b, 0.5);
    expect([half.x, half.rotation, half.scaleX]).toEqual([20, 40, 1.5]);
  });

  it('turns the short way round the circle, not through a full turn', () => {
    const half = blendPose(pose({ rotation: 170 }), pose({ rotation: -170 }), 0.5);
    expect(half.rotation).toBeCloseTo(180, 9);
    const back = blendPose(pose({ rotation: -170 }), pose({ rotation: 170 }), 0.25);
    expect(back.rotation).toBeCloseTo(-175, 9);
  });

  it('keeps the amount between 0 and 1', () => {
    const a = pose({ x: 0 });
    const b = pose({ x: 10 });
    expect(blendPose(a, b, 2).x).toBe(10);
    expect(blendPose(a, b, -1).x).toBe(0);
  });
});

describe('repairPoses', () => {
  it('leaves a good library alone', () => {
    const list = [{ id: 'a', name: 'Guard', bones: { arm: pose({ rotation: 30 }) } }];
    const out = repairPoses(structuredClone(list));
    expect(out.notes).toEqual([]);
    expect(out.poses).toEqual(list);
  });

  it('drops what is damaged and makes names and ids unique', () => {
    const out = repairPoses([
      { id: 'a', name: 'Guard', bones: { arm: pose() } },
      { id: 'a', name: 'Guard', bones: { arm: pose(), leg: { x: NaN } } },
      { id: 'c', name: 'Empty', bones: {} },
      { name: 5, bones: {} },
      null,
    ]);
    expect(out.poses.map((p) => p.name)).toEqual(['Guard', 'Guard2']);
    expect(new Set(out.poses.map((p) => p.id)).size).toBe(2);
    expect(Object.keys(out.poses[1].bones)).toEqual(['arm']); // the bone with NaN went
    expect(out.notes.length).toBeGreaterThan(3);
    expect(repairPoses('no').poses).toEqual([]);
  });

  it('is run when a project is repaired', () => {
    const f = buildFixture();
    f.project.poses = [{ id: 'p', name: 'Bad', bones: { x: { x: 1 } as unknown as BonePose } }];
    expect(validateProject(f.project).some((m) => /Bad/.test(m))).toBe(true);
  });

  it('names a new pose after the ones there are', () => {
    expect(newPoseName([], 'Wave')).toBe('Wave');
    expect(newPoseName([{ id: '1', name: 'Wave', bones: {} }], 'Wave')).toBe('Wave2');
    expect(newPoseName([], '  ')).toBe('Pose');
  });
});

describe('keeping and applying poses', () => {
  const doc = () => docStore.get().skeleton;
  const boneByName = (n: string) => doc().bones.find((b) => b.name === n)!;
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'setup',
      tool: 'select',
      animationId: f.project.skeleton.animations[0].id,
      skinId: null,
      time: 0,
      selection: emptySelection,
      overrides: {},
      autoKey: true,
      playing: false,
    });
  });

  it('keeps the pose of the selected bones by name and puts it back after the bones moved', () => {
    const arm = doc().bones[1];
    A.selectBone(arm.id);
    A.setBonePose([{ id: arm.id, props: { rotation: 33, x: 7 } }]);
    const kept = PO.savePose('Guard')!;
    expect(kept.name).toBe('Guard');
    expect(Object.keys(kept.bones)).toEqual([arm.name]);
    A.setBonePose([{ id: arm.id, props: { rotation: -50, x: 0 } }]);
    expect(PO.applyPose(kept.id)).toBe(1);
    expect(boneByName(arm.name).rotation).toBeCloseTo(33, 9);
    expect(boneByName(arm.name).x).toBeCloseTo(7, 9);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('applies part of the way, only to the selected bones, and only those the pose knows', () => {
    const [, a, b] = doc().bones;
    A.setSelection({ bones: [a.id] });
    A.setBonePose([{ id: a.id, props: { rotation: 80 } }]);
    const kept = PO.savePose()!;
    A.setBonePose([{ id: a.id, props: { rotation: 0 } }]);
    A.setSelection({ bones: [a.id, b.id] });
    expect(PO.applyPose(kept.id, 0.25)).toBe(1); // b is not in the pose
    expect(boneByName(a.name).rotation).toBeCloseTo(20, 9);
    A.setSelection({ bones: [b.id] });
    expect(PO.applyPose(kept.id)).toBe(0);
  });

  it('keys the bones at the playhead in Animate mode', () => {
    const arm = doc().bones[1];
    A.selectBone(arm.id);
    A.setBonePose([{ id: arm.id, props: { rotation: 40 } }]);
    const kept = PO.savePose('Wave')!;
    A.setMode('animate');
    A.setTime(0.5);
    PO.applyPose(kept.id);
    const keys = doc().animations[0].bones[arm.id]?.rotate ?? [];
    expect(keys.some((k) => Math.abs(k.time - 0.5) < 1e-3)).toBe(true);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('renames (unique), replaces, deletes, and undoes', () => {
    A.selectBone(doc().bones[1].id);
    const one = PO.savePose('Guard')!;
    const two = PO.savePose('Guard')!;
    expect(two.name).toBe('Guard2');
    PO.renamePose(two.id, 'Guard');
    expect(docStore.get().poses!.find((p) => p.id === two.id)!.name).toBe('Guard2'); // taken, so it keeps a unique one
    PO.renamePose(two.id, 'Wave');
    expect(docStore.get().poses!.map((p) => p.name)).toEqual(['Guard', 'Wave']);
    A.setBonePose([{ id: doc().bones[1].id, props: { rotation: 99 } }]);
    PO.overwritePose(one.id);
    expect(docStore.get().poses![0].bones[doc().bones[1].name].rotation).toBe(99);
    PO.deletePose(one.id);
    expect(docStore.get().poses!.map((p) => p.name)).toEqual(['Wave']);
    docStore.undo();
    expect(docStore.get().poses!.map((p) => p.name)).toEqual(['Guard', 'Wave']);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('does not reach the export of the skeleton', () => {
    A.selectBone(doc().bones[1].id);
    PO.savePose('Guard');
    expect(() => exportAndLoad(docStore.get())).not.toThrow();
  });
});
