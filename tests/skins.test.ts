/** Skin operations of the Skins window: copy a skin, scope (skin required bones / constraints), own copies of attachments. */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { duplicateSkin, overrideCount, overrideState, setSkinRequired, setSkinScope, toggleOverride } from '../src/core/skins';
import { validateProject } from '../src/core/validate';
import { uid } from '../src/core/ids';
import type { ImageRef, Project } from '../src/core/model';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';
import { S, exportAndLoad } from './official';

function rig(): Project {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}

const bone = (p: Project, name: string) => p.skeleton.bones.find((b) => b.name === name)!;

describe('skin copy', () => {
  it('copies attachments, scope and deform, and never the default skin', () => {
    const p = rig();
    const doc = p.skeleton;
    const arctic = doc.skins[1];
    expect(duplicateSkin(doc, doc.skins[0].id)).toBeNull();
    const tail = bone(p, doc.bones.find((b) => b.name.startsWith('tail'))!.name);
    setSkinRequired(doc, 'bone', tail.id, true);
    setSkinScope(doc, arctic.id, 'bone', tail.id, true);
    const copy = duplicateSkin(doc, arctic.id)!;
    expect(doc.skins.map((s) => s.name)).toEqual(['default', 'arctic', 'arctic copy']);
    expect(copy.id).not.toBe(arctic.id);
    expect(copy.attachments).toEqual(arctic.attachments);
    expect(copy.attachments).not.toBe(arctic.attachments);
    const slotId = Object.keys(arctic.attachments)[0];
    const name = Object.keys(arctic.attachments[slotId])[0];
    expect(copy.attachments[slotId][name]).not.toBe(arctic.attachments[slotId][name]);
    expect(copy.bones).toEqual([tail.id]);
    expect(validateProject(p)).toEqual([]);
  });
});

describe('skin scope', () => {
  it('only a skin-required item can be in a scope, and lifting the requirement removes it from every skin', () => {
    const p = rig();
    const doc = p.skeleton;
    const arctic = doc.skins[1];
    const tail = doc.bones[doc.bones.length - 1];
    setSkinScope(doc, arctic.id, 'bone', tail.id, true);
    expect(arctic.bones).toEqual([]);
    setSkinRequired(doc, 'bone', tail.id, true);
    setSkinScope(doc, arctic.id, 'bone', tail.id, true);
    setSkinScope(doc, arctic.id, 'bone', tail.id, true);
    expect(arctic.bones).toEqual([tail.id]);
    setSkinScope(doc, doc.skins[0].id, 'bone', tail.id, true);
    expect(doc.skins[0].bones).toEqual([]);
    setSkinRequired(doc, 'bone', tail.id, false);
    expect(arctic.bones).toEqual([]);
    const ik = doc.constraints.find((c) => c.type === 'ik')!;
    setSkinRequired(doc, 'constraint', ik.id, true);
    setSkinScope(doc, arctic.id, 'constraint', ik.id, true);
    expect(arctic.constraints).toEqual([ik.id]);
    expect(validateProject(p)).toEqual([]);
  });

  it('a required bone and constraint are active only in the skins that list them, in our runtime and in the official one', () => {
    const p = rig();
    const doc = p.skeleton;
    const arctic = doc.skins[1];
    const ik = doc.constraints.find((c) => c.type === 'ik')!;
    const ear = doc.bones.find((b) => b.name.toLowerCase().includes('ear'))!;
    setSkinRequired(doc, 'bone', ear.id, true);
    setSkinRequired(doc, 'constraint', ik.id, true);
    setSkinScope(doc, arctic.id, 'bone', ear.id, true);
    setSkinScope(doc, arctic.id, 'constraint', ik.id, true);

    const data = compileSkeleton(structuredClone(doc));
    const idx = data.bones.findIndex((b) => b.id === ear.id);
    const cidx = data.constraints.findIndex((c) => c.id === ik.id);
    const def = createSkeleton(data, null);
    expect(def.bones[idx].active).toBe(false);
    expect(def.constraints[cidx].active).toBe(false);
    const arc = createSkeleton(data, arctic.id);
    expect(arc.bones[idx].active).toBe(true);
    expect(arc.constraints[cidx].active).toBe(true);
    // both skins still pose without trouble
    for (const s of [def, arc]) {
      applyAnimation(s, doc.animations[0], 0.3);
      s.updateWorldTransform();
      for (const b of s.bones) expect(Number.isFinite(b.worldX) && Number.isFinite(b.worldY)).toBe(true);
    }

    const { skeletonData } = exportAndLoad(p);
    const official = skeletonData.skins.find((s: { name: string }) => s.name === 'arctic');
    expect(official.bones.map((b: { name: string }) => b.name)).toContain(ear.name);
    expect(official.constraints.map((c: { name: string }) => c.name)).toContain(ik.name);
    const officialDefault = skeletonData.defaultSkin;
    expect(officialDefault.bones.map((b: { name: string }) => b.name)).not.toContain(ear.name);
    const officialBone = skeletonData.bones.find((b: { name: string }) => b.name === ear.name);
    expect(officialBone.skinRequired).toBe(true);
    expect(S).toBeTruthy();
  });
});

describe('what a skin does not activate', () => {
  it('children of a required bone are required, with the same answer as the official runtime (no NaN below an inactive bone)', () => {
    const p = rig();
    const doc = p.skeleton;
    const hip = doc.bones.find((b) => b.name === 'hip')!;
    const below = doc.bones.filter((b) => b.parent === hip.id);
    expect(below.length).toBeGreaterThan(0);
    setSkinRequired(doc, 'bone', hip.id, true);
    // the flag moves down the whole subtree, and freeing a child frees the bones above it
    const kid = below[0];
    expect(kid.skinRequired).toBe(true);
    setSkinRequired(doc, 'bone', kid.id, false);
    expect(hip.skinRequired).toBe(false);
    // a child that is not flagged under a flagged parent is still required when compiled and exported
    hip.skinRequired = true;
    kid.skinRequired = false;
    const data = compileSkeleton(structuredClone(doc));
    expect(data.bones.find((b) => b.id === kid.id)!.skinRequired).toBe(true);
    const { skeletonData, json } = exportAndLoad(p);
    expect((json as { bones: { name: string; skin?: boolean }[] }).bones.find((b) => b.name === kid.name)!.skin).toBe(true);
    const sk = new S.Skeleton(skeletonData);
    sk.setupPose();
    sk.updateWorldTransform(S.Physics.update);
    for (const b of sk.bones) expect(Number.isNaN(b.appliedPose.a)).toBe(false);
  });

  it('slots, constraints and deforms of an inactive bone are not animated', () => {
    const p = rig();
    const doc = p.skeleton;
    const anim = doc.animations.find((a) => Object.values(a.slots).some((t) => t.attachment?.length))!;
    expect(anim).toBeTruthy();
    const slotId = Object.keys(anim.slots).find((id) => anim.slots[id].attachment?.length)!;
    const slot = doc.slots.find((s) => s.id === slotId)!;
    const bone = doc.bones.find((b) => b.id === slot.bone)!;
    setSkinRequired(doc, 'bone', bone.id, true);
    const data = compileSkeleton(structuredClone(doc));
    const sk = createSkeleton(data, null);
    const before = sk.slotById(slotId)!.attachmentName;
    applyAnimation(sk, anim, 0.4);
    expect(sk.bones[data.boneIndex.get(bone.id)!].active).toBe(false);
    expect(sk.slotById(slotId)!.attachmentName).toBe(before);
    // control: with the bone always active the same animation does move the slot over the whole length
    const free = rig().skeleton;
    const fdata = compileSkeleton(structuredClone(free));
    const seen = new Set<string | null>();
    const fsk = createSkeleton(fdata, null);
    for (let i = 0; i <= 20; i++) {
      applyAnimation(
        fsk,
        free.animations.find((x) => x.name === anim.name)!,
        (anim.duration * i) / 20,
      );
      seen.add(fsk.slots.find((x) => x.data.name === slot.name)!.attachmentName);
    }
    expect(seen.size).toBeGreaterThan(1);
    const arctic = createSkeleton(data, doc.skins[1].id);
    expect(arctic.bones[data.boneIndex.get(bone.id)!].active).toBe(false); // required and not listed
    setSkinScope(doc, doc.skins[1].id, 'bone', bone.id, true);
    const listed = createSkeleton(compileSkeleton(structuredClone(doc)), doc.skins[1].id);
    expect(listed.bones[data.boneIndex.get(bone.id)!].active).toBe(true);
  });
});

describe('own copies of attachments', () => {
  it('toggles between inherited and own, and drops empty slots', () => {
    const p = rig();
    const doc = p.skeleton;
    const arctic = doc.skins[1];
    const fresh = doc.skins[0];
    // the default skin always has the attachment; other skins inherit it until they get a copy
    const slotId = Object.keys(fresh.attachments)[0];
    const name = Object.keys(fresh.attachments[slotId])[0];
    const newSkin = duplicateSkin(doc, arctic.id)!;
    delete newSkin.attachments[slotId];
    expect(overrideState(doc, newSkin.id, slotId, name)).toBe('inherited');
    const before = overrideCount(newSkin);
    expect(toggleOverride(doc, newSkin.id, slotId, name)).toBe('own');
    expect(newSkin.attachments[slotId][name]).toEqual(fresh.attachments[slotId][name]);
    expect(newSkin.attachments[slotId][name]).not.toBe(fresh.attachments[slotId][name]);
    expect(overrideCount(newSkin)).toBe(before + 1);
    expect(toggleOverride(doc, newSkin.id, slotId, name)).toBe('inherited');
    expect(newSkin.attachments[slotId]).toBeUndefined();
    expect(toggleOverride(doc, fresh.id, slotId, name)).toBe('inherited'); // the default skin is never an override
    expect(overrideState(doc, newSkin.id, slotId, 'nonexistent')).toBe('none');
  });
});
