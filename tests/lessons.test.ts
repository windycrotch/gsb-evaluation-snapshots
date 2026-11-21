/** The lessons: the data is complete in both languages, every step condition says what it should, and the store follows the editor. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURVES_LESSON,
  FOX_LESSON,
  IK_LESSON,
  LESSONS,
  MESH_LESSON,
  RIG_LESSON,
  SKINS_LESSON,
  EXPORT_LESSON,
  lessonById,
  progressOf,
} from '../src/core/lessons';
import type { LessonState } from '../src/core/lessons';
import { meshFromRegion } from '../src/core/mesh';
import { emptyProject, newAnimation, newBone, newSlot } from '../src/core/model';
import type { RegionAttachment } from '../src/core/model';
import { selectBone, selectSlot, setMode } from '../src/store/actions';
import { setBonePose } from '../src/store/boneActions';
import { createEvent, keyEvent } from '../src/store/eventActions';
import { createIkFromDrag } from '../src/store/ikActions';
import { createSkin, setActiveSkin } from '../src/store/skinActions';
import { setKeyCurveHandle, setKeysCurve } from '../src/store/keyframeActions';
import { encodeKey } from '../src/core/keyrefs';
import type { KeyRef } from '../src/core/keyrefs';
import { docStore } from '../src/store/doc';
import { learnStore, noteExport, offerLesson, readLearn, skipStep, startLesson, stopLesson } from '../src/store/learn';
import { emptySelection, uiStore } from '../src/store/ui';

const state = (over: Partial<LessonState> = {}): LessonState => ({
  mode: 'setup',
  selectedBones: 0,
  edits: 0,
  keys: 0,
  playing: false,
  images: 0,
  bones: 1,
  ownSlots: 0,
  slotSelected: false,
  meshes: 0,
  weightedMeshes: 0,
  ikConstraints: 0,
  editsSinceIk: 0,
  selectedKeys: 0,
  interpEdits: 0,
  handleEdits: 0,
  seenGraph: false,
  skins: 1,
  events: 0,
  eventKeys: 0,
  skinSwitches: 0,
  zips: 0,
  players: 0,
  seenWeightsTool: false,
  seenPlaying: false,
  seenExport: false,
  ...over,
});

const TARGETS = ['tree', 'viewport', 'inspector', 'mode', 'play', 'export', 'images', 'toolIk', 'timeline', 'graph'];
const russian = (s: string) => /[а-яё]/i.test(s);

describe('lesson data', () => {
  it('has every text in both languages, unique ids and known targets', () => {
    const ids = new Set<string>();
    for (const lesson of LESSONS) {
      expect(ids.has(lesson.id)).toBe(false);
      ids.add(lesson.id);
      for (const t of [lesson.title, lesson.intro, lesson.outro]) {
        expect(t.en.trim().length).toBeGreaterThan(3);
        expect(russian(t.ru), `Russian text: ${t.ru}`).toBe(true);
        expect(russian(t.en), `English text: ${t.en}`).toBe(false);
      }
      const stepIds = new Set<string>();
      for (const step of lesson.steps) {
        expect(stepIds.has(step.id)).toBe(false);
        stepIds.add(step.id);
        expect(TARGETS).toContain(step.target);
        for (const t of [step.title, step.text]) {
          expect(t.en.trim().length).toBeGreaterThan(3);
          expect(russian(t.ru), `Russian text: ${t.ru}`).toBe(true);
          expect(russian(t.en), `English text: ${t.en}`).toBe(false);
        }
      }
    }
    expect(lessonById('fox')).toBe(FOX_LESSON);
    expect(lessonById('nope')).toBeUndefined();
  });
});

describe('the steps of the fox lesson', () => {
  const base = state({ edits: 3, keys: 10 });
  const done = (id: string, s: LessonState) => FOX_LESSON.steps.find((x) => x.id === id)!.done(s, base);

  it('pick a bone: a bone is selected', () => {
    expect(done('select', state())).toBe(false);
    expect(done('select', state({ selectedBones: 1 }))).toBe(true);
  });
  it('change it: only an edit made after the lesson began counts, not one that was there before', () => {
    expect(done('edit', state({ edits: 3 }))).toBe(false);
    expect(done('edit', state({ edits: 4 }))).toBe(true);
  });
  it('animate: the mode is Animate, however it got there', () => {
    expect(done('animate', state())).toBe(false);
    expect(done('animate', state({ mode: 'animate' }))).toBe(true);
  });
  it('play: playback was on at some moment, it may be off again', () => {
    expect(done('play', state({ playing: false }))).toBe(false);
    expect(done('play', state({ seenPlaying: true }))).toBe(true);
  });
  it('key: the skeleton has more keys than when the lesson began', () => {
    expect(done('key', state({ keys: 10 }))).toBe(false);
    expect(done('key', state({ keys: 11 }))).toBe(true);
  });
  it('export: the Export window was opened', () => {
    expect(done('export', state())).toBe(false);
    expect(done('export', state({ seenExport: true }))).toBe(true);
  });
});

describe('progress', () => {
  const base = state();
  it('starts at the first step and counts nothing done', () => {
    const p = progressOf(FOX_LESSON, state(), base, []);
    expect(p.current).toBe(0);
    expect(p.doneCount).toBe(0);
    expect(p.marks.every((m) => m === 'todo')).toBe(true);
  });
  it('does not depend on the order: a later step done first is done, and the first step is still in front', () => {
    const p = progressOf(FOX_LESSON, state({ mode: 'animate' }), base, []);
    expect(p.marks[2]).toBe('done');
    expect(p.current).toBe(0);
    expect(p.doneCount).toBe(1);
  });
  it('a step that was done stays done when the editor leaves its state (kept), a skipped one does not', () => {
    const p = progressOf(FOX_LESSON, state(), base, ['edit'], ['select', 'edit']);
    expect(p.marks[0]).toBe('done');
    expect(p.marks[1]).toBe('done');
    expect(p.current).toBe(2);
  });
  it('a skipped step moves the lesson on, and becomes done when the editor gets there by itself', () => {
    const skipped = progressOf(FOX_LESSON, state(), base, ['select']);
    expect(skipped.marks[0]).toBe('skipped');
    expect(skipped.current).toBe(1);
    expect(skipped.doneCount).toBe(0);
    const later = progressOf(FOX_LESSON, state({ selectedBones: 2 }), base, ['select']);
    expect(later.marks[0]).toBe('done');
  });
  it('is over (current -1) when every step is done or skipped', () => {
    const all = state({ selectedBones: 1, edits: 1, mode: 'animate', seenPlaying: true, keys: 1, seenExport: true });
    const p = progressOf(FOX_LESSON, all, base, []);
    expect(p.current).toBe(-1);
    expect(p.doneCount).toBe(FOX_LESSON.steps.length);
    const every = FOX_LESSON.steps.map((s) => s.id);
    expect(progressOf(FOX_LESSON, state(), base, every).current).toBe(-1);
  });
});

describe('what is remembered', () => {
  it('keeps only known lesson ids and a real boolean', () => {
    expect(readLearn(JSON.stringify({ finished: ['fox', 'zzz', 4], offered: true }))).toEqual({ finished: ['fox'], offered: true });
    expect(readLearn('not json')).toEqual({ finished: [], offered: false });
    expect(readLearn(null)).toEqual({ finished: [], offered: false });
    expect(readLearn(JSON.stringify({ offered: 'yes' })).offered).toBe(false);
  });
});

describe('the lesson in the store follows the editor', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    const p = emptyProject('lesson');
    const arm = newBone({ name: 'arm', parent: p.skeleton.bones[0].id, length: 40 });
    p.skeleton.bones.push(arm);
    p.skeleton.animations.push(newAnimation('wave', 1));
    docStore.replace(p);
    uiStore.patch({
      mode: 'setup',
      selection: emptySelection,
      playing: false,
      exportOpen: false,
      animationId: null,
      time: 0,
      overrides: {},
    });
  });

  it('walks through the whole lesson with the real actions of the editor, and remembers that it was finished', () => {
    const arm = docStore.get().skeleton.bones[1].id;
    startLesson('fox');
    expect(learnStore.get().progress?.current).toBe(0);

    selectBone(arm);
    expect(learnStore.get().progress?.current).toBe(1);

    setBonePose([{ id: arm, props: { rotation: 20 } }]);
    expect(learnStore.get().progress?.marks[1]).toBe('done');

    setMode('animate');
    expect(learnStore.get().progress?.marks[2]).toBe('done');

    uiStore.patch({ playing: true });
    uiStore.patch({ playing: false });
    expect(learnStore.get().progress?.marks[3]).toBe('done'); // it stays done after the playback stopped

    setBonePose([{ id: arm, props: { rotation: 45 } }]); // Auto key is on: the pose becomes a key
    expect(learnStore.get().progress?.marks[4]).toBe('done');

    expect(learnStore.get().finished).toEqual([]);
    uiStore.patch({ exportOpen: true });
    const p = learnStore.get().progress!;
    expect(p.current).toBe(-1);
    expect(p.doneCount).toBe(FOX_LESSON.steps.length);
    expect(learnStore.get().finished).toEqual(['fox']);
  });

  it('what was done before the lesson began does not count for the steps that ask for a change', () => {
    const arm = docStore.get().skeleton.bones[1].id;
    setMode('animate');
    setBonePose([{ id: arm, props: { rotation: 10 } }]);
    startLesson('fox');
    const marks = learnStore.get().progress!.marks;
    expect(marks[2]).toBe('done'); // the mode is Animate now: the state counts
    expect(marks[1]).toBe('todo'); // an earlier edit does not
    expect(marks[4]).toBe('todo'); // nor an earlier key
  });

  it('skip moves on, stop clears the lesson, and a lesson that started by itself is not forced again', () => {
    startLesson('fox');
    skipStep();
    expect(learnStore.get().progress?.current).toBe(1);
    stopLesson();
    expect(learnStore.get().active).toBeNull();
    expect(learnStore.get().progress).toBeNull();

    offerLesson('fox');
    expect(learnStore.get().active).toBe('fox');
    stopLesson();
    offerLesson('fox');
    expect(learnStore.get().active).toBeNull();
  });
});

describe('the steps of the rig lesson', () => {
  const base = state({ images: 2, bones: 3, ownSlots: 1, keys: 4 });
  const done = (id: string, s: LessonState) => RIG_LESSON.steps.find((x) => x.id === id)!.done(s, base);

  it('pictures: more pictures than when the lesson began', () => {
    expect(done('pictures', state({ images: 2 }))).toBe(false);
    expect(done('pictures', state({ images: 3 }))).toBe(true);
  });
  it('bone: more bones than when the lesson began', () => {
    expect(done('bone', state({ bones: 3 }))).toBe(false);
    expect(done('bone', state({ bones: 4 }))).toBe(true);
  });
  it('attach: a picture sits on a bone that is not a root, and one that was already there does not count', () => {
    expect(done('attach', state({ ownSlots: 1 }))).toBe(false);
    expect(done('attach', state({ ownSlots: 2 }))).toBe(true);
  });
  it('animate, key and play work as in the first lesson', () => {
    expect(done('animate', state({ mode: 'animate' }))).toBe(true);
    expect(done('key', state({ keys: 5 }))).toBe(true);
    expect(done('key', state({ keys: 4 }))).toBe(false);
    expect(done('play', state({ seenPlaying: true }))).toBe(true);
  });
  it('is offered after the first lesson, and only the first step has a button', () => {
    expect(FOX_LESSON.next).toBe('rig');
    expect(lessonById(FOX_LESSON.next!)).toBe(RIG_LESSON);
    expect(RIG_LESSON.next).toBe('mesh');
    expect(RIG_LESSON.steps.filter((s) => s.helper).map((s) => s.id)).toEqual(['pictures']);
  });
});

describe('the rig lesson in the store', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    docStore.replace(emptyProject('rig'));
    uiStore.patch({
      mode: 'setup',
      selection: emptySelection,
      playing: false,
      exportOpen: false,
      animationId: null,
      time: 0,
      overrides: {},
    });
  });

  it('follows a picture, a bone, a picture put on that bone, and the keys of the turn', () => {
    startLesson('rig');
    expect(learnStore.get().progress?.current).toBe(0);

    docStore.update('Import image', (d) => {
      d.images.push({ id: 'img1', name: 'body', width: 40, height: 60 });
    });
    expect(learnStore.get().progress?.marks[0]).toBe('done');

    let arm = '';
    docStore.update('Create bone', (d) => {
      const b = newBone({ name: 'arm', parent: d.skeleton.bones[0].id, length: 40 });
      arm = b.id;
      d.skeleton.bones.push(b);
    });
    expect(learnStore.get().progress?.marks[1]).toBe('done');
    expect(learnStore.get().progress?.marks[2]).toBe('todo');

    docStore.update('Add image', (d) => {
      d.skeleton.slots.push(newSlot({ name: 'body', bone: arm, attachment: 'body' }));
    });
    expect(learnStore.get().progress?.marks[2]).toBe('done');

    setMode('animate');
    selectBone(arm);
    setBonePose([{ id: arm, props: { rotation: 30 } }]);
    expect(learnStore.get().progress?.marks[4]).toBe('done');
    uiStore.patch({ playing: true });
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['rig']);
  });

  it('a slot on the root bone is not a picture that moves with a bone of its own', () => {
    startLesson('rig');
    docStore.update('Add image', (d) => {
      d.skeleton.slots.push(newSlot({ name: 'bg', bone: d.skeleton.bones[0].id, attachment: 'bg' }));
    });
    expect(learnStore.get().progress?.marks[2]).toBe('todo');
  });
});

describe('the steps of the mesh lesson', () => {
  const base = state({ meshes: 2, weightedMeshes: 1, keys: 3 });
  const done = (id: string, s: LessonState) => MESH_LESSON.steps.find((x) => x.id === id)!.done(s, base);

  it('slot: a picture is selected', () => {
    expect(done('slot', state())).toBe(false);
    expect(done('slot', state({ slotSelected: true }))).toBe(true);
  });
  it('mesh: more meshes than when the lesson began (the ones that were there do not count)', () => {
    expect(done('mesh', state({ meshes: 2 }))).toBe(false);
    expect(done('mesh', state({ meshes: 3 }))).toBe(true);
  });
  it('bind: more weighted meshes than at the start', () => {
    expect(done('bind', state({ meshes: 5, weightedMeshes: 1 }))).toBe(false);
    expect(done('bind', state({ weightedMeshes: 2 }))).toBe(true);
  });
  it('weights: the brush was the tool at some moment, even if it is not now', () => {
    expect(done('weights', state())).toBe(false);
    expect(done('weights', state({ seenWeightsTool: true }))).toBe(true);
  });
  it('animate and bend: the mode, and more keys than at the start', () => {
    expect(done('animate', state({ mode: 'animate' }))).toBe(true);
    expect(done('bend', state({ keys: 3 }))).toBe(false);
    expect(done('bend', state({ keys: 4 }))).toBe(true);
  });
  it('comes after the rig lesson and offers the IK lesson', () => {
    expect(RIG_LESSON.next).toBe('mesh');
    expect(lessonById('mesh')).toBe(MESH_LESSON);
    expect(MESH_LESSON.next).toBe('ik');
  });
});

describe('the mesh lesson in the store', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    const p = emptyProject('mesh');
    const arm = newBone({ name: 'arm', parent: p.skeleton.bones[0].id, length: 40 });
    p.skeleton.bones.push(arm);
    const slot = newSlot({ name: 'pic', bone: arm.id, attachment: 'pic' });
    p.skeleton.slots.push(slot);
    const region: RegionAttachment = {
      type: 'region',
      name: 'pic',
      path: 'pic',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      width: 40,
      height: 60,
      color: [1, 1, 1, 1],
    };
    p.skeleton.skins[0].attachments[slot.id] = { pic: region };
    docStore.replace(p);
    uiStore.patch({ mode: 'setup', tool: 'select', selection: emptySelection, playing: false, animationId: null, time: 0, overrides: {} });
  });

  it('follows a selected picture, a mesh, a binding, the brush and the keys of a bend', () => {
    const doc = docStore.get().skeleton;
    const slot = doc.slots[0];
    const arm = doc.bones[1].id;
    startLesson('mesh');
    expect(learnStore.get().progress?.current).toBe(0);

    selectSlot(slot.id);
    expect(learnStore.get().progress?.marks[0]).toBe('done');

    docStore.update('Convert to mesh', (d) => {
      d.skeleton.skins[0].attachments[slot.id].pic = meshFromRegion(d.skeleton.skins[0].attachments[slot.id].pic as RegionAttachment);
    });
    expect(learnStore.get().progress?.marks[1]).toBe('done');
    expect(learnStore.get().progress?.marks[2]).toBe('todo');

    docStore.update('Bind mesh', (d) => {
      const m = d.skeleton.skins[0].attachments[slot.id].pic;
      if (m.type === 'mesh') m.weights = Array.from({ length: m.uvs.length / 2 }, () => [[arm, 0, 0, 1]]);
    });
    expect(learnStore.get().progress?.marks[2]).toBe('done');

    uiStore.patch({ tool: 'weights' });
    uiStore.patch({ tool: 'select' });
    expect(learnStore.get().progress?.marks[3]).toBe('done'); // it stays done after the tool changed

    setMode('animate');
    selectBone(arm);
    setBonePose([{ id: arm, props: { rotation: 30 } }]);
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['mesh']);
  });
});

describe('the steps of the IK lesson', () => {
  const base = state({ ikConstraints: 2, keys: 5 });
  const done = (id: string, s: LessonState) => IK_LESSON.steps.find((x) => x.id === id)!.done(s, base);

  it('ik: more IK constraints than when the lesson began (the demo legs already have some)', () => {
    expect(done('ik', state({ ikConstraints: 2 }))).toBe(false);
    expect(done('ik', state({ ikConstraints: 3 }))).toBe(true);
  });
  it('pull: an edit after the new IK appeared; the creation itself is not an edit of the target', () => {
    expect(done('pull', state({ editsSinceIk: 0 }))).toBe(false);
    expect(done('pull', state({ editsSinceIk: 1 }))).toBe(true);
  });
  it('key and play work as in the other lessons, and the lesson offers the curves lesson', () => {
    expect(done('key', state({ keys: 6 }))).toBe(true);
    expect(done('play', state({ seenPlaying: true }))).toBe(true);
    expect(IK_LESSON.next).toBe('curves');
    expect(lessonById('ik')).toBe(IK_LESSON);
  });
});

describe('the IK lesson in the store', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    const p = emptyProject('ik');
    const upper = newBone({ name: 'upper', parent: p.skeleton.bones[0].id, length: 50 });
    const lower = newBone({ name: 'lower', parent: upper.id, length: 50, x: 50 });
    p.skeleton.bones.push(upper, lower);
    p.skeleton.animations.push(newAnimation('reach', 1));
    docStore.replace(p);
    uiStore.patch({ mode: 'setup', tool: 'select', selection: emptySelection, playing: false, animationId: null, time: 0, overrides: {} });
  });

  it('counts the edits only from the moment the new IK exists, and is passed with the real actions', () => {
    const lower = docStore.get().skeleton.bones[2].id;
    startLesson('ik');
    selectBone(lower);
    expect(learnStore.get().progress?.marks[0]).toBe('done');

    // an edit made before there is an IK does not pull the target
    setBonePose([{ id: lower, props: { rotation: 5 } }]);
    expect(learnStore.get().progress?.marks[2]).toBe('todo');

    const created = createIkFromDrag(lower, null, 120, 40);
    expect(created).not.toBeNull();
    expect(learnStore.get().progress?.marks[1]).toBe('done');
    expect(learnStore.get().progress?.marks[2]).toBe('todo'); // the creation is not a pull of the target

    const target = docStore.get().skeleton.bones.at(-1)!.id;
    setBonePose([{ id: target, props: { x: 90 } }]);
    expect(learnStore.get().progress?.marks[2]).toBe('done');

    setMode('animate');
    uiStore.patch({ time: 0.5 });
    setBonePose([{ id: target, props: { x: 140 } }]);
    expect(learnStore.get().progress?.marks[4]).toBe('done');
    uiStore.patch({ playing: true });
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['ik']);
  });
});

describe('the steps of the curves lesson', () => {
  const done = (id: string, s: LessonState) => CURVES_LESSON.steps.find((x) => x.id === id)!.done(s, state());

  it('select: at least one key is selected', () => {
    expect(done('select', state())).toBe(false);
    expect(done('select', state({ selectedKeys: 2 }))).toBe(true);
  });
  it('interp: an interpolation was changed; a handle drag alone is not that', () => {
    expect(done('interp', state({ handleEdits: 3 }))).toBe(false);
    expect(done('interp', state({ interpEdits: 1 }))).toBe(true);
  });
  it('graph: the graph was open at some moment', () => {
    expect(done('graph', state())).toBe(false);
    expect(done('graph', state({ seenGraph: true }))).toBe(true);
  });
  it('handle: a handle was dragged; a menu choice alone is not that', () => {
    expect(done('handle', state({ interpEdits: 3 }))).toBe(false);
    expect(done('handle', state({ handleEdits: 1 }))).toBe(true);
  });
  it('is found by its id and offers the skins lesson', () => {
    expect(CURVES_LESSON.next).toBe('skins');
    expect(lessonById('curves')).toBe(CURVES_LESSON);
  });
});

describe('the curves lesson in the store', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    const p = emptyProject('curves');
    const arm = newBone({ name: 'arm', parent: p.skeleton.bones[0].id, length: 40 });
    p.skeleton.bones.push(arm);
    const walk = newAnimation('walk', 1);
    walk.bones[arm.id] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 0.5, value: [30] },
      ],
    };
    p.skeleton.animations.push(walk);
    docStore.replace(p);
    uiStore.patch({
      mode: 'setup',
      tool: 'select',
      selection: emptySelection,
      playing: false,
      animationId: walk.id,
      time: 0,
      overrides: {},
      selectedKeys: [],
      timelineView: 'dopesheet',
    });
  });

  it('counts the kind of the change from the history, and the graph and the keys from the editor', () => {
    const doc = docStore.get().skeleton;
    const arm = doc.bones[1].id;
    const ref: KeyRef = { kind: 'bone', target: arm, prop: 'rotate', time: 0 };
    startLesson('curves');
    setMode('animate');
    expect(learnStore.get().progress?.marks[0]).toBe('done');

    uiStore.patch({ selectedKeys: [encodeKey(ref)] });
    expect(learnStore.get().progress?.marks[1]).toBe('done');
    expect(learnStore.get().progress?.marks[2]).toBe('todo');

    setKeysCurve([ref], 'stepped');
    expect(learnStore.get().progress?.marks[2]).toBe('done');
    expect(learnStore.get().progress?.marks[4]).toBe('todo'); // a menu choice is not a handle drag

    uiStore.patch({ timelineView: 'graph' });
    uiStore.patch({ timelineView: 'dopesheet' });
    expect(learnStore.get().progress?.marks[3]).toBe('done'); // it stays done after the view changed

    setKeyCurveHandle(ref, 0, 1, 0.4, 0.1);
    expect(learnStore.get().progress?.marks[4]).toBe('done');
    uiStore.patch({ playing: true });
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['curves']);
  });
});

describe('the steps of the skins lesson', () => {
  const done = (id: string, s: LessonState, base = state()) => SKINS_LESSON.steps.find((x) => x.id === id)!.done(s, base);

  it('skin: more skins than when the lesson began (the demo already has two)', () => {
    expect(done('skin', state({ skins: 2 }), state({ skins: 2 }))).toBe(false);
    expect(done('skin', state({ skins: 3 }), state({ skins: 2 }))).toBe(true);
  });
  it('switch: the shown skin changed twice (a new skin is shown at once, so one change is not enough)', () => {
    expect(done('switch', state({ skinSwitches: 1 }))).toBe(false);
    expect(done('switch', state({ skinSwitches: 2 }))).toBe(true);
  });
  it('event: more events than at the start', () => {
    expect(done('event', state({ events: 3 }), state({ events: 3 }))).toBe(false);
    expect(done('event', state({ events: 4 }), state({ events: 3 }))).toBe(true);
  });
  it('fire: more event keys than at the start (an event that exists but is not on a timeline does not count)', () => {
    expect(done('fire', state({ events: 5, eventKeys: 2 }), state({ eventKeys: 2 }))).toBe(false);
    expect(done('fire', state({ eventKeys: 3 }), state({ eventKeys: 2 }))).toBe(true);
  });
  it('animate and play work as in the other lessons, and it offers the export lesson', () => {
    expect(done('animate', state({ mode: 'animate' }))).toBe(true);
    expect(done('play', state({ seenPlaying: true }))).toBe(true);
    expect(SKINS_LESSON.next).toBe('export');
    expect(lessonById('skins')).toBe(SKINS_LESSON);
  });
});

describe('the skins lesson in the store', () => {
  beforeEach(() => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    const p = emptyProject('skins');
    const bone = newBone({ name: 'arm', parent: p.skeleton.bones[0].id, length: 40 });
    p.skeleton.bones.push(bone);
    p.skeleton.slots.push(newSlot({ name: 'arm', bone: bone.id }));
    p.skeleton.animations.push(newAnimation('walk', 1));
    docStore.replace(p);
    uiStore.patch({
      mode: 'setup',
      tool: 'select',
      selection: emptySelection,
      playing: false,
      animationId: p.skeleton.animations[0].id,
      skinId: null,
      skinMix: [],
      time: 0.25,
      overrides: {},
    });
  });

  it('counts the skins, the shown skin changes, the events and their keys, and is passed with the real actions', () => {
    startLesson('skins');
    expect(learnStore.get().progress?.doneCount).toBe(0);

    const skin = createSkin(); // a new skin is shown at once
    expect(learnStore.get().progress?.marks[0]).toBe('done');
    expect(learnStore.get().progress?.marks[1]).toBe('todo');
    setActiveSkin(null);
    expect(learnStore.get().progress?.marks[1]).toBe('done');
    setActiveSkin(skin);

    const event = createEvent();
    expect(learnStore.get().progress?.marks[2]).toBe('done');
    expect(learnStore.get().progress?.marks[4]).toBe('todo');

    keyEvent(event); // puts the event on the playhead and switches to Animate
    expect(uiStore.get().mode).toBe('animate');
    expect(learnStore.get().progress?.marks[3]).toBe('done');
    expect(learnStore.get().progress?.marks[4]).toBe('done');
    expect(docStore.get().skeleton.animations[0].events).toHaveLength(1);

    uiStore.patch({ playing: true });
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['skins']);
  });

  it('does not count a skin change made before the lesson began', () => {
    const skin = createSkin();
    setActiveSkin(null);
    setActiveSkin(skin);
    startLesson('skins');
    expect(learnStore.get().progress?.marks[1]).toBe('todo');
  });
});

describe('the export lesson', () => {
  const done = (id: string, s: LessonState) => EXPORT_LESSON.steps.find((x) => x.id === id)!.done(s, state());

  it('open: the Export window was open at some moment', () => {
    expect(done('open', state())).toBe(false);
    expect(done('open', state({ seenExport: true }))).toBe(true);
  });
  it('zip and player: each asks for its own file, the other one does not count', () => {
    expect(done('zip', state({ players: 2 }))).toBe(false);
    expect(done('zip', state({ zips: 1 }))).toBe(true);
    expect(done('player', state({ zips: 2 }))).toBe(false);
    expect(done('player', state({ players: 1 }))).toBe(true);
  });
  it('is the last lesson: nothing comes after it', () => {
    expect(EXPORT_LESSON.next).toBeUndefined();
    expect(lessonById('export')).toBe(EXPORT_LESSON);
  });

  it('follows the window and the files given out in the store, and finishes', () => {
    stopLesson();
    learnStore.patch({ finished: [], offered: false });
    uiStore.patch({ exportOpen: false });
    startLesson('export');
    noteExport('zip'); // a file given out without the window cannot happen in the editor, but the order does not matter
    expect(learnStore.get().progress?.marks).toEqual(['todo', 'done', 'todo']);
    uiStore.patch({ exportOpen: true });
    uiStore.patch({ exportOpen: false });
    expect(learnStore.get().progress?.marks[0]).toBe('done');
    noteExport('player');
    expect(learnStore.get().progress?.current).toBe(-1);
    expect(learnStore.get().finished).toEqual(['export']);
  });
});
