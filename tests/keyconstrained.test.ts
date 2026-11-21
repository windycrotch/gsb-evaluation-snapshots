/** Key Constrained: a key on the pose a bone has after the constraints, so that it holds without them. */
import { describe, expect, it } from 'vitest';
import { getScene } from '../src/store/scene';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

function session(time: number, boneName: string) {
  const f = buildFixture();
  docStore.replace(f.project);
  const doc = f.project.skeleton;
  const anim = doc.animations.find((a) => a.name === 'walk')!;
  const bone = doc.bones.find((b) => b.name === boneName)!;
  uiStore.patch({
    mode: 'animate',
    animationId: anim.id,
    selection: { ...emptySelection, bones: [bone.id] },
    overrides: {},
    muted: [],
    time,
    playing: false,
    autoKey: false,
  });
  return { doc, anim, bone };
}

/** The pose a bone has after everything is applied (rotation folded into one turn). */
function applied(id: string) {
  const b = getScene().skeleton.boneById(id)!;
  b.validateApplied();
  return { x: b.ax, y: b.ay, rot: ((b.arotation % 360) + 360) % 360, sx: b.ascaleX, sy: b.ascaleY, shx: b.ashearX, shy: b.ashearY };
}

describe('keyConstrainedBones', () => {
  it('keys the pose the IK gives, so the bone holds it with the constraints off', () => {
    const { bone, anim } = session(0.3, 'legLower');
    const want = applied(bone.id);
    A.keyConstrainedBones();
    const now = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!;
    expect(now.bones[bone.id].rotate!.some((k) => Math.abs(k.time - 0.3) < 1e-4)).toBe(true);
    // every constraint off: the keys alone give the same pose
    uiStore.patch({ muted: docStore.get().skeleton.constraints.map((c) => c.id) });
    const got = applied(bone.id);
    expect(got.x).toBeCloseTo(want.x, 3);
    expect(got.y).toBeCloseTo(want.y, 3);
    expect(got.rot).toBeCloseTo(want.rot, 3);
    expect(got.sx).toBeCloseTo(want.sx, 4);
    expect(got.sy).toBeCloseTo(want.sy, 4);
    expect(got.shx).toBeCloseTo(want.shx, 3);
    expect(got.shy).toBeCloseTo(want.shy, 3);
  });

  it('is one step of the history', () => {
    const { bone, anim } = session(0.3, 'legLower');
    A.keyConstrainedBones();
    docStore.undo();
    const back = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!;
    expect((back.bones[bone.id]?.rotate ?? []).some((k) => Math.abs(k.time - 0.3) < 1e-4)).toBe(false);
  });

  it('does nothing in Setup mode or with nothing selected', () => {
    const { anim } = session(0.3, 'legLower');
    const before = JSON.stringify(docStore.get().skeleton.animations.find((a) => a.id === anim.id));
    uiStore.patch({ selection: emptySelection });
    A.keyConstrainedBones();
    uiStore.patch({ mode: 'setup' });
    A.keyConstrainedBones();
    expect(JSON.stringify(docStore.get().skeleton.animations.find((a) => a.id === anim.id))).toBe(before);
  });
});
