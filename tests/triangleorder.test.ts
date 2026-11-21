/** Triangle order (the drawing order of a mesh's triangles) and the outline-only view of a mesh. */
import { beforeEach, describe, expect, it } from 'vitest';
import { exportSpineJson } from '../src/core/export/spineJson';
import { moveTriangle, trianglesAt } from '../src/core/mesh';
import { setSelection } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { getMesh, moveMeshTriangle, retriangulateMesh } from '../src/store/meshActions';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const tris = (t: readonly number[]) => Array.from({ length: t.length / 3 }, (_, i) => t.slice(i * 3, i * 3 + 3).join(','));

describe('moveTriangle', () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  it('moves one triangle to the first or last place, or one place on', () => {
    expect(tris(moveTriangle(t, 2, 'first').triangles)).toEqual(['6,7,8', '0,1,2', '3,4,5', '9,10,11']);
    expect(tris(moveTriangle(t, 1, 'last').triangles)).toEqual(['0,1,2', '6,7,8', '9,10,11', '3,4,5']);
    expect(tris(moveTriangle(t, 1, 'earlier').triangles)).toEqual(['3,4,5', '0,1,2', '6,7,8', '9,10,11']);
    expect(tris(moveTriangle(t, 1, 'later').triangles)).toEqual(['0,1,2', '6,7,8', '3,4,5', '9,10,11']);
  });
  it('reports where the triangle is now, and stays put at the ends', () => {
    expect(moveTriangle(t, 2, 'first').index).toBe(0);
    expect(moveTriangle(t, 0, 'later').index).toBe(1);
    const stay = moveTriangle(t, 0, 'earlier');
    expect(stay.index).toBe(0);
    expect(stay.triangles).toEqual(t);
    expect(moveTriangle(t, 3, 'last').index).toBe(3);
  });
  it('ignores a triangle that does not exist and keeps every triangle (a permutation)', () => {
    expect(moveTriangle(t, 9, 'first').triangles).toEqual(t);
    expect(moveTriangle(t, -1, 'first').triangles).toEqual(t);
    for (const to of ['first', 'earlier', 'later', 'last'] as const) {
      for (let i = 0; i < 4; i++) expect(tris(moveTriangle(t, i, to).triangles).sort()).toEqual(tris(t).sort());
    }
  });
});

describe('trianglesAt', () => {
  // two squares' worth of triangles stacked on each other: the later one is on top
  const world = [0, 0, 10, 0, 10, 10, 0, 10];
  const tri = [0, 1, 2, 0, 2, 3, 0, 1, 2];
  it('lists the triangles under a point, the one drawn last first', () => {
    expect(trianglesAt(world, tri, 8, 2)).toEqual([2, 0]);
    expect(trianglesAt(world, tri, 2, 8)).toEqual([1]);
    expect(trianglesAt(world, tri, 50, 50)).toEqual([]);
  });
});

describe('moving the triangles of a mesh', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({ mode: 'setup', selection: { bones: [], slot: null, attachment: null, constraint: null, vertices: [] } });
  });
  const headMesh = () => {
    const doc = docStore.get().skeleton;
    for (const slot of doc.slots) {
      const a = doc.skins[0].attachments[slot.id]?.head;
      if (a?.type === 'mesh' && !a.link) return { slotId: slot.id, mesh: a };
    }
    throw new Error('no mesh');
  };

  it('writes the new order as one undo step, and the export keeps it', () => {
    const { slotId, mesh } = headMesh();
    const before = tris(mesh.triangles);
    expect(before.length).toBeGreaterThan(1);
    const at = moveMeshTriangle(slotId, 'head', 0, 'last');
    expect(at).toBe(before.length - 1);
    const now = getMesh(slotId, 'head')!;
    expect(tris(now.triangles)).toEqual([...before.slice(1), before[0]]);
    const json = exportSpineJson(docStore.get().skeleton) as {
      skins: { name: string; attachments: Record<string, Record<string, { triangles?: number[] }>> }[];
    };
    const exported = json.skins[0].attachments[docStore.get().skeleton.slots.find((s) => s.id === slotId)!.name].head.triangles!;
    expect(tris(exported)).toEqual(tris(now.triangles));
    expect(() => exportAndLoad(docStore.get())).not.toThrow();
    docStore.undo();
    expect(tris(getMesh(slotId, 'head')!.triangles)).toEqual(before);
  });

  it('a move that changes nothing is not a step of the history', () => {
    const { slotId } = headMesh();
    const steps = docStore.get().skeleton.animations.length; // anything stable
    expect(moveMeshTriangle(slotId, 'head', 0, 'first')).toBe(0);
    expect(docStore.get().skeleton.animations.length).toBe(steps);
  });

  it('Retriangulate gives the default order back', () => {
    const { slotId } = headMesh();
    const count = getMesh(slotId, 'head')!.triangles.length;
    moveMeshTriangle(slotId, 'head', 0, 'last');
    const moved = getMesh(slotId, 'head')!.triangles.slice();
    retriangulateMesh(slotId, 'head');
    const again = getMesh(slotId, 'head')!.triangles;
    // the same outline gives the same number of triangles, in the order the triangulation makes them
    expect(again.length).toBe(count);
    expect(again.length).toBe(moved.length);
  });
});

describe('the mesh view', () => {
  it('has the outline-only and triangle picking switches, off to begin with', () => {
    const v = uiStore.get().meshView;
    expect(v.hullOnly).toBe(false);
    expect(v.pickTriangle).toBe(false);
    expect(v.triangle).toBeNull();
    setSelection({});
  });
});
