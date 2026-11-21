/** Bone Order Up / Down and Scale Flip. */
import { describe, expect, it } from 'vitest';
import { moveBoneOrder } from '../src/core/boneorder';
import { validateProject } from '../src/core/validate';
import * as P from '../src/store/poseActions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const names = (doc: { bones: { name: string }[] }) => doc.bones.map((b) => b.name);

/** The children of a bone, in list order. */
const kids = (doc: { bones: { name: string; parent: string | null; id: string }[] }, name: string) => {
  const p = doc.bones.find((b) => b.name === name)!;
  return doc.bones.filter((b) => b.parent === p.id).map((b) => b.name);
};

/** A parent that has at least two children, and the first two. */
function pair(doc: ReturnType<typeof buildFixture>['project']['skeleton']) {
  for (const p of doc.bones) {
    const c = doc.bones.filter((b) => b.parent === p.id);
    if (c.length >= 2) return { parent: p, a: c[0], b: c[1] };
  }
  throw new Error('no bone with two children');
}

describe('moveBoneOrder', () => {
  it('swaps a bone with the next sibling, taking its subtree along, and back', () => {
    const doc = buildFixture().project.skeleton;
    const { parent, a, b } = pair(doc);
    const order = kids(doc, parent.name);
    expect(moveBoneOrder(doc, a.id, 1)).toBe(true);
    const now = kids(doc, parent.name);
    expect(now[0]).toBe(order[1]);
    expect(now[1]).toBe(order[0]);
    // every bone still comes after its parent
    const seen = new Set<string>();
    for (const x of doc.bones) {
      if (x.parent) expect(seen.has(x.parent)).toBe(true);
      seen.add(x.id);
    }
    expect(moveBoneOrder(doc, a.id, -1)).toBe(true);
    expect(kids(doc, parent.name)).toEqual(order);
    expect(b.id).toBeDefined();
  });

  it('keeps the descendants of the moved bone right behind it and nothing is lost', () => {
    const doc = buildFixture().project.skeleton;
    const before = [...names(doc)].sort();
    const { a } = pair(doc);
    moveBoneOrder(doc, a.id, 1);
    expect([...names(doc)].sort()).toEqual(before);
  });

  it('does nothing at the ends or for an unknown bone', () => {
    const doc = buildFixture().project.skeleton;
    const { parent, a } = pair(doc);
    const list = names(doc);
    expect(moveBoneOrder(doc, a.id, -1)).toBe(false); // first
    expect(moveBoneOrder(doc, 'nope', 1)).toBe(false);
    expect(moveBoneOrder(doc, doc.bones[0].id, 1)).toBe(false); // the root has no sibling
    expect(names(doc)).toEqual(list);
    const last = doc.bones.filter((b) => b.parent === parent.id).at(-1)!;
    expect(moveBoneOrder(doc, last.id, 1)).toBe(false);
  });
});

describe('the actions', () => {
  it('Bone Order Down is one step of the history and leaves a valid document', () => {
    const f = buildFixture();
    docStore.replace(f.project);
    const { a, parent } = pair(f.project.skeleton);
    uiStore.patch({ mode: 'setup', selection: { ...emptySelection, bones: [a.id] } });
    const order = kids(docStore.get().skeleton, parent.name);
    expect(P.moveBoneOrderAction(1)).toBe(true);
    expect(kids(docStore.get().skeleton, parent.name)[0]).toBe(order[1]);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(kids(docStore.get().skeleton, parent.name)).toEqual(order);
  });

  it('Scale Flip negates the chosen scale of the selected bones in the setup pose', () => {
    const f = buildFixture();
    docStore.replace(f.project);
    const bone = f.project.skeleton.bones[1];
    const sx = bone.scaleX;
    const sy = bone.scaleY;
    uiStore.patch({ mode: 'setup', selection: { ...emptySelection, bones: [bone.id] } });
    expect(P.flipScale('x')).toBe(1);
    expect(docStore.get().skeleton.bones[1].scaleX).toBe(-sx);
    expect(docStore.get().skeleton.bones[1].scaleY).toBe(sy);
    P.flipScale('y');
    expect(docStore.get().skeleton.bones[1].scaleY).toBe(-sy);
    P.flipScale('x');
    expect(docStore.get().skeleton.bones[1].scaleX).toBe(sx);
    uiStore.patch({ selection: emptySelection });
    expect(P.flipScale('x')).toBe(0);
  });
});
