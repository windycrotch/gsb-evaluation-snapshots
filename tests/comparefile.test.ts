/** Compare with a project file: another version of the project becomes a checkpoint, and the changes are listed. */
import { describe, expect, it } from 'vitest';
import { MAX_CHECKPOINTS, changesToText } from '../src/core/checkpoints';
import { checkpointStore, checkpointsOfActive, compareWithProjectText, restoreCheckpoint } from '../src/store/checkpoints';
import { docStore } from '../src/store/doc';
import { readProjectFile } from '../src/store/project';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

/** A project file as the editor writes it (no pictures). */
const fileOf = (project: unknown) => JSON.stringify({ bone2d: 1, project, images: {} });

function session() {
  const base = buildFixture().project;
  const theirs = fileOf(base); // the other version: the file as it was
  const mine = structuredClone(base); // ours: the same ids, then edited
  docStore.replace(mine);
  uiStore.patch({ mode: 'setup', selection: emptySelection, compare: null });
  checkpointStore.set({ epoch: docStore.epoch, list: [] });
  return { base, theirs, mine };
}

describe('readProjectFile', () => {
  it('reads a project file without touching the open project', () => {
    const { theirs } = session();
    const open = docStore.get();
    const p = readProjectFile(theirs);
    expect(p?.skeleton.bones.length).toBeGreaterThan(1);
    expect(docStore.get()).toBe(open);
  });

  it('is null for anything that is not a project file', () => {
    for (const t of [
      '',
      'nope',
      '[]',
      '{}',
      '{"bone2d":2}',
      '{"bone2d":1}',
      '{"bone2d":1,"project":{}}',
      '{"bone2d":1,"project":{"skeleton":5}}',
      'null',
    ])
      expect(readProjectFile(t)).toBeNull();
  });
});

describe('compareWithProjectText', () => {
  it('lists what differs from the other version, matched by id, and shows it under the pose', () => {
    const { theirs } = session();
    docStore.update('edit', (d) => {
      d.skeleton.bones[1].x += 25; // a bone moved
      d.skeleton.slots.pop(); // a slot is gone
      d.skeleton.animations[0].name = 'renamed'; // an animation renamed
    });
    const changes = compareWithProjectText(theirs, 'v1.bone2d')!;
    expect(changes.some((c) => c.area === 'bone' && c.kind === 'changed' && c.fields?.includes('position'))).toBe(true);
    // the slot that was there in their version and is not in ours: "removed" (the change is from their version to ours)
    expect(changes.some((c) => c.area === 'slot' && c.kind === 'removed')).toBe(true);
    expect(changes.some((c) => c.area === 'animation' && c.kind === 'changed' && c.fields?.includes('name'))).toBe(true);
    const mine = checkpointsOfActive();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'v1.bone2d', fromFile: 'v1.bone2d' });
    expect(uiStore.get().compare).toBe(mine[0].id);
  });

  it('finds nothing to list for a copy of the same project', () => {
    const { theirs } = session();
    expect(compareWithProjectText(theirs, 'same.bone2d')).toEqual([]);
  });

  it('refuses text that is not a project file and changes nothing', () => {
    session();
    expect(compareWithProjectText('{"x":1}', 'junk.json')).toBeNull();
    expect(checkpointsOfActive()).toHaveLength(0);
  });

  it('the checkpoint of a file cannot be restored; the project stays as it is', () => {
    const { theirs } = session();
    docStore.update('edit', (d) => void (d.skeleton.bones[1].x += 5));
    compareWithProjectText(theirs, 'v1.bone2d');
    const open = docStore.get();
    expect(restoreCheckpoint(checkpointsOfActive()[0].id)).toBe(false);
    expect(docStore.get()).toBe(open);
  });

  it('keeps no more than the limit of checkpoints, the oldest go', () => {
    const { theirs } = session();
    for (let i = 0; i < MAX_CHECKPOINTS + 3; i++) compareWithProjectText(theirs, `v${i}.bone2d`);
    const list = checkpointsOfActive();
    expect(list).toHaveLength(MAX_CHECKPOINTS);
    expect(list[0].name).toBe('v3.bone2d');
  });
});

describe('changesToText', () => {
  it('writes one line per change with the sign, the kind of thing, its name and what differs', () => {
    const text = changesToText([
      { area: 'bone', kind: 'added', name: 'arm' },
      { area: 'slot', kind: 'removed', name: 'hat' },
      { area: 'bone', kind: 'changed', name: 'leg', fields: ['position', 'rotation'] },
      { area: 'animation', kind: 'changed', name: 'walk', keys: { added: 2, removed: 0, changed: 10 } },
    ]);
    expect(text.split('\n')).toEqual([
      '+ Bone arm',
      '- Slot hat',
      '~ Bone leg (position, rotation)',
      '~ Animation walk 12 keys: +2 -0 ~10',
    ]);
    expect(changesToText([])).toBe('');
  });
});
