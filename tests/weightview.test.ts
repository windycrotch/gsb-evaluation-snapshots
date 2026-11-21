/** Weights view: bone colours, Overlay colours (Selected makes the other bones black), which vertices get a pie. */
import { describe, expect, it } from 'vitest';
import type { Influence } from '@/core/model';
import { boneRgb, boundBones, overlayColors, pieVertices } from '@/editor/viewport/weightColors';

const I = (b: string, w: number): Influence => [b, 0, 0, w];

describe('weights view', () => {
  it('bound bones follow the skeleton order and bone colours differ', () => {
    const w = [[I('c', 1)], [I('a', 0.5), I('c', 0.5)]];
    expect(boundBones(w, ['a', 'b', 'c'])).toEqual(['a', 'c']);
    const cols = [0, 1, 2, 3, 4, 5].map((i) =>
      boneRgb(i)
        .map((x) => x.toFixed(2))
        .join(),
    );
    expect(new Set(cols).size).toBe(6);
    for (const i of [0, 1, 2, 3]) for (const x of boneRgb(i)) expect(x >= 0 && x <= 1).toBe(true);
  });

  it('overlay blends the colours by weight; with Selected the other bones are black', () => {
    const bound = ['a', 'b'];
    const w = [[I('a', 1)], [I('b', 1)], [I('a', 0.5), I('b', 0.5)]];
    const all = overlayColors(w, bound, null);
    const ca = boneRgb(0);
    const cb = boneRgb(1);
    expect(all[0]).toBeCloseTo(ca[0], 9);
    expect(all[4]).toBeCloseTo(cb[0], 9);
    expect(all[8]).toBeCloseTo((ca[0] + cb[0]) / 2, 9);
    const only = overlayColors(w, bound, new Set(['a']));
    expect(only.slice(4, 7)).toEqual([0, 0, 0]);
    expect(only[8]).toBeCloseTo(ca[0] / 2, 9);
    expect(only[3]).toBe(all[3]);
  });

  it('pies: every vertex, or with Selected the picked ones and those weighted to a picked bone', () => {
    const w = [[I('a', 1)], [I('b', 1)], [I('b', 0.5), I('c', 0.5)], [I('c', 1)]];
    expect(pieVertices(w, new Set(), new Set(), false)).toEqual([0, 1, 2, 3]);
    expect(pieVertices(w, new Set(), new Set(), true)).toEqual([]);
    expect(pieVertices(w, new Set([0]), new Set(['b']), true)).toEqual([0, 1, 2]);
  });
});
