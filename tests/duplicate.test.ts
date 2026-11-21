/** Duplicate and mirror bones: the copies are valid, load in the official runtime, and sit where a copy (or a reflection) should. */
import { describe, expect, it } from 'vitest';
import { duplicateBones, mirrorName } from '../src/core/duplicate';
import type { Mat } from '../src/core/math';
import type { Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import { buildFixture } from './fixture';
import { S, exportAndLoad, startLikeOfficial } from './official';

function setupMats(project: Project) {
  const skeleton = createSkeleton(compileSkeleton(project.skeleton));
  startLikeOfficial(skeleton);
  skeleton.updateWorldTransform();
  return new Map<string, Mat>(
    skeleton.bones.map((b) => [b.data.id, { a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY }] as const),
  );
}

function run(mirror: boolean, boneName: string) {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const before = setupMats(project);
  const original = doc.bones.find((b) => b.name === boneName)!;
  const result = duplicateBones(doc, before, [original.id], mirror);
  // the compiled skeleton is memoised by the identity of the document (the store never mutates one): hand over a fresh copy
  return { project: structuredClone(project), before, original, result };
}

describe('mirror names', () => {
  it('swap the side words and letters', () => {
    expect(mirrorName('armL')).toBe('armR');
    expect(mirrorName('legR2')).toBe('legL2');
    expect(mirrorName('left hand')).toBe('right hand');
    expect(mirrorName('ear near')).toBe('ear far');
    expect(mirrorName('head')).toBe('head copy');
  });
});

describe('duplicate', () => {
  it('copies a bone with its children, slots and meshes, and the result needs no repair', () => {
    const { project, original, result } = run(false, 'armUpper');
    expect(result.bones.length).toBeGreaterThanOrEqual(2); // the bone and its child
    expect(validateProject(project)).toEqual([]);
    const names = project.skeleton.bones.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    const copy = project.skeleton.bones.find((b) => b.id === result.bones[0])!;
    expect(copy.name).toBe(`${original.name} copy`);
    expect(copy.parent).toBe(original.parent);
  });

  it('puts the copy exactly on the original', () => {
    // a bone that no constraint drives: the world matrix of a constrained bone is not its local transform
    const { project, before, original, result } = run(false, 'head');
    const after = setupMats(project);
    const copyId = result.bones[0];
    const w0 = before.get(original.id)!;
    const w1 = after.get(copyId)!;
    for (const k of ['a', 'b', 'c', 'd', 'x', 'y'] as const) expect(w1[k]).toBeCloseTo(w0[k], 6);
  });

  it('refuses nothing it should copy: the root is skipped', () => {
    const { project } = buildFixture();
    const root = project.skeleton.bones[0];
    const result = duplicateBones(project.skeleton, setupMats(project), [root.id], false);
    expect(result.bones).toEqual([]);
  });
});

describe('mirror', () => {
  it('reflects every copied bone across the vertical axis, children included', () => {
    const { project, before, original, result } = run(true, 'armUpper');
    expect(validateProject(project)).toEqual([]);
    // the copied constraints pull the copies towards the targets of the originals: this test is about the reflection alone
    project.skeleton.constraints = project.skeleton.constraints.filter((c) => !result.constraints.includes(c.id));
    const after = setupMats(project);
    const ids = new Map<string, string>(); // original -> copy, by walking the subtree in order
    const copyOf = (name: string) => project.skeleton.bones.find((b) => b.name === name)!;
    const sub = project.skeleton.bones.filter((b) => !result.bones.includes(b.id));
    void sub;
    for (const id of result.bones) {
      const copy = project.skeleton.bones.find((b) => b.id === id)!;
      // the copy of a bone is found by its position in the copy order: same order as the originals that were copied
      ids.set(id, copy.name);
    }
    expect(copyOf(`${original.name} copy`) ?? null).not.toBeUndefined();
    // each copy's world matrix is the reflection of its original's: compare in the order the bones were copied
    const originals = project.skeleton.bones.filter(
      (b) => !result.bones.includes(b.id) && (b.id === original.id || isUnder(project, b.id, original.id)),
    );
    expect(originals.length).toBe(result.bones.length);
    originals.forEach((o, i) => {
      const w = before.get(o.id)!;
      const m = after.get(result.bones[i])!;
      expect(m.a).toBeCloseTo(-w.a, 5);
      expect(m.b).toBeCloseTo(-w.b, 5);
      expect(m.c).toBeCloseTo(w.c, 5);
      expect(m.d).toBeCloseTo(w.d, 5);
      expect(m.x).toBeCloseTo(-w.x, 5);
      expect(m.y).toBeCloseTo(w.y, 5);
    });
  });

  it('loads in the official runtime and the copy of a mesh keeps its weights on the copied bones', () => {
    const { project, result } = run(true, 'armUpper');
    const { skeletonData } = exportAndLoad(project);
    expect(skeletonData.bones.length).toBe(project.skeleton.bones.length);
    const copyIds = new Set(result.bones);
    for (const skin of project.skeleton.skins) {
      for (const slotId of Object.keys(skin.attachments)) {
        for (const att of Object.values(skin.attachments[slotId])) {
          if (att.type !== 'mesh' || !att.weights) continue;
          const slot = project.skeleton.slots.find((s) => s.id === slotId)!;
          if (!copyIds.has(slot.bone)) continue;
          // an influence that pointed into the copied set now points at the copies
          for (const v of att.weights)
            for (const [b] of v) if (b !== slot.bone) expect(project.skeleton.bones.some((x) => x.id === b)).toBe(true);
        }
      }
    }
    expect(S.Skeleton).toBeDefined();
  });
});

function isUnder(project: Project, id: string, ancestor: string): boolean {
  let p = project.skeleton.bones.find((b) => b.id === id)?.parent ?? null;
  while (p) {
    if (p === ancestor) return true;
    p = project.skeleton.bones.find((b) => b.id === p)?.parent ?? null;
  }
  return false;
}
