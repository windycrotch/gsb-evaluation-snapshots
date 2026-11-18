/**
 * Pure 1:1 (true physical scale) judgment for the orthographic camera.
 *
 * At real scale one millimeter of model geometry must occupy exactly one
 * physical screen pixel. A screen with `ppi` pixels per inch therefore needs a
 * target zoom of `ppi / 25.4` pixels per millimeter (25.4 mm per inch).
 *
 * The match is decided by RELATIVE error against that target:
 *   |currentZoom - targetPixelsPerMm| / targetPixelsPerMm < TOLERANCE
 * with TOLERANCE = 0.015 (1.5%). The comparison is strictly less-than, so an
 * error of exactly 0.015 must report a mismatch.
 */

export const ONE_TO_ONE_TOLERANCE = 0.015;
export const MM_PER_INCH = 25.4;

/** Target orthographic zoom (pixels per millimeter) for a given screen PPI. */
export const getTargetPixelsPerMm = (ppi: number): number => ppi / MM_PER_INCH;

/** Relative error of the current zoom versus the PPI-derived target. */
export const get1to1RelativeError = (currentZoom: number, ppi: number): number => {
  const target = getTargetPixelsPerMm(ppi);
  if (!Number.isFinite(target) || target <= 0) return Infinity;
  if (!Number.isFinite(currentZoom)) return Infinity;
  return Math.abs(currentZoom - target) / target;
};

/**
 * Returns true only when the orthographic camera is within the 1.5% relative
 * tolerance of true 1:1 scale. An error of exactly 0.015 is NOT a match.
 */
export const isOrthographic1to1 = (currentZoom: number, ppi: number): boolean =>
  get1to1RelativeError(currentZoom, ppi) < ONE_TO_ONE_TOLERANCE;
