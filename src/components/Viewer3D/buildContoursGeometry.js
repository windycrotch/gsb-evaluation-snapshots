import * as THREE from "three";
import { marchingSquaresLevel } from "./marchingSquares";
import { bilinear } from "../../utils/geo";

const Y_OFFSET_UNITS = 0.2; // small lift so lines don't z-fight with terrain

/**
 * Build draped contour points as a flat Vector3 list of segment pairs.
 * Each consecutive pair of Vector3s is one disconnected segment, suitable
 * for drei's <Line segments points={...} />.
 *
 * @param heightmap    {elevations, width, height}
 * @param bounds       {sceneWidth, sceneDepth}
 * @param scale        {verticalScale}
 * @param levels       array of elevation values (meters)
 * @param floodedCells optional boolean[] of length width*height; when a cell
 *                     is flagged as flooded (under the water surface) its
 *                     contour segments are skipped so no line is drawn
 *                     underwater.
 * @returns {THREE.Vector3[]} pairs of endpoints (length always even)
 */
export function buildContoursPoints(
  heightmap,
  bounds,
  scale,
  levels,
  floodedCells = null,
) {
  const { width: W, height: H } = heightmap;
  const { sceneWidth, sceneDepth } = bounds;
  const { verticalScale } = scale;
  const startX = -sceneWidth / 2;
  const startZ = -sceneDepth / 2;
  const sx = sceneWidth / (W - 1);
  const sz = sceneDepth / (H - 1);

  const points = [];
  for (const level of levels) {
    const segs = marchingSquaresLevel(heightmap, level);
    for (let i = 0; i < segs.length; i += 4) {
      const px0 = segs[i], py0 = segs[i + 1];
      const px1 = segs[i + 2], py1 = segs[i + 3];

      // Skip contour segments whose quad lies entirely inside the flooded
      // region — those lines would otherwise be drawn below the water
      // surface. Segments straddling the waterline are kept.
      if (floodedCells) {
        // Endpoints sit on quad edges, so use the segment midpoint to
        // identify which marching-squares quad produced it.
        const mx = (px0 + px1) / 2;
        const my = (py0 + py1) / 2;
        const c = Math.min(Math.floor(mx), Math.max(0, W - 2));
        const r = Math.min(Math.floor(my), Math.max(0, H - 2));
        const quadFlooded =
          floodedCells[r * W + c] &&
          floodedCells[r * W + c + 1] &&
          floodedCells[(r + 1) * W + c] &&
          floodedCells[(r + 1) * W + c + 1];
        if (quadFlooded) continue;
      }

      const ele0 = bilinear(heightmap, px0, py0);
      const ele1 = bilinear(heightmap, px1, py1);
      points.push(
        new THREE.Vector3(
          startX + px0 * sx,
          ele0 * verticalScale + Y_OFFSET_UNITS,
          startZ + py0 * sz,
        ),
        new THREE.Vector3(
          startX + px1 * sx,
          ele1 * verticalScale + Y_OFFSET_UNITS,
          startZ + py1 * sz,
        ),
      );
    }
  }
  return points;
}

/** Evenly spaced contour levels covering the heightmap range. */
export function makeLevels(minElevation, maxElevation, spacing) {
  if (spacing <= 0) return [];
  const startLevel = Math.ceil(minElevation / spacing) * spacing;
  const out = [];
  for (let l = startLevel; l <= maxElevation; l += spacing) out.push(l);
  return out;
}
