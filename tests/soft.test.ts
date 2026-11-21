/** Soft selection: the falloff, the weights of the vertices near a selection, and a soft drag of a mesh. */
import { describe, expect, it } from 'vitest';
import { meshWorldPositions } from '../src/core/mesh';
import { softFalloff, softMoves, softWeights } from '../src/core/soft';
import * as M from '../src/store/meshActions';
import * as A from '../src/store/actions';
import * as P from '../src/store/polygonActions';
import { docStore } from '../src/store/doc';
import { buildFixture } from './fixture';

describe('softFalloff', () => {
  it('is 1 at the selection, 0 at the radius and beyond, and never rises with the distance', () => {
    for (const shape of ['smooth', 'linear', 'sharp'] as const) {
      expect(softFalloff(0, shape)).toBe(1);
      expect(softFalloff(1, shape)).toBe(0);
      expect(softFalloff(3, shape)).toBe(0);
      let last = 1;
      for (let t = 0; t <= 1; t += 0.05) {
        const w = softFalloff(t, shape);
        expect(w).toBeLessThanOrEqual(last + 1e-12);
        expect(w).toBeGreaterThanOrEqual(0);
        last = w;
      }
    }
  });

  it('the three shapes order as smooth > linear at the start and sharp lowest', () => {
    expect(softFalloff(0.3, 'smooth')).toBeGreaterThan(softFalloff(0.3, 'linear'));
    expect(softFalloff(0.3, 'linear')).toBeGreaterThan(softFalloff(0.3, 'sharp'));
    expect(softFalloff(0.5, 'smooth')).toBeCloseTo(0.5, 9);
  });

  it('a NaN distance follows nothing', () => {
    expect(softFalloff(NaN, 'smooth')).toBe(0);
  });
});

describe('softWeights', () => {
  // five points on a line: 0, 10, 20, 40, 100
  const pts = [0, 0, 10, 0, 20, 0, 40, 0, 100, 0];

  it('the selected vertices are 1, the near ones fall with the distance to the nearest selected, the far ones are left out', () => {
    const w = softWeights(pts, [0], 30, 'linear');
    expect(w.get(0)).toBe(1);
    expect(w.get(1)).toBeCloseTo(1 - 10 / 30, 9);
    expect(w.get(2)).toBeCloseTo(1 - 20 / 30, 9);
    expect(w.has(3)).toBe(false); // at 40: beyond the radius
    expect(w.has(4)).toBe(false);
  });

  it('uses the nearest of several selected vertices', () => {
    const w = softWeights(pts, [0, 3], 30, 'linear');
    expect(w.get(2)).toBeCloseTo(1 - 20 / 30, 9); // 20 from 0, 20 from 3
    expect(w.get(1)).toBeCloseTo(1 - 10 / 30, 9);
  });

  it('a radius of 0, a bad radius or no selection keeps only the selection', () => {
    expect([...softWeights(pts, [1], 0, 'smooth')]).toEqual([[1, 1]]);
    expect([...softWeights(pts, [1], NaN, 'smooth')]).toEqual([[1, 1]]);
    expect(softWeights(pts, [], 50, 'smooth').size).toBe(0);
  });

  it('ignores indices that are not vertices and repeats', () => {
    const w = softWeights(pts, [1, 1, -1, 99, 1.5], 0, 'smooth');
    expect([...w.keys()]).toEqual([1]);
  });
});

describe('softMoves', () => {
  it('moves each vertex by its share of the drag', () => {
    const start = [0, 0, 10, 0, 20, 0];
    const moves = softMoves(
      start,
      new Map([
        [0, 1],
        [1, 0.5],
      ]),
      8,
      -4,
    );
    expect(moves).toEqual([
      { index: 0, x: 8, y: -4 },
      { index: 1, x: 14, y: -2 },
    ]);
  });
});

describe('a soft drag of a mesh', () => {
  for (const weighted of [false, true]) {
    it(`${weighted ? 'weighted' : 'unweighted'}: the selected vertex goes the whole way and the ones near it part of it`, () => {
      const { project } = buildFixture();
      docStore.replace(project);
      const skin = project.skeleton.skins[0];
      let found: { slotId: string; name: string } | null = null;
      for (const slotId in skin.attachments)
        for (const name in skin.attachments[slotId]) {
          const a = skin.attachments[slotId][name];
          if (!found && a.type === 'mesh' && !!a.weights === weighted) found = { slotId, name };
        }
      expect(found).not.toBeNull();
      const { slotId, name } = found!;
      const world = () => {
        const { mats, slotMat } = M.setupMats();
        return meshWorldPositions(M.getMesh(slotId, name)!, slotMat(slotId), mats);
      };
      const before = Array.from(world());
      const weights = softWeights(before, [0], 60, 'smooth');
      expect(weights.size).toBeGreaterThan(1);
      M.moveMeshVertices(slotId, name, softMoves(before, weights, 12, -7));
      const after = Array.from(world());
      for (let i = 0; i < before.length / 2; i++) {
        const w = weights.get(i) ?? 0;
        expect(after[i * 2] - before[i * 2]).toBeCloseTo(12 * w, 3);
        expect(after[i * 2 + 1] - before[i * 2 + 1]).toBeCloseTo(-7 * w, 3);
      }
    });
  }
});

describe('a soft drag of a clipping polygon', () => {
  it('moves the vertices near the selected one by their share, the far ones not at all', () => {
    const { project } = buildFixture();
    docStore.replace(project);
    A.selectBone(project.skeleton.bones[0].id);
    const made = P.createPolygon('clipping', [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [50, 160],
    ])!;
    expect(made).not.toBeNull();
    const poly = () => P.getPolygon(made.slotId, made.name)!;
    const before = Array.from(poly().vertices);
    const weights = softWeights(before, [0], 120, 'linear');
    expect(weights.has(2)).toBe(false);
    P.movePolygonVertices(made.slotId, made.name, softMoves(before, weights, 20, 0));
    const after = poly().vertices;
    const root = project.skeleton.bones[0];
    expect(root.rotation).toBe(0);
    for (let i = 0; i < before.length / 2; i++) {
      const w = weights.get(i) ?? 0;
      expect(after[i * 2] - before[i * 2]).toBeCloseTo(20 * w, 3);
      expect(after[i * 2 + 1] - before[i * 2 + 1]).toBeCloseTo(0, 3);
    }
  });
});
