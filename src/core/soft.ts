/**
 * Soft selection for the vertices of a mesh: dragging the selected vertices also pulls the ones near them, less and less with the distance
 * (the "proportional editing" of 3D tools). The weight of a vertex is 1 when it is selected, falls to 0 at `radius` from the nearest selected
 * vertex and is 0 beyond it. Nothing here is saved or exported: it only decides how far each vertex follows the drag.
 */
export type SoftShape = 'smooth' | 'linear' | 'sharp';

/** The share of the drag a vertex at distance `t` (0 at the selection, 1 at the radius) follows. */
export function softFalloff(t: number, shape: SoftShape): number {
  if (!(t < 1)) return 0;
  if (t <= 0) return 1;
  if (shape === 'linear') return 1 - t;
  if (shape === 'sharp') return (1 - t) * (1 - t);
  return 1 - t * t * (3 - 2 * t); // smooth: one minus smoothstep, flat at both ends
}

/**
 * The weight of every vertex that follows the drag (selected ones are 1). `points` is x, y pairs; vertices out of range are ignored.
 * With a radius of 0 (or no selection) only the selected vertices are in the map.
 */
export function softWeights(points: ArrayLike<number>, picked: readonly number[], radius: number, shape: SoftShape): Map<number, number> {
  const count = Math.floor(points.length / 2);
  const out = new Map<number, number>();
  const ids = [...new Set(picked)].filter((i) => Number.isInteger(i) && i >= 0 && i < count);
  for (const i of ids) out.set(i, 1);
  if (!ids.length || !(radius > 0)) return out;
  const r2 = radius * radius;
  for (let i = 0; i < count; i++) {
    if (out.has(i)) continue;
    let best = r2;
    for (const p of ids) {
      const dx = points[i * 2] - points[p * 2];
      const dy = points[i * 2 + 1] - points[p * 2 + 1];
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    if (best >= r2) continue;
    const w = softFalloff(Math.sqrt(best) / radius, shape);
    if (w > 0) out.set(i, w);
  }
  return out;
}

/** The new position of each weighted vertex after a drag of (dx, dy) from the positions in `start` (x, y pairs). */
export function softMoves(
  start: ArrayLike<number>,
  weights: ReadonlyMap<number, number>,
  dx: number,
  dy: number,
): { index: number; x: number; y: number }[] {
  const moves: { index: number; x: number; y: number }[] = [];
  for (const [index, w] of weights) moves.push({ index, x: start[index * 2] + dx * w, y: start[index * 2 + 1] + dy * w });
  return moves;
}
