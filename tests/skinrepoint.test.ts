/** Duplicate skin with pictures of its own: the copy points at other pictures where they exist. */
import { beforeEach, describe, expect, it } from 'vitest';
import { duplicateSkin, repointSkinPictures } from '../src/core/skins';
import type { Attachment, ImageRef } from '../src/core/model';
import { uid } from '../src/core/ids';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

function setup() {
  const f = buildFixture();
  const doc = f.project.skeleton;
  // a skin that overrides the picture of the first region or mesh it can find
  const skin = { id: uid(), name: 'red', attachments: {} as Record<string, Record<string, Attachment>>, bones: [], constraints: [] };
  doc.skins.push(skin);
  let slotId = '';
  let att: Attachment | null = null;
  for (const slot of doc.slots) {
    for (const a of Object.values(doc.skins[0].attachments[slot.id] ?? {})) {
      if ((a.type === 'region' || a.type === 'mesh') && !a.sequence && !att) {
        slotId = slot.id;
        att = a;
      }
    }
  }
  if (!att || (att.type !== 'region' && att.type !== 'mesh')) throw new Error('no picture');
  skin.attachments[slotId] = { [att.name]: structuredClone({ ...att, path: `red/${att.path}` }) };
  const have = new Map<string, ImageRef>(f.project.images.map((i) => [i.name, i]));
  f.project.images.push({ id: uid(), name: `blue/${att.path}`, width: 8, height: 8 });
  f.project.images.push({ id: uid(), name: `red/${att.path}`, width: 8, height: 8 });
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', selection: emptySelection, skinId: null });
  return { f, skin, slotId, name: att.name, base: att.path, have };
}

describe('repointSkinPictures', () => {
  it('swaps a part of the picture names where the new name is a picture that exists', () => {
    const { f, skin, slotId, name, base } = setup();
    const have = new Set(f.project.images.map((i) => i.name));
    const n = repointSkinPictures(f.project.skeleton, skin.id, 'red/', 'blue/', have);
    expect(n).toBe(1);
    const a = skin.attachments[slotId][name];
    expect(a.type === 'region' || a.type === 'mesh' ? a.path : '').toBe(`blue/${base}`);
  });

  it('leaves an attachment alone when the picture it would point at does not exist', () => {
    const { f, skin, slotId, name, base } = setup();
    const have = new Set(f.project.images.map((i) => i.name));
    expect(repointSkinPictures(f.project.skeleton, skin.id, 'red/', 'green/', have)).toBe(0);
    const a = skin.attachments[slotId][name];
    expect(a.type === 'region' || a.type === 'mesh' ? a.path : '').toBe(`red/${base}`);
  });

  it('ignores an empty search, an unknown skin and a name that does not contain the text', () => {
    const { f, skin } = setup();
    const have = new Set(f.project.images.map((i) => i.name));
    expect(repointSkinPictures(f.project.skeleton, skin.id, '', 'x', have)).toBe(0);
    expect(repointSkinPictures(f.project.skeleton, 'nope', 'red/', 'blue/', have)).toBe(0);
    expect(repointSkinPictures(f.project.skeleton, skin.id, 'yellow', 'blue', have)).toBe(0);
  });
});

describe('the action', () => {
  beforeEach(() => void 0);
  it('duplicates the skin and points the copy at the other pictures in one step', () => {
    const { skin, slotId, name, base } = setup();
    A.duplicateSkinAction(skin.id, { name: 'blue' }, { find: 'red/', replace: 'blue/' });
    const doc = docStore.get().skeleton;
    const copy = doc.skins.find((s) => s.name === 'blue')!;
    expect(copy).toBeDefined();
    const a = copy.attachments[slotId][name];
    expect(a.type === 'region' || a.type === 'mesh' ? a.path : '').toBe(`blue/${base}`);
    // the original is untouched
    const o = doc.skins.find((s) => s.name === 'red')!.attachments[slotId][name];
    expect(o.type === 'region' || o.type === 'mesh' ? o.path : '').toBe(`red/${base}`);
    docStore.undo();
    expect(docStore.get().skeleton.skins.some((s) => s.name === 'blue')).toBe(false);
  });

  it('duplicateSkin itself does not change pictures', () => {
    const { f, skin, slotId, name, base } = setup();
    const copy = duplicateSkin(f.project.skeleton, skin.id, { name: 'plain' })!;
    const a = copy.attachments[slotId][name];
    expect(a.type === 'region' || a.type === 'mesh' ? a.path : '').toBe(`red/${base}`);
  });
});
