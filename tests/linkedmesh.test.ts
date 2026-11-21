/**
 * Linked meshes: a mesh that takes its shape from another mesh and has a picture of its own. The shape is kept equal to the source
 * by every edit, the file carries the link (JSON and binary), the import keeps it, and the deform of the source moves the linked
 * meshes that share it — all of it against the OFFICIAL runtime (spine-core 4.3).
 */
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { jsonToBinary } from '../src/core/export/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { deformHome, linkSource, linkedTo, makeLink, syncLinkedMeshes } from '../src/core/links';
import { newAnimation, newSkin, newSlot } from '../src/core/model';
import type { Animation, MeshAttachment, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton, meshWorldVertices } from '../src/core/skeleton';
import { projectWarnings } from '../src/core/stats';
import { repairProject, validateProject } from '../src/core/validate';
import { duplicateSkin } from '../src/core/skins';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { buildFixture } from './fixture';
import { loadOfficial, loadOfficialBinary, startLikeOfficial } from './official';

interface Rig {
  project: Project;
  slotId: string;
  slotName: string;
  name: string;
  ghostId: string;
  skinId: string;
  animation: Animation;
}

/**
 * The fixture plus: a skin `alt` with a linked mesh of the same name as a mesh of the default skin (its own picture), a second
 * linked mesh there that does not share the deform (`still`), and a slot `ghost` that shows a linked mesh of the source in ANOTHER
 * slot. The animation `wobble` deforms the source and switches the slot to `still`.
 */
function rig(weighted: boolean): Rig {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const skin = doc.skins[0];
  let found: { slotId: string; name: string } | null = null;
  for (const slotId in skin.attachments) {
    for (const name in skin.attachments[slotId]) {
      const a = skin.attachments[slotId][name];
      if (!found && a.type === 'mesh' && !!a.weights === weighted) found = { slotId, name };
    }
  }
  if (!found) throw new Error('the fixture has no such mesh');
  const { slotId, name } = found;
  const source = skin.attachments[slotId][name] as MeshAttachment;
  const size = { width: Math.max(8, Math.round(source.width) || 32), height: Math.max(8, Math.round(source.height) || 32) };
  for (const picture of ['alt_pic', 'still_pic', 'ghost_pic']) project.images.push({ id: picture, name: picture, ...size });

  const alt = newSkin('linked');
  doc.skins.push(alt);
  const linkedCopy = (path: string, link: MeshAttachment['link'], nameOf: string): MeshAttachment => ({
    ...structuredClone(source),
    name: nameOf,
    path,
    color: [0.5, 0.8, 1, 1],
    link,
  });
  alt.attachments[slotId] = {
    [name]: linkedCopy('alt_pic', makeLink(doc, slotId, { skinId: skin.id, slotId, name }), name),
    still: linkedCopy('still_pic', makeLink(doc, slotId, { skinId: skin.id, slotId, name }, false), 'still'),
  };
  const slot = doc.slots.find((s) => s.id === slotId)!;
  const ghost = newSlot({ name: 'ghost', bone: slot.bone, attachment: 'ghost' });
  doc.slots.push(ghost);
  skin.attachments[ghost.id] = { ghost: linkedCopy('ghost_pic', makeLink(doc, ghost.id, { skinId: skin.id, slotId, name }), 'ghost') };

  const data = compileSkeleton(doc);
  const length = (data.defaultSkin.attachments[data.slotIndex.get(slotId)!].get(name) as { deformLength: number }).deformLength;
  const animation = newAnimation('wobble', 1);
  const wave = (k: number) => Array.from({ length }, (_, i) => Math.sin(i * 1.3 + k) * 9);
  animation.deform = {
    [skin.id]: {
      [slotId]: {
        [name]: [
          { time: 0, value: wave(0) },
          { time: 0.5, value: wave(1) },
          { time: 1, value: wave(2) },
        ],
      },
    },
  };
  doc.animations.push(animation);
  // the same, and the slot switches to `still` (a name that only the linked skin has: the official runtime cannot pose the default skin with it)
  const swap = newAnimation('swap', 1);
  swap.deform = structuredClone(animation.deform);
  swap.slots = {
    [slotId]: {
      attachment: [
        { time: 0, name },
        { time: 0.7, name: 'still' },
      ],
    },
  };
  doc.animations.push(swap);
  syncLinkedMeshes(doc);
  return { project, slotId, slotName: slot.name, name, ghostId: ghost.id, skinId: alt.id, animation };
}

const skinOf = (doc: Project['skeleton'], r: Rig) => doc.skins.find((s) => s.id === r.skinId)!;

function atlasFor(project: Project): string {
  const pages = packAtlas(
    project.images.map((i) => ({ name: i.name, width: i.width, height: i.height })),
    { maxSize: 2048, padding: 2 },
  );
  return writeAtlas(pages, (i) => `atlas${i}.png`);
}

/** World vertices of every mesh the slots show in the official runtime, for a skin, at a time of `wobble`. */
function officialWorld(sd: any, skinName: string, t: number, animation = 'wobble'): Record<string, number[]> {
  const sk = new (spine as any).Skeleton(sd);
  sk.setSkin(skinName);
  sk.setupPose();
  const state = new (spine as any).AnimationState(new (spine as any).AnimationStateData(sd));
  state.setAnimation(0, animation, false);
  state.update(t);
  state.apply(sk);
  sk.updateWorldTransform((spine as any).Physics.update);
  const out: Record<string, number[]> = {};
  for (const slot of sk.slots) {
    const att = slot.appliedPose.attachment;
    if (!(att instanceof (spine as any).MeshAttachment)) continue;
    const n = att.worldVerticesLength;
    const w = new Array(n).fill(0);
    att.computeWorldVertices(sk, slot, 0, n, w, 0, 2);
    out[`${slot.data.name}:${att.name}`] = w;
  }
  return out;
}

function ourWorld(project: Project, skinId: string | null, t: number, animation = 'wobble'): Record<string, number[]> {
  const doc = project.skeleton;
  const data = compileSkeleton(doc);
  const sk = createSkeleton(data, skinId);
  startLikeOfficial(sk);
  applyAnimation(
    sk,
    doc.animations.find((a) => a.name === animation)!,
    t,
  );
  sk.updateWorldTransform('update');
  const out: Record<string, number[]> = {};
  for (const slot of sk.slots) {
    const att = sk.slotAttachment(slot);
    if (!att || att.kind !== 'mesh') continue;
    const w = new Float32Array(att.vertexCount * 2);
    meshWorldVertices(sk, slot, att, slot.deform.length ? slot.deform : null, w);
    out[`${slot.data.name}:${att.name}`] = Array.from(w);
  }
  return out;
}

function expectSameWorld(ours: Record<string, number[]>, official: Record<string, number[]>) {
  expect(Object.keys(ours).sort()).toEqual(Object.keys(official).sort());
  for (const key in ours) {
    expect(ours[key].length).toBe(official[key].length);
    ours[key].forEach((v, i) => expect(Math.abs(v - official[key][i]), `${key}[${i}]`).toBeLessThan(2e-2));
  }
}

describe('the link and the shape of a linked mesh', () => {
  it('finds the source, and refuses a link to a mesh that is itself linked, or to nothing', () => {
    const r = rig(false);
    const doc = r.project.skeleton;
    const alt = skinOf(doc, r);
    const att = alt.attachments[r.slotId][r.name] as MeshAttachment;
    const src = linkSource(doc, r.slotId, att)!;
    expect(src.skin).toBe(doc.skins[0]);
    expect(src.mesh.name).toBe(r.name);
    expect(
      linkedTo(doc, doc.skins[0].id, r.slotId, r.name)
        .map((l) => l.name)
        .sort(),
    ).toEqual(['ghost', r.name, 'still'].sort());
    att.link = { source: 'nothing', slot: null, skin: null, deform: true };
    expect(linkSource(doc, r.slotId, att)).toBeNull();
    const still = alt.attachments[r.slotId].still as MeshAttachment;
    att.link = { source: 'still', slot: null, skin: alt.id, deform: true };
    expect(linkSource(doc, r.slotId, att)).toBeNull(); // 'still' is a linked mesh
    expect(still.link?.source).toBe(r.name);
  });

  for (const weighted of [false, true]) {
    describe(weighted ? 'weighted' : 'unweighted', () => {
      it('follows the source through an edit, and an undo takes both back', () => {
        const r = rig(weighted);
        docStore.replace(r.project);
        const before = structuredClone(skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name]) as MeshAttachment;
        docStore.update('move', (d) => {
          const m = d.skeleton.skins[0].attachments[r.slotId][r.name] as MeshAttachment;
          if (m.weights) m.weights[0][0][1] += 7;
          else m.vertices[0] += 7;
          m.uvs[0] += 0.01;
        });
        const doc = docStore.get().skeleton;
        const source = doc.skins[0].attachments[r.slotId][r.name] as MeshAttachment;
        for (const m of [
          skinOf(doc, r).attachments[r.slotId][r.name],
          skinOf(doc, r).attachments[r.slotId].still,
          doc.skins[0].attachments[r.ghostId].ghost,
        ] as MeshAttachment[]) {
          expect(m.uvs).toEqual(source.uvs);
          expect(m.weights).toEqual(source.weights);
          expect(m.vertices).toEqual(source.vertices);
          expect(m.triangles).toEqual(source.triangles);
          expect(m.path).not.toBe(source.path); // the picture stays its own
        }
        expect(validateProject(docStore.get())).toEqual([]);
        docStore.undo();
        expect(skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name]).toEqual(before);
      });

      it('becomes an ordinary mesh when its source is deleted', () => {
        const r = rig(weighted);
        docStore.replace(r.project);
        // the linked meshes of the same name in the other skins go with it; the ones with other names stay, as ordinary meshes
        A.deleteAttachment(r.slotId, r.name);
        const doc = docStore.get().skeleton;
        const still = skinOf(doc, r).attachments[r.slotId].still as MeshAttachment;
        expect(still.type).toBe('mesh');
        expect(still.link).toBeUndefined();
        expect(still.uvs.length).toBeGreaterThan(0);
        expect(skinOf(doc, r).attachments[r.slotId][r.name]).toBeUndefined();
        expect((doc.skins[0].attachments[r.ghostId].ghost as MeshAttachment).link).toBeUndefined();
        expect(validateProject(docStore.get())).toEqual([]);
      });
    });
  }

  it('is kept when a skin is duplicated, and points at the copy when the source is in the same skin', () => {
    const r = rig(false);
    const doc = r.project.skeleton;
    const alt = skinOf(doc, r);
    (alt.attachments[r.slotId].still as MeshAttachment).link = { source: r.name, slot: null, skin: alt.id, deform: false };
    const copy = duplicateSkin(doc, alt.id)!;
    expect((copy.attachments[r.slotId].still as MeshAttachment).link?.skin).toBe(copy.id);
    expect((copy.attachments[r.slotId][r.name] as MeshAttachment).link?.skin).toBeNull();
  });

  it('is repaired in a damaged project: a bad link is dropped, a stale shape is renewed', () => {
    const r = rig(false);
    const doc = r.project.skeleton;
    const att = skinOf(doc, r).attachments[r.slotId][r.name] as MeshAttachment;
    att.uvs = att.uvs.map((u) => u * 0.5);
    (skinOf(doc, r).attachments[r.slotId].still as MeshAttachment).link = { source: 5 } as any;
    const notes = repairProject(r.project);
    expect(notes.some((n) => /link/.test(n))).toBe(true);
    expect(att.uvs).toEqual((doc.skins[0].attachments[r.slotId][r.name] as MeshAttachment).uvs);
    expect((skinOf(doc, r).attachments[r.slotId].still as MeshAttachment).link).toBeUndefined();
  });

  it('keys a deform of a mesh that shares its source deform on the source', () => {
    const r = rig(false);
    const doc = r.project.skeleton;
    expect(deformHome(doc, skinOf(doc, r).id, r.slotId, r.name)).toEqual({ skinId: doc.skins[0].id, slotId: r.slotId, name: r.name });
    expect(deformHome(doc, skinOf(doc, r).id, r.slotId, 'still')).toEqual({ skinId: skinOf(doc, r).id, slotId: r.slotId, name: 'still' });
    expect(deformHome(doc, doc.skins[0].id, r.slotId, r.name)).toEqual({ skinId: doc.skins[0].id, slotId: r.slotId, name: r.name });
  });

  it('warns in Metrics about deform keys that sit on a mesh that shares the deform of its source', () => {
    const r = rig(false);
    expect(projectWarnings(r.project).some((w) => w.kind === 'ignoredDeform')).toBe(false);
    const doc = r.project.skeleton;
    const skin = skinOf(doc, r);
    const keys = structuredClone(r.animation.deform[doc.skins[0].id][r.slotId][r.name]);
    r.animation.deform[skin.id] = { [r.slotId]: { [r.name]: keys, still: structuredClone(keys) } };
    const w = projectWarnings(r.project).filter((x) => x.kind === 'ignoredDeform');
    // `still` does not share the deform (its keys are exported), the one with the source name does
    expect(w.map((x) => ({ kind: x.kind, subject: x.subject }))).toEqual([{ kind: 'ignoredDeform', subject: `wobble: ${r.name}` }]);
  });
});

for (const weighted of [false, true]) {
  describe(`${weighted ? 'a weighted' : 'an unweighted'} source against the official runtime`, () => {
    const r = rig(weighted);
    const doc = r.project.skeleton;
    const json: any = exportSpineJson(doc);
    const atlas = atlasFor(r.project);

    it('writes linkedmesh attachments the way the loader reads them', () => {
      const alt = json.skins.find((s: any) => s.name === 'linked').attachments[r.slotName];
      expect(alt[r.name].type).toBe('linkedmesh');
      expect(alt[r.name].source).toBe(r.name);
      expect(alt[r.name].path).toBe('alt_pic');
      expect(alt[r.name].timelines).toBeUndefined();
      expect(alt[r.name].skin).toBeUndefined(); // the default skin
      expect(alt[r.name].uvs).toBeUndefined();
      expect(alt.still.timelines).toBe(false);
      const ghost = json.skins[0].attachments.ghost.ghost;
      expect(ghost.type).toBe('linkedmesh');
      expect(ghost.slot).toBe(r.slotName); // the source is in another slot
      expect(() => loadOfficial(json, atlas)).not.toThrow();
    });

    it('does not write the deform keys of a mesh that follows its source', () => {
      const own = structuredClone(r.project);
      const ownDoc = own.skeleton;
      ownDoc.animations[0].deform = {
        [r.skinId]: { [r.slotId]: { [r.name]: ownDoc.animations[0].deform[ownDoc.skins[0].id][r.slotId][r.name] } },
      };
      const out: any = exportSpineJson(ownDoc);
      expect(out.animations.wobble.attachments?.alt).toBeUndefined();
    });

    for (const skinName of ['default', 'linked']) {
      it(`poses the meshes of the "${skinName}" skin like the official runtime, deform included`, () => {
        const sd = loadOfficial(json, atlas);
        const skinId = skinName === 'linked' ? r.skinId : null;
        for (const t of [0.13, 0.31, 0.5, 0.66, 0.74, 0.93])
          expectSameWorld(ourWorld(r.project, skinId, t), officialWorld(sd, skinName, t));
      });

      if (skinName === 'linked') {
        it('drops the deform when the slot switches to a linked mesh that does not share it, like the official runtime', () => {
          const sd = loadOfficial(json, atlas);
          for (const t of [0.13, 0.5, 0.66, 0.74, 0.93])
            expectSameWorld(ourWorld(r.project, r.skinId, t, 'swap'), officialWorld(sd, skinName, t, 'swap'));
        });
      }
    }

    it('is the same in the binary format, with the slots the source deform reaches', () => {
      const bytes = jsonToBinary(json);
      const sd = loadOfficialBinary(bytes, atlas);
      for (const t of [0.13, 0.5, 0.74, 0.93]) {
        expectSameWorld(ourWorld(r.project, null, t), officialWorld(sd, 'default', t));
        expectSameWorld(ourWorld(r.project, r.skinId, t), officialWorld(sd, 'linked', t));
      }
    });

    it('keeps the links through our own import (JSON, and the binary file)', () => {
      for (const input of [json, null]) {
        const text = input ? JSON.stringify(input) : '';
        const imported = input ? importSpineJson(JSON.parse(text)).project : null;
        if (!imported) continue;
        const idoc = imported.skeleton;
        const alt = idoc.skins.find((s) => s.name === 'linked')!;
        const slot = idoc.slots.find((s) => s.name === r.slotName)!;
        const att = alt.attachments[slot.id][r.name] as MeshAttachment;
        expect(att.type).toBe('mesh');
        expect(att.link).toEqual({ source: r.name, slot: null, skin: null, deform: true });
        expect((alt.attachments[slot.id].still as MeshAttachment).link?.deform).toBe(false);
        const ghostSlot = idoc.slots.find((s) => s.name === 'ghost')!;
        const ghost = idoc.skins[0].attachments[ghostSlot.id].ghost as MeshAttachment;
        expect(ghost.link).toEqual({ source: r.name, slot: slot.id, skin: null, deform: true });
        expect(att.uvs).toEqual((idoc.skins[0].attachments[slot.id][r.name] as MeshAttachment).uvs);
        expect(validateProject(imported)).toEqual([]);
        // and it exports again to the same thing
        expect(
          JSON.parse(JSON.stringify(exportSpineJson(idoc))).skins.find((s: any) => s.name === 'linked').attachments[r.slotName][r.name]
            .type,
        ).toBe('linkedmesh');
      }
    });
  });
}

describe('the editor actions', () => {
  it('give a skin another picture for a mesh as a linked mesh, and let it go again', () => {
    const r = rig(true);
    docStore.replace(r.project);
    const skin = docStore.get().skeleton.skins.find((s) => s.id === r.skinId)!;
    const before = Object.keys(skin.attachments[r.slotId]).length;
    A.removeSkinImage(r.skinId, r.slotId, r.name);
    expect(skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name]).toBeUndefined();
    A.setSkinImage(r.skinId, r.slotId, r.name, 'alt_pic');
    const made = skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name] as MeshAttachment;
    const source = docStore.get().skeleton.skins[0].attachments[r.slotId][r.name] as MeshAttachment;
    expect(made.type).toBe('mesh');
    expect(made.path).toBe('alt_pic');
    expect(made.link).toEqual({ source: r.name, slot: null, skin: null, deform: true });
    expect(made.weights).toEqual(source.weights); // the weights come with it
    expect(Object.keys(skinOf(docStore.get().skeleton, r).attachments[r.slotId]).length).toBe(before);
    A.setLinkDeform(r.skinId, r.slotId, r.name, false);
    expect((skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name] as MeshAttachment).link?.deform).toBe(false);
    A.unlinkMesh(r.skinId, r.slotId, r.name);
    const free = skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name] as MeshAttachment;
    expect(free.link).toBeUndefined();
    expect(free.weights).toEqual(source.weights);
    // a loose mesh keeps its shape when the source changes
    docStore.update('move', (d) => {
      (d.skeleton.skins[0].attachments[r.slotId][r.name] as MeshAttachment).uvs[0] += 0.02;
    });
    expect((skinOf(docStore.get().skeleton, r).attachments[r.slotId][r.name] as MeshAttachment).uvs[0]).toBe(free.uvs[0]);
    expect(validateProject(docStore.get())).toEqual([]);
  });
});

describe('sharing a shape between two slots', () => {
  it('links a mesh to another mesh of the default skin, and refuses the links that would not load', () => {
    const r = rig(false);
    docStore.replace(r.project);
    A.unlinkMesh(docStore.get().skeleton.skins[0].id, r.ghostId, 'ghost');
    const ghostBefore = docStore.get().skeleton.skins[0].attachments[r.ghostId].ghost as MeshAttachment;
    expect(ghostBefore.link).toBeUndefined();
    A.linkMeshTo(r.ghostId, 'ghost', { slotId: r.slotId, name: r.name });
    const ghost = docStore.get().skeleton.skins[0].attachments[r.ghostId].ghost as MeshAttachment;
    expect(ghost.link).toEqual({ source: r.name, slot: r.slotId, skin: null, deform: true });
    expect(ghost.path).toBe('ghost_pic');
    // the source cannot follow another mesh while others follow it
    A.linkMeshTo(r.slotId, r.name, { slotId: r.ghostId, name: 'ghost' });
    expect((docStore.get().skeleton.skins[0].attachments[r.slotId][r.name] as MeshAttachment).link).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect((docStore.get().skeleton.skins[0].attachments[r.ghostId].ghost as MeshAttachment).link).toBeUndefined();
  });
});
