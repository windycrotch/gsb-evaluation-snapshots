/** Skins shown together: the composed skin matches the official runtime's Skin.addSkin (attachments, active bones), and the editor toggles. */
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';
import { meshFromRegion } from '../src/core/mesh';
import * as M from '../src/store/meshActions';
import { emptyProject, newAnimation, newBone, newSkin, newSlot } from '../src/core/model';
import type { Project, RegionAttachment } from '../src/core/model';
import { compileSkeleton, composeSkins, createSkeleton } from '../src/core/skeleton';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { exportAndLoad } from './official';

const S = spine as any;

const region = (name: string, path: string): RegionAttachment => ({
  type: 'region',
  name,
  path,
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  width: 20,
  height: 20,
  color: [1, 1, 1, 1],
});

function rig() {
  const project: Project = emptyProject('mix');
  const doc = project.skeleton;
  const root = doc.bones[0];
  const hat = newBone({ name: 'hat', parent: root.id, length: 10, skinRequired: true });
  const cape = newBone({ name: 'cape', parent: root.id, length: 10, skinRequired: true });
  doc.bones.push(hat, cape);
  const body = newSlot({ name: 'body', bone: root.id, attachment: 'shirt' });
  const head = newSlot({ name: 'head', bone: hat.id, attachment: 'cap' });
  doc.slots.push(body, head);
  for (const n of ['plain', 'red', 'blue', 'cap_a', 'cap_b']) project.images.push({ id: n, name: n, width: 20, height: 20 });
  doc.skins[0].attachments = { [body.id]: { shirt: region('shirt', 'plain') }, [head.id]: { cap: region('cap', 'plain') } };
  const red = newSkin('red');
  red.attachments = { [body.id]: { shirt: region('shirt', 'red') }, [head.id]: { cap: region('cap', 'cap_a') } };
  red.bones = [hat.id];
  const blue = newSkin('blue');
  blue.attachments = { [body.id]: { shirt: region('shirt', 'blue') } };
  blue.bones = [cape.id];
  doc.skins.push(red, blue);
  return { project, doc, red, blue, body, head, hat, cape };
}

describe('composeSkins', () => {
  it('a later skin replaces the earlier one, bones of both are active (the official Skin.addSkin does the same)', () => {
    const { project, doc, red, blue, body, head, hat, cape } = rig();
    const data = compileSkeleton(doc);
    const mixed = createSkeleton(data, red.id, [blue.id]);
    const pathOf = (sk: typeof mixed, slot: typeof body) => (sk.slotAttachment(sk.slotById(slot.id)!) as any).path;
    expect(pathOf(mixed, body)).toBe('blue'); // blue is later
    expect(pathOf(mixed, head)).toBe('cap_a'); // blue has no cap, red's stays
    expect(mixed.boneById(hat.id)!.active).toBe(true);
    expect(mixed.boneById(cape.id)!.active).toBe(true);

    const { skeletonData } = exportAndLoad(project);
    const official = new S.Skeleton(skeletonData);
    const skin = new S.Skin('mix');
    skin.addSkin(skeletonData.findSkin('red'));
    skin.addSkin(skeletonData.findSkin('blue'));
    official.setSkin(skin);
    official.setupPose();
    official.updateWorldTransform(S.Physics.update);
    for (const slot of [body, head]) {
      const o = official.slots.find((s: any) => s.data.name === doc.slots.find((x) => x.id === slot.id)!.name);
      const att =
        skin.getAttachment(o.data.index, o.data.attachmentName) ??
        skeletonData.defaultSkin.getAttachment(o.data.index, o.data.attachmentName);
      expect(att.path).toBe(pathOf(mixed, slot));
    }
    for (const b of [hat, cape]) {
      const name = doc.bones.find((x) => x.id === b.id)!.name;
      expect(official.bones.find((x: any) => x.data.name === name).isActive()).toBe(true);
    }
  });

  it('order matters: the later skin wins', () => {
    const { doc, red, blue, body } = rig();
    const data = compileSkeleton(doc);
    const a = createSkeleton(data, blue.id, [red.id]);
    expect((a.slotAttachment(a.slotById(body.id)!) as any).path).toBe('red');
  });

  it('skips the default skin, unknown ids and repeats; one skin left is that skin, none is null', () => {
    const { doc, red, blue } = rig();
    const data = compileSkeleton(doc);
    expect(composeSkins(data, [])).toBeNull();
    expect(composeSkins(data, [doc.skins[0].id, 'nope'])).toBeNull();
    expect(composeSkins(data, [red.id, red.id, 'nope'])).toBe(data.skinById.get(red.id));
    expect(composeSkins(data, [red.id, blue.id])!.name).toBe('red + blue');
  });

  it('with the default skin active the mix still applies, and bones of an unmixed skin stay off', () => {
    const { doc, red, blue, hat, cape } = rig();
    const data = compileSkeleton(doc);
    const only = createSkeleton(data, null, [red.id]);
    expect(only.boneById(hat.id)!.active).toBe(true);
    expect(only.boneById(cape.id)!.active).toBe(false);
    const both = createSkeleton(data, null, [red.id, blue.id]);
    expect(both.boneById(cape.id)!.active).toBe(true);
  });
});

describe('skin mix in the editor', () => {
  function load() {
    const r = rig();
    docStore.replace({ ...docStore.get(), skeleton: r.doc, images: r.project.images });
    uiStore.patch({ skinId: null, skinMix: [] });
    return r;
  }

  it('toggles a skin in and out; the default and the active skin cannot join', () => {
    const { doc, red, blue } = load();
    A.toggleSkinMix(doc.skins[0].id);
    expect(uiStore.get().skinMix).toEqual([]);
    A.setActiveSkin(red.id);
    A.toggleSkinMix(red.id);
    expect(uiStore.get().skinMix).toEqual([]);
    A.toggleSkinMix(blue.id);
    expect(uiStore.get().skinMix).toEqual([blue.id]);
    A.toggleSkinMix(blue.id);
    expect(uiStore.get().skinMix).toEqual([]);
  });

  it('choosing a mixed skin as the active one takes it out of the mix; deleting a skin drops it', () => {
    const { red, blue } = load();
    A.toggleSkinMix(red.id);
    A.toggleSkinMix(blue.id);
    A.setActiveSkin(red.id);
    expect(uiStore.get().skinMix).toEqual([blue.id]);
    A.deleteSkin(blue.id);
    expect(uiStore.get().skinMix).toEqual([]);
  });
});

describe('deforming a mesh that only a worn skin has', () => {
  it('the key goes to the skin the mesh comes from (not the default skin, which has no such mesh)', () => {
    const r = rig();
    const mesh = { ...meshFromRegion(region('extra', 'red')), name: 'extra', path: 'red' };
    r.red.attachments[r.body.id] = { ...r.red.attachments[r.body.id], extra: mesh };
    r.doc.slots.find((s) => s.id === r.body.id)!.attachment = 'extra';
    const anim = newAnimation('wave', 1);
    r.doc.animations.push(anim);
    docStore.replace({ ...docStore.get(), skeleton: r.doc, images: r.project.images });
    uiStore.patch({ mode: 'animate', animationId: anim.id, time: 0.5, skinId: null, skinMix: [r.red.id] });
    const base = M.currentDeform(r.body.id)!;
    expect(base).not.toBeNull();
    M.setDeformKey(r.body.id, 'extra', base, [{ index: 0, dx: 5, dy: 3 }]);
    const deform = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.deform;
    expect(Object.keys(deform)).toEqual([r.red.id]);
    expect(deform[r.red.id][r.body.id].extra).toHaveLength(1);
    uiStore.patch({ mode: 'setup', skinMix: [] });
  });
});
