import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../types';
import {
  LAYOUT_GAP,
  layoutNewModels,
  relayoutModels,
  getModelWidth,
} from '../utils/layout.ts';

const vec = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });
const GAP = LAYOUT_GAP;

/** Build dimensions/scales/positions records keyed by model id. */
const buildState = (
  ids: string[],
  widths: Record<string, number>,
  scales: Record<string, number> = {},
  positions: Record<string, Vec3> = {}
) => {
  const dimensions: Record<string, Vec3> = {};
  const scaleVecs: Record<string, Vec3> = {};
  for (const id of ids) {
    dimensions[id] = vec(widths[id]);
    scaleVecs[id] = vec(scales[id] ?? 1);
  }
  return { dimensions, scales: scaleVecs, positions };
};

/** X position of a model center. */
const xOf = (positions: Record<string, Vec3>, id: string): number => positions[id].x;

/** Gap between two adjacent model edges (right edge of a, left edge of b). */
const edgeGap = (
  positions: Record<string, Vec3>,
  dimensions: Record<string, Vec3>,
  scales: Record<string, Vec3>,
  a: string,
  b: string
): number => {
  const aRight = positions[a].x + getModelWidth(a, dimensions, scales) / 2;
  const bLeft = positions[b].x - getModelWidth(b, dimensions, scales) / 2;
  return bLeft - aRight;
};

describe('relayoutModels: scaling the middle model shifts everything to its right', () => {
  const ids = ['A', 'B', 'C'];
  const base = buildState(ids, { A: 20, B: 40, C: 60 });

  // Establish the initial 10 mm chain.
  const initial = relayoutModels({
    modelIds: ids,
    dimensions: base.dimensions,
    positions: { A: vec(0), B: vec(0), C: vec(0) },
    scales: base.scales,
  });

  it('keeps a 10 mm gap between every adjacent pair initially', () => {
    assert.equal(edgeGap(initial, base.dimensions, base.scales, 'A', 'B'), GAP);
    assert.equal(edgeGap(initial, base.dimensions, base.scales, 'B', 'C'), GAP);
    assert.equal(xOf(initial, 'A'), 0);
    assert.equal(xOf(initial, 'B'), 20 / 2 + GAP + 40 / 2); // 40
    assert.equal(xOf(initial, 'C'), 40 + 40 / 2 + GAP + 60 / 2); // 100
  });

  it('moves the scaled model itself and every model to its right, leaving left models fixed', () => {
    // Scale B from 40 mm to 80 mm wide (scaleX 2).
    const scaledScales = { ...base.scales, B: vec(2) };
    const after = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: initial,
      scales: scaledScales,
    });

    // A is to the left of the scaled model: must not move.
    assert.equal(xOf(after, 'A'), xOf(initial, 'A'));

    // B grows by 40 mm; its center shifts right by half of that (20 mm).
    assert.equal(xOf(after, 'B'), xOf(initial, 'B') + 20);

    // C keeps its full 40 mm growth plus its own half-width offset => +40 mm.
    assert.equal(xOf(after, 'C'), xOf(initial, 'C') + 40);

    // The chain still respects the exact 10 mm edge spacing.
    assert.equal(edgeGap(after, base.dimensions, scaledScales, 'A', 'B'), GAP);
    assert.equal(edgeGap(after, base.dimensions, scaledScales, 'B', 'C'), GAP);
  });

  it('shrinking the middle model pulls right-side models back without overlap or a big void', () => {
    const shrunkScales = { ...base.scales, B: vec(0.5) }; // 40 -> 20 mm
    const after = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: initial,
      scales: shrunkScales,
    });

    assert.equal(xOf(after, 'A'), xOf(initial, 'A'));
    assert.equal(xOf(after, 'B'), xOf(initial, 'B') - 10); // half of the 20 mm shrink
    assert.equal(xOf(after, 'C'), xOf(initial, 'C') - 20);
    assert.equal(edgeGap(after, base.dimensions, shrunkScales, 'A', 'B'), GAP);
    assert.equal(edgeGap(after, base.dimensions, shrunkScales, 'B', 'C'), GAP);
  });
});

describe('relayoutModels: deletion compacts surviving models in original order', () => {
  const ids = ['A', 'B', 'C', 'D'];
  const base = buildState(ids, { A: 20, B: 40, C: 60, D: 30 });
  const initial = relayoutModels({
    modelIds: ids,
    dimensions: base.dimensions,
    positions: { A: vec(0), B: vec(0), C: vec(0), D: vec(0) },
    scales: base.scales,
  });

  it('closes the gap left by a deleted middle model', () => {
    const survivors = ['A', 'C', 'D'];
    const after = relayoutModels({
      modelIds: survivors,
      dimensions: base.dimensions,
      positions: initial,
      scales: base.scales,
    });

    assert.equal(xOf(after, 'A'), xOf(initial, 'A'));
    // C now sits directly after A with the standard gap.
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'A', 'C'), GAP);
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'C', 'D'), GAP);
    assert.equal(xOf(after, 'C'), xOf(initial, 'A') + 20 / 2 + GAP + 60 / 2);
  });

  it('deleting the first model leaves the new first model pinned where it was', () => {
    const survivors = ['B', 'C', 'D'];
    const after = relayoutModels({
      modelIds: survivors,
      dimensions: base.dimensions,
      positions: initial,
      scales: base.scales,
    });

    assert.equal(xOf(after, 'B'), xOf(initial, 'B'));
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'B', 'C'), GAP);
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'C', 'D'), GAP);
  });
});

describe('relayoutModels: manually dragged models are fixed anchors', () => {
  const ids = ['A', 'B', 'C'];
  const base = buildState(ids, { A: 20, B: 40, C: 60 });
  const initial = relayoutModels({
    modelIds: ids,
    dimensions: base.dimensions,
    positions: { A: vec(0), B: vec(0), C: vec(0) },
    scales: base.scales,
  });

  it('never overwrites an anchor position and only moves non-anchors to its right', () => {
    // User drags B far right to x = 200.
    const dragged: Record<string, Vec3> = { ...initial, B: vec(200) };
    const after = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: dragged,
      scales: base.scales,
      anchorIds: new Set(['B']),
    });

    assert.equal(xOf(after, 'A'), xOf(initial, 'A')); // left side untouched
    assert.equal(xOf(after, 'B'), 200); // anchor preserved exactly
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'B', 'C'), GAP);
    assert.equal(xOf(after, 'C'), 200 + 40 / 2 + GAP + 60 / 2); // 235
  });

  it('scaling a non-anchor still cannot drag a left-side anchor', () => {
    const dragged: Record<string, Vec3> = { ...initial, A: vec(-150) };
    const scaledScales = { ...base.scales, B: vec(3) }; // B: 40 -> 120
    const after = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: dragged,
      scales: scaledScales,
      anchorIds: new Set(['A']),
    });

    assert.equal(xOf(after, 'A'), -150); // anchor immovable
    assert.equal(edgeGap(after, base.dimensions, scaledScales, 'A', 'B'), GAP);
    assert.equal(edgeGap(after, base.dimensions, scaledScales, 'B', 'C'), GAP);
  });

  it('deleting an anchor lets the remaining chain re-compact without it', () => {
    const dragged: Record<string, Vec3> = { ...initial, B: vec(200) };
    const survivors = ['A', 'C'];
    const after = relayoutModels({
      modelIds: survivors,
      dimensions: base.dimensions,
      positions: dragged,
      scales: base.scales,
      anchorIds: new Set<string>(), // B's anchor id was removed with the model
    });

    assert.equal(xOf(after, 'A'), xOf(initial, 'A'));
    assert.equal(edgeGap(after, base.dimensions, base.scales, 'A', 'C'), GAP);
  });
});

describe('relayoutModels: repeated scale/delete sequences converge on the final state', () => {
  const ids = ['A', 'B', 'C', 'D'];
  const base = buildState(ids, { A: 20, B: 40, C: 60, D: 30 });

  it('produces the same result as one relayout computed from the final data', () => {
    // Stepwise path: initial layout -> scale B 2x -> scale C 0.5x -> delete B.
    let positions = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: { A: vec(0), B: vec(0), C: vec(0), D: vec(0) },
      scales: base.scales,
    });
    let scales = { ...base.scales };

    scales = { ...scales, B: vec(2) };
    positions = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions,
      scales,
    });

    scales = { ...scales, C: vec(0.5) };
    positions = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions,
      scales,
    });

    const finalIds = ['A', 'C', 'D'];
    const stepwise = relayoutModels({
      modelIds: finalIds,
      dimensions: base.dimensions,
      positions,
      scales,
    });

    // Direct path from the final data set.
    const direct = relayoutModels({
      modelIds: finalIds,
      dimensions: base.dimensions,
      positions: { A: vec(0), C: vec(0), D: vec(0) },
      scales,
    });

    for (const id of finalIds) {
      assert.ok(Math.abs(stepwise[id].x - direct[id].x) < 1e-9, `x mismatch for ${id}`);
    }
    assert.equal(edgeGap(stepwise, base.dimensions, scales, 'A', 'C'), GAP);
    assert.equal(edgeGap(stepwise, base.dimensions, scales, 'C', 'D'), GAP);
  });

  it('is idempotent: running it again changes nothing', () => {
    const once = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: { A: vec(0), B: vec(0), C: vec(0), D: vec(0) },
      scales: { ...base.scales, B: vec(2.5) },
    });
    const twice = relayoutModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: once,
      scales: { ...base.scales, B: vec(2.5) },
    });
    assert.deepEqual(twice, once);
  });
});

describe('layoutNewModels: initial centering and right-side appending', () => {
  it('centers the first batch around X = 0 with 10 mm gaps', () => {
    const ids = ['A', 'B'];
    const base = buildState(ids, { A: 20, B: 40 });
    const positions = layoutNewModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: {},
      scales: base.scales,
    });

    // Total width 20 + 10 + 40 = 70, centered => left edge -35, right edge +35.
    assert.equal(positions.A.x - 10, -35);
    assert.equal(positions.B.x + 20, 35);
    assert.equal(edgeGap(positions, base.dimensions, base.scales, 'A', 'B'), GAP);
  });

  it('appends later models at the far right without moving placed models', () => {
    const ids = ['A', 'B', 'C'];
    const base = buildState(ids, { A: 20, B: 40, C: 60 });

    // A and B already positioned (mimic the first debounced batch).
    const firstBatch = layoutNewModels({
      modelIds: ['A', 'B'],
      dimensions: base.dimensions,
      positions: {},
      scales: base.scales,
    });

    // C's dimensions arrive later; it must append beyond B's right edge.
    const withC = layoutNewModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: firstBatch,
      scales: base.scales,
    });

    assert.equal(withC.A.x, firstBatch.A.x);
    assert.equal(withC.B.x, firstBatch.B.x);
    assert.equal(edgeGap(withC, base.dimensions, base.scales, 'B', 'C'), GAP);
  });

  it('never overwrites an existing (including manually dragged) position', () => {
    const ids = ['A', 'B'];
    const base = buildState(ids, { A: 20, B: 40 });
    const positions = layoutNewModels({
      modelIds: ids,
      dimensions: base.dimensions,
      positions: { A: vec(123, 5, -7) },
      scales: base.scales,
    });

    assert.deepEqual(positions.A, vec(123, 5, -7));
    assert.equal(edgeGap(positions, base.dimensions, base.scales, 'A', 'B'), GAP);
  });
});
