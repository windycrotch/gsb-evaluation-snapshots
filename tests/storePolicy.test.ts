import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../types';
import { LAYOUT_GAP, layoutNewModels, relayoutModels } from '../utils/layout.ts';

/**
 * Store-policy harness.
 *
 * store.ts cannot be imported here (it pulls in zustand, three, and browser
 * APIs), so this harness reproduces its exact action logic on top of the SAME
 * pure layout engine the store imports. It verifies the end-to-end policy a
 * user experiences: scale reflow, deletion compaction, manual anchors, and
 * convergence under rapid consecutive updates. No network or model files are
 * involved; every dimension/position/scale value is constructed in-process.
 */

interface HarnessState {
  modelIds: string[];
  dimensions: Record<string, Vec3>;
  positions: Record<string, Vec3>;
  scales: Record<string, Vec3>;
  anchorIds: string[];
}

const vec = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });

const createHarness = (
  ids: string[],
  widths: Record<string, number>
): HarnessState => {
  const state: HarnessState = {
    modelIds: [...ids],
    dimensions: {},
    positions: {},
    scales: {},
    anchorIds: [],
  };
  for (const id of ids) {
    state.dimensions[id] = vec(widths[id]);
    state.scales[id] = vec(1);
  }
  // First geometry-loaded batch lands via the debounced dimension action.
  state.positions = layoutNewModels({
    modelIds: state.modelIds,
    dimensions: state.dimensions,
    positions: state.positions,
    scales: state.scales,
  });
  return state;
};

/** Mirror of store.updateModelTransform (scale / position branches). */
const applyTransform = (
  state: HarnessState,
  id: string,
  transform: { position?: Vec3; scale?: Vec3 }
): void => {
  let positions = state.positions;
  let scales = state.scales;
  let anchors = state.anchorIds;
  let positionChanged = false;
  let scaleChanged = false;

  if (transform.position) {
    const current = positions[id];
    const next = transform.position;
    if (
      !current ||
      current.x !== next.x ||
      current.y !== next.y ||
      current.z !== next.z
    ) {
      positionChanged = true;
      positions = { ...positions, [id]: next };
      if (!anchors.includes(id)) anchors = [...anchors, id];
    }
  }
  if (transform.scale) {
    const current = scales[id];
    const next = transform.scale;
    if (
      !current ||
      current.x !== next.x ||
      current.y !== next.y ||
      current.z !== next.z
    ) {
      scaleChanged = true;
      scales = { ...scales, [id]: next };
    }
  }
  if (!positionChanged && !scaleChanged) return;

  state.positions = relayoutModels({
    modelIds: state.modelIds,
    dimensions: state.dimensions,
    positions,
    scales,
    anchorIds: new Set(anchors),
  });
  state.scales = scales;
  state.anchorIds = anchors;
};

/** Mirror of store.removeModel. */
const removeModel = (state: HarnessState, id: string): void => {
  state.modelIds = state.modelIds.filter((modelId) => modelId !== id);
  delete state.dimensions[id];
  delete state.scales[id];
  delete state.positions[id];
  state.anchorIds = state.anchorIds.filter((a) => a !== id);
  state.positions = relayoutModels({
    modelIds: state.modelIds,
    dimensions: state.dimensions,
    positions: state.positions,
    scales: state.scales,
    anchorIds: new Set(state.anchorIds),
  });
};

/** Mirror of the debounced dimension-update commit (including active-id filtering). */
const commitDimensions = (
  state: HarnessState,
  updates: Record<string, Vec3>
): void => {
  const active = new Set(state.modelIds);
  const validUpdates: Record<string, Vec3> = {};
  for (const [id, dim] of Object.entries(updates)) {
    if (active.has(id)) validUpdates[id] = dim;
  }
  state.dimensions = { ...state.dimensions, ...validUpdates };
  state.positions = layoutNewModels({
    modelIds: state.modelIds,
    dimensions: state.dimensions,
    positions: state.positions,
    scales: state.scales,
  });
};

const widthOf = (state: HarnessState, id: string): number =>
  state.dimensions[id].x * state.scales[id].x;

const edgeGap = (state: HarnessState, a: string, b: string): number => {
  const aRight = state.positions[a].x + widthOf(state, a) / 2;
  const bLeft = state.positions[b].x - widthOf(state, b) / 2;
  return bLeft - aRight;
};

describe('store policy: scaling a middle model shifts right-side models correctly', () => {
  it('reflows every model right of the scaled one with exact 10 mm gaps', () => {
    const state = createHarness(['A', 'B', 'C'], { A: 20, B: 40, C: 60 });
    const beforeA = state.positions.A.x;
    const beforeB = state.positions.B.x;
    const beforeC = state.positions.C.x;

    applyTransform(state, 'B', { scale: vec(2) }); // 40 -> 80 mm

    assert.equal(state.positions.A.x, beforeA); // left model fixed
    assert.equal(state.positions.B.x, beforeB + 20); // +half the 40 mm growth
    assert.equal(state.positions.C.x, beforeC + 40); // full growth passed along
    assert.equal(edgeGap(state, 'A', 'B'), LAYOUT_GAP);
    assert.equal(edgeGap(state, 'B', 'C'), LAYOUT_GAP);
    assert.deepEqual(state.anchorIds, []); // scaling does not create an anchor
  });
});

describe('store policy: deletion compacts the remaining models', () => {
  it('removes the middle model and closes the gap without disturbing order', () => {
    const state = createHarness(['A', 'B', 'C', 'D'], {
      A: 20,
      B: 40,
      C: 60,
      D: 30,
    });
    const startA = state.positions.A.x;

    removeModel(state, 'B');

    assert.deepEqual(state.modelIds, ['A', 'C', 'D']);
    assert.equal(state.positions.A.x, startA); // first model pinned
    assert.equal(edgeGap(state, 'A', 'C'), LAYOUT_GAP);
    assert.equal(edgeGap(state, 'C', 'D'), LAYOUT_GAP);
  });
});

describe('store policy: manual drag positions are never overwritten', () => {
  it('marks a dragged model as an anchor and only shifts its right neighbors', () => {
    const state = createHarness(['A', 'B', 'C'], { A: 20, B: 40, C: 60 });
    const startA = state.positions.A.x;
    const anchorX = 175;

    applyTransform(state, 'B', { position: vec(anchorX, 12, 0) });

    assert.deepEqual(state.anchorIds, ['B']);
    assert.equal(state.positions.B.x, anchorX);
    assert.equal(state.positions.B.y, 12); // non-X components preserved too
    assert.equal(state.positions.A.x, startA); // left neighbor untouched
    assert.equal(edgeGap(state, 'B', 'C'), LAYOUT_GAP);

    // A later scale of A grows toward the pinned B. The anchor cannot be
    // pulled left, so B stays exactly where the user put it and the chain to
    // its right remains compact.
    applyTransform(state, 'A', { scale: vec(3) });
    assert.equal(state.positions.B.x, anchorX);
    assert.equal(edgeGap(state, 'B', 'C'), LAYOUT_GAP);
    assert.deepEqual(state.anchorIds, ['B']);
  });

  it('keeps anchors pinned while other deletions compact non-anchors', () => {
    const state = createHarness(['A', 'B', 'C'], { A: 20, B: 40, C: 60 });
    applyTransform(state, 'A', { position: vec(-250) }); // A is now an anchor
    const anchorX = state.positions.A.x;

    removeModel(state, 'B');

    assert.equal(state.positions.A.x, anchorX);
    assert.deepEqual(state.anchorIds, ['A']);
    assert.equal(edgeGap(state, 'A', 'C'), LAYOUT_GAP);
  });
});

describe('store policy: rapid consecutive scale/delete events match the final state', () => {
  it('a burst of transforms converges exactly on a single final recomputation', () => {
    const state = createHarness(['A', 'B', 'C', 'D'], {
      A: 20,
      B: 40,
      C: 60,
      D: 30,
    });

    applyTransform(state, 'B', { scale: vec(2) });
    applyTransform(state, 'C', { scale: vec(0.25) });
    applyTransform(state, 'B', { scale: vec(0.5) }); // shrink back partially
    removeModel(state, 'C');
    applyTransform(state, 'D', { scale: vec(4) });

    // Reference: one synchronous relayout from exactly the final data set,
    // pinning the first surviving model at its current position (the engine
    // always keeps the first positioned model fixed).
    const referenceSeeds: Record<string, Vec3> = {};
    const firstId = state.modelIds[0];
    for (const id of state.modelIds) {
      referenceSeeds[id] = id === firstId ? state.positions[id] : vec(0);
    }
    const reference = relayoutModels({
      modelIds: state.modelIds,
      dimensions: state.dimensions,
      positions: referenceSeeds,
      scales: state.scales,
      anchorIds: new Set(state.anchorIds),
    });

    for (const id of state.modelIds) {
      assert.ok(
        Math.abs(state.positions[id].x - reference[id].x) < 1e-9,
        `stale position for ${id}: ${state.positions[id].x} vs ${reference[id].x}`
      );
    }
    assert.equal(edgeGap(state, 'A', 'B'), LAYOUT_GAP);
    assert.equal(edgeGap(state, 'B', 'D'), LAYOUT_GAP);
  });

  it('a late debounced dimension commit cannot restore a removed or dragged position', () => {
    const state = createHarness(['A', 'B'], { A: 20, B: 40 });
    // Both models have been measured and positioned before any user action.
    assert.ok(state.positions.A && state.positions.B);
    const draggedX = 300;
    applyTransform(state, 'A', { position: vec(draggedX) });
    removeModel(state, 'B');

    // Simulate an in-flight geometry measurement for B landing after removal,
    // plus a re-measurement of A, both flushed by the 50 ms debounce timer.
    commitDimensions(state, { A: vec(20), B: vec(40) });

    assert.equal(state.positions.B, undefined); // removed model never resurrects
    assert.equal(state.positions.A.x, draggedX); // manual position not overwritten
  });
});
