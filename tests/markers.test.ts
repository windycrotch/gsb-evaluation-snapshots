/** Timeline markers: cleaning, adding, and cutting an animation into clips at them. */
import { beforeEach, describe, expect, it } from 'vitest';
import { sampleKeys } from '../src/core/curve';
import {
  addMarker,
  cleanMarkers,
  cutAnimation,
  markersOf,
  neighbourMarker,
  removeMarker,
  splitAtMarkers,
  splitPieces,
} from '../src/core/markers';
import { newAnimation } from '../src/core/model';
import type { Animation } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import { currentAnimation, setAnimationDuration } from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { addMarkerAtPlayhead, deleteMarker, splitAtMarkersAction, updateMarker } from '../src/store/markerActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const long = (): Animation => {
  const a = newAnimation('run', 4);
  a.bones.b1 = {
    rotate: [
      { time: 0, value: [0] },
      { time: 2, value: [80] },
      { time: 4, value: [0] },
    ],
    translate: [
      { time: 1, value: [5, 5], curve: 'stepped' },
      { time: 3, value: [9, 9] },
    ],
  };
  a.slots.s1 = {
    attachment: [
      { time: 0, name: 'a' },
      { time: 3, name: 'b' },
    ],
  };
  a.events = [
    { time: 1, event: 'e' },
    { time: 2, event: 'e' },
    { time: 4, event: 'e' },
  ];
  a.drawOrder = [{ time: 0.5, order: ['s1'] }];
  return a;
};

describe('markers', () => {
  it('cleans what is damaged and keeps what is right', () => {
    const out = cleanMarkers(
      [{ id: 'a', time: 9, name: 'x', color: 99, text: 5 }, null, { time: NaN }, { id: 'a', time: 1, name: 'y', color: 2, text: 't' }],
      4,
    );
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.time)).toEqual([1, 4]);
    expect(out[1]).toMatchObject({ name: 'x', color: 5, text: '' });
    expect(new Set(out.map((m) => m.id)).size).toBe(2);
    expect(cleanMarkers('no', 3)).toEqual([]);
  });

  it('adds one marker per time, keeps them in order, and finds the neighbours', () => {
    const a = newAnimation('a', 5);
    addMarker(a, 3, 'c');
    addMarker(a, 1, 'a');
    const again = addMarker(a, 3, 'other');
    expect(again.name).toBe('c');
    expect(markersOf(a).map((m) => m.name)).toEqual(['a', 'c']);
    expect(neighbourMarker(a, 1, 1)?.name).toBe('c');
    expect(neighbourMarker(a, 1, -1)).toBeNull();
    expect(neighbourMarker(a, 5, -1)?.name).toBe('c');
    expect(removeMarker(a, again.id)).toBe(true);
    expect(removeMarker(a, again.id)).toBe(false);
    expect(a.markers).toHaveLength(1);
    removeMarker(a, a.markers![0].id);
    expect(a.markers).toBeUndefined();
  });
});

describe('cutting', () => {
  it('a piece moves like the original over its stretch, with keys on both edges', () => {
    const a = long();
    const piece = cutAnimation(a, 1, 3, 'mid');
    expect(piece.duration).toBe(2);
    const rot = piece.bones.b1.rotate!;
    expect(rot[0]).toMatchObject({ time: 0 });
    expect(rot[0].value[0]).toBeCloseTo(40, 9);
    expect(rot[rot.length - 1].time).toBeCloseTo(2, 9);
    const o = [0];
    const p = [0];
    for (const t of [0, 0.4, 1, 1.7, 2]) {
      sampleKeys(rot, t, o);
      sampleKeys(a.bones.b1.rotate!, t + 1, p);
      expect(o[0]).toBeCloseTo(p[0], 6);
    }
  });

  it('keeps a stepped curve, starts states with the one in force, and cuts events at the edge', () => {
    const a = long();
    const piece = cutAnimation(a, 1.5, 3.5, 'p');
    expect(piece.bones.b1.translate![0]).toMatchObject({ time: 0, value: [5, 5], curve: 'stepped' });
    expect(piece.slots.s1.attachment).toEqual([
      { time: 0, name: 'a' },
      { time: 1.5, name: 'b' },
    ]);
    expect(piece.drawOrder).toEqual([{ time: 0, order: ['s1'] }]);
    expect(piece.events.map((e) => e.time)).toEqual([0.5]); // the event at 1 is before, at 2 is inside; the one at 4 is after
  });

  it('splits at the markers into named, non-overlapping clips', () => {
    const a = long();
    addMarker(a, 1, 'jump');
    addMarker(a, 3, '');
    expect(splitPieces(a).map((p) => [p.from, p.to, p.name])).toEqual([
      [0, 1, 'run'],
      [1, 3, 'jump'],
      [3, 4, 'run 3'],
    ]);
    const clips = splitAtMarkers(a, ['run']);
    expect(clips.map((c) => c.name)).toEqual(['run 1', 'jump', 'run 3']);
    expect(clips.map((c) => c.duration)).toEqual([1, 2, 1]);
    expect(clips[0].events.map((e) => e.time)).toEqual([]); // the event at 1 starts the next clip
    expect(clips[1].events.map((e) => e.time)).toEqual([0, 1]);
    expect(clips[2].events.map((e) => e.time)).toEqual([1]); // the last clip keeps the event at its end
    expect(new Set(clips.map((c) => c.id)).size).toBe(3);
    expect(splitAtMarkers(newAnimation('x', 2), [])).toEqual([]);
  });
});

describe('the actions', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    const anim = f.project.skeleton.animations.find((x) => x.name === 'walk')!;
    anim.duration = 2;
    docStore.replace(f.project);
    uiStore.patch({ mode: 'animate', animationId: anim.id, time: 0.5, selection: { ...emptySelection }, playing: false });
  });

  it('adds, edits and deletes a marker as undoable steps, and the project stays valid', () => {
    const id = addMarkerAtPlayhead()!;
    expect(currentAnimation()!.markers).toHaveLength(1);
    updateMarker(id, { name: 'hit', color: 3, time: 1.25, text: 'sound' });
    expect(currentAnimation()!.markers![0]).toMatchObject({ name: 'hit', color: 3, time: 1.25, text: 'sound' });
    expect(validateProject(docStore.get())).toEqual([]);
    deleteMarker(id);
    expect(currentAnimation()!.markers).toBeUndefined();
    docStore.undo();
    expect(currentAnimation()!.markers).toHaveLength(1);
  });

  it('a shorter animation pulls its markers in', () => {
    const id = addMarkerAtPlayhead()!;
    updateMarker(id, { time: 1.9 });
    setAnimationDuration(currentAnimation()!.id, 1.5);
    expect(currentAnimation()!.markers![0].time).toBe(1.5);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('splits into new animations in one history step', () => {
    addMarkerAtPlayhead();
    const before = docStore.get().skeleton.animations.length;
    expect(splitAtMarkersAction()).toBe(2);
    expect(docStore.get().skeleton.animations.length).toBe(before + 2);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(docStore.get().skeleton.animations.length).toBe(before);
  });
});
