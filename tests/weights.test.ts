/** Prune and Mirror weights, on plain arrays: no editor needed. */
import { describe, expect, it } from 'vitest';
import { mirrorWeights, pruneWeights } from '../src/core/mesh';
import type { BoneMats } from '../src/core/mesh';
import type { Influence } from '../src/core/model';

const I = (bone: string, x: number, y: number, w: number): Influence => [bone, x, y, w];
const total = (l: Influence[]) => l.reduce((s, i) => s + i[3], 0);

describe('prune weights', () => {
  it('drops faint influences, keeps the strongest few and scales the rest back to 1', () => {
    const [v] = pruneWeights([[I('a', 0, 0, 0.5), I('b', 0, 0, 0.3), I('c', 0, 0, 0.1), I('d', 0, 0, 0.07), I('e', 0, 0, 0.03)]], 0.05, 3);
    expect(v.map((i) => i[0])).toEqual(['a', 'b', 'c']);
    expect(total(v)).toBeCloseTo(1);
    expect(v[0][3]).toBeCloseTo(0.5 / 0.9);
  });

  it('keeps the strongest bone even when everything is faint, and leaves a vertex without weights alone', () => {
    const out = pruneWeights([[I('a', 1, 2, 0.02), I('b', 3, 4, 0.01)], []], 0.05, 4);
    expect(out[0]).toEqual([['a', 1, 2, 1]]);
    expect(out[1]).toEqual([]);
  });

  it('does not touch a vertex that is already clean, and never gives a vertex more than max bones', () => {
    const clean: Influence[] = [I('a', 0, 0, 0.6), I('b', 0, 0, 0.4)];
    expect(pruneWeights([clean], 0.05, 4)[0]).toEqual(clean);
    const many = Array.from({ length: 6 }, (_, i) => I(`b${i}`, 0, 0, 1 / 6));
    expect(pruneWeights([many], 0, 4)[0]).toHaveLength(4);
  });
});

describe('mirror weights', () => {
  // two bones: "arm L" at x = -50 and "arm R" at x = +50, both unrotated, 4 mesh vertices spread symmetric about x = 0
  const bones: BoneMats = new Map([
    ['L', { a: 1, b: 0, c: 0, d: 1, x: -50, y: 0 }],
    ['R', { a: 1, b: 0, c: 0, d: 1, x: 50, y: 0 }],
    ['C', { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }],
  ]);
  const world = [-40, 10, -20, 10, 20, 10, 40, 10];
  const twin = (id: string) => (id === 'L' ? 'R' : id === 'R' ? 'L' : id);
  const local = (bone: string, x: number, y: number) => {
    const m = bones.get(bone)!;
    return [x - m.x, y - m.y];
  };
  const left = (wx: number, wy: number, a: number): Influence[] => [
    [...['L', ...local('L', wx, wy)], a] as Influence,
    [...['C', ...local('C', wx, wy)], 1 - a] as Influence,
  ];

  it('copies the left weights to the mirrored vertices on the right, with the bones swapped', () => {
    const weights = [left(-40, 10, 0.9), left(-20, 10, 0.6), [I('C', 20, 10, 1)], [I('C', 40, 10, 1)]];
    const r = mirrorWeights(weights, world, 0, true, twin, bones);
    expect(r.changed).toBe(2);
    // vertex 3 (x = 40) mirrors vertex 0 (x = -40): R gets L's 0.9, C keeps 0.1
    const v3 = r.weights[3];
    expect(v3.find((i) => i[0] === 'R')![3]).toBeCloseTo(0.9);
    expect(v3.find((i) => i[0] === 'C')![3]).toBeCloseTo(0.1);
    expect(total(v3)).toBeCloseTo(1);
    // the vertex stays where it is: every influence points at the same world position (40, 10)
    for (const [bone, x, y] of v3) {
      const m = bones.get(bone)!;
      expect(m.x + x).toBeCloseTo(40);
      expect(m.y + y).toBeCloseTo(10);
    }
    // the left half is untouched
    expect(r.weights[0]).toEqual(weights[0]);
  });

  it('works the other way round, and leaves vertices without a partner alone', () => {
    const weights = [[I('C', -40, 10, 1)], [I('C', -20, 10, 1)], left(20, 10, 0.5), left(40, 10, 0.8)];
    const r = mirrorWeights(
      weights,
      world.map((v, i) => (i === 2 ? v - 30 : v)),
      0,
      false,
      twin,
      bones,
      3,
    );
    // vertex 1 moved to x = -50: its mirror x = 50 has no vertex within 3 px, so only vertex 0 gets weights
    expect(r.changed).toBe(1);
    expect(r.weights[1]).toEqual(weights[1]);
  });

  it('reports nothing changed for a mesh that is not symmetric', () => {
    const r = mirrorWeights([[I('C', 0, 0, 1)], [I('C', 0, 0, 1)]], [-30, 0, 17, 5], 0, true, twin, bones);
    expect(r.changed).toBe(0);
  });
});
