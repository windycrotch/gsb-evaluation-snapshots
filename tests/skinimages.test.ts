/**
 * Skins from pictures: pictures named "arctic/head" or "arctic-head" become the pictures of the skin "arctic" where the default skin has
 * "head". The plan, the skin it makes (linked meshes for meshes), the one undo step, and the export against the official runtime.
 */
import { describe, expect, it } from 'vitest';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { exportSpineJson } from '../src/core/export/spineJson';
import type { ImageRef, MeshAttachment, Project } from '../src/core/model';
import { applySkinPicks, cleanPrefix, planSkinImages, skinNameOf, suggestSkinPrefixes } from '../src/core/skinImages';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { loadOfficial } from './official';

/** Every region and mesh of the default skin: where a skin can put its own picture. */
function placeholders(project: Project): { slotId: string; name: string; mesh: boolean; w: number; h: number }[] {
  const out: { slotId: string; name: string; mesh: boolean; w: number; h: number }[] = [];
  const skin = project.skeleton.skins[0];
  for (const slotId in skin.attachments) {
    for (const name in skin.attachments[slotId]) {
      const a = skin.attachments[slotId][name];
      if (a.type === 'region' || a.type === 'mesh') out.push({ slotId, name, mesh: a.type === 'mesh', w: a.width, h: a.height });
    }
  }
  return out;
}

/** The fixture with a picture "arctic/<name>" for every attachment, and "desert-<name>" for the first two. */
function rig() {
  const { project } = buildFixture();
  const list = placeholders(project);
  const image = (name: string, w: number, h: number): ImageRef => ({
    id: name,
    name,
    width: Math.max(8, Math.round(w)),
    height: Math.max(8, Math.round(h)),
  });
  for (const p of list) project.images.push(image(`arctic/${p.name}`, p.w, p.h));
  for (const p of list.slice(0, 2)) project.images.push(image(`desert-${p.name}`, p.w, p.h));
  return { project, list };
}

describe('names', () => {
  it('cuts the separators off the end of a prefix and names the skin after its last part', () => {
    expect(cleanPrefix(' arctic- ')).toBe('arctic');
    expect(cleanPrefix('hero/arctic/')).toBe('hero/arctic');
    expect(cleanPrefix('--')).toBe('');
    expect(skinNameOf('hero/arctic')).toBe('arctic');
    expect(skinNameOf('')).toBe('skin');
  });
});

describe('the plan', () => {
  it('pairs every picture of the prefix with the attachment of the same name, in the slot that has it', () => {
    const { project, list } = rig();
    const picks = planSkinImages(project.skeleton, project.images, 'arctic');
    expect(picks.length).toBe(list.length);
    for (const p of list) expect(picks.find((k) => k.slotId === p.slotId && k.placeholder === p.name)?.image).toBe(`arctic/${p.name}`);
  });

  it('takes a dash, an underscore, a dot or a space as the separator, and a typed separator at the end of the prefix', () => {
    const { project, list } = rig();
    const first = list[0];
    for (const sep of ['-', '_', '.', ' ']) {
      project.images.push({ id: `s${sep}`, name: `tropic${sep}${first.name}`, width: 8, height: 8 });
      expect(planSkinImages(project.skeleton, project.images, 'tropic').length).toBeGreaterThanOrEqual(1);
    }
    expect(planSkinImages(project.skeleton, project.images, 'desert-').map((p) => p.placeholder)).toEqual(
      list.slice(0, 2).map((p) => p.name),
    );
  });

  it('does not take a picture whose prefix only starts the same way, nor one that is the prefix alone', () => {
    const { project } = rig();
    expect(planSkinImages(project.skeleton, project.images, 'arct')).toEqual([]);
    expect(planSkinImages(project.skeleton, project.images, 'arcticx')).toEqual([]);
    expect(planSkinImages(project.skeleton, project.images, '')).toEqual([]);
  });

  it('skips a picture the default skin already shows there', () => {
    const { project, list } = rig();
    const att: any = project.skeleton.skins[0].attachments[list[0].slotId][list[0].name];
    att.path = `arctic/${list[0].name}`;
    expect(planSkinImages(project.skeleton, project.images, 'arctic').length).toBe(list.length - 1);
  });

  it('leaves out sequences and linked meshes, which have no single picture to swap', () => {
    const { project, list } = rig();
    const mesh = list.find((p) => p.mesh)!;
    const att: any = project.skeleton.skins[0].attachments[mesh.slotId][mesh.name];
    att.link = { source: 'x', slot: null, skin: null, deform: true };
    expect(
      planSkinImages(project.skeleton, project.images, 'arctic').some((p) => p.placeholder === mesh.name && p.slotId === mesh.slotId),
    ).toBe(false);
    delete att.link;
    att.sequence = { count: 2, start: 1, digits: 2, setupIndex: 0 };
    expect(
      planSkinImages(project.skeleton, project.images, 'arctic').some((p) => p.placeholder === mesh.name && p.slotId === mesh.slotId),
    ).toBe(false);
  });

  it('marks a mesh whose new picture has another size', () => {
    const { project, list } = rig();
    const mesh = list.find((p) => p.mesh)!;
    expect(planSkinImages(project.skeleton, project.images, 'arctic').filter((p) => p.sizeDiffers)).toEqual([]);
    project.images.find((i) => i.name === `arctic/${mesh.name}`)!.width += 5;
    expect(
      planSkinImages(project.skeleton, project.images, 'arctic')
        .filter((p) => p.sizeDiffers)
        .map((p) => p.placeholder),
    ).toEqual([mesh.name]);
  });

  it('offers the prefixes that fit several attachments, the biggest first', () => {
    const { project, list } = rig();
    const s = suggestSkinPrefixes(project.skeleton, project.images);
    expect(s[0]).toEqual({ prefix: 'arctic', count: list.length });
    expect(s.find((x) => x.prefix === 'desert')?.count).toBe(2);
    expect(suggestSkinPrefixes(project.skeleton, project.images, 3).some((x) => x.prefix === 'desert')).toBe(false);
  });
});

describe('the skin', () => {
  it('gets a region for a region and a linked mesh for a mesh, each with the picture of the prefix', () => {
    const { project, list } = rig();
    const doc = project.skeleton;
    const picks = planSkinImages(doc, project.images, 'arctic');
    const { skinId, placed } = applySkinPicks(doc, 'arctic', picks, project.images);
    expect(placed).toBe(list.length);
    const skin = doc.skins.find((s) => s.id === skinId)!;
    expect(skin.name).toBe('arctic');
    for (const p of list) {
      const a: any = skin.attachments[p.slotId][p.name];
      expect(a.path).toBe(`arctic/${p.name}`);
      expect(a.type).toBe(p.mesh ? 'mesh' : 'region');
      if (p.mesh) {
        expect(a.link?.source).toBe(p.name);
        const def = doc.skins[0].attachments[p.slotId][p.name] as MeshAttachment;
        expect(a.uvs).toEqual(def.uvs);
        expect(a.triangles).toEqual(def.triangles);
      }
    }
  });

  it('is the one skin of that name when the pictures come in again: new ones are added, nothing is doubled', () => {
    const { project, list } = rig();
    const doc = project.skeleton;
    const first = applySkinPicks(doc, 'desert', planSkinImages(doc, project.images, 'desert'), project.images);
    const count = doc.skins.length;
    project.images.push({ id: 'extra', name: `desert/${list[2].name}`, width: 8, height: 8 });
    const second = applySkinPicks(doc, 'desert', planSkinImages(doc, project.images, 'desert'), project.images);
    expect(second.skinId).toBe(first.skinId);
    expect(doc.skins.length).toBe(count);
    expect(
      Object.values(doc.skins.find((s) => s.id === first.skinId)!.attachments)
        .flatMap((m) => Object.keys(m))
        .sort(),
    ).toEqual([list[0].name, list[1].name, list[2].name].sort());
  });

  it('gets a name that is free when a default skin or another name stands in the way', () => {
    const { project } = rig();
    const doc = project.skeleton;
    doc.skins[0].name = 'arctic'; // the default skin has the name
    const { skinId } = applySkinPicks(doc, 'arctic', planSkinImages(doc, project.images, 'arctic'), project.images);
    expect(doc.skins.find((s) => s.id === skinId)!.name).not.toBe('arctic');
    expect(new Set(doc.skins.map((s) => s.name)).size).toBe(doc.skins.length);
  });

  it('is a project the validator accepts and the official runtime loads, with the skin on offer', () => {
    const { project } = rig();
    const doc = project.skeleton;
    applySkinPicks(doc, 'arctic', planSkinImages(doc, project.images, 'arctic'), project.images);
    expect(validateProject(project)).toEqual([]);
    const pages = packAtlas(
      project.images.map((i) => ({ name: i.name, width: i.width, height: i.height })),
      { maxSize: 2048, padding: 2 },
    );
    const sd = loadOfficial(
      exportSpineJson(doc),
      writeAtlas(pages, (i) => `atlas${i}.png`),
    );
    expect(sd.findSkin('arctic')).toBeTruthy();
  });
});

describe('the action', () => {
  it('makes the skin in one step of the history, chooses it, and undo takes it away', () => {
    const { project } = rig();
    docStore.replace(project);
    const before = docStore.get().skeleton.skins.length;
    const id = A.createSkinFromImages('arctic');
    expect(id).toBeTruthy();
    expect(docStore.get().skeleton.skins.length).toBe(before + 1);
    expect(uiStore.get().skinId).toBe(id);
    expect(docStore.undoLabel).toBe('Skin from images');
    docStore.undo();
    expect(docStore.get().skeleton.skins.length).toBe(before);
  });

  it('changes nothing when no picture fits', () => {
    const { project } = rig();
    docStore.replace(project);
    const before = docStore.revision;
    expect(A.createSkinFromImages('nothing-like-it')).toBeNull();
    expect(docStore.revision).toBe(before);
  });

  it('setSkinImage still puts one picture in a skin the way it did', () => {
    const { project, list } = rig();
    docStore.replace(project);
    const skinId = A.createSkin('one');
    A.setSkinImage(skinId, list[0].slotId, list[0].name, `arctic/${list[0].name}`);
    const a: any = docStore.get().skeleton.skins.find((s) => s.id === skinId)!.attachments[list[0].slotId][list[0].name];
    expect(a.path).toBe(`arctic/${list[0].name}`);
  });
});
