/**
 * A physics constraint is not a no-op even for a pose at rest. In the `update` / `reset` / `pose` modes it declares that the bone's
 * WORLD transform was modified, so whatever applies local values afterwards (here a slider that applies an animation) first
 * re-derives the bone's applied transform from the world matrix; for a bone with shear that is another, equivalent decomposition,
 * and the result differs from the `none` mode. The random-session test found it: it compared our `none` mode with the official
 * `Physics.update`. Every mode has to agree with the official runtime, and the difference between the modes has to be the same.
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { emptyProject, newAnimation, newBone, newPhysicsConstraint, newSliderConstraint } from '../src/core/model';
import type { Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import type { PhysicsMode } from '../src/core/skeleton';
import { S, exportAndLoad, startLikeOfficial } from './official';

const MODES: [PhysicsMode, number][] = [
  ['none', S.Physics.none],
  ['update', S.Physics.update],
  ['reset', S.Physics.reset],
  ['pose', S.Physics.pose],
];

/** `arm` (with shear) carries a physics constraint; the slider applies the animation "walk" at its time 0 AFTER the physics constraint. */
function rig(sliderFirst = false): Project {
  const project = emptyProject('physics mode');
  const doc = project.skeleton;
  const root = doc.bones[0].id;
  const arm = newBone({ name: 'arm', parent: root, x: 70, y: 20, rotation: -30, shearX: 6, length: 60 });
  const hand = newBone({ name: 'hand', parent: arm.id, x: 60, rotation: 20, length: 50 });
  doc.bones.push(arm, hand);
  const walk = newAnimation('walk', 1);
  walk.bones[arm.id] = {
    rotate: [
      { time: 0, value: [25] },
      { time: 1, value: [60] },
    ],
  };
  walk.bones[hand.id] = {
    rotate: [
      { time: 0, value: [-15] },
      { time: 1, value: [30] },
    ],
  };
  doc.animations.push(walk);
  const physics = newPhysicsConstraint({ name: 'arm physics', bone: arm.id, rotate: 1 });
  const slider = newSliderConstraint({ name: 'slider', animation: walk.id, time: 0 });
  doc.constraints.push(...(sliderFirst ? [slider, physics] : [physics, slider]));
  return project;
}

function official(skeletonData: unknown, t: number, physics: number) {
  const skeleton = new S.Skeleton(skeletonData);
  skeleton.setupPose();
  const state = new S.AnimationState(new S.AnimationStateData(skeletonData));
  state.setAnimation(0, 'walk', false);
  state.update(t);
  state.apply(skeleton);
  skeleton.updateWorldTransform(physics);
  return skeleton;
}

function ours(project: Project, t: number, mode: PhysicsMode) {
  const skeleton = createSkeleton(compileSkeleton(project.skeleton));
  startLikeOfficial(skeleton);
  applyAnimation(skeleton, project.skeleton.animations[0], t);
  skeleton.updateWorldTransform(mode);
  return skeleton;
}

const KEYS = ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const;

function matrices(bones: { a: number; b: number; c: number; d: number; worldX: number; worldY: number }[]) {
  return bones.flatMap((b) => KEYS.map((k) => b[k]));
}
const maxDiff = (x: number[], y: number[]) => Math.max(...x.map((v, i) => Math.abs(v - y[i])));

describe('physics constraints next to a constraint that applies local values', () => {
  for (const sliderFirst of [false, true]) {
    for (const [mode, physics] of MODES) {
      it(`${mode}: our pose is the official one (${sliderFirst ? 'slider first' : 'physics first'})`, () => {
        const project = rig(sliderFirst);
        const { skeletonData } = exportAndLoad(project);
        // off the key times: the official runtime keeps them in float32
        for (const t of [0.37, 0.8]) {
          const mine = matrices(ours(project, t, mode).bones.map((b) => b));
          const theirs = matrices(official(skeletonData, t, physics).bones.map((b: any) => b.appliedPose));
          expect(maxDiff(mine, theirs), `t=${t}`).toBeLessThan(1e-3);
        }
      });
    }
  }

  it('the mode matters when the physics constraint comes first (otherwise the comparison above says nothing)', () => {
    const project = rig(false);
    const { skeletonData } = exportAndLoad(project);
    const none = matrices(official(skeletonData, 0.37, S.Physics.none).bones.map((b: any) => b.appliedPose));
    const update = matrices(official(skeletonData, 0.37, S.Physics.update).bones.map((b: any) => b.appliedPose));
    expect(maxDiff(none, update)).toBeGreaterThan(1e-3);
    // ... and ours knows the difference too
    expect(maxDiff(matrices(ours(project, 0.37, 'none').bones), matrices(ours(project, 0.37, 'update').bones))).toBeGreaterThan(1e-3);
  });
});
