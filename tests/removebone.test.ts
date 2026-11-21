/** Remove (the mesh stops following a bone): the weight goes to the other bones, a vertex with only that bone goes to the parent. */
import { beforeEach, describe, expect, it } from 'vitest';
import { meshFromRegion, meshWorldPositions, removeBoneWeights } from '@/core/mesh';
import type { BoneMats } from '@/core/mesh';
import type { Influence } from '@/core/model';
import { emptyProject, newBone, newSlot } from '@/core/model';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import { bindMeshToBones, getMesh, removeBoneFromMesh, setupMats } from '@/store/meshActions';
import { uiStore } from '@/store/ui';

const I = (b: string, x: number, y: number, w: number): Influence => [b, x, y, w];
const id = (x = 0, y = 0) => ({ a: 1, b: 0, c: 0, d: 1, x, y });

describe('remove bone weights (core)', () => {
  const bones: BoneMats = new Map([
    ['P', id()],
    ['A', id(100, 0)],
    ['B', id(0, 50)],
  ]);
  it('hands the weight to the other bones in proportion and keeps the vertex', () => {
    const w: Influence[][] = [[I('A', -50, 0, 0.5), I('B', 50, -50, 0.3), I('P', 50, 0, 0.2)]];
    const r = removeBoneWeights(w, [50, 0], 'A', 'P', bones);
    expect(r.changed).toBe(1);
    expect(r.weights[0].map((e) => e[0]).sort()).toEqual(['B', 'P']);
    expect(r.weights[0].find((e) => e[0] === 'B')![3]).toBeCloseTo(0.6, 9);
    expect(r.weights[0].find((e) => e[0] === 'P')![3]).toBeCloseTo(0.4, 9);
  });
  it('a vertex that followed only that bone goes to the fallback, at the same place; without one it is left alone', () => {
    const w: Influence[][] = [[I('A', -50, 0, 1)], [I('P', 5, 5, 1)]];
    const r = removeBoneWeights(w, [50, 0, 5, 5], 'A', 'P', bones);
    expect(r.changed).toBe(1);
    expect(r.weights[0]).toEqual([['P', 50, 0, 1]]);
    expect(r.weights[1]).toBe(w[1]);
    const none = removeBoneWeights(w, [50, 0, 5, 5], 'A', null, bones);
    expect(none.changed).toBe(0);
    expect(none.weights[0]).toBe(w[0]);
  });
});

describe('remove bone from mesh (store)', () => {
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
    setSelection({ slot: slotId, attachment: 'img', bones: [ids[1], ids[2]], vertices: [] });
    bindMeshToBones(slotId, 'img', [ids[1], ids[2]]);
  });

  it('the mesh stops following the bone, the vertices do not move, one undo step; the brush forgets the bone', () => {
    const world = () => {
      const { mats, slotMat } = setupMats();
      return meshWorldPositions(getMesh(slotId, 'img')!, slotMat(slotId), mats);
    };
    const w0 = world();
    uiStore.patch({ brush: { ...uiStore.get().brush, bone: ids[1], locked: [ids[1]] } });
    expect(removeBoneFromMesh(slotId, 'img', ids[1])).toBeGreaterThan(0);
    const mesh = getMesh(slotId, 'img')!;
    expect(mesh.weights!.flat().some((e) => e[0] === ids[1])).toBe(false);
    const w1 = world();
    for (let i = 0; i < w0.length; i++) expect(w1[i]).toBeCloseTo(w0[i], 6);
    expect(uiStore.get().brush.bone).toBeNull();
    expect(uiStore.get().brush.locked).toEqual([]);
    expect(removeBoneFromMesh(slotId, 'img', ids[1])).toBe(0);
    docStore.undo();
    expect(
      getMesh(slotId, 'img')!
        .weights!.flat()
        .some((e) => e[0] === ids[1]),
    ).toBe(true);
  });
});
