/**
 * What drawing the skeleton in its current pose costs, as the Metrics window shows it: the draw calls, the vertices and triangles that are drawn, and the
 * triangles a clipping polygon cuts. The slots are walked as the renderer walks them (`drawSkeleton`): hidden slots, clear colours and clipping
 * attachments are not drawn, and the clip that applies to a slot comes from `planClipping`.
 */
import { planClipping } from './clip';
import { packAtlas } from './export/atlas';
import { usedImages } from './export/atlasBuild';
import type { Project } from './model';
import { resolveSequenceIndex, sequenceFramePath } from './sequence';
import { meshWorldVertices, regionWorldVertices, REGION_TRIANGLES } from './skeleton';
import type { Skeleton, Slot } from './skeleton';

export interface PoseMetrics {
  /** Batches: a new one starts when the texture page, the blend mode or the clip changes. */
  drawCalls: number;
  /** Slots that draw a picture. */
  drawn: number;
  vertices: number;
  triangles: number;
  /** Triangles that cross the outline of a clipping polygon: the ones a runtime has to cut. */
  clippedTriangles: number;
  /** Clipping polygons in effect. */
  clippers: number;
}

export interface PoseMetricsOptions {
  /** The texture page a picture lives on (one page when not given). Pictures on the same page can share a draw call. */
  pageOf?: (path: string) => string | number;
  skip?: (slot: Slot) => boolean;
}

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Do the segments a-b and c-d cross each other (touching at an end does not count)? */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function inTriangle(px: number, py: number, t: ArrayLike<number>): boolean {
  const d1 = cross(t[0], t[1], t[2], t[3], px, py);
  const d2 = cross(t[2], t[3], t[4], t[5], px, py);
  const d3 = cross(t[4], t[5], t[0], t[1], px, py);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Does the outline of the polygon (flat x,y, `n` vertices) pass through the triangle (6 numbers)? Then a triangle is partly inside and partly outside it. */
export function triangleCrossesPolygon(t: ArrayLike<number>, poly: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [px, py, qx, qy] = [poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]];
    for (let k = 0; k < 3; k++) {
      const m = (k + 1) % 3;
      if (segmentsIntersect(t[k * 2], t[k * 2 + 1], t[m * 2], t[m * 2 + 1], px, py, qx, qy)) return true;
    }
  }
  // a polygon that lies wholly inside the triangle has no edge crossing it, but the triangle is cut all the same
  return n > 0 && inTriangle(poly[0], poly[1], t);
}

export function poseMetrics(skeleton: Skeleton, opts: PoseMetricsOptions = {}): PoseMetrics {
  const out: PoseMetrics = { drawCalls: 0, drawn: 0, vertices: 0, triangles: 0, clippedTriangles: 0, clippers: 0 };
  const plan = planClipping(skeleton, opts.skip);
  const order = skeleton.drawOrder;
  let batch = '';
  const held: { polygon: { clip: unknown; points: Float32Array; n: number } | null } = { polygon: null };
  const clipIndex = new Map<unknown, number>();
  let scratch = new Float32Array(512);
  const tri = new Float32Array(6);
  for (let i = 0; i < order.length; i++) {
    const slot = order[i];
    if (opts.skip?.(slot)) continue;
    const att = skeleton.slotAttachment(slot);
    if (!att || (att.kind !== 'region' && att.kind !== 'mesh')) continue;
    const a = skeleton.color[3] * slot.color[3] * att.color[3];
    if (a <= 0) continue;
    const clip = plan[i];
    if (clip && held.polygon?.clip !== clip) {
      const n = clip.att.vertexCount;
      const points = new Float32Array(n * 2);
      meshWorldVertices(skeleton, clip.slot, clip.att, null, points);
      held.polygon = { clip, points, n };
    }
    if (clip && !clipIndex.has(clip)) {
      clipIndex.set(clip, clipIndex.size);
      out.clippers++;
    }
    const seq = att.src.sequence;
    const path = seq ? sequenceFramePath(att.path, seq, resolveSequenceIndex(seq, slot.sequenceIndex)) : att.path;
    const next = `${opts.pageOf?.(path) ?? 0}|${slot.data.blend}|${clip ? clipIndex.get(clip) : -1}`;
    if (next !== batch) {
      batch = next;
      out.drawCalls++;
    }
    out.drawn++;
    let world: Float32Array;
    let indices: ArrayLike<number>;
    let count: number;
    if (att.kind === 'region') {
      regionWorldVertices(att, slot.bone, scratch);
      world = scratch;
      indices = REGION_TRIANGLES;
      count = 4;
    } else {
      count = att.vertexCount;
      if (count * 2 > scratch.length) scratch = new Float32Array(count * 2 * 2);
      meshWorldVertices(skeleton, slot, att, slot.deform.length ? slot.deform : null, scratch);
      world = scratch;
      indices = att.triangles;
    }
    out.vertices += count;
    out.triangles += indices.length / 3;
    const polygon = held.polygon;
    if (clip && polygon) {
      for (let t = 0; t + 2 < indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          tri[k * 2] = world[indices[t + k] * 2];
          tri[k * 2 + 1] = world[indices[t + k] * 2 + 1];
        }
        if (triangleCrossesPolygon(tri, polygon.points, polygon.n)) out.clippedTriangles++;
      }
    }
  }
  return out;
}

/** The texture page every used picture would be on in an export with the default atlas options (one page for all when they do not fit or there is nothing to pack). */
export function estimatePages(project: Project): (path: string) => number {
  const have = new Map(project.images.map((i) => [i.name, i] as const));
  const inputs = usedImages(project.skeleton)
    .map((u) => have.get(u.name))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => ({ name: i.name, width: i.width, height: i.height }));
  const page = new Map<string, number>();
  try {
    for (const p of packAtlas(inputs, { maxSize: 2048, padding: 2 })) for (const r of p.regions) page.set(r.name, p.index);
  } catch {
    /* a picture larger than a page: one page for all */
  }
  return (path) => page.get(path) ?? 0;
}
