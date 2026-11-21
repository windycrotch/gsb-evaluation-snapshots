/** Split axes (translatex / translatey, scalex / scaley, shearx / sheary): the solver, both export formats, the import, split / merge and keying. */
import { beforeEach, describe, expect, it } from 'vitest';
import { isSplit, mergeGroup, splitGroup } from '../src/core/axes';
import { applyAnimation } from '../src/core/animate';
import { sampleKeys } from '../src/core/curve';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { binaryToJson } from '../src/core/import/spineBinary';
import { exportSpineBinary } from '../src/core/export/spineBinary';
import type { BoneTimelines, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { setAxesSplit } from '../src/store/axisActions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { compare } from './binarykit';
import { parityMismatch } from './fuzzkit';

const walk = (p: Project) => p.skeleton.animations.find((a) => a.name === 'walk')!;

/** The fixture with the arm bone keyed per axis, the two axes with different key times and curves. */
function splitProject() {
  const f = buildFixture();
  const p = f.project;
  const bone = p.skeleton.bones[1].id;
  const a = walk(p);
  a.duration = Math.max(a.duration, 1);
  a.bones[bone] = {
    translatex: [
      { time: 0, value: [0], curve: [0.25, 0, 0.75, 20] },
      { time: 0.5, value: [20] },
      { time: 1, value: [5] },
    ],
    translatey: [
      { time: 0.2, value: [3], curve: 'stepped' },
      { time: 0.8, value: [-7] },
    ],
    scalex: [
      { time: 0, value: [1] },
      { time: 1, value: [1.5] },
    ],
    sheary: [
      { time: 0.1, value: [0] },
      { time: 0.9, value: [12], curve: [0.3, 0, 0.6, 10] },
    ],
  };
  return { p, bone };
}

describe('the solver', () => {
  it('moves one axis with its own key times and leaves the other at the setup pose', () => {
    const { p, bone } = splitProject();
    const data = compileSkeleton(p.skeleton);
    const sk = createSkeleton(data);
    const setup = p.skeleton.bones[1];
    applyAnimation(sk, walk(p), 0.5);
    const b = sk.boneById(bone)!;
    expect(b.x).toBeCloseTo(setup.x + 20, 6);
    expect(b.y).toBeCloseTo(setup.y + 3, 6); // stepped, still on the first key
    expect(b.scaleX).toBeCloseTo(setup.scaleX * 1.25, 6);
    expect(b.scaleY).toBeCloseTo(setup.scaleY, 6); // no scaley timeline
    applyAnimation(sk, walk(p), 0.05);
    expect(b.y).toBeCloseTo(setup.y, 6); // before the first key of translatey
    expect(b.shearY).toBeCloseTo(setup.shearY, 6);
  });

  it('agrees with the official runtime on what the editor exports', () => {
    const { p } = splitProject();
    expect(parityMismatch(p)).toBeNull();
  });
});

describe('export', () => {
  it('writes one JSON timeline per axis, with the keys and curves it has', () => {
    const { p, bone } = splitProject();

    const json = exportSpineJson(p.skeleton) as any;
    const t = json.animations.walk.bones[p.skeleton.bones[1].name];
    expect(bone).toBeTruthy();
    expect(t.translate).toBeUndefined();
    expect(t.translatex).toHaveLength(3);
    expect(t.translatey).toHaveLength(2);
    expect(t.translatey[0].curve).toBe('stepped');
    expect(t.translatex[1].value).toBe(20);
    expect(t.scalex).toHaveLength(2);
    expect(t.shear).toBeUndefined();
  });

  it('the binary loads like the JSON in the official runtime', () => {
    const { p } = splitProject();
    expect(compare(p).diffs).toEqual([]);
  });

  it('survives the round trip through our own binary reader and importer', () => {
    const { p } = splitProject();
    const back = importSpineJson(binaryToJson(exportSpineBinary(p.skeleton)), 'back');
    const name = p.skeleton.bones[1].name;
    const walkBack = back.project.skeleton.animations.find((a) => a.name === 'walk')!;
    const tl = walkBack.bones[back.project.skeleton.bones.find((b) => b.name === name)!.id];
    expect(tl.translatex?.map((k) => k.time)).toEqual([0, 0.5, 1]);
    expect(tl.translatey?.map((k) => k.value[0])).toEqual([3, -7]);
    expect(tl.translate).toBeUndefined();
  });
});

describe('import', () => {
  it('keeps translatex and translatey apart, as Spine does', () => {
    const spine = {
      skeleton: { spine: '4.3.0' },
      bones: [{ name: 'root' }, { name: 'hip', parent: 'root', x: 10 }],
      animations: {
        a: {
          bones: {
            hip: {
              translatex: [{ value: 1 }, { time: 1, value: 4 }],
              translatey: [
                { time: 0.5, value: 2 },
                { time: 1, value: 9, curve: 'stepped' },
              ],
            },
          },
        },
      },
    };
    const r = importSpineJson(spine, 'x');
    const tl = r.project.skeleton.animations[0].bones[r.project.skeleton.bones[1].id];
    expect(tl.translatex).toEqual([
      { time: 0, value: [1] },
      { time: 1, value: [4] },
    ]);
    expect(tl.translatey?.map((k) => k.time)).toEqual([0.5, 1]);
    expect(tl.translate).toBeUndefined();
    expect(r.warnings.join('\n')).not.toMatch(/translate/);
    expect(validateProject(r.project)).toEqual([]);
  });
});

describe('split and merge', () => {
  const combined = (): BoneTimelines => ({
    translate: [
      { time: 0, value: [0, 0], curve: [0.2, 0.1, 0.7, 0.9, 0.4, 0, 0.6, 1] },
      { time: 1, value: [10, -4], curve: 'stepped' },
      { time: 2, value: [10, -4] },
    ],
  });

  it('splitting keeps the motion exactly', () => {
    const tl = combined();
    const before = structuredClone(tl.translate!);
    expect(splitGroup(tl, 'translate')).toBe(true);
    expect(tl.translate).toBeUndefined();
    expect(isSplit(tl, 'translate')).toBe(true);
    const out = [0, 0];
    const one = [0];
    for (const t of [0, 0.13, 0.5, 0.99, 1, 1.5, 2]) {
      sampleKeys(before, t, out);
      sampleKeys(tl.translatex!, t, one);
      expect(one[0]).toBeCloseTo(out[0], 9);
      sampleKeys(tl.translatey!, t, one);
      expect(one[0]).toBeCloseTo(out[1], 9);
    }
    expect(splitGroup(tl, 'translate')).toBe(false);
  });

  it('merging after splitting gives back the same keys', () => {
    const tl = combined();
    const before = structuredClone(tl.translate!);
    splitGroup(tl, 'translate');
    expect(mergeGroup(tl, 'translate')).toBe(true);
    expect(tl.translate).toEqual(before);
    expect(isSplit(tl, 'translate')).toBe(false);
    expect(mergeGroup(tl, 'translate')).toBe(false);
  });

  it('merging axes with different key times samples both at every time', () => {
    const tl: BoneTimelines = {
      scalex: [
        { time: 0, value: [1] },
        { time: 1, value: [3] },
      ],
      scaley: [{ time: 0.5, value: [2] }],
    };
    mergeGroup(tl, 'scale');
    expect(tl.scale!.map((k) => k.time)).toEqual([0, 0.5, 1]);
    expect(tl.scale![0].value).toEqual([1, 1]); // scaley has no key yet: its neutral value
    expect(tl.scale![1].value).toEqual([2, 2]);
    expect(tl.scale![2].value).toEqual([3, 2]);
  });
});

describe('keying per axis', () => {
  let bone = '';
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    bone = f.project.skeleton.bones[1].id;
    uiStore.patch({
      mode: 'animate',
      tool: 'select',
      animationId: walk(f.project).id,
      skinId: null,
      time: 0.25,
      selection: { ...emptySelection, bones: [bone] },
      overrides: {},
      autoKey: true,
      playing: false,
    });
  });
  const tl = () => docStore.get().skeleton.animations.find((a) => a.name === 'walk')!.bones[bone] ?? {};

  it('a bone with a combined timeline keys both axes together', () => {
    A.setBonePose([{ id: bone, props: { x: 9 } }]);
    expect(tl().translate?.some((k) => Math.abs(k.time - 0.25) < 1e-6)).toBe(true);
    expect(tl().translatex).toBeUndefined();
  });

  it('once split, an edit keys only that axis', () => {
    expect(setAxesSplit([bone], 'translate', true)).toBe(1);
    const before = tl().translatey?.length;
    A.setBonePose([{ id: bone, props: { x: 17 } }]);
    expect(
      tl().translatex?.some(
        (k) => Math.abs(k.time - 0.25) < 1e-6 && Math.abs(k.value[0] - (17 - docStore.get().skeleton.bones[1].x)) < 1e-6,
      ),
    ).toBe(true);
    expect(tl().translatey?.length).toBe(before);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('Key all keys both axes of a split group', () => {
    setAxesSplit([bone], 'translate', true);
    uiStore.patch({ time: 0.6 });
    A.keySelectedBones(['translate']);
    expect(tl().translatex?.some((k) => Math.abs(k.time - 0.6) < 1e-6)).toBe(true);
    expect(tl().translatey?.some((k) => Math.abs(k.time - 0.6) < 1e-6)).toBe(true);
    expect(tl().translate).toBeUndefined();
  });

  it('splitting a group with no keys starts it with a key on each axis at the playhead', () => {
    const f = buildFixture();
    docStore.replace(f.project);
    const fresh = f.project.skeleton.bones[2].id;
    const anim = walk(f.project);
    uiStore.patch({ animationId: anim.id, selection: { ...emptySelection, bones: [fresh] }, time: 0.4 });
    delete anim.bones[fresh]?.scale;
    docStore.replace(f.project);
    expect(setAxesSplit([fresh], 'scale', true)).toBe(1);
    const t = docStore.get().skeleton.animations.find((a) => a.name === 'walk')!.bones[fresh];
    expect(t.scalex).toHaveLength(1);
    expect(t.scaley).toHaveLength(1);
    expect(t.scalex![0].time).toBeCloseTo(0.4, 6);
  });

  it('split and merge are single undo steps', () => {
    const start = docStore.get();
    setAxesSplit([bone], 'translate', true);
    docStore.undo();
    expect(docStore.get()).toEqual(start);
  });
});
