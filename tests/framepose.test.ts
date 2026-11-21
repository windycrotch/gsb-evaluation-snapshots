/** Posing an animation frame by frame for rendering: forward physics, any order, and Warm Up. */
import { describe, expect, it } from 'vitest';
import { makePoser, warmUpFrames } from '../src/core/framepose';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { buildFixture } from './fixture';
import { addPhysicsRig } from './physicsrig';

function setup(physics: boolean) {
  const f = buildFixture();
  if (physics) addPhysicsRig(f.project);
  const doc = f.project.skeleton;
  const anim = doc.animations.find((a) => a.name === 'walk')!;
  const data = compileSkeleton(doc);
  const make = () => createSkeleton(data);
  const world = (sk: ReturnType<typeof make>) => sk.bones.flatMap((b) => [b.worldX, b.worldY, b.a, b.b, b.c, b.d]);
  return { anim, make, world, hasPhysics: data.constraints.some((c) => c.kind === 'physics') };
}

describe('warmUpFrames', () => {
  it('is whole frames of the seconds, none without physics, and never more than 20 seconds', () => {
    expect(warmUpFrames(1, 30, true)).toBe(30);
    expect(warmUpFrames(0.5, 24, true)).toBe(12);
    expect(warmUpFrames(1, 30, false)).toBe(0);
    expect(warmUpFrames(0, 30, true)).toBe(0);
    expect(warmUpFrames(-3, 30, true)).toBe(0);
    expect(warmUpFrames(Number.NaN, 30, true)).toBe(0);
    expect(warmUpFrames(500, 30, true)).toBe(600);
  });
});

describe('makePoser', () => {
  it('gives the same pose for a frame whether the frames before it were posed or not', () => {
    const { anim, make, world, hasPhysics } = setup(true);
    expect(hasPhysics).toBe(true);
    const a = make();
    const pa = makePoser(a, anim, 30, hasPhysics);
    for (let i = 0; i <= 12; i++) pa.pose(i);
    const b = make();
    makePoser(b, anim, 30, hasPhysics).pose(12); // jumps: starts from the first frame itself
    expect(world(a)).toEqual(world(b));
  });

  it('warm up lets the physics settle before the first frame, and only then', () => {
    const { anim, make, world, hasPhysics } = setup(true);
    const cold = make();
    makePoser(cold, anim, 30, hasPhysics, 0).pose(0);
    const warm = make();
    const poser = makePoser(warm, anim, 30, hasPhysics, 1);
    expect(poser.warmFrames).toBe(30);
    poser.pose(0);
    const c = world(cold);
    const w = world(warm);
    expect(w.every(Number.isFinite)).toBe(true);
    expect(w.some((v, i) => Math.abs(v - c[i]) > 1e-6)).toBe(true);
    // the same warm up gives the same picture every time
    const again = make();
    makePoser(again, anim, 30, hasPhysics, 1).pose(0);
    expect(world(again)).toEqual(w);
    // and the frames after it go on from there
    const next = make();
    const p2 = makePoser(next, anim, 30, hasPhysics, 1);
    p2.pose(0);
    p2.pose(1);
    const jump = make();
    makePoser(jump, anim, 30, hasPhysics, 1).pose(1);
    expect(world(jump)).toEqual(world(next));
  });

  it('does nothing about warm up for a skeleton without physics', () => {
    const { anim, make, world, hasPhysics } = setup(false);
    expect(hasPhysics).toBe(false);
    const a = make();
    const poser = makePoser(a, anim, 30, hasPhysics, 5);
    expect(poser.warmFrames).toBe(0);
    poser.pose(3);
    const b = make();
    makePoser(b, anim, 30, hasPhysics, 0).pose(3);
    expect(world(a)).toEqual(world(b));
  });
});
