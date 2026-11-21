/** Weight lock, brush feather, copy / paste of weights. */
import { beforeEach, describe, expect, it } from 'vitest';
import { setBoneWeight } from '@/core/mesh';
import { meshFromRegion } from '@/core/mesh';
import type { Influence } from '@/core/model';
import { emptyProject, newBone, newSlot } from '@/core/model';
import { docStore } from '@/store/doc';
import { setSelection } from '@/store/actions';
import { bindMeshToBones, copyVertexWeights, getMesh, paintWeights, pasteVertexWeights } from '@/store/meshActions';
import { uiStore } from '@/store/ui';

const I = (bone: string, w: number): Influence => [bone, 0, 0, w];
const bind = () => [0, 0] as [number, number];
const get = (l: Influence[], b: string) => l.find((e) => e[0] === b)?.[3] ?? 0;

describe('setBoneWeight with locked bones', () => {
  it('a locked bone keeps its weight; the others share the rest; the painted bone is capped', () => {
    const list = [I('a', 0.5), I('b', 0.3), I('c', 0.2)];
    const out = setBoneWeight(list, 'b', 0.4, bind, 4, new Set(['a']));
    expect(get(out, 'a')).toBeCloseTo(0.5);
    expect(get(out, 'b')).toBeCloseTo(0.4);
    expect(get(out, 'c')).toBeCloseTo(0.1);
    const capped = setBoneWeight(list, 'b', 1, bind, 4, new Set(['a']));
    expect(get(capped, 'a')).toBeCloseTo(0.5);
    expect(get(capped, 'b')).toBeCloseTo(0.5);
    expect(get(capped, 'c')).toBe(0);
  });

  it('a locked bone cannot be painted, and without locks nothing changes', () => {
    const list = [I('a', 0.6), I('b', 0.4)];
    expect(setBoneWeight(list, 'a', 0.1, bind, 4, new Set(['a']))).toBe(list);
    const free = setBoneWeight(list, 'a', 0.1, bind);
    expect(get(free, 'a')).toBeCloseTo(0.1);
    expect(get(free, 'b')).toBeCloseTo(0.9);
  });

  it('a new bone can take only what the locked bones leave; all weights still add up to 1', () => {
    const out = setBoneWeight([I('a', 0.7), I('b', 0.3)], 'c', 1, bind, 4, new Set(['a']));
    expect(get(out, 'a')).toBeCloseTo(0.7);
    expect(get(out, 'c')).toBeCloseTo(0.3);
    expect(out.reduce((s, e) => s + e[3], 0)).toBeCloseTo(1);
  });
});

describe('brush on a mesh: lock, feather, copy and paste', () => {
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
  const brush = (patch: object) =>
    uiStore.patch({ brush: { size: 400, strength: 1, mode: 'replace', bone: ids[2], feather: 100, locked: [], ...patch } as never });

  it('painting with the other bone locked leaves its weights as they were', () => {
    const before = w().map((l) => get(l, ids[1]));
    brush({ locked: [ids[1]] });
    paintWeights(slotId, 'img', { x: 100, y: 0 }, ids[2]);
    w().forEach((l, i) => expect(get(l, ids[1])).toBeCloseTo(before[i], 6));
    brush({ locked: [] });
    paintWeights(slotId, 'img', { x: 100, y: 0 }, ids[2]);
    expect(w().some((l, i) => Math.abs(get(l, ids[1]) - before[i]) > 0.05)).toBe(true);
  });

  it('a hard edge (feather 0) paints at full strength inside the size and not at all outside', () => {
    const world = [0, 0, 200, 0, 200, 60, 0, 60];
    expect(world.length).toBe(w().length * 2); // a quad: 4 corners; the left ones are 30 from the stroke, the right ones 200
    brush({ feather: 0, size: 100, mode: 'replace', strength: 0.5, bone: ids[1] });
    const before = w().map((l) => get(l, ids[1]));
    paintWeights(slotId, 'img', { x: 0, y: 30 }, ids[1]);
    const after = w().map((l) => get(l, ids[1]));
    let inside = 0;
    after.forEach((v, i) => {
      const x = getMesh(slotId, 'img')!.uvs[i * 2]; // uv.x: 0 on the left edge of the image
      if (x < 0.5) {
        inside++;
        expect(v).toBeGreaterThan(before[i] - 1e-9);
        expect(v).toBeGreaterThan(0.7); // 0.5 strength * 1.5 = a full replace
      } else expect(v).toBeCloseTo(before[i], 6);
    });
    expect(inside).toBe(2);
  });

  it('copy then paste moves the weights of the first vertices to others, one history step, with the right count', () => {
    setSelection({ slot: slotId, attachment: 'img', vertices: [0, 1] });
    expect(copyVertexWeights(slotId, 'img')).toBe(2);
    const src = [0, 1].map((i) => w()[i].map((e) => [e[0], e[3]]));
    setSelection({ slot: slotId, attachment: 'img', vertices: [2] });
    expect(pasteVertexWeights(slotId, 'img')).toBe(0); // wrong count
    setSelection({ slot: slotId, attachment: 'img', vertices: [2, 3] });
    const undo = docStore.canUndo;
    expect(pasteVertexWeights(slotId, 'img')).toBe(2);
    [2, 3].forEach((vi, k) => {
      const got = w()[vi].map((e) => [e[0], e[3]]);
      expect(got.length).toBe(src[k].length);
      for (const [bone, wt] of src[k] as [string, number][]) expect(get(w()[vi], bone)).toBeCloseTo(wt, 6);
    });
    docStore.undo();
    expect(docStore.canUndo).toBe(undo);
  });
});
