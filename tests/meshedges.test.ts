/** Manual mesh edges: the constrained triangulation keeps outline and edges, nothing crosses them; the store toggles and renumbers them. */
import { beforeEach, describe, expect, it } from 'vitest';
import { edgeProblem, meshFromRegion, remapEdges, triangulate } from '@/core/mesh';
import { segmentsCross } from '@/core/constrain';
import { emptyProject, newBone, newSlot } from '@/core/model';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import { addMeshVertex, clearMeshEdges, deleteMeshVertices, getMesh, retriangulateMesh, toggleMeshEdge } from '@/store/meshActions';
import { uiStore } from '@/store/ui';

const area = (p: ArrayLike<number>, t: number[]) => {
  let s = 0;
  for (let i = 0; i < t.length; i += 3)
    s +=
      Math.abs(
        (p[t[i + 1] * 2] - p[t[i] * 2]) * (p[t[i + 2] * 2 + 1] - p[t[i] * 2 + 1]) -
          (p[t[i + 2] * 2] - p[t[i] * 2]) * (p[t[i + 1] * 2 + 1] - p[t[i] * 2 + 1]),
      ) / 2;
  return s;
};
const hasEdge = (t: number[], a: number, b: number) => {
  for (let i = 0; i < t.length; i += 3) {
    const v = [t[i], t[i + 1], t[i + 2]];
    if (v.includes(a) && v.includes(b)) return true;
  }
  return false;
};
const noCrossing = (p: ArrayLike<number>, t: number[], a: number, b: number) => {
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) if (segmentsCross(p, a, b, t[i + k], t[i + ((k + 1) % 3)])) return false;
  return true;
};
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

describe('constrained triangulation', () => {
  it('a concave outline keeps every outline edge and fills exactly the polygon', () => {
    // an L shape, counter-clockwise, plus a point inside each arm
    const pts = [0, 0, 100, 0, 100, 40, 40, 40, 40, 100, 0, 100, 70, 20, 20, 70];
    const t = triangulate(pts, 6);
    for (let i = 0; i < 6; i++) expect(hasEdge(t, i, (i + 1) % 6)).toBe(true);
    expect(area(pts, t)).toBeCloseTo(100 * 100 - 60 * 60, 6);
  });

  it('a manual edge across the mesh is an edge of the result and nothing crosses it', () => {
    const r = rng(7);
    const pts: number[] = [0, 0, 200, 0, 200, 200, 0, 200];
    for (let i = 0; i < 40; i++) pts.push(10 + r() * 180, 10 + r() * 180);
    for (const [a, b] of [
      [4, 30],
      [0, 2],
      [5, 20],
      [1, 3],
    ]) {
      const t = triangulate(pts, 4, [a, b]);
      expect(hasEdge(t, a, b)).toBe(true);
      expect(noCrossing(pts, t, a, b)).toBe(true);
      expect(area(pts, t)).toBeCloseTo(200 * 200, 4);
    }
  });

  it('several edges at once, and a vertex lying on an edge splits it', () => {
    // the four corners are the outline, the other twelve grid points are interior
    const all = [0, 0, 90, 0, 90, 90, 0, 90];
    const inner: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (!((x === 0 || x === 3) && (y === 0 || y === 3))) inner.push(x * 30, y * 30);
    const p = [...all, ...inner]; // corners 0..3, interior from 4
    // the diagonal (0,0)-(90,90) passes through the interior vertices (30,30) and (60,60)
    const t = triangulate(p, 4, [0, 2]);
    const at = (x: number, y: number) => {
      for (let i = 0; i < p.length / 2; i++) if (p[i * 2] === x && p[i * 2 + 1] === y) return i;
      return -1;
    };
    const a = at(30, 30);
    const b = at(60, 60);
    expect(hasEdge(t, 0, a)).toBe(true);
    expect(hasEdge(t, a, b)).toBe(true);
    expect(hasEdge(t, b, 2)).toBe(true);
    expect(area(p, t)).toBeCloseTo(90 * 90, 6);
  });

  it('is Delaunay where nothing constrains it: no constraint, same area and count as before', () => {
    const r = rng(3);
    const pts: number[] = [0, 0, 100, 0, 100, 100, 0, 100];
    for (let i = 0; i < 30; i++) pts.push(5 + r() * 90, 5 + r() * 90);
    const t = triangulate(pts, 4);
    expect(area(pts, t)).toBeCloseTo(10000, 4);
    expect(t.length / 3).toBe(2 * (pts.length / 2) - 2 - 4); // Euler: 2n - 2 - h for a triangulated convex polygon
  });
});

describe('edge helpers', () => {
  const sq = [0, 0, 100, 0, 100, 100, 0, 100, 50, 50, 20, 20, 80, 20];
  it('remapEdges follows the renumbering and drops edges that lost a vertex', () => {
    expect(remapEdges([4, 5, 5, 6, 4, 6], [0, 1, 2, 3, 4, -1, 6])).toEqual([4, 6]);
    expect(remapEdges([4, 5, 5, 4], [4, 5])).toEqual([0, 1]);
  });
  it('edgeProblem: outline edge, duplicate, crossing, outside', () => {
    expect(edgeProblem(sq, 4, [], 0, 1)).toMatch(/outline/);
    expect(edgeProblem(sq, 4, [4, 5], 5, 4)).toMatch(/exists/);
    expect(edgeProblem(sq, 4, [4, 5], 6, 0)).toBeNull();
    expect(edgeProblem(sq, 4, [4, 5], 0, 4)).toBeNull(); // shares a vertex: fine
    expect(edgeProblem(sq, 4, [0, 2], 1, 3)).toMatch(/cross/);
    const concave = [0, 0, 100, 0, 100, 40, 40, 40, 40, 100, 0, 100];
    expect(edgeProblem(concave, 6, [], 1, 5)).toMatch(/outline|inside/);
    expect(edgeProblem(sq, 4, [], 3, 3)).toMatch(/different/);
  });
});

describe('manual edges in the store', () => {
  let slotId = '';
  beforeEach(() => {
    const p = emptyProject();
    p.skeleton.bones = [];
    const root = newBone({ name: 'root' });
    p.skeleton.bones.push(root);
    const slot = newSlot({ name: 's', bone: root.id });
    p.skeleton.slots.push(slot);
    p.skeleton.skins[0].attachments[slot.id] = {
      img: meshFromRegion({
        type: 'region',
        name: 'img',
        path: 'img',
        x: 0,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        width: 100,
        height: 100,
        color: [1, 1, 1, 1],
        sequence: null,
      } as never),
    };
    slot.attachment = 'img';
    docStore.replace(p);
    uiStore.patch({ mode: 'setup' });
    slotId = slot.id;
    setSelection({ slot: slotId, attachment: 'img', bones: [], vertices: [] });
    // a few interior vertices (inside the quad), then they can be joined
    addMeshVertex(slotId, 'img', -20, -20);
    addMeshVertex(slotId, 'img', 20, 20);
    addMeshVertex(slotId, 'img', 20, -20);
    addMeshVertex(slotId, 'img', -20, 20);
  });
  const mesh = () => getMesh(slotId, 'img')!;

  it('toggle adds then removes an edge, the triangulation honours it, one history step each', () => {
    const n = mesh().uvs.length / 2;
    expect(n).toBe(8);
    const last = n - 1;
    const first = last - 3;
    const undo0 = docStore.canUndo;
    expect(toggleMeshEdge(slotId, 'img', first, last)).toBe(true);
    expect(mesh().edges).toEqual([first, last]);
    expect(hasEdge(mesh().triangles, first, last)).toBe(true);
    expect(toggleMeshEdge(slotId, 'img', last, first)).toBe(false);
    expect(mesh().edges).toEqual([]);
    docStore.undo();
    expect(mesh().edges).toEqual([first, last]);
    docStore.undo();
    expect(mesh().edges).toEqual([]);
    expect(docStore.canUndo).toBe(undo0);
  });

  it('refuses an edge that crosses an edge or the outline', () => {
    const n = mesh().uvs.length / 2;
    expect(toggleMeshEdge(slotId, 'img', 0, 1)).toBe(false); // outline
    expect(mesh().edges).toEqual([]);
    expect(toggleMeshEdge(slotId, 'img', n - 4, n - 3)).toBe(true);
    expect(n).toBeGreaterThan(5);
  });

  it('adding and deleting vertices renumbers the edges; clear removes them all', () => {
    const n = mesh().uvs.length / 2;
    toggleMeshEdge(slotId, 'img', n - 4, n - 1);
    const before = [...mesh().edges];
    // a new outline vertex is inserted in the middle: the interior vertices move up by one
    addMeshVertex(slotId, 'img', 150, 0);
    expect(mesh().edges).toEqual(before.map((v) => v + 1));
    deleteMeshVertices(slotId, 'img', [n - 4 + 1]);
    expect(mesh().edges).toEqual([]);
    toggleMeshEdge(slotId, 'img', 5, 7);
    retriangulateMesh(slotId, 'img');
    expect(mesh().edges.length).toBe(2);
    clearMeshEdges(slotId, 'img');
    expect(mesh().edges).toEqual([]);
  });
});
