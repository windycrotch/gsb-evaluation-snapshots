/** The cost of drawing the pose on screen: draw calls and clipped triangles (the Metrics window). */
import { describe, expect, it } from 'vitest';
import { estimatePages, poseMetrics, segmentsIntersect, triangleCrossesPolygon } from '../src/core/drawstats';
import type { Project } from '../src/core/model';
import { compileSkeleton, createSkeleton, meshWorldVertices } from '../src/core/skeleton';
import { addAttachmentRig, buildFixture } from './fixture';

function posed(project: Project) {
  const sk = createSkeleton(compileSkeleton(project.skeleton));
  sk.setToSetupPose();
  sk.updateWorldTransform();
  return sk;
}

const isPicture = (sk: ReturnType<typeof posed>, slot: ReturnType<typeof posed>['drawOrder'][number]) => {
  const att = sk.slotAttachment(slot);
  return !!att && (att.kind === 'region' || att.kind === 'mesh') && sk.color[3] * slot.color[3] * att.color[3] > 0;
};

describe('geometry', () => {
  it('segments cross only when they really cross', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 0, 5, 10, 5)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 0, 10, 0, 10, 10)).toBe(false); // touching at an end
  });
  it('a triangle is cut by an outline that passes through it, not by one that holds it or misses it', () => {
    const t = [0, 0, 10, 0, 0, 10];
    expect(triangleCrossesPolygon(t, [5, -5, 15, -5, 15, 5, 5, 5], 4)).toBe(true); // crosses an edge
    expect(triangleCrossesPolygon(t, [-5, -5, 20, -5, 20, 20, -5, 20], 4)).toBe(false); // the triangle is inside
    expect(triangleCrossesPolygon(t, [50, 50, 60, 50, 60, 60], 3)).toBe(false); // far away
    expect(triangleCrossesPolygon(t, [1, 1, 2, 1, 2, 2, 1, 2], 4)).toBe(true); // the outline is inside the triangle
  });
});

describe('poseMetrics', () => {
  it('counts what the renderer draws: pictures and triangles', () => {
    const sk = posed(buildFixture().project);
    const m = poseMetrics(sk);
    let drawn = 0;
    let tri = 0;
    for (const slot of sk.drawOrder) {
      if (!isPicture(sk, slot)) continue;
      const att = sk.slotAttachment(slot)!;
      drawn++;
      tri += att.kind === 'region' ? 2 : att.kind === 'mesh' ? att.triangles.length / 3 : 0;
    }
    expect(m.drawn).toBe(drawn);
    expect(m.triangles).toBe(tri);
    expect(m.drawn).toBeGreaterThan(0);
    expect(m.clippedTriangles).toBe(0);
    expect(m.clippers).toBe(0);
  });

  it('starts a draw call when the blend mode or the texture page changes', () => {
    const sk = posed(buildFixture().project);
    const all = poseMetrics(sk).drawCalls;
    // one page: the runs of equal blend modes are the batches
    let runs = 0;
    let last = '';
    for (const slot of sk.drawOrder) {
      if (!isPicture(sk, slot)) continue;
      if (slot.data.blend !== last) runs++;
      last = slot.data.blend;
    }
    expect(all).toBe(runs);
    // every picture on a page of its own: a call each
    const pictures = sk.drawOrder.filter((s) => isPicture(sk, s));
    expect(poseMetrics(sk, { pageOf: (p) => p }).drawCalls).toBeGreaterThanOrEqual(all);
    // a different blend mode in the middle splits the batch
    const mid = pictures[Math.floor(pictures.length / 2)];
    (mid.data as { blend: string }).blend = mid.data.blend === 'additive' ? 'multiply' : 'additive';
    expect(poseMetrics(sk).drawCalls).toBeGreaterThan(all - 1);
  });

  it('a hidden slot, or a clear one, is not drawn', () => {
    const sk = posed(buildFixture().project);
    const base = poseMetrics(sk);
    const slot = sk.drawOrder.find((s) => isPicture(sk, s))!;
    expect(poseMetrics(sk, { skip: (s) => s === slot }).drawn).toBe(base.drawn - 1);
    slot.color[3] = 0;
    expect(poseMetrics(sk).drawn).toBe(base.drawn - 1);
  });

  it('counts the clips in effect, and the triangles a clipping polygon cuts', () => {
    const big = buildFixture();
    addAttachmentRig(big.project, { vertices: [-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000] });
    const wide = poseMetrics(posed(big.project));
    expect(wide.clippers).toBeGreaterThan(0);
    expect(wide.clippedTriangles).toBe(0);
    // a small polygon laid in a triangle of the head (the mesh the clip covers) is inside that triangle: the triangle has to be cut
    const f = buildFixture();
    const rig = addAttachmentRig(f.project);
    const sk = posed(f.project);
    const head = sk.drawOrder.find((s) => s.data.name === 'head')!;
    const mesh = sk.slotAttachment(head)!;
    if (mesh.kind !== 'mesh') throw new Error('the head is a mesh');
    const world = new Float32Array(mesh.vertexCount * 2);
    meshWorldVertices(sk, head, mesh, null, world);
    const [a, b, c] = [mesh.triangles[0], mesh.triangles[1], mesh.triangles[2]];
    const cx = (world[a * 2] + world[b * 2] + world[c * 2]) / 3;
    const cy = (world[a * 2 + 1] + world[b * 2 + 1] + world[c * 2 + 1]) / 3;
    const clipSlot = f.project.skeleton.slots.find((s) => s.id === rig.slotId.clip)!;
    // the point in the space of the clip's bone: the inverse of the bone matrix (a b / c d) after the move to its origin
    const bone = sk.boneById(clipSlot.bone)!;
    const det = bone.a * bone.d - bone.b * bone.c;
    const [dx, dy] = [cx - bone.worldX, cy - bone.worldY];
    const lx = (bone.d * dx - bone.b * dy) / det;
    const ly = (bone.a * dy - bone.c * dx) / det;
    // (the rig scales this bone a lot: a polygon this small in its space is small on the screen too)
    const e = 0.0002;
    const g = buildFixture(); // the compiled skeleton is kept per document, so the polygon goes into a new one
    addAttachmentRig(g.project, { vertices: [lx - e, ly - e, lx + e, ly - e, lx + e, ly + e, lx - e, ly + e] });
    expect(poseMetrics(posed(g.project)).clippedTriangles).toBeGreaterThan(0);
  });
});

describe('estimatePages', () => {
  it('puts the used pictures on atlas pages and gives page 0 to what it does not know', () => {
    const f = buildFixture();
    const page = estimatePages(f.project);
    expect(page('nothing-like-this')).toBe(0);
    for (const i of f.project.images) expect(page(i.name)).toBeGreaterThanOrEqual(0);
  });
});
