/** Chain curve: one physics value per bone along a curve; constraints are created for the bones that lack one. */
import { beforeEach, describe, expect, it } from 'vitest';
import { chainBones, chainValues, shapeAt } from '@/core/chains';
import { emptyProject, newBone } from '@/core/model';
import type { PhysicsConstraint } from '@/core/model';
import { applyChainCurve } from '@/store/chainActions';
import { docStore } from '@/store/doc';
import { uiStore } from '@/store/ui';

function tail() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const t1 = newBone({ name: 't1', parent: root.id, length: 20 });
  const t2 = newBone({ name: 't2', parent: t1.id, x: 20, length: 20 });
  const t3 = newBone({ name: 't3', parent: t2.id, x: 20, length: 20 });
  const t4 = newBone({ name: 't4', parent: t3.id, x: 20, length: 20 });
  p.skeleton.bones.push(root, t1, t2, t3, t4);
  docStore.replace(p);
  uiStore.patch({ mode: 'setup' });
  return { root, t1, t2, t3, t4 };
}
const physicsOf = (id: string) =>
  docStore.get().skeleton.constraints.find((c): c is PhysicsConstraint => c.type === 'physics' && c.bone === id);

describe('chain curve', () => {
  beforeEach(() => void tail());

  it('curve shapes start at 0, end at 1 and bend the way they are named', () => {
    for (const s of ['linear', 'in', 'out', 'smooth'] as const) {
      expect(shapeAt(0, s, 2)).toBeCloseTo(0, 9);
      expect(shapeAt(1, s, 2)).toBeCloseTo(1, 9);
    }
    expect(shapeAt(0.5, 'in', 2)).toBeLessThan(0.5);
    expect(shapeAt(0.5, 'out', 2)).toBeGreaterThan(0.5);
    expect(shapeAt(0.5, 'smooth', 3)).toBeCloseTo(0.5, 9);
  });

  it('values: first and last as asked, one bone gets the first, nothing for none', () => {
    expect(chainValues(4, 300, 60, 'linear', 1)).toEqual([300, 220, 140, 60]);
    expect(chainValues(1, 5, 9, 'linear', 1)).toEqual([5]);
    expect(chainValues(0, 5, 9, 'linear', 1)).toEqual([]);
    const v = chainValues(5, 0, 1, 'in', 2);
    expect(v[2]).toBeLessThan(0.5);
  });

  it('chain of a bone: it and its descendants along the first child; several selected: in hierarchy order', () => {
    const { root, t1, t2, t3, t4 } = tail();
    const doc = docStore.get().skeleton;
    expect(chainBones(doc, [t2.id])).toEqual([t2.id, t3.id, t4.id]);
    expect(chainBones(doc, [root.id])).toEqual([root.id, t1.id, t2.id, t3.id, t4.id]);
    expect(chainBones(doc, [t4.id, t2.id])).toEqual([t2.id, t4.id]);
  });

  it('creates the missing physics constraints, skips the root, sets the values, one undo step', () => {
    const { root, t1, t2, t3, t4 } = tail();
    const n = applyChainCurve(chainBones(docStore.get().skeleton, [root.id]), {
      param: 'strength',
      from: 300,
      to: 60,
      shape: 'linear',
      power: 1,
      create: true,
    });
    expect(n).toBe(4);
    expect(physicsOf(root.id)).toBeUndefined();
    expect([t1, t2, t3, t4].map((b) => physicsOf(b.id)!.strength)).toEqual([300, 220, 140, 60]);
    docStore.undo();
    expect(docStore.get().skeleton.constraints).toHaveLength(0);
  });

  it('without "create" only existing constraints change; damping stays within 0..1', () => {
    const { t1, t2, t3 } = tail();
    applyChainCurve([t1.id, t2.id, t3.id], { param: 'damping', from: 0.9, to: 0.7, shape: 'linear', power: 1, create: true });
    const before = docStore.get().skeleton.constraints.length;
    const n = applyChainCurve([t1.id, t2.id, t3.id], { param: 'damping', from: 4, to: -2, shape: 'linear', power: 1, create: false });
    expect(n).toBe(3);
    expect(docStore.get().skeleton.constraints.length).toBe(before);
    expect(physicsOf(t1.id)!.damping).toBe(1);
    expect(physicsOf(t3.id)!.damping).toBe(0);
    const { t4 } = tail();
    expect(applyChainCurve([t4.id], { param: 'mix', from: 1, to: 1, shape: 'linear', power: 1, create: false })).toBe(0);
  });
});
