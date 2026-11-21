/** Weights on selected vertices only (Auto, Smooth, Prune), and Swap: two bones exchange their weights. */
import { beforeEach, describe, expect, it } from 'vitest';
import { keepOutside, pruneWeights, swapBoneWeights } from '@/core/mesh';
import type { BoneMats } from '@/core/mesh';
import type { Influence } from '@/core/model';
import { emptyProject, newBone, newSlot } from '@/core/model';
import { docStore } from '@/store/doc';
import { getMesh } from '@/store/meshActions';
import { meshFromRegion } from '@/core/mesh';
import { autoWeightMesh, bindMeshToBones, pruneMeshWeights, smoothMeshWeights, swapMeshWeights } from '@/store/meshActions';
import { setSelection } from '@/store/actions';
import { uiStore } from '@/store/ui';

const I = (bone: string, x: number, y: number, w: number): Influence => [bone, x, y, w];
const bones: BoneMats = new Map([
  ['A', { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }],
  ['B', { a: 1, b: 0, c: 0, d: 1, x: 100, y: 0 }],
  ['C', { a: 1, b: 0, c: 0, d: 1, x: 0, y: 50 }],
]);

describe('swap bone weights (core)', () => {
  it('exchanges the two weights, keeps the vertex where it is, leaves others alone', () => {
    const world = [10, 0, 120, 0, 5, 5];
    const w: Influence[][] = [[I('A', 10, 0, 0.7), I('B', -90, 0, 0.3)], [I('A', 120, 0, 1)], [I('C', 5, -45, 1)]];
    const r = swapBoneWeights(w, world, 'A', 'B', bones);
    expect(r.changed).toBe(2);
    const v0 = r.weights[0];
    expect(v0.find((e) => e[0] === 'A')![3]).toBeCloseTo(0.3);
    expect(v0.find((e) => e[0] === 'B')![3]).toBeCloseTo(0.7);
    // bind positions are re-expressed so the vertex stays at world (10, 0)
    expect(v0.find((e) => e[0] === 'A')![1]).toBeCloseTo(10);
    expect(v0.find((e) => e[0] === 'B')![1]).toBeCloseTo(-90);
    expect(r.weights[1].map((e) => e[0])).toEqual(['B']);
    expect(r.weights[1][0][1]).toBeCloseTo(20);
    expect(r.weights[2]).toBe(w[2]);
  });

  it('works only on the given vertices, and does nothing for the same bone twice', () => {
    const world = [10, 0, 20, 0];
    const w: Influence[][] = [[I('A', 10, 0, 1)], [I('A', 20, 0, 1)]];
    const r = swapBoneWeights(w, world, 'A', 'B', bones, new Set([1]));
    expect(r.weights[0]).toBe(w[0]);
    expect(r.weights[1][0][0]).toBe('B');
    expect(swapBoneWeights(w, world, 'A', 'A', bones).changed).toBe(0);
  });

  it('keepOutside keeps the new values only inside the scope; prune honours the scope', () => {
    expect(keepOutside([1, 2, 3], [9, 9, 9], new Set([1]))).toEqual([1, 9, 3]);
    expect(keepOutside([1, 2], [9, 9], undefined)).toEqual([9, 9]);
    const faint: Influence[] = [I('A', 0, 0, 0.9), I('B', 0, 0, 0.1)];
    const out = pruneWeights([faint, faint], 0.2, 4, new Set([0]));
    expect(out[0]).toHaveLength(1);
    expect(out[1]).toBe(faint);
  });
});

describe('scope of the weight buttons (store)', () => {
  let slotId = '';
  let ids: string[] = [];
  beforeEach(() => {
    const p = emptyProject();
    p.skeleton.bones = [];
    const root = newBone({ name: 'root' });
    const a = newBone({ name: 'a', parent: root.id, length: 100 });
    const b = newBone({ name: 'b', parent: root.id, x: 100, length: 100 });
    p.skeleton.bones.push(root, a, b);
    const slot = newSlot({ name: 's', bone: root.id });
    p.skeleton.slots.push(slot);
    p.skeleton.skins[0].attachments[slot.id] = {
      img: meshFromRegion({
        type: 'region',
        name: 'img',
        path: 'img',
        x: 100,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        width: 200,
        height: 60,
        color: [1, 1, 1, 1],
        sequence: null,
      } as never),
    };
    slot.attachment = 'img';
    docStore.replace(p);
    uiStore.patch({ mode: 'setup' });
    slotId = slot.id;
    ids = [root.id, a.id, b.id];
    setSelection({ slot: slotId, attachment: 'img', bones: [ids[1], ids[2]] });
    bindMeshToBones(slotId, 'img', [ids[1], ids[2]]);
  });
  const w = () => getMesh(slotId, 'img')!.weights!;
  const snapshot = () => JSON.stringify(w());

  it('with vertices selected Auto, Smooth and Prune leave the other vertices untouched', () => {
    const before = w().map((l) => JSON.stringify(l));
    setSelection({ slot: slotId, attachment: 'img', vertices: [0], bones: [ids[1], ids[2]] });
    smoothMeshWeights(slotId, 'img', 2);
    pruneMeshWeights(slotId, 'img', 0.45, 1);
    autoWeightMesh(slotId, 'img');
    const after = w().map((l) => JSON.stringify(l));
    for (let i = 1; i < after.length; i++) expect(after[i]).toBe(before[i]);
  });

  it('Swap on the whole mesh exchanges the bones, in one history step; two equal bones are refused', () => {
    setSelection({ slot: slotId, attachment: 'img', vertices: [], bones: [] });
    const first = w()[0].find((e) => e[0] === ids[1])?.[3] ?? 0;
    const second = w()[0].find((e) => e[0] === ids[2])?.[3] ?? 0;
    const s0 = snapshot();
    expect(swapMeshWeights(slotId, 'img', ids[1], ids[1])).toBe(0);
    expect(snapshot()).toBe(s0);
    expect(swapMeshWeights(slotId, 'img', ids[1], ids[2])).toBeGreaterThan(0);
    expect(w()[0].find((e) => e[0] === ids[1])?.[3] ?? 0).toBeCloseTo(second);
    expect(w()[0].find((e) => e[0] === ids[2])?.[3] ?? 0).toBeCloseTo(first);
    docStore.undo();
    expect(snapshot()).toBe(s0);
  });
});
