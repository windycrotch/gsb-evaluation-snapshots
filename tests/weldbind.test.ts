/** Weld (weights of another mesh where this one lies over it) and Update bindings (bind pose = the pose the bones have now). */
import { beforeEach, describe, expect, it } from 'vitest';
import { meshFromRegion, meshWorldPositions, updateBindings, vertexWorldPositions, weldWeights } from '@/core/mesh';
import type { BoneMats } from '@/core/mesh';
import { matInvert, matApply } from '@/core/math';
import type { Influence } from '@/core/model';
import { emptyProject, newBone, newSlot } from '@/core/model';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import { bindMeshToBones, getMesh, setupMats, updateMeshBindings, weldMeshWeights, weldTargets } from '@/store/meshActions';
import { uiStore } from '@/store/ui';

const I = (bone: string, x: number, y: number, w: number): Influence => [bone, x, y, w];
const id = (x = 0, y = 0) => ({ a: 1, b: 0, c: 0, d: 1, x, y });

describe('update bindings (core)', () => {
  it('re-expresses the current world position in every bone, the vertex does not move', () => {
    // bound while A stood at the origin and B at (100, 0); then B was moved up by 30 in the setup pose
    const bones: BoneMats = new Map([
      ['A', id()],
      ['B', id(100, 30)],
    ]);
    const w: Influence[][] = [[I('A', 60, 0, 0.5), I('B', -40, 0, 0.5)], [I('A', 5, 5, 1)]];
    const before = vertexWorldPositions({ vertices: [], weights: w }, 2, id(), bones);
    const r = updateBindings(w, before, bones);
    expect(r.changed).toBe(1); // the second vertex only follows A, which did not move
    expect(r.weights[1]).toBe(w[1]);
    const after = vertexWorldPositions({ vertices: [], weights: r.weights }, 2, id(), bones);
    for (let i = 0; i < 4; i++) expect(after[i]).toBeCloseTo(before[i], 9);
    for (const e of r.weights[0]) {
      const p = matApply(matInvert(bones.get(e[0])!), before[0], before[1]);
      expect(e[1]).toBeCloseTo(p[0], 9);
      expect(e[2]).toBeCloseTo(p[1], 9);
    }
    // second run: nothing is stale any more
    expect(updateBindings(r.weights, after, bones).changed).toBe(0);
  });

  it('works only on the given vertices', () => {
    const bones: BoneMats = new Map([['A', id(0, 10)]]);
    const w: Influence[][] = [[I('A', 1, 1, 1)], [I('A', 2, 2, 1)]];
    const world = vertexWorldPositions({ vertices: [], weights: w }, 2, id(), bones);
    const r = updateBindings(w, world, bones, new Set([1]));
    expect(r.changed).toBe(0); // world was computed from the same bind, nothing stale
    const moved = new Float64Array([1, 20, 2, 20]);
    const r2 = updateBindings(w, moved, bones, new Set([1]));
    expect(r2.weights[0]).toBe(w[0]);
    expect(r2.weights[1][0][2]).toBeCloseTo(10, 9);
  });
});

describe('weld weights (core)', () => {
  // the other mesh: a quad 0..100 x 0..50, left corners all on A, right corners all on B
  const bones: BoneMats = new Map([
    ['A', id()],
    ['B', id(100, 0)],
    ['C', id(0, 80)],
  ]);
  const other = {
    world: [0, 0, 100, 0, 100, 50, 0, 50],
    triangles: [0, 1, 2, 0, 2, 3],
    weights: [[I('A', 0, 0, 1)], [I('B', 0, 0, 1)], [I('B', 0, 50, 1)], [I('A', 0, 50, 1)]] as Influence[][],
  };
  const mine = (n: number): Influence[][] => Array.from({ length: n }, () => [I('A', 0, 0, 0.5), I('B', 0, 0, 0.5)]);

  it('a vertex over the other mesh gets the weights blended by position, and stays put', () => {
    const r = weldWeights(mine(1), [25, 10], other, 'overlapping', bones);
    expect(r.changed).toBe(1);
    const a = r.weights[0].find((e) => e[0] === 'A')!;
    const b = r.weights[0].find((e) => e[0] === 'B')!;
    expect(a[3]).toBeCloseTo(0.75, 6);
    expect(b[3]).toBeCloseTo(0.25, 6);
    expect(a[1]).toBeCloseTo(25, 9);
    expect(b[1]).toBeCloseTo(-75, 9);
    expect(b[2]).toBeCloseTo(10, 9);
  });

  it('Overlapping leaves the vertices outside alone; All gives them the nearest weights', () => {
    const outside = [150, 10];
    const o = weldWeights(mine(1), outside, other, 'overlapping', bones);
    expect(o.changed).toBe(0);
    const all = weldWeights(mine(1), outside, other, 'all', bones);
    expect(all.changed).toBe(1);
    expect(all.weights[0]).toHaveLength(1);
    expect(all.weights[0][0][0]).toBe('B');
  });

  it('needs two common bones, ignores the bones only one of them has, and honours the scope', () => {
    const one: Influence[][] = [[I('A', 0, 0, 1)]];
    expect(weldWeights(one, [25, 10], other, 'all', bones).changed).toBe(0);
    const withC: Influence[][] = [
      [I('A', 0, 0, 0.4), I('B', 0, 0, 0.3), I('C', 0, 0, 0.3)],
      [I('A', 0, 0, 0.4), I('B', 0, 0, 0.3), I('C', 0, 0, 0.3)],
    ];
    const r = weldWeights(withC, [25, 10, 25, 10], other, 'all', bones, new Set([1]));
    expect(r.weights[0]).toBe(withC[0]);
    expect(r.weights[1].map((e) => e[0]).sort()).toEqual(['A', 'B']);
    expect(r.weights[1].reduce((s, e) => s + e[3], 0)).toBeCloseTo(1, 9);
  });
});

describe('Update bindings and Weld (store)', () => {
  let s1 = '';
  let s2 = '';
  let a = '';
  let b = '';
  beforeEach(() => {
    const p = emptyProject();
    p.skeleton.bones = [];
    const root = newBone({ name: 'root' });
    const ba = newBone({ name: 'a', parent: root.id, length: 100 });
    const bb = newBone({ name: 'b', parent: root.id, x: 100, length: 100 });
    p.skeleton.bones.push(root, ba, bb);
    const slot1 = newSlot({ name: 'big', bone: root.id });
    const slot2 = newSlot({ name: 'small', bone: root.id });
    p.skeleton.slots.push(slot1, slot2);
    const region = (name: string, x: number, w: number, h: number) =>
      meshFromRegion({
        type: 'region',
        name,
        path: name,
        x,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        width: w,
        height: h,
        color: [1, 1, 1, 1],
        sequence: null,
      } as never);
    p.skeleton.skins[0].attachments[slot1.id] = { big: region('big', 100, 200, 80) };
    p.skeleton.skins[0].attachments[slot2.id] = { small: region('small', 100, 100, 20) };
    slot1.attachment = 'big';
    slot2.attachment = 'small';
    docStore.replace(p);
    uiStore.patch({ mode: 'setup' });
    s1 = slot1.id;
    s2 = slot2.id;
    a = ba.id;
    b = bb.id;
    setSelection({ slot: s1, attachment: 'big', bones: [a, b], vertices: [] });
    bindMeshToBones(s1, 'big', [a, b]);
    setSelection({ slot: s2, attachment: 'small', bones: [a, b], vertices: [] });
    bindMeshToBones(s2, 'small', [a, b]);
    setSelection({ slot: s2, attachment: 'small', bones: [], vertices: [] });
  });

  it('Update bindings after a bone was moved: vertices stay, binds follow the bones, one undo step', () => {
    docStore.update('move', (d) => {
      d.skeleton.bones.find((x) => x.id === b)!.y = 25;
    });
    const mesh = () => getMesh(s1, 'big')!;
    const world = () => {
      const { mats, slotMat } = setupMats();
      return meshWorldPositions(mesh(), slotMat(s1), mats);
    };
    const w0 = world();
    expect(updateMeshBindings(s1, 'big')).toBeGreaterThan(0);
    const w1 = world();
    for (let i = 0; i < w0.length; i++) expect(w1[i]).toBeCloseTo(w0[i], 6);
    const { mats } = setupMats();
    for (const [vi, list] of mesh().weights!.entries()) {
      for (const e of list) {
        const p = matApply(matInvert(mats.get(e[0])!), w1[vi * 2], w1[vi * 2 + 1]);
        expect(e[1]).toBeCloseTo(p[0], 6);
        expect(e[2]).toBeCloseTo(p[1], 6);
      }
    }
    expect(updateMeshBindings(s1, 'big')).toBe(0);
    docStore.undo();
    const stale = JSON.stringify(mesh().weights);
    docStore.redo();
    expect(JSON.stringify(mesh().weights)).not.toBe(stale);
  });

  it('Weld: the small mesh takes the weights of the big one under it; a target list names the shared bones', () => {
    const targets = weldTargets(s2, 'small');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ slotId: s1, name: 'big', shared: 2 });
    // make the big mesh 80% A and 20% B everywhere so the weld is visible
    const { mats, slotMat } = setupMats();
    const wp = meshWorldPositions(getMesh(s1, 'big')!, slotMat(s1), mats);
    docStore.update('uniform', (d) => {
      const m = d.skeleton.skins[0].attachments[s1].big as never as { weights: Influence[][] };
      m.weights = m.weights.map((_, i) => {
        const pa = matApply(matInvert(mats.get(a)!), wp[i * 2], wp[i * 2 + 1]);
        const pb = matApply(matInvert(mats.get(b)!), wp[i * 2], wp[i * 2 + 1]);
        return [[a, pa[0], pa[1], 0.8] as Influence, [b, pb[0], pb[1], 0.2] as Influence];
      });
    });
    expect(weldMeshWeights(s2, 'small', s1, 'big', 'overlapping')).toBeGreaterThan(0);
    const small = getMesh(s2, 'small')!;
    for (const l of small.weights!) {
      expect(l.find((e) => e[0] === a)![3]).toBeCloseTo(0.8, 6);
      expect(l.find((e) => e[0] === b)![3]).toBeCloseTo(0.2, 6);
    }
    docStore.undo();
    expect(getMesh(s2, 'small')!.weights!.some((l) => l.length > 1)).toBe(true);
  });

  it('Weld refuses a mesh that shares fewer than two bones', () => {
    docStore.update('only A', (d) => {
      const m = d.skeleton.skins[0].attachments[s1].big as never as { weights: Influence[][] };
      m.weights = m.weights.map(() => [[a, 0, 0, 1] as Influence]);
    });
    expect(weldMeshWeights(s2, 'small', s1, 'big', 'all')).toBe(0);
  });
});
