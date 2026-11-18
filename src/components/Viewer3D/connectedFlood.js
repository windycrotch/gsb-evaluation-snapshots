/**
 * Connected ("hydraulically linked") static flood inundation.
 *
 * Only water that can reach the heightmap border is counted as inundation:
 * every boundary cell whose elevation is <= level is used as a seed, and the
 * flood spreads to the four-neighbourhood through cells that are themselves
 * <= level. Low cells that are walled in by higher ground are therefore
 * reported separately as enclosed depressions instead of being counted as
 * flooded.
 *
 * All values are non-negative; an empty or degenerate heightmap, a level below
 * the global minimum, or a non-finite level yields an all-zero result.
 *
 * @param {{elevations: ArrayLike<number>, width: number, height: number}} hm
 * @param {number} level          water surface elevation in meters
 * @param {number} pixelAreaM2    horizontal area of one heightmap cell in m²
 * @returns {{
 *   connectedCount: number,
 *   connectedAreaM2: number,
 *   enclosedCount: number,
 *   floodedFraction: number,
 *   connected: boolean[],
 * }} `connected[i]` is true iff cell i is part of the border-connected water
 *    body; `enclosedCount` counts cells at or below `level` that are not
 *    connected (i.e. ponded behind higher ground).
 */
export function computeConnectedFlood(hm, level, pixelAreaM2) {
  const width = Math.trunc(hm?.width ?? 0);
  const height = Math.trunc(hm?.height ?? 0);
  const total = width > 0 && height > 0 ? width * height : 0;
  const elevations = hm?.elevations;
  const cellAreaM2 =
    Number.isFinite(pixelAreaM2) && pixelAreaM2 > 0 ? pixelAreaM2 : 0;

  const zeroResult = (size) => ({
    connectedCount: 0,
    connectedAreaM2: 0,
    enclosedCount: 0,
    floodedFraction: 0,
    connected: new Array(size).fill(false),
  });

  if (
    total === 0 ||
    !elevations ||
    elevations.length < total ||
    !Number.isFinite(level)
  ) {
    return zeroResult(total);
  }

  const connected = new Array(total).fill(false);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  // Seed from every border cell that is at or below the water level.
  for (let r = 0; r < height; r++) {
    const isBorderRow = r === 0 || r === height - 1;
    for (let c = 0; c < width; c++) {
      if (!isBorderRow && c !== 0 && c !== width - 1) continue;
      const i = r * width + c;
      if (elevations[i] <= level) {
        connected[i] = true;
        queue[tail++] = i;
      }
    }
  }

  // Flood fill through 4-connected cells that stay at or below the level.
  while (head < tail) {
    const i = queue[head++];
    const c = i % width;
    const r = (i - c) / width;

    if (c > 0) {
      const j = i - 1;
      if (!connected[j] && elevations[j] <= level) {
        connected[j] = true;
        queue[tail++] = j;
      }
    }
    if (c < width - 1) {
      const j = i + 1;
      if (!connected[j] && elevations[j] <= level) {
        connected[j] = true;
        queue[tail++] = j;
      }
    }
    if (r > 0) {
      const j = i - width;
      if (!connected[j] && elevations[j] <= level) {
        connected[j] = true;
        queue[tail++] = j;
      }
    }
    if (r < height - 1) {
      const j = i + width;
      if (!connected[j] && elevations[j] <= level) {
        connected[j] = true;
        queue[tail++] = j;
      }
    }
  }

  const connectedCount = tail;
  let enclosedCount = 0;
  for (let i = 0; i < total; i++) {
    if (!connected[i] && elevations[i] <= level) enclosedCount++;
  }

  return {
    connectedCount,
    connectedAreaM2: connectedCount * cellAreaM2,
    enclosedCount,
    floodedFraction: total > 0 ? connectedCount / total : 0,
    connected,
  };
}
