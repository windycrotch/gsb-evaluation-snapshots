/** Set Parent: pick, then click the new parent. Bones stay where they are; a slot changes bone; one history step. */
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyProject, newBone } from '@/core/model';
import { getSetupSkeleton } from '@/store/scene';
import { applyParent, cancelSetParent, startSetParent } from '@/store/parentActions';
import { docStore } from '@/store/doc';
import { setSelection } from '@/store/actions';
import { uiStore } from '@/store/ui';

function rig() {
  const p = emptyProject();
  const root = newBone({ name: 'root' });
  const a = newBone({ name: 'a', parent: root.id, x: 50, length: 40 });
  const b = newBone({ name: 'b', parent: root.id, x: 0, y: 60, length: 30, rotation: 20 });
  const c = newBone({ name: 'c', parent: root.id, x: -30, length: 20 });
  p.skeleton.bones.push(root, a, b, c);
  docStore.replace(p);
  uiStore.patch({
    mode: 'setup',
    pickParent: false,
    selection: { bones: [], slot: null, attachment: null, constraint: null, vertices: [] },
  });
  return { root, a, b, c };
}
const world = (id: string) => {
  const s = getSetupSkeleton().boneById(id)!;
  return [s.worldX, s.worldY, s.a, s.b];
};

describe('set parent', () => {
  beforeEach(() => void rig());

  it('needs a selection and the setup mode', () => {
    expect(startSetParent()).toBe(false);
    const { a } = rig();
    setSelection({ bones: [a.id] });
    uiStore.patch({ mode: 'animate' });
    expect(startSetParent()).toBe(false);
    uiStore.patch({ mode: 'setup' });
    expect(startSetParent()).toBe(true);
    expect(uiStore.get().pickParent).toBe(true);
    expect(cancelSetParent()).toBe(true);
    expect(uiStore.get().pickParent).toBe(false);
    expect(cancelSetParent()).toBe(false);
  });

  it('gives every selected bone the clicked bone as parent, keeps their world pose, one undo step', () => {
    const { a, b, c } = rig();
    const before = [world(a.id), world(b.id)];
    setSelection({ bones: [a.id, b.id] });
    const undo0 = docStore.canUndo;
    startSetParent();
    applyParent(c.id);
    const doc = docStore.get().skeleton;
    expect(doc.bones.find((x) => x.id === a.id)!.parent).toBe(c.id);
    expect(doc.bones.find((x) => x.id === b.id)!.parent).toBe(c.id);
    const after = [world(a.id), world(b.id)];
    for (let i = 0; i < 2; i++) for (let k = 0; k < 4; k++) expect(after[i][k]).toBeCloseTo(before[i][k], 6);
    expect(uiStore.get().pickParent).toBe(false);
    docStore.undo();
    expect(docStore.get().skeleton.bones.find((x) => x.id === a.id)!.parent).not.toBe(c.id);
    expect(docStore.get().skeleton.bones.find((x) => x.id === b.id)!.parent).not.toBe(c.id);
    expect(docStore.canUndo).toBe(undo0);
  });

  it('refuses a cycle and ignores the clicked bone itself', () => {
    const { a, b } = rig();
    setSelection({ bones: [a.id] });
    startSetParent();
    applyParent(b.id);
    setSelection({ bones: [b.id] });
    startSetParent();
    applyParent(a.id); // a is now b's child: b cannot go under a
    expect(docStore.get().skeleton.bones.find((x) => x.id === b.id)!.parent).not.toBe(a.id);
    setSelection({ bones: [a.id] });
    startSetParent();
    applyParent(a.id);
    expect(docStore.get().skeleton.bones.find((x) => x.id === a.id)!.parent).toBe(b.id);
  });
});
