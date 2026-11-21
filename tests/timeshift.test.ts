/** Insert time / Delete time: the whole animation is cut at the playhead and pulled apart or pushed together. */
import { beforeEach, describe, expect, it } from 'vitest';
import { animationEndTime } from '../src/core/animate';
import { deleteTime, insertTime } from '../src/core/timeshift';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

/** Every key time of the animation, as a sorted list of the times of all its timelines (to compare before and after). */
function allTimes(anim: object): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object' && v[0] !== null && typeof (v[0] as { time?: unknown }).time === 'number')
        for (const k of v as { time: number }[]) out.push(k.time);
      else v.forEach(walk);
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  const a = anim as {
    bones: unknown;
    slots: unknown;
    deform: unknown;
    sequence: unknown;
    ik: unknown;
    transform: unknown;
    slider: unknown;
    path: unknown;
    physics: unknown;
    drawOrder: unknown;
    drawOrderFolder: unknown;
    events: unknown;
  };
  for (const key of [
    'bones',
    'slots',
    'deform',
    'sequence',
    'ik',
    'transform',
    'slider',
    'path',
    'physics',
    'drawOrder',
    'drawOrderFolder',
    'events',
  ] as const)
    walk(a[key]);
  return out.sort((x, y) => x - y);
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;

describe('insertTime', () => {
  it('moves every key at or after the cut and leaves the ones before it', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const before = allTimes(anim);
    const at = 0.5;
    const r = insertTime(anim, at, 0.25);
    const after = allTimes(anim);
    expect(after.length).toBe(before.length);
    expect(r.moved).toBeGreaterThan(0);
    // the multiset of times: those before `at` are the same, the others are 0.25 later
    const expected = before.map((t) => (t >= at - 1e-4 ? t + 0.25 : t)).sort((x, y) => x - y);
    after.forEach((t, i) => expect(near(t, expected[i])).toBe(true));
  });

  it('makes the animation longer by the same amount, and the keys stay in order', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const d = anim.duration;
    insertTime(anim, 0.3, 0.4);
    expect(anim.duration).toBeCloseTo(d + 0.4, 6);
    expect(animationEndTime(anim)).toBeLessThanOrEqual(anim.duration + 1e-9);
    for (const tl of Object.values(anim.bones))
      for (const keys of Object.values(tl)) for (let i = 1; i < keys!.length; i++) expect(keys![i].time).toBeGreaterThan(keys![i - 1].time);
    expect(validateProject(project)).toEqual([]);
  });

  it('moves the markers and the play range from the cut on', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    anim.markers = [
      { id: 'm1', time: 0.1, name: 'a', color: 0, text: '' },
      { id: 'm2', time: 0.6, name: 'b', color: 1, text: '' },
    ];
    anim.play = { loop: true, pingPong: false, range: [0.2, 0.9] };
    insertTime(anim, 0.4, 0.5);
    expect(anim.markers.map((m) => m.time)).toEqual([0.1, 1.1]);
    expect(anim.play.range).toEqual([0.2, 1.4]); // a range that spans the cut gets longer
    insertTime(anim, 0, 1);
    expect(anim.play.range).toEqual([1.2, 2.4]);
  });

  it('does nothing for a length that is not positive, or a time that is not a time', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const copy = JSON.stringify(anim);
    expect(insertTime(anim, 0.5, 0).moved).toBe(0);
    expect(insertTime(anim, 0.5, -1).moved).toBe(0);
    expect(insertTime(anim, NaN, 1).moved).toBe(0);
    expect(insertTime(anim, -1, 1).moved).toBe(0);
    expect(JSON.stringify(anim)).toBe(copy);
  });
});

describe('deleteTime', () => {
  it('removes the keys inside the span and pulls the later ones back', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const before = allTimes(anim);
    const at = 0.3;
    const span = 0.3;
    const r = deleteTime(anim, at, span, 1 / 30);
    const inside = before.filter((t) => t >= at - 1e-4 && t < at + span - 1e-4).length;
    expect(inside).toBeGreaterThan(0);
    expect(r.removed).toBe(inside);
    const after = allTimes(anim);
    expect(after.length).toBe(before.length - inside);
    const expected = before
      .filter((t) => !(t >= at - 1e-4 && t < at + span - 1e-4))
      .map((t) => (t >= at + span - 1e-4 ? t - span : t))
      .sort((x, y) => x - y);
    after.forEach((t, i) => expect(near(t, expected[i])).toBe(true));
    expect(validateProject(project)).toEqual([]);
  });

  it('makes the animation shorter, never shorter than a frame, and never cuts off its last key', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const d = anim.duration;
    deleteTime(anim, 0.2, 0.3, 1 / 30);
    expect(anim.duration).toBeCloseTo(d - 0.3, 6);
    expect(animationEndTime(anim)).toBeLessThanOrEqual(anim.duration + 1e-6);
    const b = buildFixture().project.skeleton.animations[0];
    deleteTime(b, 0, 999, 1 / 30);
    expect(b.duration).toBeCloseTo(1 / 30, 6);
    // the keys at the very end of the animation are not inside the span: they come to the cut (here the start)
    expect(allTimes(b).every((t) => t === 0)).toBe(true);
  });

  it('collapses the markers inside the span onto the cut and cuts the play range the same way', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    anim.markers = [
      { id: 'm1', time: 0.1, name: 'a', color: 0, text: '' },
      { id: 'm2', time: 0.4, name: 'b', color: 0, text: '' },
      { id: 'm3', time: 0.8, name: 'c', color: 0, text: '' },
    ];
    anim.play = { loop: true, pingPong: false, range: [0.35, 0.9] };
    deleteTime(anim, 0.3, 0.2, 1 / 30);
    anim.markers.forEach((m, i) => expect(m.time).toBeCloseTo([0.1, 0.3, 0.6][i], 9));
    expect(anim.play.range![0]).toBeCloseTo(0.3, 9);
    expect(anim.play.range![1]).toBeCloseTo(0.7, 9);
    const gone = buildFixture().project.skeleton.animations[0];
    gone.play = { loop: true, pingPong: false, range: [0.3, 0.4] };
    deleteTime(gone, 0.2, 0.4, 1 / 30);
    expect(gone.play.range).toBeNull(); // the whole range was inside the span
  });

  it('does nothing at or past the end, or for a length that is not positive', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const copy = JSON.stringify(anim);
    expect(deleteTime(anim, anim.duration, 0.2, 1 / 30).removed).toBe(0);
    expect(deleteTime(anim, 0.2, 0, 1 / 30).removed).toBe(0);
    expect(deleteTime(anim, -1, 1, 1 / 30).removed).toBe(0);
    expect(JSON.stringify(anim)).toBe(copy);
  });

  it('insert then delete the same span brings the keys back where they were', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const before = allTimes(anim);
    const d = anim.duration;
    insertTime(anim, 0.45, 0.3);
    deleteTime(anim, 0.45, 0.3, 1 / 30);
    const after = allTimes(anim);
    expect(after.length).toBe(before.length);
    after.forEach((t, i) => expect(near(t, before[i])).toBe(true));
    expect(anim.duration).toBeCloseTo(d, 6);
  });
});

describe('the frame grid', () => {
  it('keys on whole frames stay on whole frames after an insert and a delete (nothing is rounded to a millionth of a second: the fuzzer found that this puts a key off its frame)', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    const fps = project.skeleton.fps;
    const onFrames = (t: number) => Math.abs(t * fps - Math.round(t * fps)) < 1e-9;
    const before = allTimes(anim);
    expect(before.every(onFrames)).toBe(true);
    insertTime(anim, 10 / fps, 7 / fps);
    expect(allTimes(anim).every(onFrames)).toBe(true);
    deleteTime(anim, 3 / fps, 5 / fps, 1 / fps);
    expect(allTimes(anim).every(onFrames)).toBe(true);
  });
});

describe('rounding', () => {
  it('a marker that collapses onto a cut that is not a round number never lies beyond the rounded end (the fuzzer found this)', () => {
    const { project } = buildFixture();
    const anim = project.skeleton.animations[0];
    anim.duration = 1.2;
    anim.markers = [{ id: 'm', time: 1.1333333333333333, name: '', color: 0, text: '' }];
    deleteTime(anim, 1.0333333333333334, 1 / 30 + 0.1, 1 / 30);
    expect(anim.markers[0].time).toBeLessThanOrEqual(anim.duration);
    expect(validateProject(project)).toEqual([]);
  });
});

describe('the actions', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'animate',
      animationId: f.project.skeleton.animations[0].id,
      time: 0.5,
      selection: emptySelection,
      selectedKeys: ['x'],
      playing: false,
    });
  });

  it('Insert time works at the playhead, in frames, as one undo step', () => {
    const fps = docStore.get().skeleton.fps;
    const anim0 = A.currentAnimation()!;
    const before = JSON.stringify(anim0);
    const steps = docStore.history.past.length;
    expect(A.insertTimeAtPlayhead(6)).toBe(true);
    expect(docStore.history.past.length).toBe(steps + 1);
    expect(A.currentAnimation()!.duration).toBeCloseTo(anim0.duration + 6 / fps, 6);
    expect(uiStore.get().selectedKeys).toEqual([]);
    expect(uiStore.get().time).toBe(0.5);
    docStore.undo();
    expect(JSON.stringify(A.currentAnimation())).toBe(before);
  });

  it('Delete time cuts the frames after the playhead and keeps the playhead inside the animation', () => {
    const fps = docStore.get().skeleton.fps;
    const d = A.currentAnimation()!.duration;
    uiStore.patch({ time: d - 0.05 });
    expect(A.deleteTimeAtPlayhead(30)).toBe(true);
    expect(A.currentAnimation()!.duration).toBeCloseTo(d - 0.05, 6);
    expect(uiStore.get().time).toBeLessThanOrEqual(A.currentAnimation()!.duration);
    uiStore.patch({ time: A.currentAnimation()!.duration });
    expect(A.deleteTimeAtPlayhead(3)).toBe(false); // nothing after the end
    expect(fps).toBeGreaterThan(0);
  });

  it('refuses a number of frames that is not a whole number of at least one, and does nothing without an animation', () => {
    expect(A.insertTimeAtPlayhead(0)).toBe(false);
    expect(A.deleteTimeAtPlayhead(NaN)).toBe(false);
    uiStore.patch({ animationId: null });
    expect(A.insertTimeAtPlayhead(5)).toBe(false);
  });

  it('what is left exports and loads in the official runtime', () => {
    A.insertTimeAtPlayhead(9);
    A.deleteTimeAtPlayhead(4);
    expect(validateProject(docStore.get())).toEqual([]);
    const { skeletonData } = exportAndLoad(docStore.get(), { splitColor: true });
    const name = A.currentAnimation()!.name;
    expect(skeletonData.findAnimation(name)).toBeTruthy();
  });
});
