import { describe, expect, it } from 'vitest';
import { deformedVertices } from '../src/core/deformMarks';

describe('deformedVertices', () => {
  it('marks the vertices of an unweighted mesh that the deform moves', () => {
    const att = { vertexCount: 3, weighted: false, bones: null };
    expect(deformedVertices(att, [])).toEqual([false, false, false]);
    expect(deformedVertices(att, [0, 0, 0.5, 0, 0, 0])).toEqual([false, true, false]);
    expect(deformedVertices(att, [0, 0.0001, 0, 0, 0, -2])).toEqual([false, false, true]); // under the threshold is not a move
  });

  it('reads the two numbers per influence of a weighted mesh', () => {
    // vertex 0 has two influences, vertex 1 has one, vertex 2 has two
    const att = { vertexCount: 3, weighted: true, bones: Int32Array.from([2, 0, 1, 1, 1, 2, 0, 2]) };
    expect(deformedVertices(att, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual([false, false, false]);
    expect(deformedVertices(att, [0, 0, 0, 3, 0, 0, 0, 0, 0, 0])).toEqual([true, false, false]);
    expect(deformedVertices(att, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toEqual([false, false, true]);
    expect(deformedVertices(att, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0])).toEqual([false, true, false]);
  });
});
