/** Duplicating bones brings the constraints that act on them. */
import { describe, expect, it } from 'vitest';
import { duplicateBones } from '../src/core/duplicate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import type { Mat } from '../src/core/math';
import { newPathConstraint, newPhysicsConstraint, newTransformConstraint } from '../src/core/model';
import type { IkConstraint, PathConstraint, TransformConstraint } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import { buildFixture } from './fixture';

/** The setup-pose world matrices of every bone. */
function mats(doc: ReturnType<typeof buildFixture>['project']['skeleton']): Map<string, Mat> {
  const sk = createSkeleton(compileSkeleton(doc));
  sk.setToSetupPose();
  sk.updateWorldTransform('none');
  return new Map(sk.bones.map((b) => [b.data.id, { a: b.a, b: b.c, c: b.b, d: b.d, x: b.worldX, y: b.worldY }]));
}

const byName = (doc: { bones: { id: string; name: string }[] }, name: string) => doc.bones.find((b) => b.name === name)!;

describe('duplicateBones and constraints', () => {
  it('copies an IK constraint whose bones are all copied, onto the copies, with the target shared or copied', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const leg = doc.constraints.find((c) => c.name === 'leg ik') as IkConstraint;
    const upper = byName(doc, 'legUpper');
    const before = doc.constraints.length;
    const m = mats(doc);
    const made = duplicateBones(doc, m, [upper.id], false);
    expect(made.constraints).toHaveLength(1);
    expect(doc.constraints).toHaveLength(before + 1);
    const copy = doc.constraints.find((c) => c.id === made.constraints[0]) as IkConstraint;
    expect(copy.type).toBe('ik');
    expect(copy.name).toBe('leg ik copy');
    expect(copy.bones.every((id) => made.bones.includes(id))).toBe(true);
    expect(copy.target).toBe(leg.target); // the target was not copied: it stays the same bone
    expect(copy.bendPositive).toBe(leg.bendPositive);
    expect(copy.id).not.toBe(leg.id);
    // the original is untouched
    expect(leg.bones).toEqual([upper.id, byName(doc, 'legLower').id]);
  });

  it('a mirrored copy flips the bend of an IK constraint and follows a copied target', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const leg = doc.constraints.find((c) => c.name === 'leg ik') as IkConstraint;
    const made = duplicateBones(doc, mats(doc), [byName(doc, 'legUpper').id, leg.target], true);
    const copy = doc.constraints.find((c) => c.id === made.constraints[0]) as IkConstraint;
    expect(copy.bendPositive).toBe(!leg.bendPositive);
    expect(made.bones).toContain(copy.target);
    expect(copy.target).not.toBe(leg.target);
  });

  it('does not copy a constraint that has a bone that is not copied', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const before = doc.constraints.length;
    // only the lower leg: the two-bone constraint needs both
    const made = duplicateBones(doc, mats(doc), [byName(doc, 'legLower').id], false);
    expect(made.constraints).toEqual([]);
    expect(doc.constraints).toHaveLength(before);
  });

  it('copies transform, path and physics constraints with their own fields', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const tail = byName(doc, 'tail');
    const src = byName(doc, 'footTarget');
    const slot = doc.slots[0];
    const t = newTransformConstraint({ name: 'tx', bones: [tail.id], source: src.id });
    t.mix.rotate = 0.5;
    const p = newPathConstraint({ name: 'pth', bones: [tail.id], target: slot.id });
    p.position = 0.3;
    const ph = newPhysicsConstraint({ name: 'phy', bone: tail.id });
    ph.mass = 2;
    doc.constraints.push(t, p, ph);
    const made = duplicateBones(doc, mats(doc), [tail.id], false);
    const copies = made.constraints.map((id) => doc.constraints.find((c) => c.id === id)!);
    expect(copies.map((c) => c.type).sort()).toEqual(['ik', 'path', 'physics', 'transform']);
    const tc = copies.find((c) => c.type === 'transform') as TransformConstraint;
    expect(tc.bones).toEqual(made.bones.slice(0, 1));
    expect(tc.source).toBe(src.id);
    expect(tc.mix.rotate).toBe(0.5);
    const pc = copies.find((c) => c.type === 'path') as PathConstraint;
    expect(pc.position).toBe(0.3);
    expect(copies.find((c) => c.type === 'physics')).toMatchObject({ mass: 2, bone: made.bones[0] });
  });

  it('keeps the document valid and adds the copy to the skins that list the original', () => {
    const f = buildFixture();
    const doc = f.project.skeleton;
    const leg = doc.constraints.find((c) => c.name === 'leg ik')!;
    doc.skins[0].constraints.push(leg.id);
    const made = duplicateBones(doc, mats(doc), [byName(doc, 'legUpper').id], false);
    expect(doc.skins[0].constraints).toContain(made.constraints[0]);
    expect(validateProject(f.project)).toEqual([]);
    expect(() => createSkeleton(compileSkeleton(doc))).not.toThrow();
  });
});
