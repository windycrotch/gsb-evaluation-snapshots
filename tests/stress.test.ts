/** The rig test: a mesh with bad weights folds when a bone is turned, a mesh with good weights does not, and the demo fox is clean. */
import { describe, expect, it } from 'vitest';
import { uid } from '../src/core/ids';
import { emptyProject, newBone, newSlot } from '../src/core/model';
import type { ImageRef, Influence, MeshAttachment, Project } from '../src/core/model';
import { STRESS_ANGLES, stressRig } from '../src/core/stress';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';

/** A strip of two bones (A at the origin, B 100 units along it) and a mesh 200 long over them, weighted by `weightAt(x)` = the share of bone B. */
function strip(weightAt: (x: number) => number): { project: Project; b: string; mesh: MeshAttachment } {
  const project = emptyProject('strip');
  const doc = project.skeleton;
  const root = doc.bones[0];
  const a = newBone({ name: 'a', parent: root.id, length: 100 });
  const b = newBone({ name: 'b', parent: a.id, length: 100, x: 100 });
  doc.bones.push(a, b);
  const slot = newSlot({ name: 'skin', bone: a.id });
  slot.attachment = 'strip';
  doc.slots.push(slot);
  // a grid of 9 x 2 vertices along x from 0 to 200, a row at y = -20 and one at y = 20
  const xs = [0, 25, 50, 75, 100, 125, 150, 175, 200];
  const verts: [number, number][] = [];
  for (const x of xs) verts.push([x, -20], [x, 20]);
  const triangles: number[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const [p, q, r, s] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3];
    triangles.push(p, r, q, q, r, s);
  }
  const weights: Influence[][] = verts.map(([x, y]) => {
    const wb = Math.min(1, Math.max(0, weightAt(x)));
    const list: Influence[] = [];
    // a vertex stores its place in the space of each bone that carries it
    if (wb < 1) list.push([a.id, x, y, 1 - wb]);
    if (wb > 0) list.push([b.id, x - 100, y, wb]);
    return list;
  });
  const mesh: MeshAttachment = {
    type: 'mesh',
    name: 'strip',
    path: 'strip',
    color: [1, 1, 1, 1],
    width: 200,
    height: 40,
    vertices: verts.flat(),
    uvs: verts.flatMap(([x, y]) => [x / 200, (y + 20) / 40]),
    triangles,
    hull: 18,
    edges: [],
    weights,
  } as unknown as MeshAttachment;
  doc.skins[0].attachments[slot.id] = { strip: mesh };
  return { project, b: b.id, mesh };
}

describe('stressRig', () => {
  it('says nothing about a strip whose weights blend smoothly over a long stretch', () => {
    const { project } = strip((x) => (x - 50) / 100);
    expect(stressRig(project.skeleton)).toEqual([]);
  });

  it('finds the folds of a hard seam: opposite bones with half weights on one line of vertices', () => {
    // every vertex is either all A or all B, and the middle one is shared half and half: turning B far folds the triangles at the seam
    const { project, b } = strip((x) => (x < 100 ? 0 : x === 100 ? 0.5 : 1));
    const found = stressRig(project.skeleton, { angles: [170], minShare: 0 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({ bone: b, mesh: 'strip', angle: 170 });
    expect(found[0].flipped).toBeGreaterThan(0);
    expect(found[0].triangles).toBe(16);
  });

  it('reports nothing for an unweighted mesh and for a rig without meshes', () => {
    const { project } = strip(() => 0);
    const att = project.skeleton.skins[0].attachments[project.skeleton.slots[0].id].strip as MeshAttachment;
    (att as { weights?: unknown }).weights = undefined;
    expect(stressRig(project.skeleton)).toEqual([]);
    expect(stressRig(emptyProject('empty').skeleton)).toEqual([]);
  });

  it('leaves the document as it was', () => {
    const { project } = strip((x) => (x < 100 ? 0 : 1));
    const before = JSON.stringify(project);
    stressRig(project.skeleton, { angles: [170] });
    expect(JSON.stringify(project)).toBe(before);
  });

  it('has a short default list of angles, both ways', () => {
    expect(STRESS_ANGLES.some((a) => a < 0)).toBe(true);
    expect(STRESS_ANGLES.some((a) => a > 0)).toBe(true);
  });

  it('the demo fox holds up at a gentle turn; harder turns of a lone tail or scarf bone do fold it, and that is said', () => {
    const images: Record<string, ImageRef> = {};
    for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
    const doc = buildDemoRig(images).skeleton;
    expect(stressRig(doc, { angles: [20, -20] })).toEqual([]);
    const found = stressRig(doc);
    expect(found.length).toBeGreaterThan(0);
    // the gentlest turn comes first, and every finding says how much of the mesh folds
    for (let i = 1; i < found.length; i++) expect(Math.abs(found[i].angle)).toBeGreaterThanOrEqual(Math.abs(found[i - 1].angle));
    for (const f of found) expect(f.share).toBeGreaterThanOrEqual(0.05);
  });
});
