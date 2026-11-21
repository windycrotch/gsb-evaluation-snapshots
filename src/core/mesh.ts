/**
 * Mesh tooling: region -> mesh, alpha tracing, Delaunay triangulation, vertex add/remove, weights (auto, brush, bind).
 * Everything here is pure geometry on plain arrays so it can be tested in Node.
 */
import Delaunator from 'delaunator';
import type { Id, Influence, MeshAttachment, PathAttachment, RegionAttachment } from './model';
import { DEG2RAD, distToSegmentSq, matApply, matInvert, pointInPolygon } from './math';
import type { Mat } from './math';
import { constrainTriangles, segmentsCross } from './constrain';

/** A 4 vertex quad covering the region (vertices in slot-bone space, hull = 4). */
export function meshFromRegion(r: RegionAttachment): MeshAttachment {
  const w = r.width;
  const h = r.height;
  const c = Math.cos(r.rotation * DEG2RAD);
  const s = Math.sin(r.rotation * DEG2RAD);
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [-w / 2, h / 2],
    [w / 2, h / 2],
    [w / 2, -h / 2],
  ];
  const vertices: number[] = [];
  for (const [x, y] of corners) {
    const lx = x * r.scaleX;
    const ly = y * r.scaleY;
    vertices.push(lx * c - ly * s + r.x, lx * s + ly * c + r.y);
  }
  return {
    type: 'mesh',
    name: r.name,
    path: r.path,
    color: [...r.color] as MeshAttachment['color'],
    width: w,
    height: h,
    uvs: [0, 1, 0, 0, 1, 0, 1, 1],
    triangles: [0, 1, 2, 2, 3, 0],
    hull: 4,
    edges: [],
    vertices,
    weights: null,
    ...(r.sequence ? { sequence: { ...r.sequence } } : {}),
  };
}

/** Maps image pixel coordinates (y down) to slot-bone space through the region transform. */
function imageToBoneSpace(r: RegionAttachment, imgW: number, imgH: number): (px: number, py: number) => [number, number] {
  const c = Math.cos(r.rotation * DEG2RAD);
  const s = Math.sin(r.rotation * DEG2RAD);
  const sx = (r.width / imgW) * r.scaleX;
  const sy = (r.height / imgH) * r.scaleY;
  return (px, py) => {
    const lx = (px - imgW / 2) * sx;
    const ly = (imgH / 2 - py) * sy;
    return [lx * c - ly * s + r.x, lx * s + ly * c + r.y];
  };
}

export function polygonArea(p: ArrayLike<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(l2);
}

function dp(points: [number, number][], tol: number): [number, number][] {
  if (points.length < 3) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > tol) {
    const left = dp(points.slice(0, idx + 1), tol);
    const right = dp(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** Douglas-Peucker for closed polygons. */
function simplifyClosed(points: [number, number][], tol: number): [number, number][] {
  if (points.length <= 4) return points.slice();
  // split at the two most distant points to keep both halves well conditioned
  let i0 = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > best) {
      best = d;
      i0 = i;
    }
  }
  const a = dp(points.slice(0, i0 + 1), tol);
  const b = dp(points.slice(i0).concat([points[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** Moves every vertex along its outward normal. */
function offsetPolygon(points: [number, number][], dist: number): [number, number][] {
  const n = points.length;
  const sign = polygonArea(points) >= 0 ? 1 : -1;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const norm = (a: [number, number], b: [number, number]): [number, number] => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      return sign > 0 ? [dy / l, -dx / l] : [-dy / l, dx / l];
    };
    const n1 = norm(p0, p1);
    const n2 = norm(p1, p2);
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // miter scale (clamped so sharp corners do not explode)
    const dot = Math.max(0.5, nx * n1[0] + ny * n1[1]);
    out.push([p1[0] + (nx * dist) / dot, p1[1] + (ny * dist) / dot]);
  }
  return out;
}

export interface TraceOptions {
  /** Alpha (0-255) above which a pixel counts as solid. */
  threshold?: number;
  /** Outline simplification tolerance in image pixels. */
  tolerance?: number;
  /** Pixels the outline is pushed outwards. */
  padding?: number;
  /** Approximate spacing of interior vertices in pixels (0 = no interior points). */
  spacing?: number;
  maxHullVertices?: number;
}

/** Largest outer contour of the opaque pixels, in image pixel coordinates (y down). */
export function traceOutline(rgba: ArrayLike<number>, w: number, h: number, opts: TraceOptions = {}): [number, number][] {
  const threshold = opts.threshold ?? 12;
  const scale = Math.max(1, Math.ceil(Math.max(w, h) / 220));
  const mw = Math.ceil(w / scale);
  const mh = Math.ceil(h / scale);
  const mask = new Uint8Array(mw * mh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > threshold) mask[Math.floor(y / scale) * mw + Math.floor(x / scale)] = 1;
    }
  }
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < mw && y < mh && mask[y * mw + x] === 1;

  // directed boundary edges on the corner lattice, filled pixel on the right-hand side
  const stride = mw + 1;
  const outgoing = new Map<number, number[]>();
  const edges: [number, number][] = [];
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const from = ay * stride + ax;
    const to = by * stride + bx;
    const id = edges.length;
    edges.push([from, to]);
    const list = outgoing.get(from);
    if (list) list.push(id);
    else outgoing.set(from, [id]);
  };
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  if (edges.length === 0) return [];

  const used = new Uint8Array(edges.length);
  let bestLoop: [number, number][] = [];
  let bestArea = 0;
  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const loop: [number, number][] = [];
    let e = start;
    let guard = 0;
    while (!used[e] && guard++ < edges.length + 4) {
      used[e] = 1;
      const [from, to] = edges[e];
      loop.push([(from % stride) * scale, Math.floor(from / stride) * scale]);
      const cands = (outgoing.get(to) ?? []).filter((c) => !used[c]);
      if (cands.length === 0) break;
      if (cands.length === 1) e = cands[0];
      else {
        // prefer a right turn (towards the filled side) to keep the outline tight at diagonal contacts
        const dx = (to % stride) - (from % stride);
        const dy = Math.floor(to / stride) - Math.floor(from / stride);
        let pick = cands[0];
        let bestCross = -Infinity;
        for (const c of cands) {
          const [f2, t2] = edges[c];
          const ex = (t2 % stride) - (f2 % stride);
          const ey = Math.floor(t2 / stride) - Math.floor(f2 / stride);
          const cross = dx * ey - dy * ex; // y-down: positive = turning right
          if (cross > bestCross) {
            bestCross = cross;
            pick = c;
          }
        }
        e = pick;
      }
    }
    const a = Math.abs(polygonArea(loop));
    if (a > bestArea) {
      bestArea = a;
      bestLoop = loop;
    }
  }
  const clamp = (p: [number, number]): [number, number] => [Math.min(w, Math.max(0, p[0])), Math.min(h, Math.max(0, p[1]))];
  let tol = opts.tolerance ?? Math.max(1.2, scale * 0.9);
  let poly = simplifyClosed(bestLoop, tol);
  const maxHull = opts.maxHullVertices ?? 48;
  while (poly.length > maxHull && tol < 200) {
    tol *= 1.35;
    poly = simplifyClosed(bestLoop, tol);
  }
  if (poly.length < 3) poly = bestLoop.slice(0, 3);
  const pad = opts.padding ?? 2;
  if (pad !== 0) poly = offsetPolygon(poly, pad);
  return poly.map(clamp);
}

/**
 * Delaunay triangulation of `points` (flat x,y), keeping only triangles whose centroid is inside the hull polygon. The outline and the
 * manual `edges` (vertex index pairs, Spine's orange edges) are always edges of the result: the triangulation never crosses them.
 */
export function triangulate(points: ArrayLike<number>, hullCount: number, edges: ArrayLike<number> = []): number[] {
  const n = points.length / 2;
  if (n < 3) return [];
  const flat = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) flat[i] = points[i];
  const del = new Delaunator(flat);
  const hull = new Float64Array(hullCount * 2);
  for (let i = 0; i < hullCount * 2; i++) hull[i] = points[i];
  const out: number[] = [];
  const constraints: [number, number][] = [];
  if (hullCount >= 3) for (let i = 0; i < hullCount; i++) constraints.push([i, (i + 1) % hullCount]);
  for (let i = 0; i + 1 < edges.length; i += 2)
    if (edges[i] < n && edges[i + 1] < n && edges[i] !== edges[i + 1]) constraints.push([edges[i], edges[i + 1]]);
  const t = constraints.length ? constrainTriangles(flat, del.triangles, constraints) : del.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i];
    const b = t[i + 1];
    const c = t[i + 2];
    const cx = (flat[a * 2] + flat[b * 2] + flat[c * 2]) / 3;
    const cy = (flat[a * 2 + 1] + flat[b * 2 + 1] + flat[c * 2 + 1]) / 3;
    const area = Math.abs(
      (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]),
    );
    if (area < 1e-6) continue;
    if (hullCount >= 3 && !pointInPolygon(cx, cy, hull)) continue;
    out.push(a, b, c);
  }
  return out;
}

/** Index pairs of the manual edges after the vertices were renumbered: `from[new]` is the old index of a vertex (-1 for a new one). Edges that lost a vertex are dropped. */
export function remapEdges(edges: readonly number[], from: ArrayLike<number>): number[] {
  const to = new Map<number, number>();
  for (let i = 0; i < from.length; i++) if (from[i] >= 0) to.set(from[i], i);
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const a = to.get(edges[i]);
    const b = to.get(edges[i + 1]);
    if (a === undefined || b === undefined || a === b) continue;
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a, b);
  }
  return out;
}

/** Is `a`-`b` a hull edge (neighbours on the outline)? */
function isHullEdge(hull: number, a: number, b: number): boolean {
  return hull >= 3 && a < hull && b < hull && ((a + 1) % hull === b || (b + 1) % hull === a);
}

/** Can a manual edge be drawn from `a` to `b`: inside the outline, not crossing the outline or another manual edge, not there already. Returns an error text or null. */
export function edgeProblem(points: ArrayLike<number>, hull: number, edges: readonly number[], a: number, b: number): string | null {
  const n = points.length >> 1;
  if (a === b || a < 0 || b < 0 || a >= n || b >= n) return 'Pick two different vertices';
  if (isHullEdge(hull, a, b)) return 'That edge is part of the outline already';
  for (let i = 0; i + 1 < edges.length; i += 2) {
    if ((edges[i] === a && edges[i + 1] === b) || (edges[i] === b && edges[i + 1] === a)) return 'That edge exists already';
    if (segmentsCross(points, a, b, edges[i], edges[i + 1])) return 'An edge cannot cross another edge';
  }
  for (let i = 0; i < hull; i++) if (segmentsCross(points, a, b, i, (i + 1) % hull)) return 'An edge cannot cross the outline';
  const hullPts = new Float64Array(hull * 2);
  for (let i = 0; i < hull * 2; i++) hullPts[i] = points[i];
  if (hull >= 3 && !pointInPolygon((points[a * 2] + points[b * 2]) / 2, (points[a * 2 + 1] + points[b * 2 + 1]) / 2, hullPts))
    return 'An edge has to run inside the outline';
  return null;
}

/** Interior sample points of a polygon on a staggered grid, kept away from the outline. */
export function interiorPoints(hull: [number, number][], spacing: number): [number, number][] {
  if (spacing <= 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of hull) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const flat = new Float64Array(hull.length * 2);
  hull.forEach((p, i) => {
    flat[i * 2] = p[0];
    flat[i * 2 + 1] = p[1];
  });
  const out: [number, number][] = [];
  const minEdge2 = (spacing * 0.7) ** 2;
  let row = 0;
  for (let y = minY + spacing / 2; y < maxY; y += spacing * 0.866, row++) {
    for (let x = minX + (row % 2 ? spacing / 2 : 0) + spacing / 2; x < maxX; x += spacing) {
      if (!pointInPolygon(x, y, flat)) continue;
      let near = Infinity;
      for (let i = 0, j = hull.length - 1; i < hull.length; j = i++)
        near = Math.min(near, distToSegmentSq(x, y, hull[j][0], hull[j][1], hull[i][0], hull[i][1]));
      if (near >= minEdge2) out.push([x, y]);
    }
  }
  return out;
}

/** Adds points along long outline edges so triangles stay reasonably sized. */
export function subdivideOutline(hull: [number, number][], maxEdge: number): [number, number][] {
  if (maxEdge <= 0) return hull;
  const out: [number, number][] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    out.push(a);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(d / maxEdge);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Builds a fully triangulated mesh from the opaque pixels of an image (replaces a region attachment). */
export function generateMeshFromImage(
  region: RegionAttachment,
  rgba: ArrayLike<number>,
  imgW: number,
  imgH: number,
  opts: TraceOptions = {},
): MeshAttachment {
  let outline = traceOutline(rgba, imgW, imgH, opts);
  if (outline.length < 3) return meshFromRegion(region);
  const spacing = opts.spacing ?? Math.max(imgW, imgH) / 5;
  outline = subdivideOutline(outline, spacing * 1.6);
  const inner = interiorPoints(outline, spacing);
  const pts: [number, number][] = [...outline, ...inner];
  const flat: number[] = [];
  for (const p of pts) flat.push(p[0], p[1]);
  const triangles = triangulate(flat, outline.length);
  const toBone = imageToBoneSpace(region, imgW, imgH);
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const [px, py] of pts) {
    const [bx, by] = toBone(px, py);
    vertices.push(bx, by);
    uvs.push(px / imgW, py / imgH);
  }
  return {
    type: 'mesh',
    name: region.name,
    path: region.path,
    color: [...region.color] as MeshAttachment['color'],
    width: imgW,
    height: imgH,
    uvs,
    triangles,
    hull: outline.length,
    edges: [],
    vertices,
    weights: null,
    ...(region.sequence ? { sequence: { ...region.sequence } } : {}),
  };
}

export type BoneMats = Map<Id, Mat>;

/** Setup-pose world positions of every mesh vertex (x,y pairs). */
export function meshWorldPositions(mesh: MeshAttachment, slotMat: Mat, bones: BoneMats): Float64Array {
  return vertexWorldPositions(mesh, mesh.uvs.length >> 1, slotMat, bones);
}

/** Setup-pose world positions of `n` vertices stored like a mesh's (unweighted in the slot bone's space, or weighted). */
export function vertexWorldPositions(
  mesh: { vertices: number[]; weights: Influence[][] | null },
  n: number,
  slotMat: Mat,
  bones: BoneMats,
): Float64Array {
  const out = new Float64Array(n * 2);
  if (!mesh.weights) {
    for (let i = 0; i < n; i++) {
      const p = matApply(slotMat, mesh.vertices[i * 2], mesh.vertices[i * 2 + 1]);
      out[i * 2] = p[0];
      out[i * 2 + 1] = p[1];
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    let x = 0;
    let y = 0;
    for (const [bone, bx, by, w] of mesh.weights[i] ?? []) {
      const m = bones.get(bone);
      if (!m) continue;
      const p = matApply(m, bx, by);
      x += p[0] * w;
      y += p[1] * w;
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}

export interface BoneSegment {
  id: Id;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export function normalizeInfluences(list: Influence[], maxInfluences = 4): Influence[] {
  let out = list
    .filter((i) => i[3] > 1e-4)
    .sort((a, b) => b[3] - a[3])
    .slice(0, maxInfluences);
  const sum = out.reduce((s, i) => s + i[3], 0);
  if (sum <= 0) return out.length ? [[out[0][0], out[0][1], out[0][2], 1]] : [];
  out = out.map((i) => [i[0], i[1], i[2], i[3] / sum] as Influence);
  return out;
}

/**
 * Prune (Spine's weights tool): drops the influences lighter than `threshold`, keeps the strongest `max` of a vertex and scales what
 * is left back to 1. A vertex always keeps at least its strongest bone. The setup pose does not change (every influence of a vertex
 * points at the same world position), only how the vertex follows the bones.
 */
export function pruneWeights(weights: Influence[][], threshold = 0.05, max = 4, only?: ReadonlySet<number>): Influence[][] {
  return weights.map((list, vi) => {
    if (list.length === 0 || (only && !only.has(vi))) return list;
    const sorted = [...list].sort((a, b) => b[3] - a[3]);
    let kept = sorted.filter((i) => i[3] >= threshold).slice(0, Math.max(1, max));
    if (kept.length === 0) kept = [sorted[0]];
    const sum = kept.reduce((s, i) => s + i[3], 0);
    return kept.map((i) => [i[0], i[1], i[2], sum > 0 ? i[3] / sum : 1 / kept.length] as Influence);
  });
}

/**
 * Remove (Spine's weights list): the mesh stops following `bone`. Its weight goes to the other bones of each vertex in proportion; a vertex
 * that followed only that bone goes to `fallback` (the parent of the bone). The vertices stay where they are.
 * Returns the new weights and how many vertices had the bone.
 */
export function removeBoneWeights(
  weights: Influence[][],
  world: ArrayLike<number>,
  bone: Id,
  fallback: Id | null,
  bones: BoneMats,
): { weights: Influence[][]; changed: number } {
  let changed = 0;
  const fb = fallback && fallback !== bone ? bones.get(fallback) : undefined;
  const out = weights.map((list, i) => {
    if (!list.some((e) => e[0] === bone)) return list;
    const rest = list.filter((e) => e[0] !== bone && e[3] > 0);
    if (rest.length) {
      changed++;
      return normalizeInfluences(rest.map((e) => [...e] as Influence));
    }
    if (!fb) return list; // nowhere to go: this vertex keeps the bone
    changed++;
    const p = matApply(matInvert(fb), world[i * 2], world[i * 2 + 1]);
    return [[fallback!, p[0], p[1], 1] as Influence];
  });
  return { weights: out, changed };
}

/**
 * Update bindings (Spine's weights panel, "Update"): the bind positions stored per bone go stale when a bone was moved after binding, and
 * then every weight edit makes the vertices shift. This re-expresses the CURRENT world position of the vertices of `only` (all when missing)
 * in the space of each of their bones, so the bind pose is the pose the bones have now. The setup pose does not change.
 * Returns the new weights and how many vertices had a stale binding.
 */
export function updateBindings(
  weights: Influence[][],
  world: ArrayLike<number>,
  bones: BoneMats,
  only?: ReadonlySet<number>,
): { weights: Influence[][]; changed: number } {
  const inv = new Map<Id, Mat>();
  for (const [id, m] of bones) inv.set(id, matInvert(m));
  let changed = 0;
  const out = weights.map((list, i) => {
    if ((only && !only.has(i)) || list.length === 0 || list.some((e) => !inv.has(e[0]))) return list;
    let stale = false;
    const next = list.map((e) => {
      const p = matApply(inv.get(e[0])!, world[i * 2], world[i * 2 + 1]);
      if (Math.abs(p[0] - e[1]) > 1e-6 || Math.abs(p[1] - e[2]) > 1e-6) stale = true;
      return [e[0], p[0], p[1], e[3]] as Influence;
    });
    if (!stale) return list;
    changed++;
    return next;
  });
  return { weights: out, changed };
}

/**
 * Weld (Spine's weights panel): the vertices of this mesh take the weights the other mesh has at the same place, so the two deform as one
 * picture. Both must be bound to at least the same two bones; only those common bones are used. A vertex over a triangle of the other mesh
 * gets the weights of its corners blended by position; `overlapping` limits it to the vertices that really lie over the other mesh,
 * otherwise (`all`) the vertices outside take the weights of the nearest triangle. The vertices stay where they are.
 * Returns the new weights and how many vertices were set.
 */
export function weldWeights(
  weights: Influence[][],
  world: ArrayLike<number>,
  other: { world: ArrayLike<number>; triangles: ArrayLike<number>; weights: Influence[][] },
  mode: 'all' | 'overlapping',
  bones: BoneMats,
  only?: ReadonlySet<number>,
): { weights: Influence[][]; changed: number } {
  const mine = new Set(weights.flat().map((e) => e[0]));
  const common = new Set(
    other.weights
      .flat()
      .map((e) => e[0])
      .filter((b) => mine.has(b) && bones.has(b)),
  );
  if (common.size < 2) return { weights, changed: 0 };
  let changed = 0;
  const out = weights.map((list, i) => {
    if (only && !only.has(i)) return list;
    const x = world[i * 2];
    const y = world[i * 2 + 1];
    const at = locateInMesh(other.world, other.triangles, x, y);
    if (!at) return list;
    if (mode === 'overlapping' && Math.min(...at.bary) < -1e-3) return list;
    const bary = at.bary.map((b) => Math.max(0, b));
    const bsum = bary[0] + bary[1] + bary[2];
    if (bsum <= 1e-9) return list;
    const acc = new Map<Id, number>();
    for (let k = 0; k < 3; k++) {
      const v = other.triangles[at.tri * 3 + k];
      for (const e of other.weights[v] ?? []) if (common.has(e[0])) acc.set(e[0], (acc.get(e[0]) ?? 0) + (e[3] * bary[k]) / bsum);
    }
    const next: Influence[] = [];
    for (const [b, w] of acc) {
      const p = matApply(matInvert(bones.get(b)!), x, y);
      next.push([b, p[0], p[1], w]);
    }
    if (next.reduce((s, e) => s + e[3], 0) < 1e-6) return list;
    changed++;
    return normalizeInfluences(next);
  });
  return { weights: out, changed };
}

/** Keeps `next` for the vertices in `only` and `old` for every other vertex (scope of Auto, Smooth, Prune and Swap to the selected vertices). */
export function keepOutside<T>(old: readonly T[], next: readonly T[], only: ReadonlySet<number> | undefined): T[] {
  return only ? next.map((v, i) => (only.has(i) ? v : old[i])) : [...next];
}

/**
 * Swap (Spine's weights tool, two bones selected): the two bones exchange their weights on the vertices of `only` (all vertices when
 * it is missing). The vertex stays where it is: the bind position of each moved influence is re-expressed in the other bone's space.
 * Returns the new weights and how many vertices had either bone.
 */
export function swapBoneWeights(
  weights: Influence[][],
  world: ArrayLike<number>,
  a: Id,
  b: Id,
  bones: BoneMats,
  only?: ReadonlySet<number>,
): { weights: Influence[][]; changed: number } {
  const ma = bones.get(a);
  const mb = bones.get(b);
  if (a === b || !ma || !mb) return { weights, changed: 0 };
  const ia = matInvert(ma);
  const ib = matInvert(mb);
  let changed = 0;
  const out = weights.map((list, i) => {
    if (only && !only.has(i)) return list;
    const wa = list.find((e) => e[0] === a)?.[3] ?? 0;
    const wb = list.find((e) => e[0] === b)?.[3] ?? 0;
    if (wa === 0 && wb === 0) return list;
    changed++;
    const rest = list.filter((e) => e[0] !== a && e[0] !== b).map((e) => [...e] as Influence);
    const x = world[i * 2];
    const y = world[i * 2 + 1];
    if (wb > 0) {
      const p = matApply(ia, x, y);
      rest.push([a, p[0], p[1], wb]);
    }
    if (wa > 0) {
      const p = matApply(ib, x, y);
      rest.push([b, p[0], p[1], wa]);
    }
    return normalizeInfluences(rest);
  });
  return { weights: out, changed };
}

/**
 * Mirror weights: the vertices on one side of the vertical axis `axisX` (world) give their weights to the vertex on the other side
 * that sits where they would be reflected, with every bone replaced by its mirror twin (`twin`; a bone without one stays itself).
 * The target keeps its position: its influences are re-expressed in the local space of the twin bones. Vertices with no partner
 * within `tolerance` are left alone. Returns the new weights and how many vertices were set.
 */
export function mirrorWeights(
  weights: Influence[][],
  world: ArrayLike<number>,
  axisX: number,
  fromLeft: boolean,
  twin: (bone: Id) => Id,
  bones: BoneMats,
  tolerance = 3,
): { weights: Influence[][]; changed: number } {
  const n = weights.length;
  const out = weights.map((l) => l.map((i) => [...i] as Influence));
  const inverse = new Map<Id, Mat>();
  const inv = (id: Id): Mat | null => {
    let m = inverse.get(id);
    if (!m) {
      const base = bones.get(id);
      if (!base) return null;
      m = matInvert(base);
      inverse.set(id, m);
    }
    return m;
  };
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const x = world[i * 2];
    const y = world[i * 2 + 1];
    // the source side: left of the axis for "left to right"; vertices on the axis are their own mirror and stay
    if (fromLeft ? x >= axisX - 1e-6 : x <= axisX + 1e-6) continue;
    const mx = 2 * axisX - x;
    let best = -1;
    let bestD = tolerance * tolerance;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = world[j * 2] - mx;
      const dy = world[j * 2 + 1] - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0 || weights[i].length === 0) continue;
    const tx = world[best * 2];
    const ty = world[best * 2 + 1];
    const list: Influence[] = [];
    for (const [bone, , , w] of weights[i]) {
      const target = twin(bone);
      const im = inv(target);
      if (!im) continue;
      const p = matApply(im, tx, ty);
      const existing = list.find((e) => e[0] === target);
      if (existing) existing[3] += w;
      else list.push([target, p[0], p[1], w]);
    }
    if (list.length === 0) continue;
    out[best] = normalizeInfluences(list);
    changed++;
  }
  return { weights: out, changed };
}

/** Inverse-distance weights from bone segments, limited to `maxInfluences` bones per vertex. */
export function autoWeights(
  world: ArrayLike<number>,
  segs: BoneSegment[],
  opts: { maxInfluences?: number; falloff?: number } = {},
): { bone: Id; w: number }[][] {
  const maxInfl = opts.maxInfluences ?? 4;
  const falloff = opts.falloff ?? 2.2;
  const n = world.length / 2;
  const res: { bone: Id; w: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const px = world[i * 2];
    const py = world[i * 2 + 1];
    const scores = segs.map((s) => {
      const d = Math.sqrt(distToSegmentSq(px, py, s.ax, s.ay, s.bx, s.by));
      return { bone: s.id, w: 1 / Math.pow(d + 6, falloff) };
    });
    scores.sort((a, b) => b.w - a.w);
    const top = scores.slice(0, maxInfl);
    const sum = top.reduce((s, t) => s + t.w, 0) || 1;
    // drop negligible influences relative to the strongest
    const kept = top.filter((t) => t.w / sum > 0.04);
    const ksum = kept.reduce((s, t) => s + t.w, 0) || 1;
    res.push(kept.map((t) => ({ bone: t.bone, w: t.w / ksum })));
  }
  return res;
}

/** Vertex adjacency from triangles. */
export function adjacency(triangles: ArrayLike<number>, vertexCount: number): number[][] {
  const adj: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    adj[a].add(b).add(c);
    adj[b].add(a).add(c);
    adj[c].add(a).add(b);
  }
  return adj.map((s) => [...s]);
}

/** Blends each vertex's weights with its neighbours' (`amount` 0..1), keeping at most `maxInfluences`. */
export function smoothWeights(
  weights: { bone: Id; w: number }[][],
  adj: number[][],
  passes: number,
  amount = 0.5,
  maxInfluences = 4,
): { bone: Id; w: number }[][] {
  let cur = weights;
  for (let p = 0; p < passes; p++) {
    cur = cur.map((own, i) => {
      const nb = adj[i];
      if (!nb.length) return own;
      const acc = new Map<Id, number>();
      for (const e of own) acc.set(e.bone, (acc.get(e.bone) ?? 0) + e.w * (1 - amount));
      for (const j of nb) for (const e of cur[j]) acc.set(e.bone, (acc.get(e.bone) ?? 0) + (e.w * amount) / nb.length);
      const list = [...acc.entries()]
        .map(([bone, w]) => ({ bone, w }))
        .sort((a, b) => b.w - a.w)
        .slice(0, maxInfluences);
      const sum = list.reduce((s, e) => s + e.w, 0) || 1;
      return list.map((e) => ({ bone: e.bone, w: e.w / sum }));
    });
  }
  return cur;
}

/** Converts an unweighted mesh into a weighted one using the given per-vertex weights. */
export function bindMesh(mesh: MeshAttachment, slotMat: Mat, bones: BoneMats, weights: { bone: Id; w: number }[][]): MeshAttachment {
  const world = meshWorldPositions(mesh, slotMat, bones);
  const inv = new Map<Id, Mat>();
  for (const [id, m] of bones) inv.set(id, matInvert(m));
  const out: Influence[][] = [];
  const n = mesh.uvs.length / 2;
  for (let i = 0; i < n; i++) {
    const list: Influence[] = [];
    for (const e of weights[i] ?? []) {
      const im = inv.get(e.bone);
      if (!im) continue;
      const p = matApply(im, world[i * 2], world[i * 2 + 1]);
      list.push([e.bone, p[0], p[1], e.w]);
    }
    out.push(normalizeInfluences(list));
  }
  return { ...mesh, vertices: [], weights: out };
}

/** Back to a plain mesh in the slot bone's space (positions preserved). */
export function unbindMesh(mesh: MeshAttachment, slotMat: Mat, bones: BoneMats): MeshAttachment {
  if (!mesh.weights) return mesh;
  const world = meshWorldPositions(mesh, slotMat, bones);
  const inv = matInvert(slotMat);
  const vertices: number[] = [];
  for (let i = 0; i < world.length / 2; i++) {
    const p = matApply(inv, world[i * 2], world[i * 2 + 1]);
    vertices.push(p[0], p[1]);
  }
  return { ...mesh, vertices, weights: null };
}

/**
 * Sets the weight of one bone on a vertex, rescaling the other influences so the total stays 1.
 * `bindFor` supplies the bind position when the bone is not yet an influence.
 * `locked` (Spine's weight lock): the weight of a locked bone does not change; the others share what is left, and a locked bone itself cannot be painted.
 */
export function setBoneWeight(
  list: Influence[],
  bone: Id,
  target: number,
  bindFor: (bone: Id) => [number, number] | null,
  maxInfluences = 4,
  locked?: ReadonlySet<Id>,
): Influence[] {
  if (locked?.has(bone)) return list;
  let cur = list.map((i) => [...i] as Influence);
  const held = locked ? cur.filter((i) => locked.has(i[0])) : [];
  const heldSum = held.reduce((s, i) => s + i[3], 0);
  target = Math.max(0, Math.min(1 - heldSum, target));
  let mine = cur.find((i) => i[0] === bone);
  if (!mine) {
    const bind = bindFor(bone);
    if (!bind) return list;
    mine = [bone, bind[0], bind[1], 0] as Influence;
    cur.push(mine);
  }
  const others = cur.filter((i) => i !== mine && !held.includes(i));
  const otherSum = others.reduce((s, i) => s + i[3], 0);
  mine[3] = target;
  const rest = Math.max(0, 1 - heldSum - target);
  if (otherSum > 1e-6) for (const o of others) o[3] = (o[3] / otherSum) * rest;
  else if (others.length) for (const o of others) o[3] = rest / others.length;
  else mine[3] = Math.max(0, 1 - heldSum);
  cur = cur.filter((i) => i[3] > 1e-4);
  if (held.length && cur.length > maxInfluences) {
    // a locked bone is never the one that drops out
    const keep = cur.filter((i) => held.includes(i));
    const free = cur
      .filter((i) => !held.includes(i))
      .sort((x, y) => y[3] - x[3])
      .slice(0, Math.max(0, maxInfluences - keep.length));
    cur = [...keep, ...free];
  }
  return normalizeInfluences(cur, maxInfluences);
}

/** Barycentric UV + weights for a new point from the triangle that contains it (or the nearest triangle). */
export function locateInMesh(
  world: ArrayLike<number>,
  triangles: ArrayLike<number>,
  px: number,
  py: number,
): { tri: number; bary: [number, number, number] } | null {
  let best: { tri: number; bary: [number, number, number]; score: number } | null = null;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 2;
    const b = triangles[t + 1] * 2;
    const c = triangles[t + 2] * 2;
    const det = (world[b + 1] - world[c + 1]) * (world[a] - world[c]) + (world[c] - world[b]) * (world[a + 1] - world[c + 1]);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((world[b + 1] - world[c + 1]) * (px - world[c]) + (world[c] - world[b]) * (py - world[c + 1])) / det;
    const l2 = ((world[c + 1] - world[a + 1]) * (px - world[c]) + (world[a] - world[c]) * (py - world[c + 1])) / det;
    const l3 = 1 - l1 - l2;
    const score = Math.min(l1, l2, l3);
    if (!best || score > best.score) best = { tri: t / 3, bary: [l1, l2, l3], score };
  }
  return best ? { tri: best.tri, bary: best.bary } : null;
}

export type TriangleMove = 'first' | 'earlier' | 'later' | 'last';

/** The triangles that contain the point, the one drawn last (on top) first. */
export function trianglesAt(world: ArrayLike<number>, triangles: ArrayLike<number>, px: number, py: number): number[] {
  const out: number[] = [];
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] * 2;
    const b = triangles[t + 1] * 2;
    const c = triangles[t + 2] * 2;
    const d1 = (px - world[b]) * (world[a + 1] - world[b + 1]) - (world[a] - world[b]) * (py - world[b + 1]);
    const d2 = (px - world[c]) * (world[b + 1] - world[c + 1]) - (world[b] - world[c]) * (py - world[c + 1]);
    const d3 = (px - world[a]) * (world[c + 1] - world[a + 1]) - (world[c] - world[a]) * (py - world[a + 1]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) out.push(t / 3);
  }
  return out.reverse();
}

/**
 * Spine's Triangle order: the triangles are drawn in the order of the list, so where triangles overlap (a folded mesh) the later one is on top.
 * Moves one triangle to the first or last place or one place earlier or later; returns the new list and where the triangle is now.
 */
export function moveTriangle(triangles: readonly number[], index: number, to: TriangleMove): { triangles: number[]; index: number } {
  const count = Math.floor(triangles.length / 3);
  if (index < 0 || index >= count) return { triangles: triangles.slice(), index };
  const target = to === 'first' ? 0 : to === 'last' ? count - 1 : Math.max(0, Math.min(count - 1, index + (to === 'earlier' ? -1 : 1)));
  if (target === index) return { triangles: triangles.slice(), index };
  const list: number[][] = [];
  for (let t = 0; t < count; t++) list.push([triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]]);
  const [one] = list.splice(index, 1);
  list.splice(target, 0, one);
  return { triangles: list.flat(), index: target };
}

/** Removes the given vertices (never dropping below a 3 vertex hull) and retriangulates in `positions` space. */
export function removeMeshVertices(mesh: MeshAttachment, remove: Set<number>, positions: ArrayLike<number>): MeshAttachment {
  const n = mesh.uvs.length / 2;
  const keep: number[] = [];
  let hull = 0;
  for (let i = 0; i < n; i++) {
    if (remove.has(i)) continue;
    keep.push(i);
    if (i < mesh.hull) hull++;
  }
  if (hull < 3) return mesh;
  const pos: number[] = [];
  const uvs: number[] = [];
  const vertices: number[] = [];
  const weights: Influence[][] | null = mesh.weights ? [] : null;
  for (const i of keep) {
    pos.push(positions[i * 2], positions[i * 2 + 1]);
    uvs.push(mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]);
    if (weights) weights.push(mesh.weights![i]);
    else vertices.push(mesh.vertices[i * 2], mesh.vertices[i * 2 + 1]);
  }
  const edges = remapEdges(mesh.edges ?? [], keep);
  return { ...mesh, uvs, vertices, weights, hull, edges, triangles: triangulate(pos, hull, edges) };
}

/**
 * Number of deform values an attachment expects: x,y per vertex, or x,y per influence for weighted meshes.
 * Mirrors `compileSkeleton` (a vertex without a usable influence still counts one) and the exported vertex layout.
 */
export function deformLength(mesh: MeshAttachment | PathAttachment, hasBone: (id: Id) => boolean): number {
  if (!mesh.weights) return mesh.vertices.length;
  const n = mesh.type === 'mesh' ? mesh.uvs.length >> 1 : mesh.weights.length;
  let influences = 0;
  for (let i = 0; i < n; i++) {
    let count = 0;
    for (const inf of mesh.weights[i] ?? []) if (hasBone(inf[0])) count++;
    influences += count || 1;
  }
  return influences * 2;
}

/** For every vertex of an edited mesh, the index of the vertex it came from (-1 = new). `null` = same order and count. */
export type VertexMap = ArrayLike<number> | null;

function influenceBones(mesh: MeshAttachment, vertex: number, hasBone: (id: Id) => boolean): Id[] {
  const out: Id[] = [];
  for (const inf of mesh.weights?.[vertex] ?? []) if (hasBone(inf[0])) out.push(inf[0]);
  return out.length ? out : [''];
}

/**
 * Re-lays out one deform key after the mesh changed from `before` to `after`.
 * Values follow their vertex (and, for weighted meshes, their bone); new vertices / influences start at zero.
 * Returns `null` when the old values cannot be carried over (bind / unbind, unknown history) — the caller drops the keys.
 */
export function remapDeformValues(
  before: MeshAttachment,
  after: MeshAttachment,
  map: VertexMap,
  hasBone: (id: Id) => boolean,
  values: ArrayLike<number>,
  hasBoneBefore: (id: Id) => boolean = hasBone,
): number[] | null {
  if ((before.weights == null) !== (after.weights == null)) return null;
  if (values.length !== deformLength(before, hasBoneBefore)) return null;
  const nOld = before.uvs.length >> 1;
  const nNew = after.uvs.length >> 1;
  if (!map && nOld !== nNew) return null;
  const from = (j: number) => (map ? map[j] : j);
  if (!after.weights) {
    const out = new Array<number>(nNew * 2).fill(0);
    for (let j = 0; j < nNew; j++) {
      const s = from(j);
      if (s >= 0 && s < nOld) {
        out[j * 2] = values[s * 2];
        out[j * 2 + 1] = values[s * 2 + 1];
      }
    }
    return out;
  }
  const oldBones: Id[][] = [];
  const oldOffset: number[] = [];
  let offset = 0;
  for (let i = 0; i < nOld; i++) {
    const bones = influenceBones(before, i, hasBoneBefore);
    oldBones.push(bones);
    oldOffset.push(offset);
    offset += bones.length * 2;
  }
  const out: number[] = [];
  for (let j = 0; j < nNew; j++) {
    const s = from(j);
    for (const bone of influenceBones(after, j, hasBone)) {
      const k = s >= 0 && s < nOld ? oldBones[s].indexOf(bone) : -1;
      out.push(k >= 0 ? values[oldOffset[s] + k * 2] : 0, k >= 0 ? values[oldOffset[s] + k * 2 + 1] : 0);
    }
  }
  return out;
}
