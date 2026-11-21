/** Split bone: lengths, nested chain and side-by-side siblings, children follow in the nested case, one history step. */
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyProject, newBone, newSlot } from '@/core/model';
import type { IkConstraint } from '@/core/model';
import type { MeshAttachment } from '@/core/model';
import { meshWorldPositions } from '@/core/mesh';
import { partShares, splitLengths } from '@/core/split';
import { validateProject } from '@/core/validate';
import { getSetupSkeleton } from '@/store/scene';
import { docStore } from '@/store/doc';
import { splitBone } from '@/store/splitActions';
import { uiStore } from '@/store/ui';

function rig() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const arm = newBone({ name: 'arm', parent: root.id, x: 10, y: 5, rotation: 30, length: 100 });
  const hand = newBone({ name: 'hand', parent: arm.id, x: 100, length: 20 });
  const mid = newBone({ name: 'mid', parent: arm.id, x: 55, y: 7, rotation: 10, length: 10 });
  p.skeleton.bones.push(root, arm, hand, mid);
  docStore.replace(p);
  uiStore.patch({ mode: 'setup' });
  return { root, arm, hand, mid };
}
const tip = (name: string) => {
  const s = getSetupSkeleton();
  const b = s.bones.find((x) => x.data.name === name)!;
  return [b.worldX, b.worldY, b.a, b.c];
};

describe('split bone', () => {
  beforeEach(() => void rig());

  it('lengths add up: equal and Fibonacci (longest first)', () => {
    expect(splitLengths(90, 3, false)).toEqual([30, 30, 30]);
    const f = splitLengths(120, 5, true);
    expect(f.map((x) => Math.round(x * 100) / 100)).toEqual([50, 30, 20, 10, 10]);
    expect(f.reduce((s, x) => s + x, 0)).toBeCloseTo(120, 9);
  });

  it('nested: a chain along the original, same total length and direction, one undo step', () => {
    const { arm } = rig();
    const undo0 = docStore.canUndo;
    const ids = splitBone(arm.id, 4, { nested: true, fibonacci: false });
    expect(ids.length).toBe(3);
    const bones = docStore.get().skeleton.bones;
    expect(bones.find((b) => b.id === arm.id)!.length).toBeCloseTo(25, 9);
    expect(bones.find((b) => b.id === ids[0])!.parent).toBe(arm.id);
    expect(bones.find((b) => b.id === ids[1])!.parent).toBe(ids[0]);
    expect(bones.find((b) => b.id === ids[2])!.parent).toBe(ids[1]);
    // the last part starts 75 along the arm and ends at the old tip
    const armW = tip('arm');
    const last = getSetupSkeleton().boneById(ids[2])!;
    expect(last.worldX).toBeCloseTo(armW[0] + 75 * armW[2], 6);
    expect(last.worldY).toBeCloseTo(armW[1] + 75 * armW[3], 6);
    const tipLen = Math.hypot(last.worldX + last.a * 25 - (armW[0] + 100 * armW[2]), last.worldY + last.c * 25 - (armW[1] + 100 * armW[3]));
    expect(tipLen).toBeCloseTo(0, 6);
    docStore.undo();
    expect(docStore.get().skeleton.bones.length).toBe(4);
    expect(docStore.get().skeleton.bones.find((b) => b.id === arm.id)!.length).toBe(100);
    expect(docStore.canUndo).toBe(undo0);
  });

  it('nested: children move to the part they sit on and stay where they are in the world', () => {
    const { arm, hand, mid } = rig();
    const before = [tip('hand'), tip('mid')];
    const ids = splitBone(arm.id, 4, { nested: true, fibonacci: false });
    const bones = docStore.get().skeleton.bones;
    expect(bones.find((b) => b.id === hand.id)!.parent).toBe(ids[2]);
    expect(bones.find((b) => b.id === mid.id)!.parent).toBe(ids[1]); // x = 55 sits on the third part (50..75)
    const after = [tip('hand'), tip('mid')];
    for (let i = 0; i < 2; i++) for (let k = 0; k < 4; k++) expect(after[i][k]).toBeCloseTo(before[i][k], 6);
  });

  it('side by side: siblings under the parent, shifted along the bone, children stay', () => {
    const { arm, root, hand } = rig();
    const ids = splitBone(arm.id, 3, { nested: false, fibonacci: false });
    const bones = docStore.get().skeleton.bones;
    for (const id of ids) expect(bones.find((b) => b.id === id)!.parent).toBe(root.id);
    expect(bones.find((b) => b.id === hand.id)!.parent).toBe(arm.id);
    const armW = tip('arm');
    const second = getSetupSkeleton().boneById(ids[0])!;
    expect(second.worldX).toBeCloseTo(armW[0] + (100 / 3) * armW[2], 6);
    expect(second.worldY).toBeCloseTo(armW[1] + (100 / 3) * armW[3], 6);
    expect(second.rotation).toBeCloseTo(30, 9);
  });

  it('refuses: root side by side, a bone without length, silly counts; no history step', () => {
    const { root, arm } = rig();
    const undo0 = docStore.canUndo;
    expect(splitBone(root.id, 3, { nested: false, fibonacci: false })).toEqual([]);
    expect(splitBone(arm.id, 1, { nested: true, fibonacci: false })).toEqual([]);
    expect(splitBone(arm.id, 99, { nested: true, fibonacci: false })).toEqual([]);
    docStore.update('zero', (d) => {
      d.skeleton.bones.find((b) => b.id === arm.id)!.length = 0;
    });
    expect(splitBone(arm.id, 3, { nested: true, fibonacci: false })).toEqual([]);
    docStore.undo();
    expect(docStore.canUndo).toBe(undo0);
  });

  it('new names do not clash', () => {
    const { arm } = rig();
    splitBone(arm.id, 3, { nested: true, fibonacci: true });
    const names = docStore.get().skeleton.bones.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('split bone with a weighted mesh', () => {
  /** A strip along the arm (100 long, rotated), weighted to the arm only, with one deform key. */
  function skinned() {
    const { arm, root } = rig();
    const slot = newSlot({ name: 's', bone: root.id });
    const sk = getSetupSkeleton();
    const a = sk.bones.find((b) => b.data.id === arm.id)!;
    // vertices at 0, 25, 50, 75, 100 along the arm, two rows
    const xs = [0, 25, 50, 75, 100];
    const local = xs.flatMap((x) => [
      [x, -5],
      [x, 5],
    ]);
    const weights = local.map(([x, y]) => [[arm.id, x, y, 1]] as [string, number, number, number][]);
    const mesh: MeshAttachment = {
      type: 'mesh',
      name: 'strip',
      path: 'strip',
      color: [1, 1, 1, 1],
      width: 100,
      height: 10,
      uvs: local.flatMap(([x, y]) => [x / 100, (y + 5) / 10]),
      triangles: [0, 1, 2, 1, 3, 2],
      hull: 4,
      edges: [],
      vertices: [],
      weights,
    };
    docStore.update('setup', (d) => {
      d.skeleton.slots.push(slot);
      d.skeleton.skins[0].attachments[slot.id] = { strip: mesh };
      const anim = {
        id: 'an',
        name: 'a',
        duration: 1,
        bones: {},
        slots: {},
        ik: {},
        transform: {},
        slider: {},
        path: {},
        physics: {},
        deform: { [d.skeleton.skins[0].id]: { [slot.id]: { strip: [{ time: 0, value: new Array(local.length * 2).fill(1) }] } } },
        drawOrder: [],
        events: [],
      };
      d.skeleton.animations.push(anim);
    });
    void a;
    return { arm, slot };
  }
  const positions = (slotId: string) => {
    const doc = docStore.get().skeleton;
    const sk = getSetupSkeleton();
    const mats = new Map(sk.bones.map((b) => [b.data.id, { a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY }]));
    const slot = doc.slots.find((x) => x.id === slotId)!;
    return meshWorldPositions(doc.skins[0].attachments[slotId].strip as MeshAttachment, mats.get(slot.bone)!, mats);
  };

  it('shares: the part it lies on, or a blend around the cut', () => {
    const offsets = [0, 25, 50];
    const lens = [25, 25, 25];
    expect(partShares(10, offsets, lens, false)).toEqual([1, 0, 0]);
    expect(partShares(30, offsets, lens, false)).toEqual([0, 1, 0]);
    expect(partShares(25, offsets, lens, true)).toEqual([0.5, 0.5, 0]);
    const near = partShares(20, offsets, lens, true);
    expect(near[0] + near[1] + near[2]).toBeCloseTo(1, 9);
    expect(near[0]).toBeGreaterThan(0.5);
    expect(partShares(37.5, offsets, lens, true)[1]).toBeCloseTo(1, 9); // the middle of a part is its own
  });

  it('by position: every vertex stays where it was and follows the part it lies on', () => {
    const { arm, slot } = skinned();
    const before = Array.from(positions(slot.id));
    const ids = splitBone(arm.id, 4, { nested: true, fibonacci: false, weights: 'split' });
    expect(ids).toHaveLength(3);
    const after = Array.from(positions(slot.id));
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
    const mesh = docStore.get().skeleton.skins[0].attachments[slot.id].strip as MeshAttachment;
    expect(mesh.weights![0].map((i) => i[0])).toEqual([arm.id]); // x = 0
    expect(mesh.weights![2].map((i) => i[0])).toEqual([ids[0]]); // x = 25 starts the second part
    expect(mesh.weights![8].map((i) => i[0])).toEqual([ids[2]]); // x = 100: the last
    expect(mesh.weights![2][0][1]).toBeCloseTo(0, 9); // bind position relative to its own part
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('blend: weights sum to one, the vertices do not move, the deform key follows its influences, one undo step', () => {
    const { arm, slot } = skinned();
    const before = Array.from(positions(slot.id));
    const undo0 = docStore.canUndo;
    splitBone(arm.id, 4, { nested: true, fibonacci: false, weights: 'blend' });
    const after = Array.from(positions(slot.id));
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
    const mesh = docStore.get().skeleton.skins[0].attachments[slot.id].strip as MeshAttachment;
    for (const list of mesh.weights!) expect(list.reduce((s, i) => s + i[3], 0)).toBeCloseTo(1, 9);
    expect(mesh.weights![2].length).toBe(2); // on a cut: two parts with half each
    const keys = docStore.get().skeleton.animations.find((a) => a.id === 'an')!.deform[docStore.get().skeleton.skins[0].id][slot.id].strip;
    expect(keys[0].value.length).toBe(mesh.weights!.reduce((n, l) => n + l.length, 0) * 2);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(docStore.canUndo).toBe(undo0);
    expect((docStore.get().skeleton.skins[0].attachments[slot.id].strip as MeshAttachment).weights![2]).toHaveLength(1);
  });

  it('keep: nothing changes (Spine behaviour)', () => {
    const { arm, slot } = skinned();
    splitBone(arm.id, 3, { nested: true, fibonacci: false });
    const mesh = docStore.get().skeleton.skins[0].attachments[slot.id].strip as MeshAttachment;
    expect(mesh.weights!.every((l) => l.length === 1 && l[0][0] === arm.id)).toBe(true);
  });
});

describe('split bone and IK', () => {
  it('refuses a nested split that would take the second bone of a chain away from the first, and allows side by side', () => {
    const { root, arm, hand } = rig();
    const target = newBone({ name: 'target', parent: root.id, x: 50, y: 50 });
    docStore.update('ik', (d) => {
      d.skeleton.bones.push(target);
      d.skeleton.constraints.push({
        id: 'ik1',
        type: 'ik',
        name: 'reach',
        order: 0,
        bones: [arm.id, hand.id],
        target: target.id,
        mix: 1,
        softness: 0,
        bendPositive: true,
        compress: false,
        stretch: false,
        uniform: false,
        skinRequired: false,
      } as unknown as IkConstraint);
    });
    const undo0 = docStore.canUndo;
    expect(splitBone(arm.id, 3, { nested: true, fibonacci: false })).toEqual([]);
    expect(docStore.canUndo).toBe(undo0);
    expect(splitBone(arm.id, 3, { nested: false, fibonacci: false })).toHaveLength(2);
    expect(validateProject(docStore.get())).toEqual([]);
  });
});
