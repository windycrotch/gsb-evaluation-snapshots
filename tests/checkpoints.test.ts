/** Checkpoints: the comparison of two skeletons, marking / restoring (one undoable step), staleness when another project opens, and the viewport ghost. */
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSkeletons, MAX_CHECKPOINTS, nextCheckpointName, restoredImages, summarizeChanges } from '../src/core/checkpoints';
import { emptyProject, newAnimation, newBone, newSkin, newSlot } from '../src/core/model';
import type { Project } from '../src/core/model';
import { checkpointGhost } from '../src/editor/ghosts';
import {
  checkpointStore,
  checkpointsOfActive,
  deleteCheckpoint,
  markCheckpoint,
  renameCheckpoint,
  restoreCheckpoint,
  toggleCompare,
} from '../src/store/checkpoints';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';

function rig(): Project {
  const p = emptyProject('cp');
  const doc = p.skeleton;
  const root = doc.bones[0];
  const arm = newBone({ name: 'arm', parent: root.id, length: 40, x: 10 });
  doc.bones.push(arm);
  doc.slots.push(newSlot({ name: 'hand', bone: arm.id }));
  const walk = newAnimation('walk', 1);
  walk.bones[arm.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 0.5, value: [30] },
      { time: 1, value: [0] },
    ],
  };
  doc.animations.push(walk);
  return p;
}

beforeEach(() => {
  docStore.replace(rig());
  uiStore.patch({ mode: 'setup', selection: emptySelection, animationId: null, compare: null, skinId: null, skinMix: [], time: 0 });
});

describe('diffSkeletons', () => {
  it('equal skeletons have no changes', () => {
    const p = docStore.get();
    expect(diffSkeletons(p.skeleton, p.skeleton)).toEqual([]);
    expect(diffSkeletons(p.skeleton, structuredClone(p.skeleton))).toEqual([]);
  });

  it('names the fields that changed in a bone', () => {
    const before = docStore.get().skeleton;
    docStore.update('t', (d) => {
      d.skeleton.bones[1].x = 12;
      d.skeleton.bones[1].rotation = 5;
      d.skeleton.bones[1].length = 50;
    });
    const changes = diffSkeletons(before, docStore.get().skeleton);
    expect(changes).toEqual([
      { area: 'bone', kind: 'changed', name: 'arm', id: expect.any(String), fields: ['position', 'rotation', 'length'] },
    ]);
  });

  it('lists added and removed bones and slots, and renames', () => {
    const before = docStore.get().skeleton;
    docStore.update('t', (d) => {
      d.skeleton.bones.push(newBone({ name: 'leg', parent: d.skeleton.bones[0].id }));
      d.skeleton.bones[1].name = 'forearm';
      d.skeleton.slots.pop();
    });
    const changes = diffSkeletons(before, docStore.get().skeleton);
    expect(changes).toContainEqual({ area: 'bone', kind: 'added', name: 'leg', id: expect.any(String) });
    expect(changes).toContainEqual({ area: 'bone', kind: 'changed', name: 'forearm', id: expect.any(String), fields: ['name'] });
    expect(changes).toContainEqual({ area: 'slot', kind: 'removed', name: 'hand', id: expect.any(String) });
    expect(summarizeChanges(changes)).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('counts the keys of a changed animation by time', () => {
    const before = docStore.get().skeleton;
    const arm = before.bones[1].id;
    docStore.update('t', (d) => {
      const tl = d.skeleton.animations[0].bones[arm].rotate!;
      tl[1].value = [45]; // changed
      tl.splice(2, 1); // removed
      tl.push({ time: 0.75, value: [10] }); // added
      d.skeleton.animations[0].bones[arm].translate = [{ time: 0, value: [1, 2] }]; // a whole new timeline: one key
    });
    const [change] = diffSkeletons(before, docStore.get().skeleton);
    expect(change.area).toBe('animation');
    expect(change.keys).toEqual({ added: 2, removed: 1, changed: 1 });
  });

  it('sees a new, a removed and a renamed animation, and skins', () => {
    const before = docStore.get().skeleton;
    docStore.update('t', (d) => {
      d.skeleton.animations[0].name = 'run';
      d.skeleton.animations.push(newAnimation('idle', 2));
      d.skeleton.skins.push(newSkin('red'));
    });
    const changes = diffSkeletons(before, docStore.get().skeleton);
    expect(changes).toContainEqual({ area: 'animation', kind: 'changed', name: 'run', id: expect.any(String), fields: ['name'] });
    expect(changes).toContainEqual({ area: 'animation', kind: 'added', name: 'idle', id: expect.any(String) });
    expect(changes).toContainEqual({ area: 'skin', kind: 'added', name: 'red', id: expect.any(String) });
    const back = diffSkeletons(docStore.get().skeleton, before);
    expect(back).toContainEqual({ area: 'animation', kind: 'removed', name: 'idle', id: expect.any(String) });
  });

  it('a duration change counts as one changed key-less value', () => {
    const before = docStore.get().skeleton;
    docStore.update('t', (d) => void (d.skeleton.animations[0].duration = 2));
    const [c] = diffSkeletons(before, docStore.get().skeleton);
    expect(c.keys).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it('the settings of the skeleton itself', () => {
    const before = docStore.get().skeleton;
    docStore.update('t', (d) => void (d.skeleton.fps = 24));
    expect(diffSkeletons(before, docStore.get().skeleton)).toEqual([
      { area: 'skeleton', kind: 'changed', name: docStore.get().skeleton.name, fields: ['frame rate'] },
    ]);
  });
});

describe('checkpoint store', () => {
  it('names checkpoints in order and fills gaps', () => {
    const a = markCheckpoint();
    const b = markCheckpoint();
    expect([a.name, b.name]).toEqual(['Checkpoint 1', 'Checkpoint 2']);
    deleteCheckpoint(a.id);
    expect(nextCheckpointName(checkpointsOfActive())).toBe('Checkpoint 1');
    renameCheckpoint(b.id, '  Before the arm  ');
    expect(checkpointsOfActive()[0].name).toBe('Before the arm');
  });

  it('restore is one undoable step and puts the skeleton back exactly', () => {
    const cp = markCheckpoint('start');
    const before = docStore.get().skeleton;
    docStore.update('edit', (d) => {
      d.skeleton.bones[1].x = 99;
      d.skeleton.bones.push(newBone({ name: 'extra', parent: d.skeleton.bones[0].id }));
    });
    const edited = docStore.get().skeleton;
    const past = docStore.history.past.length;
    expect(restoreCheckpoint(cp.id)).toBe(true);
    expect(docStore.get().skeleton).toBe(before);
    expect(docStore.history.past.length).toBe(past + 1);
    expect(docStore.undoLabel).toBe('Back to start');
    docStore.undo();
    expect(docStore.get().skeleton).toEqual(edited);
    docStore.redo();
    expect(docStore.get().skeleton).toEqual(before);
  });

  it('restoring with nothing changed does nothing', () => {
    const cp = markCheckpoint();
    const past = docStore.history.past.length;
    expect(restoreCheckpoint(cp.id)).toBe(false);
    expect(docStore.history.past.length).toBe(past);
  });

  it('after a restore the editor does not point at things that are gone', () => {
    const cp = markCheckpoint();
    const id = 'late';
    docStore.update('edit', (d) => {
      const a = newAnimation('late', 1);
      a.id = id;
      d.skeleton.animations.push(a);
    });
    uiStore.patch({
      mode: 'animate',
      animationId: id,
      selection: { ...emptySelection, bones: [docStore.get().skeleton.bones[1].id] },
      reference: id,
    });
    restoreCheckpoint(cp.id);
    const ui = uiStore.get();
    expect(ui.animationId).toBe(docStore.get().skeleton.animations[0].id);
    expect(ui.selection).toBe(emptySelection);
    expect(ui.reference).toBeNull();
  });

  it('a project opened over this one empties the list and the comparison', () => {
    const cp = markCheckpoint();
    toggleCompare(cp.id);
    expect(uiStore.get().compare).toBe(cp.id);
    docStore.replace(rig());
    expect(checkpointStore.get().list).toEqual([]);
    expect(uiStore.get().compare).toBeNull();
  });

  it('compare toggles, and deleting the compared checkpoint turns it off', () => {
    const cp = markCheckpoint();
    toggleCompare(cp.id);
    toggleCompare(cp.id);
    expect(uiStore.get().compare).toBeNull();
    toggleCompare(cp.id);
    deleteCheckpoint(cp.id);
    expect(uiStore.get().compare).toBeNull();
  });

  it('keeps at most MAX_CHECKPOINTS, dropping the oldest', () => {
    const first = markCheckpoint('first');
    for (let i = 0; i < MAX_CHECKPOINTS; i++) markCheckpoint(`n${i}`);
    const list = checkpointsOfActive();
    expect(list.length).toBe(MAX_CHECKPOINTS);
    expect(list.some((c) => c.id === first.id)).toBe(false);
  });

  it('the checkpoint shares the unedited parts of the document (it is a cheap copy)', () => {
    const cp = markCheckpoint();
    docStore.update('edit', (d) => void (d.skeleton.bones[1].x = 5));
    expect(docStore.get().skeleton.animations).toBe(cp.skeleton.animations);
    expect(docStore.get().skeleton.slots).toBe(cp.skeleton.slots);
  });
});

describe('crossfades', () => {
  it('the mix table goes back with the skeleton, so it never names an animation that is gone', () => {
    const walk = docStore.get().skeleton.animations[0];
    docStore.update('mix', (d) => void (d.mixes = { default: 0.2, pairs: [{ from: walk.id, to: walk.id, time: 0.3 }] }));
    const cp = markCheckpoint();
    docStore.update('edit', (d) => {
      const a = newAnimation('late', 1);
      d.skeleton.animations.push(a);
      d.mixes = { default: 0.5, pairs: [{ from: walk.id, to: a.id, time: 0.1 }] };
    });
    expect(restoreCheckpoint(cp.id)).toBe(true);
    expect(docStore.get().mixes).toEqual({ default: 0.2, pairs: [{ from: walk.id, to: walk.id, time: 0.3 }] });
    // and a checkpoint taken without a table removes the later one
    docStore.undo();
    docStore.update('drop', (d) => void delete d.mixes);
    const none = markCheckpoint();
    docStore.update('mix again', (d) => void (d.mixes = { default: 1, pairs: [] }));
    expect(restoreCheckpoint(none.id)).toBe(true);
    expect(docStore.get().mixes).toBeUndefined();
  });
});

describe('pictures', () => {
  it('restoring brings back the pictures the old skeleton names, and keeps the ones that came later', () => {
    docStore.update('add', (d) => {
      d.images.push({ id: 'i1', name: 'hand', width: 10, height: 10 }, { id: 'i2', name: 'foot', width: 8, height: 8 });
    });
    const cp = markCheckpoint('with pictures');
    docStore.update('edit', (d) => {
      d.images = d.images.filter((i) => i.name !== 'hand'); // removed (unused)
      d.images.find((i) => i.name === 'foot')!.name = 'boot'; // renamed
      d.images.push({ id: 'i3', name: 'later', width: 4, height: 4 });
      d.skeleton.bones[1].x = 7;
    });
    expect(restoreCheckpoint(cp.id)).toBe(true);
    const names = docStore.get().images.map((i) => i.name);
    expect(names).toEqual(['hand', 'foot', 'boot', 'later']);
    // no two pictures share an id
    expect(new Set(docStore.get().images.map((i) => i.id)).size).toBe(4);
    docStore.undo();
    expect(docStore.get().images.map((i) => i.name)).toEqual(['boot', 'later']);
  });

  it('the size of a picture is the current one where the name is still there', () => {
    const out = restoredImages([{ id: 'a', name: 'p', width: 10, height: 10 }], [{ id: 'a', name: 'p', width: 20, height: 20 }]);
    expect(out).toEqual([{ id: 'a', name: 'p', width: 20, height: 20 }]);
  });
});

describe('checkpointGhost', () => {
  it('poses the checkpoint as it was, not as it is', () => {
    const arm = docStore.get().skeleton.bones[1].id;
    const cp = markCheckpoint();
    docStore.update('edit', (d) => void (d.skeleton.bones[1].x = 80));
    const g = checkpointGhost(cp.skeleton, null, 0, true, null)!;
    expect(g.skeleton.boneById(arm)!.worldX).toBeCloseTo(10, 5);
  });

  it('plays the animation of the checkpoint at the playhead time', () => {
    const doc = docStore.get().skeleton;
    const arm = doc.bones[1].id;
    const walk = doc.animations[0];
    const cp = markCheckpoint();
    docStore.update('edit', (d) => void (d.skeleton.animations[0].bones[arm].rotate![1].value = [90]));
    const g = checkpointGhost(cp.skeleton, walk.id, 0.5, true, null)!;
    expect(g.skeleton.boneById(arm)!.rotation).toBeCloseTo(30, 4);
    // an animation the checkpoint does not know shows the setup pose
    expect(checkpointGhost(cp.skeleton, 'nope', 0.5, true, null)!.skeleton.boneById(arm)!.rotation).toBe(0);
  });
});
