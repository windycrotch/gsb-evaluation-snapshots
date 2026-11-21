/**
 * Degenerate poses (a bone scaled to exactly 0) are legal in the editor: the official runtime turns them into NaN for the whole
 * subtree, ours stays finite and the editor tools never write NaN into the document (found by the random sessions).
 */
import { describe, expect, it } from 'vitest';
import { newAnimation, newBone, newTransformConstraint, emptyProject } from '../src/core/model';
import type { Inherit } from '../src/core/model';
import { applyAnimation } from '../src/core/animate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';

const INHERITS: Inherit[] = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];

function rig(inherit: Inherit, parentScaleX: number, parentScaleY = 1) {
  const project = emptyProject('degenerate');
  const doc = project.skeleton;
  const root = doc.bones[0];
  const parent = newBone({
    name: 'parent',
    parent: root.id,
    x: 20,
    y: 5,
    rotation: 90,
    scaleX: parentScaleX,
    scaleY: parentScaleY,
    length: 40,
  });
  const child = newBone({ name: 'child', parent: parent.id, x: 30, y: 10, rotation: 20, scaleX: 1.5, scaleY: 1.2, inherit, length: 20 });
  const grand = newBone({ name: 'grand', parent: child.id, x: 10, length: 10 });
  const source = newBone({ name: 'source', parent: root.id, x: 100, length: 10 });
  doc.bones.push(parent, child, grand, source);
  // a transform constraint applied to the child in world and in local space: both convert world <-> local through the parent
  doc.constraints.push(
    newTransformConstraint({
      name: 'follow',
      bones: [child.id],
      source: source.id,
      properties: [{ prop: 'x', offset: 0, to: [{ prop: 'rotate', offset: 0, max: 45, scale: 0.5 }] }],
    }),
  );
  doc.constraints.push(
    newTransformConstraint({
      name: 'follow local',
      bones: [child.id],
      source: source.id,
      localSource: true,
      localTarget: true,
      properties: [{ prop: 'x', offset: 0, to: [{ prop: 'scaleX', offset: 0, max: 2, scale: 0.01 }] }],
    }),
  );
  const anim = newAnimation('a', 1);
  doc.animations.push(anim);
  return { project, doc, parent, child };
}

describe('collapsed bones', () => {
  for (const inherit of INHERITS) {
    for (const [sx, sy] of [
      [0, 1],
      [1, 0],
      [0, 0],
    ]) {
      it(`a child with inherit "${inherit}" under a parent scaled to (${sx}, ${sy}) stays finite`, () => {
        const { doc } = rig(inherit, sx, sy);
        const sk = createSkeleton(compileSkeleton(doc));
        applyAnimation(sk, doc.animations[0], 0.5);
        sk.updateWorldTransform();
        for (const b of sk.bones)
          for (const v of [b.a, b.b, b.c, b.d, b.worldX, b.worldY])
            expect(Number.isFinite(v), `${b.data.name} ${inherit} (${sx}, ${sy})`).toBe(true);
      });
    }
  }

  it('worldToLocal of a collapsed bone is the local origin, not NaN', () => {
    const { doc } = rig('normal', 0, 0);
    const sk = createSkeleton(compileSkeleton(doc));
    sk.updateWorldTransform();
    const parent = sk.bones.find((b) => b.data.name === 'parent')!;
    expect(parent.worldToLocal(100, 50)).toEqual([0, 0]);
    const normal = sk.bones.find((b) => b.data.name === 'source')!;
    const [x, y] = normal.worldToLocal(normal.worldX + 3, normal.worldY);
    expect(x).toBeCloseTo(3, 6);
    expect(y).toBeCloseTo(0, 6);
  });
});
