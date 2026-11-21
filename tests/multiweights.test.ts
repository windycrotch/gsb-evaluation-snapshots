/** Weights of several meshes at once (Spine 4.3): slots selected together with Ctrl-click; the weight tools work on all their meshes in one history step. */
import { beforeEach, describe, expect, it } from 'vitest';
import { meshWorldPositions } from '../src/core/mesh';
import { newSlot } from '../src/core/model';
import type { MeshAttachment } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as M from '../src/store/meshActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;
const mesh = (slotId: string, name: string) => M.getMesh(slotId, name)!;

let armSlot = '';
let twinSlot = '';
let thirdSlot = '';
let armLower = '';
let armUpper = '';

beforeEach(() => {
  const f = buildFixture();
  const d = f.project.skeleton;
  const slotOf = (name: string) => d.slots.find((s) => s.name === name)!;
  armSlot = slotOf('arm').id;
  armUpper = d.bones.find((b) => b.name === 'armUpper')!.id;
  armLower = d.bones.find((b) => b.name === 'armLower')!.id;
  const arm = d.skins[0].attachments[armSlot].arm as MeshAttachment;
  // a twin of the arm in a slot of its own, and a third mesh that follows armUpper only
  const twin = newSlot({ name: 'twin', bone: slotOf('arm').bone, attachment: 'twin' });
  const third = newSlot({ name: 'third', bone: slotOf('arm').bone, attachment: 'third' });
  d.slots.push(twin, third);
  twinSlot = twin.id;
  thirdSlot = third.id;
  d.skins[0].attachments[twin.id] = { twin: { ...JSON.parse(JSON.stringify(arm)), name: 'twin', path: 'twin' } };
  const only: MeshAttachment = { ...JSON.parse(JSON.stringify(arm)), name: 'third', path: 'third' };
  only.weights = only.weights!.map((list) => [[armUpper, list[0][1], list[0][2], 1]]);
  d.skins[0].attachments[third.id] = { third: only };
  docStore.replace(f.project);
  uiStore.patch({
    mode: 'setup',
    tool: 'weights',
    selection: { ...emptySelection, slot: armSlot, attachment: 'arm', bones: [armLower], extraSlots: [twinSlot] },
  });
});

describe('the group of meshes', () => {
  it('is the selected mesh and the mesh each other selected slot shows', () => {
    expect(M.weightGroup()).toEqual([
      { slotId: armSlot, name: 'arm' },
      { slotId: twinSlot, name: 'twin' },
    ]);
    uiStore.patch({ selection: { ...uiStore.get().selection, extraSlots: [] } });
    expect(M.weightGroup()).toEqual([{ slotId: armSlot, name: 'arm' }]);
  });

  it('leaves out slots that show no mesh, and meshes that are linked', () => {
    const plain = doc().slots.find((s) => s.name === 'body')!.id;
    uiStore.patch({ selection: { ...uiStore.get().selection, extraSlots: [plain, twinSlot] } });
    expect(M.weightGroup().map((m) => m.slotId)).toEqual([armSlot, twinSlot]);
    docStore.update('link', (d) => {
      (d.skeleton.skins[0].attachments[twinSlot].twin as MeshAttachment).link = { source: 'arm', slot: armSlot, skin: null, deform: false };
    });
    expect(M.weightGroup().map((m) => m.slotId)).toEqual([armSlot]);
  });

  it('Ctrl-click adds a slot and takes it out again; it is dropped when the slot goes', () => {
    uiStore.patch({ selection: { ...uiStore.get().selection, extraSlots: [] } });
    A.toggleExtraSlot(twinSlot);
    expect(uiStore.get().selection.extraSlots).toEqual([twinSlot]);
    A.toggleExtraSlot(twinSlot);
    expect(uiStore.get().selection.extraSlots).toEqual([]);
    A.toggleExtraSlot(armSlot); // the selected slot itself is not "extra"
    expect(uiStore.get().selection.extraSlots).toEqual([]);
    A.toggleExtraSlot(twinSlot);
    A.deleteSlots([twinSlot]);
    A.sanitizeSelection();
    expect(uiStore.get().selection.extraSlots).toEqual([]);
  });

  it('commonBones are the bones that every mesh follows', () => {
    uiStore.patch({ selection: { ...uiStore.get().selection, extraSlots: [twinSlot, thirdSlot] } });
    expect(M.commonBones(M.weightGroup())).toEqual([armUpper]);
  });
});

describe('the tools on the group', () => {
  it('Prune works on every mesh and is one step of history', () => {
    const before = docStore.history.past.length;
    M.pruneMeshesWeights(0, 1);
    expect(docStore.history.past.length).toBe(before + 1);
    for (const [slot, name] of [
      [armSlot, 'arm'],
      [twinSlot, 'twin'],
    ] as const)
      expect(mesh(slot, name).weights!.every((l) => l.length === 1)).toBe(true);
    docStore.undo();
    expect(mesh(armSlot, 'arm').weights!.some((l) => l.length > 1)).toBe(true);
    expect(mesh(twinSlot, 'twin').weights!.some((l) => l.length > 1)).toBe(true);
  });

  it('Unbind and Bind work on every mesh', () => {
    M.unbindMeshesFromBones();
    expect(mesh(armSlot, 'arm').weights).toBeNull();
    expect(mesh(twinSlot, 'twin').weights).toBeNull();
    M.bindMeshesToBones([armUpper, armLower]);
    expect(mesh(armSlot, 'arm').weights).not.toBeNull();
    expect(mesh(twinSlot, 'twin').weights).not.toBeNull();
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('Swap and removing a bone work on every mesh', () => {
    M.swapMeshesWeights(armUpper, armLower);
    expect(mesh(twinSlot, 'twin').weights![0].map((e) => e[0])).toEqual(mesh(armSlot, 'arm').weights![0].map((e) => e[0]));
    M.removeBoneFromMeshes(armLower);
    for (const [slot, name] of [
      [armSlot, 'arm'],
      [twinSlot, 'twin'],
    ] as const)
      expect(
        mesh(slot, name)
          .weights!.flat()
          .some((e) => e[0] === armLower),
      ).toBe(false);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('the brush paints every mesh that follows its bone, and leaves the ones that do not', () => {
    uiStore.patch({
      selection: { ...uiStore.get().selection, extraSlots: [twinSlot, thirdSlot] },
      brush: { size: 800, strength: 1, mode: 'add', bone: armLower, feather: 100, locked: [] },
    });
    const before = JSON.stringify([mesh(armSlot, 'arm').weights, mesh(twinSlot, 'twin').weights, mesh(thirdSlot, 'third').weights]);
    const { mats, slotMat } = M.setupMats();
    const w = meshWorldPositions(mesh(armSlot, 'arm'), slotMat(armSlot), mats);
    docStore.beginGesture('Paint weights');
    M.paintWeightsGroup({ x: w[0], y: w[1] }, armLower);
    docStore.endGesture();
    const after = [mesh(armSlot, 'arm').weights, mesh(twinSlot, 'twin').weights, mesh(thirdSlot, 'third').weights];
    expect(JSON.stringify(after)).not.toBe(before);
    expect(JSON.stringify(after[0])).not.toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(JSON.stringify(after[1])).not.toBe(JSON.stringify(JSON.parse(before)[1]));
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(JSON.parse(before)[2])); // armLower does not move it
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('with one mesh only the tools behave as before', () => {
    uiStore.patch({ selection: { ...uiStore.get().selection, extraSlots: [] } });
    M.pruneMeshesWeights(0, 1);
    expect(mesh(armSlot, 'arm').weights!.every((l) => l.length === 1)).toBe(true);
    expect(mesh(twinSlot, 'twin').weights!.some((l) => l.length > 1)).toBe(true);
  });
});

describe('tracing several images at once', () => {
  const regionSlots = () =>
    doc()
      .slots.filter((sl) => doc().skins[0].attachments[sl.id]?.[sl.attachment ?? '']?.type === 'region')
      .map((sl) => sl.id);

  it('turns the image of every selected slot into a mesh in one step and keeps the group selected', () => {
    const [a, b] = regionSlots();
    const nameOf = (id: string) => doc().slots.find((x) => x.id === id)!.attachment!;
    uiStore.patch({ selection: { ...emptySelection, slot: a, attachment: nameOf(a), bones: [], extraSlots: [b, armSlot] } });
    expect(M.traceGroup().map((m) => m.slotId)).toEqual([a, b]); // the arm already shows a mesh
    const before = docStore.history.past.length;
    expect(M.convertImagesToMeshes('quad')).toBe(2);
    expect(docStore.history.past.length).toBe(before + 1);
    expect(doc().skins[0].attachments[a][nameOf(a)].type).toBe('mesh');
    expect(doc().skins[0].attachments[b][nameOf(b)].type).toBe('mesh');
    expect(uiStore.get().selection.extraSlots).toEqual([b, armSlot]);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(doc().skins[0].attachments[a][nameOf(a)].type).toBe('region');
    expect(doc().skins[0].attachments[b][nameOf(b)].type).toBe('region');
  });

  it('does nothing when no selected slot shows an image', () => {
    expect(M.traceGroup()).toEqual([]);
    expect(M.convertImagesToMeshes('quad')).toBe(0);
  });

  it('re-tracing leaves weighted meshes alone', () => {
    expect(M.regenerateMeshes({})).toBe(0);
  });
});
