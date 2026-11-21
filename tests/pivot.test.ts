/**
 * Turning a bone about a point of the world: the bone's origin goes round the point and the bone turns by the same angle,
 * checked against the real world transform of the skeleton (parents that are turned, scaled and mirrored included).
 */
import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../src/core/math';
import { originOf, turnAbout, turnSign } from '../src/core/pivot';
import type { TurnFrame } from '../src/core/pivot';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { buildFixture } from './fixture';

const worldOf = (project: ReturnType<typeof buildFixture>['project']) => {
  const sk = createSkeleton(compileSkeleton(project.skeleton), null);
  sk.updateWorldTransform('none');
  return sk;
};

/** The frame of a bone of the fixture, read from its parent's world transform. */
function frameOf(project: ReturnType<typeof buildFixture>['project'], name: string): { frame: TurnFrame; id: string } {
  const sk = worldOf(project);
  const bone = project.skeleton.bones.find((b) => b.name === name)!;
  const live = sk.boneById(bone.id)!;
  const p = live.parent;
  const parent = p ? { a: p.a, b: p.b, c: p.c, d: p.d, x: p.worldX, y: p.worldY } : null;
  return { id: bone.id, frame: { x: bone.x, y: bone.y, rotation: bone.rotation, sign: turnSign(parent), parent } };
}

function apply(project: ReturnType<typeof buildFixture>['project'], id: string, pose: { x: number; y: number; rotation: number }) {
  const bone = project.skeleton.bones.find((b) => b.id === id)!;
  Object.assign(bone, pose);
}

const worldAngle = (b: { a: number; c: number }) => (Math.atan2(b.c, b.a) * 180) / Math.PI;

describe('turnAbout', () => {
  it('is the pose it started from when the angle is zero', () => {
    const { project } = buildFixture();
    const { frame } = frameOf(project, 'head');
    const r = turnAbout(frame, 33, -12, 0);
    expect(r.x).toBeCloseTo(frame.x, 9);
    expect(r.y).toBeCloseTo(frame.y, 9);
    expect(r.rotation).toBeCloseTo(frame.rotation, 9);
  });

  it('keeps the bone where it is when the point is its own origin, and only turns it', () => {
    const { project } = buildFixture();
    const { frame } = frameOf(project, 'head');
    const [ox, oy] = originOf(frame);
    const r = turnAbout(frame, ox, oy, 37);
    expect(r.x).toBeCloseTo(frame.x, 6);
    expect(r.y).toBeCloseTo(frame.y, 6);
    expect(r.rotation).toBeCloseTo(frame.rotation + 37, 9);
  });

  for (const name of ['head', 'torso', 'hip', 'arm near 1', 'hand near']) {
    it(`takes the origin of "${name}" round the point and turns the bone by the same angle in the real skeleton`, () => {
      const { project } = buildFixture();
      if (!project.skeleton.bones.some((b) => b.name === name)) return;
      const { frame, id } = frameOf(project, name);
      const sk0 = worldOf(project);
      const before = sk0.boneById(id)!;
      const [x0, y0, a0] = [before.worldX, before.worldY, worldAngle(before)];
      for (const [px, py, deg] of [
        [10, 200, 35],
        [-60, 90, -80],
        [0, 0, 170],
        [x0 + 5, y0 - 9, -25],
      ]) {
        const next = turnAbout(frame, px, py, deg);
        const copy = structuredClone(project);
        apply(copy, id, next);
        const after = worldOf(copy).boneById(id)!;
        const r = (deg * Math.PI) / 180;
        const ex = px + (x0 - px) * Math.cos(r) - (y0 - py) * Math.sin(r);
        const ey = py + (x0 - px) * Math.sin(r) + (y0 - py) * Math.cos(r);
        expect(after.worldX).toBeCloseTo(ex, 5);
        expect(after.worldY).toBeCloseTo(ey, 5);
        expect(wrapAngle(worldAngle(after) - a0)).toBeCloseTo(wrapAngle(deg), 5);
      }
    });
  }

  it('does the same under a parent that is scaled and mirrored (the angle too, when the scale is even)', () => {
    const { project } = buildFixture();
    const torso = project.skeleton.bones.find((b) => b.name === 'torso')!;
    torso.scaleX = -1.4;
    torso.scaleY = 1.4;
    const { frame, id } = frameOf(project, 'head');
    expect(frame.sign).toBe(-1);
    const before = worldOf(project).boneById(id)!;
    const [x0, y0, a0] = [before.worldX, before.worldY, worldAngle(before)];
    const next = turnAbout(frame, 20, 140, 55);
    const copy = structuredClone(project);
    apply(copy, id, next);
    const after = worldOf(copy).boneById(id)!;
    const r = (55 * Math.PI) / 180;
    expect(after.worldX).toBeCloseTo(20 + (x0 - 20) * Math.cos(r) - (y0 - 140) * Math.sin(r), 5);
    expect(after.worldY).toBeCloseTo(140 + (x0 - 20) * Math.sin(r) + (y0 - 140) * Math.cos(r), 5);
    expect(wrapAngle(worldAngle(after) - a0)).toBeCloseTo(55, 5);
  });

  it('moves the origin to the right place under an unevenly scaled parent too, where a local angle is not a world angle', () => {
    const { project } = buildFixture();
    project.skeleton.bones.find((b) => b.name === 'torso')!.scaleY = 0.5;
    const { frame, id } = frameOf(project, 'head');
    const before = worldOf(project).boneById(id)!;
    const next = turnAbout(frame, -15, 100, -40);
    const copy = structuredClone(project);
    apply(copy, id, next);
    const after = worldOf(copy).boneById(id)!;
    const r = (-40 * Math.PI) / 180;
    expect(after.worldX).toBeCloseTo(-15 + (before.worldX + 15) * Math.cos(r) - (before.worldY - 100) * Math.sin(r), 5);
    expect(after.worldY).toBeCloseTo(100 + (before.worldX + 15) * Math.sin(r) + (before.worldY - 100) * Math.cos(r), 5);
  });

  it('turning forward and then back by the same angle returns to the start pose', () => {
    const { project } = buildFixture();
    const { frame } = frameOf(project, 'head');
    const there = turnAbout(frame, 12, 130, 63);
    const back = turnAbout({ ...frame, x: there.x, y: there.y, rotation: there.rotation }, 12, 130, -63);
    expect(back.x).toBeCloseTo(frame.x, 6);
    expect(back.y).toBeCloseTo(frame.y, 6);
    expect(back.rotation).toBeCloseTo(frame.rotation, 6);
  });

  it('works for a root bone, which has no parent', () => {
    const f: TurnFrame = { x: 10, y: 0, rotation: 0, sign: 1, parent: null };
    const r = turnAbout(f, 0, 0, 90);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(10, 9);
    expect(r.rotation).toBe(90);
  });
});
