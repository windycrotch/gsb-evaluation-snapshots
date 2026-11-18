import type { Vec3 } from '../types';

/**
 * Pure X-axis build-plate layout engine.
 *
 * Rules (see ViewerState layout requirements):
 * - Models sit side by side along X with a fixed LAYOUT_GAP (10 mm) between
 *   adjacent model edges.
 * - Newly measured models are appended to the right of every already-placed
 *   model; the very first batch on an empty plate is centered around X = 0.
 * - After a scale change, the scaled model and every non-anchored model to its
 *   right are translated so the 10 mm edge gaps are restored.
 * - After a removal, surviving non-anchored models are compacted in original
 *   order.
 * - Manually positioned ("dragged") models are fixed anchors. Layout never
 *   moves an anchor, and may only move non-anchored models to the right of it.
 *
 * Every function here is deterministic, side-effect free, and operates only on
 * the data passed in, which keeps it fully testable without a renderer,
 * browser APIs, network access, or model files.
 */

export const LAYOUT_GAP = 10;

export interface LayoutInput {
  /** Model ids in original add-order. */
  modelIds: string[];
  dimensions: Record<string, Vec3>;
  positions: Record<string, Vec3>;
  scales: Record<string, Vec3>;
  /** Ids the user has manually positioned; these are fixed layout anchors. */
  anchorIds?: ReadonlySet<string>;
}

/** Scaled X width of a model in millimeters; 0 when dimensions are unknown. */
export const getModelWidth = (
  id: string,
  dimensions: Record<string, Vec3>,
  scales: Record<string, Vec3>
): number => {
  const dim = dimensions[id];
  if (!dim) return 0;
  const scaleX = Math.abs(scales[id]?.x ?? 1);
  return dim.x * scaleX;
};

const rightEdge = (position: Vec3, width: number): number => position.x + width / 2;

/**
 * Positions models that have just received their bounding-box dimensions.
 * Existing positions (including manual drags) are always preserved. New models
 * are appended to the right of the furthest-placed right edge, or centered as
 * one batch when nothing on the plate has a position yet.
 */
export const layoutNewModels = ({
  modelIds,
  dimensions,
  positions,
  scales,
}: LayoutInput): Record<string, Vec3> => {
  const nextPositions: Record<string, Vec3> = { ...positions };
  const newlyDimensioned: string[] = [];
  let hasPositionedModels = false;
  let maxRightEdge = -Infinity;

  for (const id of modelIds) {
    const dim = dimensions[id];
    const existingPos = positions[id];

    if (existingPos) {
      hasPositionedModels = true;
      if (dim) {
        maxRightEdge = Math.max(
          maxRightEdge,
          rightEdge(existingPos, getModelWidth(id, dimensions, scales))
        );
      }
    } else if (dim) {
      newlyDimensioned.push(id);
    }
  }

  if (newlyDimensioned.length === 0) {
    return nextPositions;
  }

  if (!hasPositionedModels) {
    // Fresh plate: center the initial batch around X = 0.
    let currentX = 0;
    for (const id of newlyDimensioned) {
      const width = getModelWidth(id, dimensions, scales);
      nextPositions[id] = { x: currentX + width / 2, y: 0, z: 0 };
      currentX += width + LAYOUT_GAP;
    }

    const totalWidth = currentX - LAYOUT_GAP;
    const shiftX = totalWidth > 0 ? -totalWidth / 2 : 0;
    for (const id of newlyDimensioned) {
      nextPositions[id] = { ...nextPositions[id], x: nextPositions[id].x + shiftX };
    }
    return nextPositions;
  }

  // Append newly loaded models to the right of the existing arrangement.
  let cursorX = Number.isFinite(maxRightEdge) ? maxRightEdge + LAYOUT_GAP : 0;
  for (const id of newlyDimensioned) {
    const width = getModelWidth(id, dimensions, scales);
    nextPositions[id] = { x: cursorX + width / 2, y: 0, z: 0 };
    cursorX += width + LAYOUT_GAP;
  }

  return nextPositions;
};

/**
 * Re-establishes the 10 mm chain for models that already have positions.
 *
 * Sweeping left to right in original order:
 * - The first positioned model stays put, so the whole arrangement never
 *   drifts when nothing relevant changed.
 * - A manually positioned anchor is never moved; the sweep restarts from its
 *   right edge, so only non-anchored models following it can be shifted.
 * - Every other non-anchored model is placed LAYOUT_GAP mm after the previous
 *   model's right edge, compacting gaps left by deletions and absorbing width
 *   changes from scaling.
 *
 * Models without a position (e.g. geometry still loading) are left untouched
 * for layoutNewModels to pick up once their dimensions arrive.
 */
export const relayoutModels = ({
  modelIds,
  dimensions,
  positions,
  scales,
  anchorIds,
}: LayoutInput): Record<string, Vec3> => {
  const anchors = anchorIds ?? new Set<string>();
  const nextPositions: Record<string, Vec3> = { ...positions };

  let cursor: number | null = null;
  let firstPositioned = true;

  for (const id of modelIds) {
    const pos = positions[id];
    if (!pos) continue;

    const width = getModelWidth(id, dimensions, scales);

    if (firstPositioned || anchors.has(id)) {
      // Anchors (and the first positioned model) keep their current location.
      nextPositions[id] = pos;
      cursor = rightEdge(pos, width) + LAYOUT_GAP;
      firstPositioned = false;
      continue;
    }

    const targetX = (cursor ?? 0) + width / 2;
    nextPositions[id] = { ...pos, x: targetX };
    cursor = targetX + width / 2 + LAYOUT_GAP;
  }

  return nextPositions;
};
