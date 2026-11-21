/**
 * Crossfading the pictures of a slot: a partner slot above it fades the old picture out while the slot fades the new one in. The keys, the
 * partner and its pictures, the refusals, one history step, and the result against the official runtime.
 */
import { describe, expect, it } from 'vitest';
import { applyCrossfade, fadeRefusal, fadeSteps } from '../src/core/crossfade';
import { newAnimation } from '../src/core/model';
import type { Animation, Project, Slot } from '../src/core/model';
import { applyAnimation } from '../src/core/animate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { S, exportAndLoad } from './official';

/** The fixture with a clean animation "talk" that changes the picture of the slot "body" three times. */
function rig() {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const slot = doc.slots.find((s) => s.name === 'body')!;
  slot.dark = null;
  const talk = newAnimation('talk', 2);
  talk.slots[slot.id] = {
    attachment: [
      { time: 0.5, name: 'bodyAlt' },
      { time: 1, name: 'body' },
      { time: 1.05, name: null },
    ],
  };
  doc.animations.push(talk);
  return { project, doc, slot, talk };
}

describe('the steps', () => {
  it('lists each change with its fade, shortened to the time before the next change', () => {
    const { slot, talk } = rig();
    const steps = fadeSteps(slot, talk, 0.2);
    expect(steps.map((s) => [s.time, s.from, s.to])).toEqual([
      [0.5, 'body', 'bodyAlt'],
      [1, 'bodyAlt', 'body'],
      [1.05, 'body', null],
    ]);
    expect(steps[0].seconds).toBeCloseTo(0.2, 9);
    expect(steps[1].seconds).toBeCloseTo(0.05, 9);
    expect(steps[2].seconds).toBeCloseTo(0.2, 9);
  });

  it('is cut short by the end of the animation, and a key that changes nothing is not a step', () => {
    const { slot, talk } = rig();
    talk.slots[slot.id].attachment!.push({ time: 1.1, name: null }, { time: 1.95, name: 'bodyAlt' });
    const steps = fadeSteps(slot, talk, 1);
    expect(steps).toHaveLength(4);
    expect(steps[3].seconds).toBeCloseTo(0.05, 9);
  });
});

describe('keys that are closer than the editor tells apart', () => {
  it('a fade that ends a hair before the next change leaves a document with nothing to repair', () => {
    const { project, doc, slot, talk } = rig();
    // the first fade (0.5 .. 0.7) ends 0.00005 s before the next change: the end key and the next start key count as one time
    talk.slots[slot.id].attachment = [
      { time: 0.5, name: 'bodyAlt' },
      { time: 0.70005, name: 'body' },
    ];
    expect(applyCrossfade(doc, talk.id, slot.id, 0.2)).not.toBeNull();
    expect(validateProject(project)).toEqual([]);
  });

  it('a fade shorter than two key tolerances is not made', () => {
    const { doc, slot, talk } = rig();
    expect(applyCrossfade(doc, talk.id, slot.id, 0.0001)).toBeNull();
  });
});

describe('the refusals', () => {
  it('refuses a slot without picture keys, with a dark color, or with color keys', () => {
    const { doc, slot, talk } = rig();
    const other = doc.slots.find((s) => s.id !== slot.id)!;
    expect(fadeRefusal(doc, other, talk)).toBe('no-keys');
    expect(fadeRefusal(doc, slot, talk)).toBeNull();
    talk.slots[slot.id].rgba = [{ time: 0, value: [1, 1, 1, 1] }];
    expect(fadeRefusal(doc, slot, talk)).toBe('color-keys');
    delete talk.slots[slot.id].rgba;
    slot.dark = [0, 0, 0];
    expect(fadeRefusal(doc, slot, talk)).toBe('two-color');
  });

  it('makes nothing when no fade has any length', () => {
    const { doc, slot, talk } = rig();
    expect(applyCrossfade(doc, talk.id, slot.id, 0)).toBeNull();
    expect(doc.slots.some((s) => s.name === 'body fade')).toBe(false);
  });
});

describe('the result', () => {
  it('adds a partner slot right above with copies of the pictures, and keys both', () => {
    const { doc, slot, talk } = rig();
    const slots = doc.slots.length;
    const r = applyCrossfade(doc, talk.id, slot.id, 0.2)!;
    expect(r.fades).toBe(3);
    expect(doc.slots.length).toBe(slots + 1);
    const partner = doc.slots.find((s) => s.id === r.partner)!;
    expect(doc.slots[doc.slots.indexOf(slot) + 1]).toBe(partner);
    expect(partner.name).toBe('body fade');
    expect(partner.bone).toBe(slot.bone);
    expect(partner.attachment).toBeNull();
    expect(Object.keys(doc.skins[0].attachments[partner.id]).sort()).toEqual(['body', 'bodyAlt']);
    expect(doc.skins[0].attachments[partner.id].body).not.toBe(doc.skins[0].attachments[slot.id].body);
    const main = talk.slots[slot.id].rgba!;
    expect(main[0]).toMatchObject({ time: 0.5 });
    expect(main[0].value[3]).toBe(0);
    expect(talk.slots[partner.id].attachment).toEqual([
      { time: 0.5, name: 'body' },
      { time: 0.7, name: null },
      { time: 1, name: 'bodyAlt' },
      // the second fade ends where the third starts: the start of the third key wins
      { time: 1.05, name: 'body' },
      { time: 1.25, name: null },
    ]);
    // the attachment keys of the slot itself stay as they were
    expect(talk.slots[slot.id].attachment).toHaveLength(3);
  });

  it('puts the partner in the folder of the slot', () => {
    const { doc, slot, talk } = rig();
    doc.drawOrderFolders = [{ id: 'f1', name: 'face', slots: [slot.id] }];
    const r = applyCrossfade(doc, talk.id, slot.id, 0.2)!;
    expect(doc.drawOrderFolders[0].slots).toEqual([slot.id, r.partner]);
  });

  it('is a valid project', () => {
    const { project, slot, talk } = rig();
    applyCrossfade(project.skeleton, talk.id, slot.id, 0.2);
    expect(validateProject(project).filter((p: any) => p.level === 'error')).toEqual([]);
  });
});

function ours(project: Project, anim: Animation, t: number) {
  const sk = createSkeleton(compileSkeleton(structuredClone(project.skeleton)));
  applyAnimation(sk, anim, t);
  return sk;
}

describe('against the official runtime', () => {
  it('shows both pictures at half strength in the middle of a fade, like our own pose', () => {
    const { project, slot, talk } = rig();
    const r = applyCrossfade(project.skeleton, talk.id, slot.id, 0.2)!;
    const partnerName = project.skeleton.slots.find((s) => s.id === r.partner)!.name;
    const { skeletonData } = exportAndLoad(project);
    const times = [0, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.99, 1, 1.02, 1.05, 1.1, 1.15, 1.25, 1.5, 1.9];
    for (const t of times) {
      const sk = new S.Skeleton(skeletonData);
      sk.setupPose();
      const state = new S.AnimationState(new S.AnimationStateData(skeletonData));
      state.setAnimation(0, 'talk', false);
      state.update(t);
      state.apply(sk);
      const mine = ours(project, talk, t);
      for (const [name, id] of [
        [slot.name, slot.id],
        [partnerName, r.partner],
      ] as const) {
        const official = sk.findSlot(name).pose;
        const theirs = mine.slotById(id)!;
        expect(official.attachment?.name ?? null, `${name} picture at ${t}`).toBe(theirs.attachmentName ?? null);
        expect(official.color.a, `${name} alpha at ${t}`).toBeCloseTo(theirs.color[3], 4);
      }
    }
    // at 0.6 the new picture is half in and the old one half out
    const mid = ours(project, talk, 0.6);
    expect(mid.slotById(slot.id)!.attachmentName).toBe('bodyAlt');
    expect(mid.slotById(slot.id)!.color[3]).toBeCloseTo(0.5, 6);
    expect(mid.slotById(r.partner)!.attachmentName).toBe('body');
    expect(mid.slotById(r.partner)!.color[3]).toBeCloseTo(0.5, 6);
    // afterwards only the new picture shows
    const done = ours(project, talk, 0.8);
    expect(done.slotById(slot.id)!.color[3]).toBeCloseTo(1, 6);
    expect(done.slotById(r.partner)!.attachmentName ?? null).toBeNull();
  });
});

describe('the action', () => {
  function open() {
    const r = rig();
    docStore.replace(r.project);
    uiStore.patch({ animationId: r.talk.id, time: 0, playing: false, selectedKeys: [] });
    return r;
  }

  it('is one history step, and undo takes the partner slot away again', () => {
    const { slot } = open();
    const slots = docStore.get().skeleton.slots.length;
    const id = A.crossfadeSlot(slot.id, 0.2);
    expect(id).toBeTruthy();
    expect(docStore.get().skeleton.slots.length).toBe(slots + 1);
    expect(docStore.undoLabel).toBe('Crossfade pictures');
    docStore.undo();
    expect(docStore.get().skeleton.slots.length).toBe(slots);
  });

  it('changes nothing when the slot cannot fade, and a second run is refused (the slot has color keys now)', () => {
    const { slot, doc } = open();
    const other = doc.slots.find((s: Slot) => s.id !== slot.id)!;
    const rev = docStore.revision;
    expect(A.crossfadeSlot(other.id, 0.2)).toBeNull();
    expect(docStore.revision).toBe(rev);
    expect(A.crossfadeSlot(slot.id, 0.2)).toBeTruthy();
    const rev2 = docStore.revision;
    expect(A.crossfadeSlot(slot.id, 0.2)).toBeNull();
    expect(docStore.revision).toBe(rev2);
  });
});
