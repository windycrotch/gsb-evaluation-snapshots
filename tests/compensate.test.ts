/** Compensation: the children and the pictures that are asked to stay in place do, while a bone is edited in Setup mode. */
import { describe, expect, it } from 'vitest';
import { compensateEdit, setupWorlds } from '../src/core/compensate';
import type { Compensation } from '../src/core/compensate';
import type { MeshAttachment, Project, RegionAttachment } from '../src/core/model';
import { setBonePose } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const BOTH: Compensation = { bones: true, images: true };

/** World corners of a region in the setup pose. */
function corners(doc: Project['skeleton'], slotName: string, attName: string) {
  const slot = doc.slots.find((s) => s.name === slotName)!;
  const att = doc.skins[0].attachments[slot.id][attName] as RegionAttachment;
  const w = setupWorlds(doc).get(slot.bone)!;
  const r = (att.rotation * Math.PI) / 180;
  const local = (x: number, y: number): [number, number] => [
    att.x + Math.cos(r) * att.scaleX * x - Math.sin(r) * att.scaleY * y,
    att.y + Math.sin(r) * att.scaleX * x + Math.cos(r) * att.scaleY * y,
  ];
  return [
    [0, 0],
    [att.width, 0],
    [att.width, att.height],
  ].map(([x, y]) => {
    const [lx, ly] = local(x, y);
    return [w.a * lx + w.b * ly + w.x, w.c * lx + w.d * ly + w.y];
  });
}

describe('compensateEdit', () => {
  it('children keep their world matrix while the bone is turned, moved and scaled', () => {
    const { project } = buildFixture();
    const before = project.skeleton;
    const torso = before.bones.find((b) => b.name === 'torso')!;
    const kids = before.bones.filter((b) => b.parent === torso.id && b.inherit === 'normal');
    expect(kids.length).toBeGreaterThan(0);
    const after = clone(before);
    const t = after.bones.find((b) => b.id === torso.id)!;
    t.rotation += 33;
    t.x += 17;
    t.scaleX *= 1.3;
    compensateEdit(before, after, [torso.id], { bones: true, images: false });
    const w0 = setupWorlds(before);
    const w1 = setupWorlds(after);
    for (const k of kids)
      for (const key of ['a', 'b', 'c', 'd', 'x', 'y'] as const)
        expect(w1.get(k.id)![key], `${k.name}.${key}`).toBeCloseTo(w0.get(k.id)![key], 4);
    // the bone itself did move
    expect(w1.get(torso.id)!.x).not.toBeCloseTo(w0.get(torso.id)!.x, 3);
  });

  it('without compensation nothing but the edit changes', () => {
    const { project } = buildFixture();
    const after = clone(project.skeleton);
    after.bones[1].rotation += 10;
    const copy = clone(after);
    compensateEdit(project.skeleton, after, [after.bones[1].id], { bones: false, images: false });
    expect(after).toEqual(copy);
  });

  it('pictures on the bone stay where they are in the scene', () => {
    const { project } = buildFixture();
    const before = project.skeleton;
    const slot = before.slots.find(
      (s) => before.skins[0].attachments[s.id] && Object.values(before.skins[0].attachments[s.id]).some((a) => a.type === 'region'),
    )!;
    const att = Object.values(before.skins[0].attachments[slot.id]).find((a) => a.type === 'region')!;
    const after = clone(before);
    const bone = after.bones.find((b) => b.id === slot.bone)!;
    // a turn, a move and an even scale: a picture cannot follow an uneven one (it has no shear)
    bone.rotation += 41;
    bone.x -= 9;
    bone.scaleX *= 0.8;
    bone.scaleY *= 0.8;
    compensateEdit(before, after, [bone.id], { bones: false, images: true });
    const want = corners(before, slot.name, att.name);
    const got = corners(after, slot.name, att.name);
    got.forEach((p, i) => p.forEach((v, k) => expect(v, `corner ${i}`).toBeCloseTo(want[i][k], 3)));
  });

  it('unweighted mesh vertices and points follow the same way, weighted ones are left alone', () => {
    const { project } = buildFixture();
    const before = project.skeleton;
    const worldOf = (doc: Project['skeleton'], boneId: string, x: number, y: number) => {
      const w = setupWorlds(doc).get(boneId)!;
      return [w.a * x + w.b * y + w.x, w.c * x + w.d * y + w.y];
    };
    for (const slot of before.slots) {
      for (const att of Object.values(before.skins[0].attachments[slot.id] ?? {})) {
        if (att.type !== 'mesh' || att.weights) continue;
        const after = clone(before);
        const bone = after.bones.find((b) => b.id === slot.bone)!;
        bone.rotation += 25;
        compensateEdit(before, after, [bone.id], BOTH);
        const moved = after.skins[0].attachments[slot.id][att.name] as MeshAttachment;
        const a = worldOf(before, slot.bone, att.vertices[0], att.vertices[1]);
        const b = worldOf(after, slot.bone, moved.vertices[0], moved.vertices[1]);
        expect(b[0]).toBeCloseTo(a[0], 3);
        expect(b[1]).toBeCloseTo(a[1], 3);
        return;
      }
    }
    throw new Error('the fixture has no unweighted mesh');
  });
});

describe('through setBonePose', () => {
  it('uses the compensation of the UI in Setup mode, as one history step', () => {
    const { project } = buildFixture();
    docStore.replace(project);
    uiStore.patch({ mode: 'setup', compensate: { bones: true, images: false } });
    const torso = project.skeleton.bones.find((b) => b.name === 'torso')!;
    const kid = project.skeleton.bones.find((b) => b.parent === torso.id && b.inherit === 'normal')!;
    const w0 = setupWorlds(project.skeleton).get(kid.id)!;
    setBonePose([{ id: torso.id, props: { rotation: torso.rotation + 20 } }], 'Edit bone');
    const w1 = setupWorlds(docStore.get().skeleton).get(kid.id)!;
    expect(w1.x).toBeCloseTo(w0.x, 4);
    expect(w1.a).toBeCloseTo(w0.a, 4);
    expect(docStore.get().skeleton.bones.find((b) => b.id === torso.id)!.rotation).toBeCloseTo(torso.rotation + 20, 9);
    docStore.undo();
    expect(docStore.get().skeleton.bones.find((b) => b.id === kid.id)!.rotation).toBeCloseTo(kid.rotation, 9);
    uiStore.patch({ compensate: { bones: false, images: false } });
    setBonePose([{ id: torso.id, props: { rotation: torso.rotation + 20 } }], 'Edit bone');
    expect(docStore.get().skeleton.bones.find((b) => b.id === kid.id)!.rotation).toBeCloseTo(kid.rotation, 9);
  });
});
