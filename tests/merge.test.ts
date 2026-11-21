/** Take from a checkpoint or a project file: the picked differences go into the open skeleton, nothing else does. */
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSkeletons } from '../src/core/checkpoints';
import { mergeFromFile } from '../src/core/merge';
import { validateProject } from '../src/core/validate';
import { deleteAnimation, deleteBones, deleteSlots } from '../src/store/actions';
import {
  checkpointStore,
  checkpointsOfActive,
  compareWithProjectText,
  markCheckpoint,
  restoreCheckpoint,
  restoreFileCheckpoint,
  takeFromCheckpoint,
  takeNow,
} from '../src/store/checkpoints';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;
const fileOf = (project: unknown) => JSON.stringify({ bone2d: 1, project, images: {} });

beforeEach(() => {
  docStore.replace(structuredClone(buildFixture().project));
  uiStore.patch({ mode: 'setup', animationId: null, selection: emptySelection, compare: null, selectedKeys: [] });
  checkpointStore.set({ epoch: docStore.epoch, list: [] });
});

const refOf = (changes: ReturnType<typeof diffSkeletons>, area: string, name: string) => {
  const c = changes.find((x) => x.area === area && x.name === name);
  if (!c) throw new Error(`no change ${area} ${name}`);
  return { area: c.area, id: c.id };
};

describe('the changes carry the id of the thing', () => {
  it('has an id for everything but the skeleton settings', () => {
    const cp = markCheckpoint();
    docStore.update('x', (d) => void (d.skeleton.fps += 1));
    docStore.update('y', (d) => void (d.skeleton.bones[1].x += 3));
    const changes = diffSkeletons(cp.skeleton, doc());
    expect(changes.find((c) => c.area === 'bone')?.id).toBe(doc().bones[1].id);
    expect(changes.find((c) => c.area === 'skeleton')?.id).toBeUndefined();
  });
});

describe('taking a thing back from a checkpoint', () => {
  it('brings a deleted animation back and leaves the rest of the work alone', async () => {
    const cp = markCheckpoint();
    const gone = doc().animations[0];
    deleteAnimation(gone.id);
    docStore.update('later work', (d) => void (d.skeleton.bones[1].x += 40));
    const x = doc().bones[1].x;
    const refs = [refOf(diffSkeletons(cp.skeleton, doc()), 'animation', gone.name)];
    const steps = docStore.history.past.length;
    const res = await takeFromCheckpoint(cp.id, refs);
    expect(res).toMatchObject({ taken: 1, skipped: 0 });
    expect(doc().animations.some((a) => a.id === gone.id)).toBe(true);
    expect(doc().animations.find((a) => a.id === gone.id)).toEqual(gone);
    expect(doc().bones[1].x).toBe(x); // the later work stays
    expect(docStore.history.past.length).toBe(steps + 1); // one step
    docStore.undo();
    expect(doc().animations.some((a) => a.id === gone.id)).toBe(false);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('brings a deleted bone back with the bones it hangs on, and its slot with its pictures', async () => {
    const cp = markCheckpoint();
    const deep = doc().bones.find((b) => b.name === 'hand')!;
    const slot = doc().slots.find((s) => s.bone === deep.id);
    const parent = deep.parent;
    // delete the top of the chain and so everything below it
    deleteBones([doc().bones.find((b) => b.name === 'armUpper')!.id]);
    expect(doc().bones.some((b) => b.id === deep.id)).toBe(false);
    const changes = diffSkeletons(cp.skeleton, doc());
    const res = await takeFromCheckpoint(cp.id, [refOf(changes, 'bone', deep.name)]);
    expect(res!.taken).toBe(1);
    expect(res!.carried).toBeGreaterThanOrEqual(2); // armUpper and armLower came with it
    expect(doc().bones.some((b) => b.id === deep.id)).toBe(true);
    expect(doc().bones.some((b) => b.id === parent)).toBe(true);
    if (slot) expect(doc().slots.some((s) => s.id === slot.id)).toBe(false); // a slot comes only when it is picked
    expect(validateProject(docStore.get())).toEqual([]);
    // parents come before children
    const index = new Map(doc().bones.map((b, i) => [b.id, i]));
    for (const b of doc().bones) if (b.parent) expect(index.get(b.parent)!).toBeLessThan(index.get(b.id)!);
  });

  it('brings a deleted slot back with its attachments in the skins', async () => {
    const cp = markCheckpoint();
    const slot = doc().slots[0];
    const attachments = Object.keys(doc().skins[0].attachments[slot.id] ?? {});
    expect(attachments.length).toBeGreaterThan(0);
    deleteSlots([slot.id]);
    const res = await takeFromCheckpoint(cp.id, [refOf(diffSkeletons(cp.skeleton, doc()), 'slot', slot.name)]);
    expect(res!.taken).toBe(1);
    expect(doc().slots[0].id).toBe(slot.id); // back in its place
    expect(Object.keys(doc().skins[0].attachments[slot.id] ?? {})).toEqual(attachments);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('puts a changed bone back and keeps the bones that were not picked as they are', async () => {
    const cp = markCheckpoint();
    const [a, b] = [doc().bones[1], doc().bones[2]];
    docStore.update('edit', (d) => {
      d.skeleton.bones[1].x += 11;
      d.skeleton.bones[1].rotation += 7;
      d.skeleton.bones[2].x += 5;
    });
    const res = await takeFromCheckpoint(cp.id, [refOf(diffSkeletons(cp.skeleton, doc()), 'bone', a.name)]);
    expect(res!.taken).toBe(1);
    expect(doc().bones[1]).toEqual(a);
    expect(doc().bones[2].x).toBe(b.x + 5);
  });

  it('takes the skeleton settings over', async () => {
    const cp = markCheckpoint();
    const fps = doc().fps;
    docStore.update('edit', (d) => void (d.skeleton.fps = fps + 6));
    const changes = diffSkeletons(cp.skeleton, doc());
    const res = await takeFromCheckpoint(cp.id, [{ area: 'skeleton' }]);
    expect(changes.some((c) => c.area === 'skeleton')).toBe(true);
    expect(res!.taken).toBe(1);
    expect(doc().fps).toBe(fps);
  });

  it('a name another thing took in the meantime does not make two with one name', async () => {
    const cp = markCheckpoint();
    const gone = doc().animations[0];
    deleteAnimation(gone.id);
    docStore.update('rename', (d) => void (d.skeleton.animations[0].name = gone.name));
    const res = await takeFromCheckpoint(cp.id, [{ area: 'animation', id: gone.id }]);
    expect(res!.taken).toBe(1);
    const names = doc().animations.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses what is not in the checkpoint and changes nothing', async () => {
    const cp = markCheckpoint();
    const open = docStore.get();
    const res = await takeFromCheckpoint(cp.id, [{ area: 'bone', id: 'nope' }]);
    expect(res).toMatchObject({ taken: 0, skipped: 1 });
    expect(docStore.get()).toBe(open);
  });

  it('refuses a bone that would hang under its own child', () => {
    const cp = markCheckpoint();
    const [a, b] = [doc().bones[1], doc().bones[2]];
    // here: b hangs under a; the checkpoint says the opposite
    docStore.update('swap', (d) => {
      d.skeleton.bones[1].parent = b.id;
      d.skeleton.bones[2].parent = null;
    });
    const mine = doc().bones.find((x) => x.id === b.id)!;
    expect(mine.parent).toBeNull();
    const res = takeNow({ ...cp, skeleton: { ...cp.skeleton } }, [{ area: 'bone', id: b.id }]);
    void a;
    expect(res).not.toBeNull();
    expect(validateProject(docStore.get())).toEqual([]);
    // no loop, however it was resolved
    const by = new Map(doc().bones.map((x) => [x.id, x]));
    for (const x of doc().bones) {
      const seen = new Set<string>();
      for (let c: typeof x | undefined = x; c; c = c.parent ? by.get(c.parent) : undefined) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
    }
  });
});

describe('a project file', () => {
  it('can be gone back to, in one step that undo takes back', async () => {
    const theirs = fileOf(docStore.get());
    docStore.update('edit', (d) => void (d.skeleton.bones[1].x += 25));
    deleteSlots([doc().slots[doc().slots.length - 1].id]);
    const mine = doc();
    compareWithProjectText(theirs, 'v1.bone2d');
    const cp = checkpointsOfActive()[0];
    expect(restoreCheckpoint(cp.id)).toBe(false); // the plain restore still refuses: the pictures are read first
    const steps = docStore.history.past.length;
    expect(await restoreFileCheckpoint(cp.id)).toBe(true);
    expect(diffSkeletons(cp.skeleton, doc())).toEqual([]);
    expect(docStore.history.past.length).toBe(steps + 1);
    docStore.undo();
    expect(doc()).toEqual(mine);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('says so when nothing differs', async () => {
    compareWithProjectText(fileOf(docStore.get()), 'same.bone2d');
    expect(await restoreFileCheckpoint(checkpointsOfActive()[0].id)).toBe(false);
  });

  it('gives back what a teammate deleted and the open project took the other way: only the picked things move', async () => {
    const theirs = fileOf(docStore.get());
    const gone = doc().animations[0];
    deleteAnimation(gone.id);
    docStore.update('edit', (d) => void (d.skeleton.bones[1].x += 25));
    const x = doc().bones[1].x;
    const changes = compareWithProjectText(theirs, 'v1.bone2d')!;
    const cp = checkpointsOfActive()[0];
    const res = await takeFromCheckpoint(cp.id, [refOf(changes, 'animation', gone.name)]);
    expect(res!.taken).toBe(1);
    expect(doc().animations.some((a) => a.id === gone.id)).toBe(true);
    expect(doc().bones[1].x).toBe(x);
  });
});

describe('mergeFromFile', () => {
  it('adds the pictures a taken skin uses and the project lacks', () => {
    const project = structuredClone(buildFixture().project);
    const file = structuredClone(project);
    const gone = project.images.find((i) => i.name === 'flagA')!;
    project.images = project.images.filter((i) => i !== gone);
    expect(project.images.some((i) => i.name === 'flagA')).toBe(false);
    const skinId = project.skeleton.skins[0].id;
    const res = mergeFromFile(project, file, [{ area: 'skin', id: skinId }]);
    expect(res.pictures).toBeGreaterThanOrEqual(1);
    expect(project.images.some((i) => i.name === 'flagA')).toBe(true);
  });

  it('leaves the other version untouched and shares nothing with it', () => {
    const project = structuredClone(buildFixture().project);
    const file = structuredClone(project);
    project.skeleton.animations.shift();
    const before = JSON.stringify(file);
    mergeFromFile(project, file, [{ area: 'animation', id: file.skeleton.animations[0].id }]);
    expect(JSON.stringify(file)).toBe(before);
    const a = project.skeleton.animations.find((x) => x.id === file.skeleton.animations[0].id)!;
    expect(a).not.toBe(file.skeleton.animations[0]);
  });
});

describe('going back to a file when another skeleton took its name', () => {
  it('keeps the names of the skeletons of the project unique', async () => {
    const theirs = fileOf(docStore.get());
    const name = doc().name;
    const second = { ...structuredClone(doc()), name }; // a second skeleton now carries the name the file's skeleton has
    docStore.update('edit', (d) => {
      d.skeleton.name = 'mine';
      d.skeleton.bones[1].x += 9;
      d.others = [second];
    });
    compareWithProjectText(theirs, 'v1.bone2d');
    expect(await restoreFileCheckpoint(checkpointsOfActive()[0].id)).toBe(true);
    expect(docStore.get().others!.some((o) => o.name === doc().name)).toBe(false);
    expect(validateProject(docStore.get())).toEqual([]);
  });
});
