/** Skin pins (a pinned skin stays shown when another is chosen) and the options of duplicating a skin. */
import { beforeEach, describe, expect, it } from 'vitest';
import { duplicateSkin } from '../src/core/skins';
import { deleteSkin, duplicateSkinAction, setActiveSkin, toggleSkinPin } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

function open() {
  const { project } = buildFixture();
  const doc = project.skeleton;
  doc.skins.push(
    { id: 'hat', name: 'hat', attachments: {}, bones: [doc.bones[1].id], constraints: [] },
    { id: 'cape', name: 'cape', attachments: {}, bones: [], constraints: [] },
  );
  docStore.replace(project);
  uiStore.patch({ skinId: null, skinMix: [], skinPins: [] });
  return doc;
}

describe('skin pins', () => {
  beforeEach(() => void open());

  it('a pinned skin stays shown when another skin is chosen', () => {
    setActiveSkin('hat');
    toggleSkinPin('hat');
    expect(uiStore.get().skinPins).toEqual(['hat']);
    setActiveSkin('cape');
    expect(uiStore.get().skinId).toBe('cape');
    expect(uiStore.get().skinMix).toEqual(['hat']);
    // choosing the pinned one again makes it the active skin, not a mix member
    setActiveSkin('hat');
    expect(uiStore.get().skinMix).toEqual([]);
    setActiveSkin('cape');
    expect(uiStore.get().skinMix).toEqual(['hat']);
  });

  it('an unpinned skin is replaced as before', () => {
    setActiveSkin('hat');
    setActiveSkin('cape');
    expect(uiStore.get().skinMix).toEqual([]);
  });

  it('pinning a skin that is not the active one shows it at once; the default skin cannot be pinned', () => {
    setActiveSkin('cape');
    toggleSkinPin('hat');
    expect(uiStore.get().skinMix).toEqual(['hat']);
    toggleSkinPin(docStore.get().skeleton.skins[0].id);
    toggleSkinPin('nope');
    expect(uiStore.get().skinPins).toEqual(['hat']);
    toggleSkinPin('hat');
    expect(uiStore.get().skinPins).toEqual([]);
  });

  it('a deleted skin leaves the pins', () => {
    setActiveSkin('cape');
    toggleSkinPin('hat');
    deleteSkin('hat');
    expect(uiStore.get().skinPins).toEqual([]);
    expect(uiStore.get().skinMix).toEqual([]);
  });
});

describe('duplicating a skin with options', () => {
  it('takes a name, and leaves out the scope or the animation keys', () => {
    const doc = open();
    doc.animations.push({ ...doc.animations[0], id: 'a1', name: 'a1', deform: { hat: { s: { att: [{ time: 0, value: [1, 2] }] } } } });
    const full = duplicateSkin(structuredClone(doc), 'hat', { name: 'beret' })!;
    expect(full.name).toBe('beret');
    expect(full.bones).toEqual(doc.skins.find((s) => s.id === 'hat')!.bones);

    const d1 = structuredClone(doc);
    const bare = duplicateSkin(d1, 'hat', { scope: false, animations: false })!;
    expect(bare.name).toBe('hat copy');
    expect(bare.bones).toEqual([]);
    expect(d1.animations.at(-1)!.deform[bare.id]).toBeUndefined();

    const d2 = structuredClone(doc);
    const kept = duplicateSkin(d2, 'hat')!;
    expect(d2.animations.at(-1)!.deform[kept.id]).toEqual(doc.animations.at(-1)!.deform.hat);
  });

  it('keeps a linked mesh on the original skin when asked', () => {
    const doc = open();
    doc.skins.find((s) => s.id === 'hat')!.attachments = {
      slot: { m: { type: 'mesh', name: 'm', link: { skin: 'hat', parent: 'p' } } as never },
    };
    const follow = duplicateSkin(structuredClone(doc), 'hat')!;
    expect((follow.attachments.slot.m as never as { link: { skin: string } }).link.skin).toBe(follow.id);
    const stay = duplicateSkin(structuredClone(doc), 'hat', { relink: false })!;
    expect((stay.attachments.slot.m as never as { link: { skin: string } }).link.skin).toBe('hat');
  });

  it('the action passes the options on, makes the copy active, and is one step', () => {
    open();
    duplicateSkinAction('hat', { name: 'fez', scope: false });
    const copy = docStore.get().skeleton.skins.find((s) => s.name === 'fez')!;
    expect(copy.bones).toEqual([]);
    expect(uiStore.get().skinId).toBe(copy.id);
    expect(docStore.undoLabel).toBe('Duplicate skin');
  });
});
