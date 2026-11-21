/** Merge a skin into another: attachments, scope and animation keys are copied; the source stays. */
import { describe, expect, it } from 'vitest';
import { mergeSkin } from '../src/core/skins';
import type { Attachment, Skin } from '../src/core/model';
import { uid } from '../src/core/ids';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

function setup() {
  const f = buildFixture();
  const doc = f.project.skeleton;
  let slotId = '';
  let att: Attachment | null = null;
  for (const slot of doc.slots) {
    for (const a of Object.values(doc.skins[0].attachments[slot.id] ?? {})) {
      if (a.type === 'region' && !a.sequence && !att) {
        slotId = slot.id;
        att = a;
      }
    }
  }
  if (!att) throw new Error('no region');
  const mk = (name: string): Skin => ({ id: uid(), name, attachments: {}, bones: [], constraints: [] });
  const red = mk('red');
  const blue = mk('blue');
  red.attachments[slotId] = { [att.name]: structuredClone({ ...att, path: 'red/x' }) };
  red.bones.push(doc.bones[1].id);
  blue.attachments[slotId] = { [att.name]: structuredClone({ ...att, path: 'blue/x' }) };
  doc.skins.push(red, blue);
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', selection: emptySelection, skinId: null });
  return { doc, red, blue, slotId, name: att.name };
}

const pathOf = (a: Attachment | undefined) => (a && (a.type === 'region' || a.type === 'mesh') ? a.path : '');

describe('mergeSkin', () => {
  it('copies what the target does not have and leaves what it has', () => {
    const { doc, red, blue, slotId, name } = setup();
    const extra = structuredClone(red.attachments[slotId][name]);
    red.attachments[slotId].extra = { ...extra, name: 'extra' };
    const r = mergeSkin(doc, red.id, blue.id)!;
    expect(r).toEqual({ added: 1, replaced: 0 });
    expect(pathOf(blue.attachments[slotId][name])).toBe('blue/x'); // kept
    expect(blue.attachments[slotId].extra).toBeDefined();
    // the source is untouched and the copy is a copy
    expect(Object.keys(red.attachments[slotId])).toHaveLength(2);
    expect(blue.attachments[slotId].extra).not.toBe(red.attachments[slotId].extra);
  });

  it('replaces them when asked', () => {
    const { doc, red, blue, slotId, name } = setup();
    expect(mergeSkin(doc, red.id, blue.id, { overwrite: true })).toEqual({ added: 0, replaced: 1 });
    expect(pathOf(blue.attachments[slotId][name])).toBe('red/x');
  });

  it('brings the bones and constraints of the skin along, once, unless told not to', () => {
    const { doc, red, blue } = setup();
    mergeSkin(doc, red.id, blue.id, { scope: false });
    expect(blue.bones).toEqual([]);
    mergeSkin(doc, red.id, blue.id);
    mergeSkin(doc, red.id, blue.id);
    expect(blue.bones).toEqual(red.bones);
  });

  it('copies the deform and sequence keys of the attachments that came over, and drops the stale ones of a replaced attachment', () => {
    const { doc, red, blue, slotId, name } = setup();
    const anim = doc.animations[0];
    const keys = { keys: [{ time: 0, value: [1, 2, 3, 4] }] } as never;
    anim.deform[red.id] = { [slotId]: { [name]: keys } };
    anim.deform[blue.id] = { [slotId]: { [name]: { keys: [{ time: 0, value: [9] }] } as never } };
    mergeSkin(doc, red.id, blue.id, { overwrite: true });
    expect(anim.deform[blue.id][slotId][name]).toEqual(keys);
    expect(anim.deform[blue.id][slotId][name]).not.toBe(keys);
    // the target had keys, the source has none: a replaced attachment does not keep the old keys
    delete anim.deform[red.id];
    mergeSkin(doc, red.id, blue.id, { overwrite: true });
    expect(anim.deform[blue.id][slotId][name]).toBeUndefined();
  });

  it('is refused for the same skin or a missing one', () => {
    const { doc, red } = setup();
    expect(mergeSkin(doc, red.id, red.id)).toBeNull();
    expect(mergeSkin(doc, red.id, 'nope')).toBeNull();
    expect(mergeSkin(doc, 'nope', red.id)).toBeNull();
  });

  it('merges into the default skin without a scope', () => {
    const { doc, red, slotId, name } = setup();
    red.attachments[slotId].other = { ...structuredClone(red.attachments[slotId][name]), name: 'other' };
    const r = mergeSkin(doc, red.id, doc.skins[0].id)!;
    expect(r.added).toBe(1);
    expect(doc.skins[0].bones).toEqual([]);
  });
});

describe('the action', () => {
  it('is one step of the history', () => {
    const { red, blue, slotId, name } = setup();
    const r = A.mergeSkinAction(red.id, blue.id, { overwrite: true });
    expect(r).toEqual({ added: 0, replaced: 1 });
    const now = docStore.get().skeleton.skins.find((s) => s.id === blue.id)!;
    expect(pathOf(now.attachments[slotId][name])).toBe('red/x');
    docStore.undo();
    const back = docStore.get().skeleton.skins.find((s) => s.id === blue.id)!;
    expect(pathOf(back.attachments[slotId][name])).toBe('blue/x');
    expect(A.mergeSkinAction(red.id, red.id)).toBeNull();
  });
});
