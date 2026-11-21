/**
 * Sequences (frame-by-frame pictures): the names of the frames, the frame every mode shows at every time, the JSON and binary files
 * and the import, all against the OFFICIAL runtime (spine-core 4.3): its loader has to accept what we write, and its SequenceTimeline
 * has to show the same frame as ours at every sampled time.
 */
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { jsonToBinary } from '../src/core/export/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { meshFromRegion } from '../src/core/mesh';
import { SEQUENCE_MODES, newAnimation, newSkin } from '../src/core/model';
import type { Animation, Attachment, MeshAttachment, Project, RegionAttachment, SequenceDef, SequenceKey } from '../src/core/model';
import {
  attachmentPictures,
  cleanSequence,
  detectSequence,
  cleanSequenceKey,
  resolveSequenceIndex,
  sequenceFrameNames,
  sequenceFramePath,
  sequenceIndexAt,
  setupPicture,
} from '../src/core/sequence';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { repairProject, validateProject } from '../src/core/validate';
import { duplicateSkin } from '../src/core/skins';
import { moveKeys, removeKeys, resolveKeys } from '../src/core/keyrefs';
import { buildRows } from '../src/core/timelineRows';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as SQ from '../src/store/sequenceActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { loadOfficial, loadOfficialBinary } from './official';

const SEQ: SequenceDef = { count: 6, start: 3, digits: 2, setupIndex: 1 };

const key = (time: number, mode: SequenceKey['mode'], index: number, delay: number): SequenceKey => ({ time, mode, index, delay });

/** Keys that use every mode, some of them twice, with delays that are not multiples of the frame rate. */
const KEYS: SequenceKey[] = [
  key(0.2, 'hold', 2, 0.1),
  key(0.5, 'loop', 0, 0.1),
  key(0.9, 'pingpong', 1, 0.12),
  key(1.4, 'once', 1, 0.15),
  key(1.9, 'onceReverse', 0, 0.2),
  key(2.3, 'loopReverse', 2, 0.07),
  key(2.8, 'pingpongReverse', 0, 0.11),
  key(3.4, 'hold', 4, 0.1),
];

interface Rig {
  project: Project;
  slotId: string;
  name: string;
  animation: Animation;
  skinId: string;
}

/** The fixture with one slot showing a sequence (a region, or a mesh made from one) and an animation `fx` with sequence keys. */
function rig(kind: 'region' | 'mesh'): Rig {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const skin = doc.skins[0];
  let slotId = '';
  let base: RegionAttachment | undefined;
  for (const [sid, per] of Object.entries(skin.attachments)) {
    const found = Object.values(per).find((a): a is RegionAttachment => a.type === 'region');
    if (found) {
      slotId = sid;
      base = found;
      break;
    }
  }
  if (!base) throw new Error('the fixture has no region');
  const region: RegionAttachment = { ...structuredClone(base), name: 'flame', path: 'flame_', sequence: { ...SEQ } };
  const att: Attachment = kind === 'region' ? region : { ...meshFromRegion(region), name: 'flame', path: 'flame_', sequence: { ...SEQ } };
  skin.attachments[slotId].flame = att;
  doc.slots.find((s) => s.id === slotId)!.attachment = 'flame';
  for (const picture of attachmentPictures(att))
    project.images.push({ id: picture, name: picture, width: base.width || 32, height: base.height || 32 });
  const animation = newAnimation('fx', 4);
  animation.sequence = { [skin.id]: { [slotId]: { flame: KEYS.map((k) => ({ ...k })) } } };
  doc.animations.push(animation);
  return { project, slotId, name: 'flame', animation, skinId: skin.id };
}

function atlasFor(project: Project): string {
  const used = new Set<string>();
  for (const skin of project.skeleton.skins)
    for (const per of Object.values(skin.attachments))
      for (const a of Object.values(per)) for (const p of attachmentPictures(a)) used.add(p);
  const pages = packAtlas(
    project.images.filter((i) => used.has(i.name)).map((i) => ({ name: i.name, width: i.width, height: i.height })),
    { maxSize: 2048, padding: 2 },
  );
  return writeAtlas(pages, (i) => `atlas${i}.png`);
}

/** The frame the official runtime shows for a slot at time t of an animation (its resolved index into the sequence). */
function officialFrame(sd: any, animation: string, slotName: string, t: number): { frame: number; region: string } {
  const sk = new (spine as any).Skeleton(sd);
  sk.setupPose();
  const state = new (spine as any).AnimationState(new (spine as any).AnimationStateData(sd));
  state.setAnimation(0, animation, false);
  state.update(t);
  state.apply(sk);
  sk.updateWorldTransform((spine as any).Physics.update);
  const slot = sk.slots.find((s: any) => s.data.name === slotName);
  const att = slot.appliedPose.attachment;
  const frame = att.sequence.resolveIndex(slot.appliedPose);
  return { frame, region: att.sequence.regions[frame].name };
}

describe('frame names and indexes', () => {
  it('names the pictures like the official Sequence.getPath', () => {
    expect(sequenceFramePath('flame_', SEQ, 0)).toBe('flame_03');
    expect(sequenceFramePath('flame_', SEQ, 5)).toBe('flame_08');
    expect(sequenceFramePath('x', { count: 3, start: 0, digits: 0, setupIndex: 0 }, 2)).toBe('x2');
    expect(sequenceFramePath('x', { count: 3, start: 98, digits: 3, setupIndex: 0 }, 2)).toBe('x100');
    expect(sequenceFrameNames('f', { count: 3, start: 1, digits: 2, setupIndex: 0 })).toEqual(['f01', 'f02', 'f03']);
  });

  it('shows the setup frame without a key, and never a frame past the end', () => {
    expect(resolveSequenceIndex(SEQ, -1)).toBe(1);
    expect(resolveSequenceIndex(SEQ, 4)).toBe(4);
    expect(resolveSequenceIndex(SEQ, 99)).toBe(5);
    expect(sequenceIndexAt([], 1, 6)).toBe(-1);
    expect(sequenceIndexAt(KEYS, 0.1, 6)).toBe(-1);
  });

  it('lists the pictures an attachment needs, and its setup picture', () => {
    const r = rig('region');
    const att = r.project.skeleton.skins[0].attachments[r.slotId].flame;
    expect(attachmentPictures(att)).toEqual(['flame_03', 'flame_04', 'flame_05', 'flame_06', 'flame_07', 'flame_08']);
    expect(setupPicture(att)).toBe('flame_04');
    const plain = Object.values(r.project.skeleton.skins[0].attachments[r.slotId]).find((a) => a.type === 'region' && !a.sequence)!;
    expect(attachmentPictures(plain)).toEqual([(plain as RegionAttachment).path]);
  });

  it('repairs a damaged sequence and damaged keys', () => {
    expect(cleanSequence({ count: 0, start: -3, digits: 99, setupIndex: 50 })).toEqual({ count: 1, start: 0, digits: 9, setupIndex: 0 });
    expect(cleanSequence(undefined)).toEqual({ count: 1, start: 1, digits: 0, setupIndex: 0 });
    expect(cleanSequenceKey({ time: -1, mode: 'zigzag' as any, index: 2.7, delay: -4 })).toEqual({
      time: 0,
      mode: 'hold',
      index: 2,
      delay: 0,
    });
  });
});

for (const kind of ['region', 'mesh'] as const) {
  describe(`a ${kind} with a sequence against the official runtime`, () => {
    const r = rig(kind);
    const doc = r.project.skeleton;
    const json = exportSpineJson(doc);
    const atlas = atlasFor(r.project);
    const sd = loadOfficial(json, atlas);
    const slotName = doc.slots.find((s) => s.id === r.slotId)!.name;

    it('is a valid project', () => {
      expect(validateProject(r.project)).toEqual([]);
    });

    it('is written the way the loader reads it', () => {
      const att = (json as any).skins.find((s: any) => s.name === 'default').attachments[slotName].flame;
      expect(att.sequence).toEqual({ count: 6, start: 3, digits: 2, setup: 1 });
      const keys = (json as any).animations.fx.attachments.default[slotName].flame.sequence;
      expect(keys).toHaveLength(KEYS.length);
      const slot = sd.findSlot(slotName);
      const official = sd.findSkin('default').getAttachment(slot.index, 'flame');
      expect(official.sequence.regions.map((x: any) => x.name)).toEqual([
        'flame_03',
        'flame_04',
        'flame_05',
        'flame_06',
        'flame_07',
        'flame_08',
      ]);
      expect(official.sequence.setupIndex).toBe(1);
    });

    it('shows the same frame as the official runtime at every sampled time', () => {
      const data = compileSkeleton(doc);
      let compared = 0;
      const seen = new Set<number>();
      for (let t = 0; t <= 4 + 1e-9; t += 0.0377) {
        const ours = createSkeleton(data);
        applyAnimation(ours, r.animation, t);
        const slot = ours.slots.find((s) => s.data.name === slotName)!;
        const att = ours.slotAttachment(slot)!;
        const seq = (att as any).src.sequence as SequenceDef;
        const mine = resolveSequenceIndex(seq, slot.sequenceIndex);
        const off = officialFrame(sd, 'fx', slotName, t);
        expect(mine, `t=${t.toFixed(4)}`).toBe(off.frame);
        expect(sequenceFramePath('flame_', seq, mine)).toBe(off.region);
        seen.add(mine);
        compared++;
      }
      expect(compared).toBeGreaterThan(100);
      expect(seen.size).toBeGreaterThanOrEqual(5); // the keys really move through the frames
    });

    it('is read back from the binary file the same, by the official binary reader', () => {
      const bytes = jsonToBinary(json);
      const sdb = loadOfficialBinary(bytes, atlas);
      for (let t = 0; t <= 4; t += 0.173) {
        expect(officialFrame(sdb, 'fx', slotName, t), `t=${t.toFixed(3)}`).toEqual(officialFrame(sd, 'fx', slotName, t));
      }
    });

    it('survives our own import of the JSON', () => {
      const back = importSpineJson(JSON.parse(JSON.stringify(json))).project;
      const skin = back.skeleton.skins[0];
      const slot = back.skeleton.slots.find((s) => s.name === slotName)!;
      const att = skin.attachments[slot.id].flame as RegionAttachment | MeshAttachment;
      expect(att.sequence).toEqual(SEQ);
      const keys = back.skeleton.animations.find((a) => a.name === 'fx')!.sequence![skin.id][slot.id].flame;
      expect(keys).toEqual(KEYS);
      expect(back.images.map((i) => i.name)).toEqual(expect.arrayContaining(['flame_03', 'flame_08']));
      expect(validateProject(back)).toEqual([]);
    });
  });
}

describe('sequence keys in a project', () => {
  it('are dropped by the repair when the attachment has no sequence, and sorted and merged otherwise', () => {
    const r = rig('region');
    const a = r.project.skeleton.animations.find((x) => x.name === 'fx')!;
    a.sequence![r.skinId][r.slotId].flame = [
      key(1, 'loop', 0, 0.1),
      key(0.5, 'once', 0, 0.1),
      key(1, 'hold', 3, 0.2),
      { time: NaN, mode: 'hold', index: 0, delay: 0 },
    ];
    expect(repairProject(r.project).some((m) => /sequence keys/.test(m))).toBe(true);
    const keys = a.sequence![r.skinId][r.slotId].flame;
    expect(keys.map((k) => [k.time, k.mode])).toEqual([
      [0.5, 'once'],
      [1, 'hold'],
    ]);
    delete (r.project.skeleton.skins[0].attachments[r.slotId].flame as RegionAttachment).sequence;
    expect(repairProject(r.project).some((m) => /no sequence/.test(m))).toBe(true);
    expect(a.sequence).toBeUndefined();
  });

  it('are part of the length of the animation', () => {
    const r = rig('region');
    const a = r.project.skeleton.animations.find((x) => x.name === 'fx')!;
    a.duration = 1;
    repairProject(r.project);
    expect(a.duration).toBeGreaterThanOrEqual(3.4);
  });

  it('every mode name the editor knows is one the loader knows', () => {
    const r = rig('region');
    const doc = r.project.skeleton;
    const a = r.project.skeleton.animations.find((x) => x.name === 'fx')!;
    a.sequence![r.skinId][r.slotId].flame = SEQUENCE_MODES.map((m, i) => key(i * 0.5, m, 0, 0.1));
    expect(() => loadOfficial(exportSpineJson(doc), atlasFor(r.project))).not.toThrow();
  });
});

describe('finding the series of pictures', () => {
  const names = [
    'flame01',
    'flame02',
    'flame03',
    'flame04',
    'flame07',
    'flame08',
    'smoke_1',
    'smoke_2',
    'smoke_3',
    'smoke_10',
    'blink',
    'x9',
    'x10',
    'x11',
  ];

  it('takes the run of consecutive numbers around the picture', () => {
    expect(detectSequence(names, 'flame02')).toEqual({ path: 'flame', sequence: { count: 4, start: 1, digits: 2, setupIndex: 1 } });
    expect(detectSequence(names, 'flame07')).toEqual({ path: 'flame', sequence: { count: 2, start: 7, digits: 2, setupIndex: 0 } });
  });

  it('reads numbers without padding, and a run that crosses a power of ten', () => {
    expect(detectSequence(names, 'smoke_1')).toEqual({ path: 'smoke_', sequence: { count: 3, start: 1, digits: 0, setupIndex: 0 } });
    expect(detectSequence(names, 'x10')).toEqual({ path: 'x', sequence: { count: 3, start: 9, digits: 0, setupIndex: 1 } });
  });

  it('works from the start of the names, and finds nothing for a single picture', () => {
    expect(detectSequence(names, 'flame')?.sequence.count).toBe(4);
    expect(detectSequence(names, 'blink')).toBeNull();
    expect(detectSequence(names, 'smoke_10')).toBeNull();
  });
});

describe('sequence actions', () => {
  function setUp() {
    const r = rig('region');
    // an attachment that shows one picture of a series, like after dropping flame03 … flame08 into the scene
    const att = r.project.skeleton.skins[0].attachments[r.slotId].flame as RegionAttachment;
    att.path = 'flame_05';
    delete att.sequence;
    r.project.skeleton.animations = r.project.skeleton.animations.filter((a) => a.name !== 'fx');
    docStore.replace(r.project);
    uiStore.patch({
      mode: 'setup',
      tool: 'select',
      animationId: null,
      skinId: null,
      time: 0,
      selection: emptySelection,
      overrides: {},
      autoKey: true,
      playing: false,
    });
    return r;
  }
  const attOf = (r: Rig) => docStore.get().skeleton.skins[0].attachments[r.slotId].flame as RegionAttachment;

  it('makes a sequence out of the numbered pictures, and takes it away again', () => {
    const r = setUp();
    expect(SQ.makeSequence(r.slotId, 'flame')).toBe(6);
    expect(attOf(r).path).toBe('flame_');
    expect(attOf(r).sequence).toEqual({ count: 6, start: 3, digits: 2, setupIndex: 2 });
    expect(repairProject(structuredClone(docStore.get()))).toEqual([]);
    expect(SQ.setSequence(r.slotId, 'flame', null)).toBe(true);
    expect(attOf(r).sequence).toBeUndefined();
    expect(attOf(r).path).toBe('flame_05'); // it keeps showing the picture of its setup frame
    docStore.undo();
    expect(attOf(r).sequence).toBeDefined();
  });

  it('changes nothing when there are no numbered pictures', () => {
    const r = setUp();
    docStore.update(
      't',
      (d) =>
        void (d.skeleton.skins[0].attachments[r.slotId].flame = {
          ...(d.skeleton.skins[0].attachments[r.slotId].flame as RegionAttachment),
          path: 'lonely',
        }),
    );
    expect(SQ.makeSequence(r.slotId, 'flame')).toBe(0);
    expect(attOf(r).sequence).toBeUndefined();
  });

  it('a dropped folder with a numbered series becomes one slot with a sequence, in one history step', () => {
    const r = setUp();
    const names = docStore.get().images.map((i) => i.name);
    const slots0 = docStore.get().skeleton.slots.length;
    expect(SQ.placeSequences([...names, 'single'], 10, 20)).toBe(1);
    const slots = docStore.get().skeleton.slots;
    expect(slots.length).toBe(slots0 + 1);
    const made = slots[slots.length - 1];
    const att = Object.values(docStore.get().skeleton.skins[0].attachments[made.id])[0] as RegionAttachment;
    expect(att.sequence).toEqual({ count: 6, start: 3, digits: 2, setupIndex: 0 });
    expect(att.path).toBe('flame_');
    docStore.undo();
    expect(docStore.get().skeleton.slots.length).toBe(slots0);
    expect(SQ.placeSequences(['a', 'b'], 0, 0)).toBe(0);
    void r;
  });

  it('keys the sequence at the playhead, taking what is not given from the key in force', () => {
    const r = setUp();
    SQ.makeSequence(r.slotId, 'flame');
    const animId = A.createAnimation('fx2', 3);
    uiStore.patch({ mode: 'animate', animationId: animId, time: 0.5 });
    SQ.keySequence(r.slotId, 'flame', { mode: 'loop', delay: 0.08 });
    uiStore.patch({ time: 1.25 });
    SQ.keySequence(r.slotId, 'flame', { index: 4 });
    const keys = A.currentAnimation()!.sequence![docStore.get().skeleton.skins[0].id][r.slotId].flame;
    expect(keys).toEqual([key(0.5, 'loop', 0, 0.08), key(1.25, 'loop', 4, 0.08)]);
    expect(SQ.sequenceKeyAt(r.slotId, 'flame', 1)).toEqual(keys[0]);
    expect(SQ.sequenceKeyAt(r.slotId, 'flame', 0.2)).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
    // removing the sequence takes its keys with it
    SQ.setSequence(r.slotId, 'flame', null);
    expect(A.currentAnimation()!.sequence).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('refuses to rename a picture that is a frame, keeps a sequence path when its base image is renamed', () => {
    const r = setUp();
    SQ.makeSequence(r.slotId, 'flame');
    expect(A.renameImageAction('flame_04', 'renamed')).toBeNull();
    expect(docStore.get().images.some((i) => i.name === 'flame_04')).toBe(true);
    docStore.update('t', (d) => void d.images.push({ id: 'base', name: 'flame_', width: 8, height: 8 }));
    expect(A.renameImageAction('flame_', 'other')).toBe('other');
    expect(attOf(r).path).toBe('flame_');
  });

  it('drops the sequence keys with the slot', () => {
    const r = setUp();
    SQ.makeSequence(r.slotId, 'flame');
    const animId = A.createAnimation('fx3', 2);
    uiStore.patch({ mode: 'animate', animationId: animId, time: 0.4 });
    SQ.keySequence(r.slotId, 'flame', { mode: 'once', delay: 0.1 });
    expect(docStore.get().skeleton.animations.find((a) => a.id === animId)!.sequence).toBeDefined();
    A.deleteSlots([r.slotId]);
    expect(docStore.get().skeleton.animations.find((a) => a.id === animId)!.sequence).toBeUndefined();
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('copies the sequence keys with a skin', () => {
    const r = rig('region');
    const doc = r.project.skeleton;
    const alt = newSkin('alt');
    doc.skins.push(alt);
    r.animation.sequence![alt.id] = structuredClone(r.animation.sequence![r.skinId]);
    const copy = duplicateSkin(doc, alt.id)!;
    expect(r.animation.sequence![copy.id]).toEqual(r.animation.sequence![alt.id]);
    expect(r.animation.sequence![copy.id]).not.toBe(r.animation.sequence![alt.id]);
  });
});

describe('sequence keys in the dopesheet', () => {
  it('have a row of their own, and their keys can be addressed, moved and removed like any key', () => {
    const r = rig('region');
    const doc = r.project.skeleton;
    const rows = buildRows(doc, r.animation, [], null, {});
    const row = rows.find((x) => x.id.startsWith('sequence:'))!;
    expect(row).toBeTruthy();
    expect(rows.some((x) => x.id === 'g:sequence')).toBe(true);
    expect(row.keys.map((k) => k.time)).toEqual(KEYS.map((k) => k.time));
    const refs = row.keys.slice(0, 2).map((k) => k.refs[0]);
    expect(resolveKeys(r.animation, refs[0])).toBe(r.animation.sequence![r.skinId][r.slotId].flame);
    moveKeys(r.animation, refs, 0.05);
    expect(r.animation.sequence![r.skinId][r.slotId].flame.slice(0, 2).map((k) => k.time)).toEqual([0.25, 0.55]);
    removeKeys(r.animation, [
      { ...refs[0], time: 0.25 },
      { ...refs[1], time: 0.55 },
    ]);
    expect(r.animation.sequence![r.skinId][r.slotId].flame).toHaveLength(KEYS.length - 2);
    removeKeys(
      r.animation,
      r.animation.sequence![r.skinId][r.slotId].flame.map((k) => ({ ...refs[0], time: k.time })),
    );
    expect(r.animation.sequence).toBeUndefined();
  });
});
