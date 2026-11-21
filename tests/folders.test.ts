/** Draw order folders: the helpers, the pose against the OFFICIAL runtime (JSON and binary), import, and the editor actions. */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { exportSpineBinary } from '../src/core/export/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import { completeFolderOrder, drawOrderOffsets, folderOrderAfterMove, folderOfSlot, pruneFolders } from '../src/core/folders';
import { importSpineJson } from '../src/core/import/spineJson';
import { emptyProject, newAnimation, newBone, newSlot } from '../src/core/model';
import type { Project, SkeletonDoc } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import { setMode, selectAnimation, moveSlot, deleteSlots, createAnimation } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { deleteFolder, renameFolder, setSlotFolder } from '../src/store/folderActions';
import { uiStore } from '../src/store/ui';
import { loadOfficial, loadOfficialBinary, S } from './official';

function build(n = 7) {
  const p: Project = emptyProject('folders');
  p.skeleton.bones = [];
  const root = newBone({ name: 'root', length: 10 });
  p.skeleton.bones.push(root);
  for (let i = 0; i < n; i++) p.skeleton.slots.push(newSlot({ name: `s${i}`, bone: root.id }));
  return p;
}
const ids = (d: SkeletonDoc) => d.slots.map((s) => s.id);
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const shuffled = <T>(a: T[], r: () => number) => {
  const o = [...a];
  for (let i = o.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
};

describe('helpers', () => {
  it('completeFolderOrder keeps folder slots once and adds the missing ones in setup order', () => {
    expect(completeFolderOrder(['a', 'b', 'c'], ['c', 'x', 'c'])).toEqual(['c', 'a', 'b']);
    expect(completeFolderOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('drawOrderOffsets: nothing for the setup order, moved slots in setup order', () => {
    expect(drawOrderOffsets(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
    expect(drawOrderOffsets(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      { id: 'a', offset: 1 },
      { id: 'b', offset: 1 },
      { id: 'c', offset: -2 },
    ]);
  });
  it('folderOrderAfterMove: the folder takes the order of its slots after the drag; slots outside a folder give null', () => {
    const p = build(5);
    const [a, b, c, d, e] = ids(p.skeleton);
    p.skeleton.drawOrderFolders = [{ id: 'F', name: 'f', slots: [a, c, e] }];
    // drag c to the very bottom of the list a b c d e
    expect(folderOrderAfterMove(p.skeleton, [a, b, c, d, e], c, 0)!.order).toEqual([c, a, e]);
    expect(folderOrderAfterMove(p.skeleton, [a, b, c, d, e], b, 0)).toBeNull();
    expect(folderOfSlot(p.skeleton, e)!.id).toBe('F');
  });
  it('pruneFolders drops missing and shared slots and the folders left empty, with their keys', () => {
    const p = build(3);
    const [a, b] = ids(p.skeleton);
    p.skeleton.drawOrderFolders = [
      { id: 'F', name: 'f', slots: [a, 'gone'] },
      { id: 'G', name: 'g', slots: [a] },
      { id: 'H', name: 'h', slots: ['gone2'] },
    ];
    const an = newAnimation('x', 1);
    an.drawOrderFolder = { F: [{ time: 0, order: [a] }], H: [{ time: 0, order: [] }] };
    p.skeleton.animations.push(an);
    expect(pruneFolders(p.skeleton).sort()).toEqual(['G', 'H']);
    expect(p.skeleton.drawOrderFolders).toEqual([{ id: 'F', name: 'f', slots: [a] }]);
    expect(Object.keys(an.drawOrderFolder)).toEqual(['F']);
    expect(b).toBeTruthy();
  });
});

describe('against the official runtime', () => {
  function randomDoc(seed: number) {
    const r = rng(seed);
    const p = build(8 + Math.floor(r() * 4));
    const d = p.skeleton;
    const order = shuffled(ids(d), r);
    // two disjoint folders of random slots, in setup order inside
    const pickA = order.slice(0, 2 + Math.floor(r() * 3));
    const pickB = order.slice(pickA.length, pickA.length + 2 + Math.floor(r() * 2));
    d.drawOrderFolders = [
      { id: 'FA', name: 'a', slots: pickA },
      { id: 'FB', name: 'b', slots: pickB },
    ];
    const a = newAnimation('anim', 2);
    const withFull = r() < 0.5;
    for (let k = 0; k < 5; k++) {
      const t = k * 0.375; // times a 32-bit float holds exactly, so the key times compare the same in the official runtime
      if (withFull && k % 2 === 0) a.drawOrder.push({ time: t, order: shuffled(ids(d), r) });
      if (r() < 0.8) ((a.drawOrderFolder ??= {}).FA ??= []).push({ time: t + 0.0625, order: shuffled(pickA, r) });
      if (r() < 0.6) ((a.drawOrderFolder ??= {}).FB ??= []).push({ time: t + 0.125, order: shuffled(pickB, r) });
    }
    d.animations.push(a);
    return p;
  }
  const names = (p: Project, order: { data: { id: string } }[]) => order.map((s) => p.skeleton.slots.find((x) => x.id === s.data.id)!.name);

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    it(`random folders and keys, seed ${seed}: pose equals the official one (JSON and binary)`, () => {
      const p = randomDoc(seed);
      const d = p.skeleton;
      expect(validateProject(p)).toEqual([]);
      const json = exportSpineJson(d);
      const viaJson = loadOfficial(json, '');
      const viaBinary = loadOfficialBinary(exportSpineBinary(d), '');
      const data = compileSkeleton(d);
      for (const sd of [viaJson, viaBinary]) {
        for (let t = 0; t <= 2; t += 0.0625) {
          const official = new S.Skeleton(sd);
          official.setupPose();
          const state = new S.AnimationState(new S.AnimationStateData(sd));
          state.setAnimation(0, 'anim', false);
          state.update(t);
          state.apply(official);
          official.updateWorldTransform(S.Physics.update);
          const ours = createSkeleton(data);
          applyAnimation(ours, d.animations[0], t);
          expect(names(p, ours.drawOrder), `t=${t.toFixed(2)}`).toEqual(
            official.drawOrder.appliedPose.map((s: { data: { name: string } }) => s.data.name),
          );
        }
      }
    });
  }

  it('imports what it exports: the folders, their slots and the order they key', () => {
    const p = randomDoc(21);
    const d = p.skeleton;
    const back = importSpineJson(JSON.parse(JSON.stringify(exportSpineJson(d))), 'back').project.skeleton;
    expect(back.drawOrderFolders!.map((f) => f.slots.map((s) => back.slots.find((x) => x.id === s)!.name).sort())).toEqual(
      d.drawOrderFolders!.map((f) => f.slots.map((s) => d.slots.find((x) => x.id === s)!.name).sort()),
    );
    const dataA = compileSkeleton(d);
    const dataB = compileSkeleton(back);
    for (let t = 0; t <= 2; t += 0.0625) {
      const a = createSkeleton(dataA);
      const b = createSkeleton(dataB);
      applyAnimation(a, d.animations[0], t);
      applyAnimation(b, back.animations[0], t);
      expect(b.drawOrder.map((s) => s.data.name)).toEqual(a.drawOrder.map((s) => s.data.name));
    }
  });
});

describe('editor actions', () => {
  let slots: string[] = [];
  beforeEach(() => {
    const p = build(5);
    docStore.replace(p);
    uiStore.patch({ mode: 'setup', time: 0, playing: false });
    slots = ids(p.skeleton);
  });
  const doc = () => docStore.get().skeleton;

  it('a slot goes into a new folder, another joins it, one history step each; a slot is in one folder', () => {
    setSlotFolder(slots[1], 'new');
    const f = doc().drawOrderFolders![0];
    expect(f.slots).toEqual([slots[1]]);
    setSlotFolder(slots[3], f.id);
    expect(doc().drawOrderFolders![0].slots).toEqual([slots[1], slots[3]]);
    setSlotFolder(slots[3], 'new');
    expect(doc().drawOrderFolders!.map((x) => x.slots)).toEqual([[slots[1]], [slots[3]]]);
    docStore.undo();
    expect(doc().drawOrderFolders!.map((x) => x.slots)).toEqual([[slots[1], slots[3]]]);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('dragging a slot of a folder in Animate mode keys the folder only; the folder row survives rename; delete takes the keys', () => {
    setSlotFolder(slots[1], 'new');
    setSlotFolder(slots[3], doc().drawOrderFolders![0].id);
    createAnimation();
    const anim = doc().animations[0];
    selectAnimation(anim.id);
    setMode('animate');
    uiStore.patch({ time: 0.3 });
    moveSlot(slots[3], 0); // slot 3 dragged to the bottom of the list
    const f = doc().drawOrderFolders![0];
    const keys = doc().animations[0].drawOrderFolder![f.id];
    expect(keys).toHaveLength(1);
    expect(keys[0].order).toEqual([slots[3], slots[1]]);
    expect(doc().animations[0].drawOrder).toEqual([]);
    expect(validateProject(docStore.get())).toEqual([]);
    renameFolder(f.id, 'wings');
    expect(doc().drawOrderFolders![0].name).toBe('wings');
    // a slot outside every folder still keys the whole draw order
    moveSlot(slots[4], 0);
    expect(doc().animations[0].drawOrder).toHaveLength(1);
    deleteFolder(f.id);
    expect(doc().drawOrderFolders).toBeUndefined();
    expect(doc().animations[0].drawOrderFolder).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('deleting a slot takes it out of its folder; an empty folder and its keys go', () => {
    setSlotFolder(slots[1], 'new');
    const fid = doc().drawOrderFolders![0].id;
    createAnimation();
    doc().animations[0];
    docStore.update('keys', (d) => {
      d.skeleton.animations[0].drawOrderFolder = { [fid]: [{ time: 0.1, order: [slots[1]] }] };
    });
    deleteSlots([slots[1]]);
    expect(doc().drawOrderFolders).toBeUndefined();
    expect(doc().animations[0].drawOrderFolder).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('a damaged folder table is repaired when a project opens', () => {
    const p = structuredClone(docStore.get());
    p.skeleton.drawOrderFolders = [
      { id: 'X', name: 'x', slots: [slots[0], slots[0], 'nope'] },
      { id: 'Y', name: 'y', slots: [slots[0]] },
    ];
    const notes = validateProject(p);
    expect(notes.join(' ')).toMatch(/draw order folders repaired/);
  });
});
