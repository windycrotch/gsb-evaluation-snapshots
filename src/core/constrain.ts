/**
 * Constrained triangulation: Spine lets the user draw edges between mesh vertices (orange) and the triangulation never crosses them, and the
 * outline (cyan) always stays edges, concave or not. This takes a plain Delaunay triangulation and makes every constraint an edge of it by
 * flipping the edges that cross it (Sloan's method), then flips the other edges back to Delaunay where it is allowed.
 */

type P = ArrayLike<number>;

const cross = (p: P, a: number, b: number, c: number) =>
  (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);

/** The open segments a-b and c-d cross at a point that is inside both (touching at an end or sharing a vertex does not count). */
export function segmentsCross(p: P, a: number, b: number, c: number, d: number): boolean {
  if (a === c || a === d || b === c || b === d) return false;
  const d1 = cross(p, a, b, c);
  const d2 = cross(p, a, b, d);
  const d3 = cross(p, c, d, a);
  const d4 = cross(p, c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Vertices (other than a and b) that lie on the segment a-b, nearest to a first. */
function onSegment(p: P, n: number, a: number, b: number): number[] {
  const dx = p[b * 2] - p[a * 2];
  const dy = p[b * 2 + 1] - p[a * 2 + 1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [];
  const found: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (i === a || i === b) continue;
    const t = ((p[i * 2] - p[a * 2]) * dx + (p[i * 2 + 1] - p[a * 2 + 1]) * dy) / len2;
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const off = Math.abs(cross(p, a, b, i)) / Math.sqrt(len2);
    if (off < 1e-6) found.push([t, i]);
  }
  return found.sort((x, y) => x[0] - y[0]).map((f) => f[1]);
}

export function constrainTriangles(points: P, triangles: ArrayLike<number>, constraints: readonly (readonly [number, number])[]): number[] {
  const n = points.length >> 1;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const tris: number[][] = [];
  const alive: boolean[] = [];
  const edge = new Map<number, number[]>();
  const link = (t: number) => {
    const v = tris[t];
    for (let k = 0; k < 3; k++) {
      const e = key(v[k], v[(k + 1) % 3]);
      const list = edge.get(e);
      if (list) list.push(t);
      else edge.set(e, [t]);
    }
  };
  const unlink = (t: number) => {
    const v = tris[t];
    for (let k = 0; k < 3; k++) {
      const e = key(v[k], v[(k + 1) % 3]);
      const list = edge.get(e);
      if (!list) continue;
      const at = list.indexOf(t);
      if (at >= 0) list.splice(at, 1);
      if (!list.length) edge.delete(e);
    }
  };
  const add = (a: number, b: number, c: number) => {
    tris.push(cross(points, a, b, c) < 0 ? [a, c, b] : [a, b, c]);
    alive.push(true);
    link(tris.length - 1);
  };
  for (let i = 0; i < triangles.length; i += 3) {
    if (Math.abs(cross(points, triangles[i], triangles[i + 1], triangles[i + 2])) > 1e-9)
      add(triangles[i], triangles[i + 1], triangles[i + 2]);
  }
  const fixed = new Set<number>();
  const opposite = (t: number, a: number, b: number) => tris[t].find((v) => v !== a && v !== b)!;

  /** Flips the edge a-b shared by two triangles; returns the new edge, or null when the quad is not convex. */
  const flip = (a: number, b: number): [number, number] | null => {
    const list = edge.get(key(a, b));
    if (!list || list.length !== 2) return null;
    const [t1, t2] = list;
    const r = opposite(t1, a, b);
    const s = opposite(t2, a, b);
    if (!segmentsCross(points, a, b, r, s)) return null;
    unlink(t1);
    unlink(t2);
    alive[t1] = false;
    alive[t2] = false;
    add(r, s, a);
    add(s, r, b);
    return [r, s];
  };

  const insert = (u: number, v: number, depth = 0): void => {
    if (u === v || edge.has(key(u, v))) {
      if (u !== v) fixed.add(key(u, v));
      return;
    }
    const mid = depth < 8 ? onSegment(points, n, u, v) : [];
    if (mid.length) {
      // a vertex sits on the segment: the constraint is the chain through it
      const chain = [u, ...mid, v];
      for (let i = 0; i + 1 < chain.length; i++) insert(chain[i], chain[i + 1], depth + 1);
      return;
    }
    const queue: [number, number][] = [];
    for (const [e, list] of edge) {
      if (list.length !== 2 || fixed.has(e)) continue;
      const a = Math.floor(e / n);
      const b = e % n;
      if (segmentsCross(points, u, v, a, b)) queue.push([a, b]);
    }
    let guard = 20 * (queue.length + 10) ** 2;
    while (queue.length && guard-- > 0) {
      const [a, b] = queue.shift()!;
      if (!edge.has(key(a, b)) || !segmentsCross(points, u, v, a, b)) continue;
      const made = flip(a, b);
      if (!made) queue.push([a, b]);
      else if (segmentsCross(points, u, v, made[0], made[1])) queue.push(made);
    }
    if (edge.has(key(u, v))) fixed.add(key(u, v));
  };
  for (const [a, b] of constraints) insert(a, b);

  // back to Delaunay where the edge is not a constraint
  const illegal = (a: number, b: number): boolean => {
    const list = edge.get(key(a, b));
    if (!list || list.length !== 2 || fixed.has(key(a, b))) return false;
    const r = opposite(list[0], a, b);
    const s = opposite(list[1], a, b);
    // in-circle test of s against the circle through a, b, r (a, b, r in counter-clockwise order)
    const [p1, p2, p3] = cross(points, a, b, r) > 0 ? [a, b, r] : [a, r, b];
    const ax = points[p1 * 2];
    const ay = points[p1 * 2 + 1];
    const bx = points[p2 * 2];
    const by = points[p2 * 2 + 1];
    const cx = points[p3 * 2];
    const cy = points[p3 * 2 + 1];
    const dx = points[s * 2] - ax;
    const dy = points[s * 2 + 1] - ay;
    const ex = bx - ax;
    const ey = by - ay;
    const fx = cx - ax;
    const fy = cy - ay;
    const det =
      (ex * ex + ey * ey) * (fx * dy - fy * dx) - (fx * fx + fy * fy) * (ex * dy - ey * dx) + (dx * dx + dy * dy) * (ex * fy - ey * fx);
    return det > 1e-9;
  };
  for (let pass = 0, changed = true; changed && pass < 50; pass++) {
    changed = false;
    for (const e of [...edge.keys()]) {
      const a = Math.floor(e / n);
      const b = e % n;
      if (illegal(a, b) && flip(a, b)) changed = true;
    }
  }

  const out: number[] = [];
  tris.forEach((t, i) => {
    if (alive[i]) out.push(t[0], t[1], t[2]);
  });
  return out;
}
