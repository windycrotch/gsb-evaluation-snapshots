/** Problems with a fix: the warnings of the Metrics window put right in one step (the safe ones together). */
import { describe, expect, it } from 'vitest';
import { makeLink } from '../src/core/links';
import { deformLength } from '../src/core/mesh';
import { newAnimation, newSlot } from '../src/core/model';
import type { Influence, MeshAttachment, Project } from '../src/core/model';
import { canFix, fixAllSafe, fixProblem, isSafeFix } from '../src/core/problems';
import { MAX_INFLUENCES, projectWarnings } from '../src/core/stats';
import { syncLinkedMeshes } from '../src/core/links';
import { repairProject } from '../src/core/validate';
import { fixAllSafeWarnings, fixWarning } from '../src/store/problemActions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const kinds = (p: Project) => projectWarnings(p).map((w) => w.kind);

function weightedMesh(p: Project): { slotId: string; mesh: MeshAttachment } {
  const skin = p.skeleton.skins[0];
  for (const slotId in skin.attachments)
    for (const name in skin.attachments[slotId]) {
      const a = skin.attachments[slotId][name];
      if (a.type === 'mesh' && a.weights && !a.link) return { slotId, mesh: a };
    }
  throw new Error('the fixture has no weighted mesh');
}

/** The first vertex of the weighted mesh follows six bones (the others stay as they were). */
function overweight(p: Project) {
  const { slotId, mesh } = weightedMesh(p);
  const bones = p.skeleton.bones.slice(0, 6);
  while (bones.length < 6) bones.push(p.skeleton.bones[0]);
  const list: Influence[] = bones.map((b, i) => [b.id, 1 + i, 2, (6 - i) / 21] as Influence);
  mesh.weights![0] = list;
  return { slotId, mesh };
}

describe('the fixes', () => {
  it('an image nothing shows is removed, and only once', () => {
    const { project } = buildFixture();
    project.images.push({ id: 'junk', name: 'junk', width: 8, height: 8 });
    const w = projectWarnings(project).find((x) => x.kind === 'unusedImage' && x.subject === 'junk')!;
    expect(w).toBeTruthy();
    expect(fixProblem(project, w)).toBe(true);
    expect(project.images.some((i) => i.name === 'junk')).toBe(false);
    expect(fixProblem(project, w)).toBe(false);
  });

  it('an image another skeleton shows is not listed and not removed', () => {
    const { project } = buildFixture();
    const other = structuredClone(project.skeleton);
    other.name = 'second';
    const skin = other.skins[0];
    const slot = other.slots[0];
    skin.attachments[slot.id] = {
      ...skin.attachments[slot.id],
      z: {
        type: 'region',
        name: 'z',
        path: 'only_here',
        x: 0,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        width: 8,
        height: 8,
        color: [1, 1, 1, 1],
      } as never,
    };
    project.others = [other];
    project.activeAt = 0;
    project.images.push({ id: 'only_here', name: 'only_here', width: 8, height: 8 });
    expect(projectWarnings(project).some((w) => w.kind === 'unusedImage' && w.subject === 'only_here')).toBe(false);
    expect(fixProblem(project, { kind: 'unusedImage', subject: 'only_here' })).toBe(false);
    expect(project.images.some((i) => i.name === 'only_here')).toBe(true);
  });

  it('an empty animation is deleted with what pointed at it', () => {
    const { project } = buildFixture();
    const empty = newAnimation('blank');
    project.skeleton.animations.push(empty);
    project.skeleton.constraints.push({
      id: 'sl',
      type: 'slider',
      name: 'sl',
      bone: null,
      property: 'x',
      mix: 1,
      time: 0,
      from: 0,
      to: 1,
      scale: 1,
      max: 1,
      animation: empty.id,
    } as never);
    const w = projectWarnings(project).find((x) => x.kind === 'emptyAnimation' && x.subject === 'blank')!;
    expect(fixProblem(project, w)).toBe(true);
    expect(project.skeleton.animations.some((a) => a.id === empty.id)).toBe(false);
    const slider = project.skeleton.constraints.find((c) => c.id === 'sl');
    expect(slider && slider.type === 'slider' ? slider.animation : 'x').toBeNull();
    expect(repairProject(structuredClone(project))).toEqual([]);
  });

  it('a slot without attachments is deleted', () => {
    const { project } = buildFixture();
    const slot = newSlot({ name: 'nothing', bone: project.skeleton.bones[0].id });
    project.skeleton.slots.push(slot);
    const w = projectWarnings(project).find((x) => x.kind === 'emptySlot' && x.subject === 'nothing')!;
    expect(fixProblem(project, w)).toBe(true);
    expect(project.skeleton.slots.some((s) => s.id === slot.id)).toBe(false);
    expect(projectWarnings(project).some((x) => x.subject === 'nothing')).toBe(false);
  });

  it('a vertex with too many bones keeps the strongest ones, scaled back to 1; other vertices stay', () => {
    const { project } = buildFixture();
    const { mesh } = overweight(project);
    const others = structuredClone(mesh.weights!.slice(1));
    const strongest = [...mesh.weights![0]]
      .sort((a, b) => b[3] - a[3])
      .slice(0, MAX_INFLUENCES)
      .map((i) => i[0]);
    const w = projectWarnings(project).find((x) => x.kind === 'tooManyInfluences')!;
    expect(fixProblem(project, w)).toBe(true);
    const fixed = weightedMesh(project).mesh.weights!;
    expect(fixed[0].length).toBe(MAX_INFLUENCES);
    expect(fixed[0].map((i) => i[0]).sort()).toEqual([...strongest].sort());
    expect(fixed[0].reduce((s, i) => s + i[3], 0)).toBeCloseTo(1, 9);
    expect(fixed.slice(1)).toEqual(others);
    expect(kinds(project)).not.toContain('tooManyInfluences');
    expect(fixProblem(project, w)).toBe(false);
  });

  it('the deform keys of the mesh follow the weights (nothing is left to repair)', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const { slotId, mesh } = overweight(project);
    // a key made for the mesh as it is now
    const has = (id: string) => doc.bones.some((b) => b.id === id);
    const n = deformLength(mesh, has);
    const anim = doc.animations[0];
    for (const a of doc.animations) delete a.deform[doc.skins[0].id]?.[slotId]?.[mesh.name]; // the keys of the fixture were made for the old weights
    (((anim.deform[doc.skins[0].id] ??= {})[slotId] ??= {})[mesh.name] ??= []).push({
      time: 0.2,
      value: Array.from({ length: n }, (_, i) => (i % 5) * 0.1),
    });
    expect(repairProject(structuredClone(project))).toEqual([]);
    expect(
      fixProblem(
        project,
        projectWarnings(project).find((x) => x.kind === 'tooManyInfluences')!,
      ),
    ).toBe(true);
    expect(repairProject(structuredClone(project))).toEqual([]);
  });

  it('a linked mesh is fixed through its source', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const { slotId, mesh } = overweight(project);
    const alt = { id: 'altskin', name: 'linkedskin', attachments: {}, bones: [], constraints: [] } as unknown as (typeof doc.skins)[number];
    alt.attachments[slotId] = {
      [mesh.name]: { ...structuredClone(mesh), link: makeLink(doc, slotId, { skinId: doc.skins[0].id, slotId, name: mesh.name }) },
    };
    doc.skins.push(alt);
    syncLinkedMeshes(doc);
    const found = projectWarnings(project).filter((w) => w.kind === 'tooManyInfluences');
    expect(found.length).toBe(2);
    // the first warning of the pair is the source; fixing the one of the linked mesh works the same
    const linked = found.find((w) => w.ref?.skin === 'altskin')!;
    expect(fixProblem(project, linked)).toBe(true);
    syncLinkedMeshes(doc);
    expect(kinds(project)).not.toContain('tooManyInfluences');
    expect((alt.attachments[slotId][mesh.name] as MeshAttachment).weights![0].length).toBe(MAX_INFLUENCES);
  });

  it('deform keys a linked mesh has next to the shared deform of its source are dropped', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const { slotId, mesh } = weightedMesh(project);
    const alt = { id: 'altskin', name: 'linkedskin', attachments: {}, bones: [], constraints: [] } as unknown as (typeof doc.skins)[number];
    alt.attachments[slotId] = {
      [mesh.name]: { ...structuredClone(mesh), link: makeLink(doc, slotId, { skinId: doc.skins[0].id, slotId, name: mesh.name }) },
    };
    doc.skins.push(alt);
    syncLinkedMeshes(doc);
    const has = (id: string) => doc.bones.some((b) => b.id === id);
    const anim = doc.animations[0];
    (((anim.deform.altskin ??= {})[slotId] ??= {})[mesh.name] ??= []).push({ time: 0, value: new Array(deformLength(mesh, has)).fill(0) });
    const w = projectWarnings(project).find((x) => x.kind === 'ignoredDeform')!;
    expect(w).toBeTruthy();
    expect(fixProblem(project, w)).toBe(true);
    expect(anim.deform.altskin).toBeUndefined();
    expect(kinds(project)).not.toContain('ignoredDeform');
    expect(repairProject(structuredClone(project))).toEqual([]);
  });

  it('"fix all" does the safe ones and leaves the ones that delete something a person may have made on purpose', () => {
    const { project } = buildFixture();
    project.images.push({ id: 'junk', name: 'junk', width: 8, height: 8 });
    overweight(project);
    project.skeleton.animations.push(newAnimation('blank'));
    project.skeleton.slots.push(newSlot({ name: 'nothing', bone: project.skeleton.bones[0].id }));
    const before = projectWarnings(project);
    expect(before.some(isSafeFix)).toBe(true);
    const done = fixAllSafe(project, before);
    expect(done).toBe(before.filter(isSafeFix).length);
    const left = kinds(project);
    expect(left).toContain('emptyAnimation');
    expect(left).toContain('emptySlot');
    expect(left).not.toContain('unusedImage');
    expect(left).not.toContain('tooManyInfluences');
  });

  it('the warnings that have no fix say so', () => {
    expect(canFix({ kind: 'missingFrame', subject: 'x' })).toBe(false);
    expect(canFix({ kind: 'duplicatePath', subject: 'x' })).toBe(false);
    expect(fixProblem(buildFixture().project, { kind: 'missingFrame', subject: 'x' })).toBe(false);
  });
});

describe('the actions of the Metrics window', () => {
  it('one fix is one step of history, and undo brings the problem back', () => {
    const { project } = buildFixture();
    project.images.push({ id: 'junk', name: 'junk', width: 8, height: 8 });
    docStore.replace(project);
    const w = projectWarnings(docStore.get()).find((x) => x.kind === 'unusedImage' && x.subject === 'junk')!;
    expect(fixWarning(w)).toBe(true);
    expect(docStore.get().images.some((i) => i.name === 'junk')).toBe(false);
    docStore.undo();
    expect(docStore.get().images.some((i) => i.name === 'junk')).toBe(true);
  });

  it('deleting the animation that is open moves the editor to another one', () => {
    const { project } = buildFixture();
    const empty = newAnimation('blank');
    project.skeleton.animations.push(empty);
    docStore.replace(project);
    uiStore.patch({ mode: 'animate', animationId: empty.id });
    const w = projectWarnings(docStore.get()).find((x) => x.kind === 'emptyAnimation' && x.subject === 'blank')!;
    fixWarning(w);
    const id = uiStore.get().animationId;
    expect(id).not.toBe(empty.id);
    expect(docStore.get().skeleton.animations.some((a) => a.id === id)).toBe(true);
  });

  it('"fix all" is one step too', () => {
    const { project } = buildFixture();
    project.images.push({ id: 'junk', name: 'junk', width: 8, height: 8 }, { id: 'junk2', name: 'junk2', width: 8, height: 8 });
    overweight(project);
    docStore.replace(project);
    expect(fixAllSafeWarnings()).toBeGreaterThanOrEqual(3);
    expect(kinds(docStore.get())).not.toContain('unusedImage');
    docStore.undo();
    expect(kinds(docStore.get())).toContain('unusedImage');
    expect(kinds(docStore.get())).toContain('tooManyInfluences');
  });
});
