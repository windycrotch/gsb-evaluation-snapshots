/** Wiggle, mirrored cycles, the foot-slide check and the bones an animation does not touch. */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SLIDE, counterpartName, footSlides, mirrorCycle, sidePairs, unkeyedBones, wiggleKeys } from '../src/core/animtools';
import { sampleKeys } from '../src/core/curve';
import { emptyProject, newAnimation, newBone } from '../src/core/model';
import type { Project } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import { currentAnimation } from '../src/store/actions';
import { hideUnkeyedBones, mirrorCurrentCycle, wiggleSelected } from '../src/store/animToolActions';
import { docStore } from '../src/store/doc';
import { encodeKey } from '../src/core/keyrefs';
import { emptySelection, uiStore } from '../src/store/ui';

describe('wiggle', () => {
  const base = [
    { time: 0, value: [0] },
    { time: 1, value: [10] },
  ];
  const opts = { amount: 2, every: 3, fps: 30, seed: 7, smooth: false, keepEnds: true };

  it('is the same for the same seed, differs for another, and stays within the amount', () => {
    const a = wiggleKeys(base, opts);
    const b = wiggleKeys(base, opts);
    const c = wiggleKeys(base, { ...opts, seed: 8 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const tmp = [0];
    for (const k of a) {
      sampleKeys(base, k.time, tmp);
      expect(Math.abs(k.value[0] - tmp[0])).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(a.length).toBe(11); // 0, 0.1 ... 1
  });

  it('keeps the ends so a loop closes, or lets them move', () => {
    const kept = wiggleKeys(base, opts);
    expect([kept[0].value[0], kept[kept.length - 1].value[0]]).toEqual([0, 10]);
    const free = wiggleKeys(base, { ...opts, keepEnds: false });
    expect(free[0].value[0]).not.toBe(0);
  });

  it('smooth keys get a bezier, a lone key or no amount changes nothing', () => {
    expect(Array.isArray(wiggleKeys(base, { ...opts, smooth: true })[0].curve)).toBe(true);
    const one = [{ time: 0, value: [1] }];
    expect(wiggleKeys(one, opts)).toBe(one);
    expect(wiggleKeys(base, { ...opts, amount: 0 })).toBe(base);
  });
});

describe('left and right', () => {
  it('finds the other side of a name', () => {
    expect(counterpartName('arm near 1')).toBe('arm far 1');
    expect(counterpartName('Arm Far')).toBe('Arm Near');
    expect(counterpartName('Leg_L')).toBe('Leg_R');
    expect(counterpartName('leg-right')).toBe('leg-left');
    expect(counterpartName('handLeft')).toBe('handRight');
    expect(counterpartName('LArm')).toBe('RArm');
    expect(counterpartName('hip')).toBeNull();
    expect(counterpartName('lower')).toBeNull();
  });

  it('pairs only the items whose other side exists', () => {
    const p = sidePairs([
      { id: 'a', name: 'arm L' },
      { id: 'b', name: 'arm R' },
      { id: 'c', name: 'foot L' },
      { id: 'd', name: 'hip' },
    ]);
    expect([...p]).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });
});

function rig(): { project: Project; ids: Record<string, string> } {
  const project = emptyProject();
  project.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const hip = newBone({ name: 'hip', parent: root.id, y: 40 });
  const footL = newBone({ name: 'foot L', parent: hip.id, x: -10, y: -40 });
  const footR = newBone({ name: 'foot R', parent: hip.id, x: 10, y: -40 });
  project.skeleton.bones.push(root, hip, footL, footR);
  const half = newAnimation('step', 1);
  half.bones[footL.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [30] },
    ],
  };
  half.bones[footR.id] = {
    rotate: [
      { time: 0, value: [30] },
      { time: 1, value: [0] },
    ],
  };
  half.bones[hip.id] = {
    rotate: [
      { time: 0, value: [5] },
      { time: 1, value: [10] },
    ],
  };
  project.skeleton.animations = [half];
  return { project, ids: { root: root.id, hip: hip.id, footL: footL.id, footR: footR.id } };
}

describe('mirror a half cycle', () => {
  it('the second half is the first with the sides swapped, the centre turned', () => {
    const { project, ids } = rig();
    const half = project.skeleton.animations[0];
    const full = mirrorCycle(project.skeleton, half, 'step full');
    expect(full.duration).toBe(2);
    expect(full.id).not.toBe(half.id);
    // footL: its own 0 -> 30 over the first second, then what footR did (30 -> 0): the key at 1 is its own, the one at 2 is footR's last
    expect(full.bones[ids.footL].rotate!.map((k) => k.time)).toEqual([0, 1, 2]);
    expect(full.bones[ids.footL].rotate!.map((k) => k.value[0])).toEqual([0, 30, 0]);
    expect(full.bones[ids.footR].rotate!.map((k) => k.value[0])).toEqual([30, 0, 30]);
    // the hip has no side: 5 -> 10, then the same turned: -5 -> -10
    expect(full.bones[ids.hip].rotate!.map((k) => k.value[0])).toEqual([5, 10, -10]);
    expect(half.bones[ids.hip].rotate).toHaveLength(2); // the original is not changed
  });

  it('without turning the centre it just repeats', () => {
    const { project, ids } = rig();
    const full = mirrorCycle(project.skeleton, project.skeleton.animations[0], 'x', { flipCentre: false });
    expect(full.bones[ids.hip].rotate!.map((k) => k.value[0])).toEqual([5, 10, 10]);
  });
});

describe('foot slide', () => {
  /** A foot that touches the ground (y = 0 at its lowest) for half the time; it moves along x by the given speed while planted. */
  function walker(plantedSpeed: number) {
    const project = emptyProject();
    project.skeleton.bones = [];
    project.skeleton.fps = 10;
    const root = newBone({ name: 'root' });
    const foot = newBone({ name: 'foot', parent: root.id });
    project.skeleton.bones.push(root, foot);
    const a = newAnimation('walk', 1);
    // planted from 0 to 0.5 (y = 0), lifted at 0.7, back down at 1
    a.bones[foot.id] = {
      translatex: [
        { time: 0, value: [0] },
        { time: 0.5, value: [plantedSpeed * 0.5] },
        { time: 1, value: [plantedSpeed * 0.5] },
      ],
      translatey: [
        { time: 0, value: [0] },
        { time: 0.5, value: [0] },
        { time: 0.7, value: [20] },
        { time: 1, value: [0] },
      ],
    };
    project.skeleton.animations = [a];
    return { project, foot: foot.id, anim: a };
  }

  it('finds a foot that drags while planted and stays quiet for one that is still', () => {
    const slid = walker(40);
    const found = footSlides(slid.project.skeleton, slid.anim, [slid.foot], DEFAULT_SLIDE);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].from).toBe(0);
    expect(found[0].worst).toBeCloseTo(40, 3);
    const still = walker(0);
    expect(footSlides(still.project.skeleton, still.anim, [still.foot], DEFAULT_SLIDE)).toEqual([]);
  });

  it('a planted foot that moves back by the body speed is not sliding', () => {
    const w = walker(-40);
    expect(footSlides(w.project.skeleton, w.anim, [w.foot], { ...DEFAULT_SLIDE, bodySpeed: 40 })).toEqual([]);
    expect(footSlides(w.project.skeleton, w.anim, [w.foot], { ...DEFAULT_SLIDE, bodySpeed: 0 }).length).toBeGreaterThan(0);
  });
});

describe('the actions', () => {
  beforeEach(() => {
    const { project, ids } = rig();
    docStore.replace(project);
    uiStore.patch({
      mode: 'animate',
      animationId: project.skeleton.animations[0].id,
      time: 0,
      selection: { ...emptySelection, bones: [ids.footL] },
      playing: false,
      selectedKeys: [],
    });
  });

  it('wiggles the selected timelines in one undo step', () => {
    const anim = currentAnimation()!;
    const footL = anim.bones[Object.keys(anim.bones)[1]];
    expect(footL.rotate).toHaveLength(2);
    const id = Object.keys(anim.bones).find((b) => anim.bones[b] === footL)!;
    expect(wiggleSelected({ amount: 1, every: 3, seed: 1, smooth: false, keepEnds: true })).toBe(0); // nothing selected
    uiStore.patch({ selectedKeys: [encodeKey({ kind: 'bone', target: id, prop: 'rotate', time: 0 })] });
    const before = docStore.get();
    expect(wiggleSelected({ amount: 1, every: 3, seed: 1, smooth: false, keepEnds: true })).toBe(1);
    expect(currentAnimation()!.bones[id].rotate!.length).toBeGreaterThan(2);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(docStore.get()).toEqual(before);
  });

  it('makes the full cycle as a new animation, and hides the bones without keys', () => {
    const made = mirrorCurrentCycle({ flipCentre: true });
    expect(made).toBeTruthy();
    expect(docStore.get().skeleton.animations).toHaveLength(2);
    expect(currentAnimation()!.duration).toBe(2);
    expect(validateProject(docStore.get())).toEqual([]);
    const un = unkeyedBones(docStore.get().skeleton, currentAnimation());
    expect(un).toHaveLength(1); // the root
    expect(hideUnkeyedBones()).toBe(1);
    expect(
      docStore
        .get()
        .skeleton.bones.filter((b) => b.hidden)
        .map((b) => b.name),
    ).toEqual(['root']);
  });
});
