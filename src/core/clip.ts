/**
 * Clipping attachments. The renderer clips with the stencil buffer instead of cutting triangles like Spine's
 * `SkeletonClipping`, so what is shared with the reference runtime is (1) WHICH slots are clipped by which polygon
 * (`planClipping`) and (2) the polygon preparation: a `convex` or `inverse` clip whose polygon is (or has deformed
 * into) a concave shape uses its convex hull.
 */
import type { ClippingData, Skeleton, Slot } from './skeleton';

/** A clipping attachment that is in effect, with the slot whose bone carries it. */
export interface ClipState {
  slot: Slot;
  att: ClippingData;
}

/**
 * For every slot of the draw order, the clip that applies while the slot is drawn (null = none). Mirrors the loop of
 * Spine's `SkeletonRendererCore`: a clipping attachment starts clipping after its own slot (nesting is ignored) and the
 * clip ends after its `end` slot, which is therefore still clipped; without an `end` it lasts to the end of the draw order.
 * `skip` marks slots that are not rendered (hidden in the editor): they count as having no attachment.
 */
export function planClipping(skeleton: Skeleton, skip?: (slot: Slot) => boolean): (ClipState | null)[] {
  const plan: (ClipState | null)[] = [];
  let clip: ClipState | null = null;
  const endIfLast = (slot: Slot) => {
    if (clip && clip.att.end === slot.data.id) clip = null;
  };
  for (const slot of skeleton.drawOrder) {
    const att = skip?.(slot) ? null : skeleton.slotAttachment(slot);
    if (att && att.kind === 'clipping') {
      endIfLast(slot);
      if (!clip) clip = { slot, att };
      plan.push(null); // the clipping slot itself draws nothing
      continue;
    }
    plan.push(clip);
    endIfLast(slot);
  }
  return plan;
}

/** True when all turns of the polygon (x,y pairs, `n` vertices) go the same way. */
function isConvexPolygon(v: ArrayLike<number>, n: number): boolean {
  if (n < 3) return true;
  let noCW = true;
  let noCCW = true;
  let prevX = v[(n - 1) * 2];
  let prevY = v[(n - 1) * 2 + 1];
  let currX = v[0];
  let currY = v[1];
  for (let i = 1; i <= n; i++) {
    const j = i % n;
    const nextX = v[j * 2];
    const nextY = v[j * 2 + 1];
    const cross = (currX - prevX) * (nextY - currY) - (currY - prevY) * (nextX - currX);
    noCCW = noCCW && cross <= 0;
    noCW = noCW && cross >= 0;
    prevX = currX;
    prevY = currY;
    currX = nextX;
    currY = nextY;
  }
  return noCW || noCCW;
}

/** Convex hull (Andrew's monotone chain) of x,y pairs; counter-clockwise, no repeated first point. */
function convexHull(v: ArrayLike<number>, n: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => v[a * 2] - v[b * 2] || v[a * 2 + 1] - v[b * 2 + 1]);
  const cross = (o: number, a: number, b: number) =>
    (v[a * 2] - v[o * 2]) * (v[b * 2 + 1] - v[o * 2 + 1]) - (v[a * 2 + 1] - v[o * 2 + 1]) * (v[b * 2] - v[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const out: number[] = [];
  for (const i of [...lower, ...upper]) out.push(v[i * 2], v[i * 2 + 1]);
  return out;
}

/** The polygon that is actually used for clipping: the hull for a concave `convex` / `inverse` clip, else the polygon itself. */
export function clipOutline(
  world: ArrayLike<number>,
  n: number,
  convex: boolean,
  inverse: boolean,
): { vertices: ArrayLike<number>; count: number } {
  if ((convex || inverse) && !isConvexPolygon(world, n)) {
    const hull = convexHull(world, n);
    return { vertices: hull, count: hull.length >> 1 };
  }
  return { vertices: world, count: n };
}

/** Fan triangulation `[0, i, i+1]`. With the stencil `INVERT` operation the overlaps cancel, which fills any simple polygon (even concave). */
export function fanIndices(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
  return out;
}

/** Even-odd point-in-polygon test, the same as `SkeletonBounds.containsPointPolygon`. */
export function polygonContains(v: ArrayLike<number>, n: number, x: number, y: number): boolean {
  let inside = false;
  let prev = (n - 1) * 2;
  for (let ii = 0; ii < n * 2; ii += 2) {
    const vy = v[ii + 1];
    const py = v[prev + 1];
    if ((vy < y && py >= y) || (py < y && vy >= y)) {
      const vx = v[ii];
      if (vx + ((y - vy) / (py - vy)) * (v[prev] - vx) < x) inside = !inside;
    }
    prev = ii;
  }
  return inside;
}
