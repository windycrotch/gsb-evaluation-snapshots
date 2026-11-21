/**
 * Plain 2D geometry for the demo character: smooth outlines of its parts in world coordinates of the setup pose (x to the right, y up).
 * The art (canvas) and the meshes (triangles, weights) are made from the same outlines, so a mesh always follows its picture.
 * No DOM here: the demo rig can be built, validated and played in tests.
 */

export type Pt = [number, number];

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, n = 32): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt;
  });
}

/** A Catmull-Rom curve through the points, `per` samples between two of them. */
export function spline(points: Pt[], closed = false, per = 6): Pt[] {
  const n = points.length;
  const at = (i: number): Pt => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out: Pt[] = [];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a: number, b: number, d: number, e: number) =>
        0.5 * (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** Cumulative length along a polyline, 0 at the start. */
function arcLengths(line: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  return out;
}

/**
 * The outline of a tube around a centre line: `radius(t)` is the half width at the fraction t (0..1) of the length. The start is flat (it sits
 * inside the body), the end is round, or a point when the radius reaches 0 there.
 */
export function tube(centre: Pt[], radius: (t: number) => number, capSteps = 6): Pt[] {
  const len = arcLengths(centre);
  const total = len[len.length - 1] || 1;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < centre.length; i++) {
    const a = centre[Math.max(0, i - 1)];
    const b = centre[Math.min(centre.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    const r = radius(len[i] / total);
    left.push([centre[i][0] - (dy / d) * r, centre[i][1] + (dx / d) * r]);
    right.push([centre[i][0] + (dy / d) * r, centre[i][1] - (dx / d) * r]);
  }
  const end = centre[centre.length - 1];
  const before = centre[centre.length - 2];
  const heading = Math.atan2(end[1] - before[1], end[0] - before[0]);
  const rEnd = radius(1);
  const cap: Pt[] = [];
  if (rEnd > 0.5) {
    for (let k = 1; k < capSteps; k++) {
      const a = heading + Math.PI / 2 - (k / capSteps) * Math.PI;
      cap.push([end[0] + Math.cos(a) * rEnd, end[1] + Math.sin(a) * rEnd]);
    }
  }
  return [...left, ...cap, ...right.reverse()];
}

export const translate = (poly: Pt[], dx: number, dy: number): Pt[] => poly.map(([x, y]) => [x + dx, y + dy]);

function boundsOf(polys: Pt[][]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

/** The picture box of a part: its bounds grown by `pad` and rounded out to whole pixels. */
export function pictureBox(polys: Pt[][], pad = 4): Box & { width: number; height: number } {
  const b = boundsOf(polys);
  const x0 = Math.floor(b.x0 - pad);
  const y0 = Math.floor(b.y0 - pad);
  const x1 = Math.ceil(b.x1 + pad);
  const y1 = Math.ceil(b.y1 + pad);
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}
