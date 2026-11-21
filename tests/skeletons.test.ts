/** Several skeletons in one project: the list and its order, switching, adding, copying, deleting, repair, undo, and the export of each. */
import { beforeEach, describe, expect, it } from 'vitest';
import { exportSpineBinary } from '../src/core/export/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import { emptyProject, migrateProject, newAnimation, newBone, newSlot } from '../src/core/model';
import type { Project } from '../src/core/model';
import {
  activeIndex,
  addSkeleton,
  blankSkeleton,
  copyOfSkeleton,
  duplicateSkeleton,
  newSkeletonName,
  removeSkeleton,
  renameSkeleton,
  skeletonCount,
  skeletonList,
  switchSkeleton,
} from '../src/core/skeletons';
import { repairProject, validateProject } from '../src/core/validate';
import { docStore } from '../src/store/doc';
import { copySkeleton, createSkeleton, deleteSkeletonAt, renameSkeletonAt, switchToSkeleton } from '../src/store/skeletonActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { loadOfficial } from './official';

const names = (p: Project) => skeletonList(p).map((d) => d.name);

function project(): Project {
  const p = emptyProject('proj');
  p.skeleton.name = 'a';
  return p;
}

/** A plain-data version of the recipe: the same functions the store runs on a draft, run on a clone. */
function apply(p: Project, recipe: (d: Project) => void): Project {
  const copy = structuredClone(p);
  recipe(copy);
  return copy;
}

describe('the list', () => {
  it('one skeleton is the default; the list keeps the order and the edited one stands where activeAt says', () => {
    let p = project();
    expect(names(p)).toEqual(['a']);
    expect(skeletonCount(p)).toBe(1);
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('c')));
    expect(names(p)).toEqual(['a', 'b', 'c']);
    expect(p.skeleton.name).toBe('c');
    expect(activeIndex(p)).toBe(2);
    p = apply(p, (d) => void switchSkeleton(d, 0));
    expect(p.skeleton.name).toBe('a');
    expect(names(p)).toEqual(['a', 'b', 'c']);
    p = apply(p, (d) => void switchSkeleton(d, 1));
    expect(names(p)).toEqual(['a', 'b', 'c']);
    expect(activeIndex(p)).toBe(1);
    expect(switchSkeleton(structuredClone(p), 1)).toBe(false);
    expect(switchSkeleton(structuredClone(p), 7)).toBe(false);
  });

  it('names are made unique, a rename too', () => {
    let p = apply(project(), (d) => void addSkeleton(d, blankSkeleton(newSkeletonName(d, 'a'))));
    expect(names(p)).toEqual(['a', 'a2']);
    p = apply(p, (d) => void renameSkeleton(d, 1, 'a'));
    expect(names(p)).toEqual(['a', 'a2']);
    p = apply(p, (d) => void renameSkeleton(d, 1, 'hero'));
    expect(names(p)).toEqual(['a', 'hero']);
  });

  it('the pose library and the mix table travel with their skeleton', () => {
    let p = project();
    p.poses = [{ id: 'p1', name: 'pose a', bones: {} }];
    p.mixes = { default: 0.3, pairs: [] };
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    expect(p.poses).toBeUndefined();
    expect(p.mixes).toBeUndefined();
    expect(skeletonList(p)[0].aside?.mixes?.default).toBe(0.3);
    p = apply(p, (d) => void switchSkeleton(d, 0));
    expect(p.mixes?.default).toBe(0.3);
    expect(p.poses).toHaveLength(1);
    expect(p.skeleton.aside).toBeUndefined();
    expect(skeletonList(p)[1].aside).toBeUndefined();
  });

  it('a copy starts with everything of the original, goes right after it and becomes the edited one', () => {
    let p = project();
    p.skeleton.bones.push(newBone({ name: 'arm', parent: p.skeleton.bones[0].id }));
    p.mixes = { default: 0.2, pairs: [] };
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('z')));
    p = apply(p, (d) => void switchSkeleton(d, 0));
    const copy = copyOfSkeleton(p);
    expect(copy.name).toBe('a2');
    p = apply(p, (d) => void duplicateSkeleton(d, copy));
    expect(names(p)).toEqual(['a', 'a2', 'z']);
    expect(p.skeleton.name).toBe('a2');
    expect(p.skeleton.bones.map((b) => b.name)).toEqual(['root', 'arm']);
    expect(p.mixes?.default).toBe(0.2);
    p = apply(p, (d) => void switchSkeleton(d, 0));
    expect(p.mixes?.default).toBe(0.2); // the original kept its own
  });

  it('delete: never the last one; an edited one hands over to its neighbour; a waiting one just goes', () => {
    let p = project();
    expect(removeSkeleton(structuredClone(p), 0)).toBe(false);
    for (const n of ['b', 'c', 'd']) p = apply(p, (d) => void addSkeleton(d, blankSkeleton(n)));
    p = apply(p, (d) => void switchSkeleton(d, 1)); // b is edited
    p = apply(p, (d) => void removeSkeleton(d, 3)); // d waits
    expect(names(p)).toEqual(['a', 'b', 'c']);
    expect(p.skeleton.name).toBe('b');
    p = apply(p, (d) => void removeSkeleton(d, 0)); // a waits, before the edited one
    expect(names(p)).toEqual(['b', 'c']);
    expect(p.skeleton.name).toBe('b');
    expect(activeIndex(p)).toBe(0);
    p = apply(p, (d) => void removeSkeleton(d, 0)); // the edited one goes: c takes over
    expect(names(p)).toEqual(['c']);
    expect(p.skeleton.name).toBe('c');
    expect(validateProject(p)).toEqual([]);
  });
});

describe('repair and migrate', () => {
  it('a healthy multi-skeleton project is clean', () => {
    let p = project();
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    expect(validateProject(p)).toEqual([]);
  });
  it('a bad table is repaired: position, unreadable skeletons, duplicate names, damage inside another skeleton', () => {
    let p = project();
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    const bad = structuredClone(p);
    bad.activeAt = 9;
    bad.others!.push({ nope: 1 } as never, blankSkeleton('a'));
    bad.others![0].fps = 9999;
    const notes = repairProject(bad);
    expect(notes.join(' | ')).toMatch(/position of the edited skeleton/);
    expect(notes.join(' | ')).toMatch(/could not be read/);
    expect(notes.join(' | ')).toMatch(/skeleton "a": fps was out of range/);
    expect(new Set(names(bad)).size).toBe(names(bad).length);
    expect(skeletonList(bad)).toHaveLength(3);
  });
  it('migrate fills the animation tables of every skeleton', () => {
    let p = project();
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    const old = newAnimation('x');
    delete (old as Partial<typeof old>).transform;
    p.others![0].animations.push(old);
    migrateProject(p);
    expect(p.others![0].animations[0].transform).toEqual({});
  });
});

describe('export of each skeleton', () => {
  it('each skeleton exports on its own and the official runtime reads it', () => {
    let p = project();
    p.skeleton.slots.push(newSlot({ name: 's', bone: p.skeleton.bones[0].id }));
    p = apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
    for (const d of skeletonList(p)) {
      const json = exportSpineJson(d);
      expect(() => loadOfficial(json, '')).not.toThrow();
      expect(exportSpineBinary(d).length).toBeGreaterThan(10);
    }
    expect(exportSpineJson(skeletonList(p)[0]).skeleton).toBeDefined();
  });
});

describe('editor actions', () => {
  beforeEach(() => {
    const p = project();
    docStore.replace(p);
    uiStore.patch({
      mode: 'animate',
      selection: emptySelection,
      animationId: 'stale',
      skinId: null,
      time: 0.4,
      playing: false,
      overrides: {},
      selectedKeys: [],
    });
  });

  it('create, switch, copy, rename and delete are one history step each, and the view starts again', () => {
    createSkeleton();
    expect(names(docStore.get())).toEqual(['a', 'skeleton']);
    expect(uiStore.get().mode).toBe('setup');
    expect(uiStore.get().animationId).toBeNull();
    expect(uiStore.get().time).toBe(0);
    switchToSkeleton(0);
    expect(docStore.get().skeleton.name).toBe('a');
    copySkeleton();
    expect(names(docStore.get())).toEqual(['a', 'a2', 'skeleton']);
    renameSkeletonAt(1, 'copy');
    expect(names(docStore.get())).toEqual(['a', 'copy', 'skeleton']);
    deleteSkeletonAt(2);
    expect(names(docStore.get())).toEqual(['a', 'copy']);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo(); // delete
    docStore.undo(); // rename
    docStore.undo(); // copy
    expect(names(docStore.get())).toEqual(['a', 'skeleton']);
    expect(docStore.get().skeleton.name).toBe('a');
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('the last skeleton cannot be deleted', () => {
    deleteSkeletonAt(0);
    expect(names(docStore.get())).toEqual(['a']);
  });

  it('editing one skeleton leaves the others alone', () => {
    createSkeleton('b');
    docStore.update('bone', (d) => void d.skeleton.bones.push(newBone({ name: 'extra', parent: d.skeleton.bones[0].id })));
    switchToSkeleton(0);
    expect(docStore.get().skeleton.bones.map((b) => b.name)).toEqual(['root']);
    switchToSkeleton(1);
    expect(docStore.get().skeleton.bones.map((b) => b.name)).toEqual(['root', 'extra']);
  });
});

describe('the pictures are shared', () => {
  function withImage(): Project {
    const p = project();
    p.images.push({ id: 'i1', name: 'head', width: 8, height: 8 }, { id: 'i2', name: 'spare', width: 8, height: 8 });
    const slot = newSlot({ name: 's', bone: p.skeleton.bones[0].id });
    p.skeleton.slots.push(slot);
    p.skeleton.skins[0].attachments[slot.id] = {
      head: {
        type: 'region',
        name: 'head',
        path: 'head',
        x: 0,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        width: 8,
        height: 8,
        color: [1, 1, 1, 1],
      },
    };
    return apply(p, (d) => void addSkeleton(d, blankSkeleton('b')));
  }
  it('an image only the other skeleton shows is still in use, and a rename follows it there', async () => {
    const { unusedImages, renameImage } = await import('../src/core/images');
    let p = withImage();
    expect(unusedImages(p)).toEqual(['spare']); // "head" is shown by the skeleton that is waiting
    p = apply(p, (d) => void renameImage(d, 'head', 'face'));
    const waiting = skeletonList(p)[0];
    expect(Object.values(Object.values(waiting.skins[0].attachments)[0])[0]).toMatchObject({ path: 'face' });
    expect(p.images.map((i) => i.name)).toEqual(['face', 'spare']);
  });
});
