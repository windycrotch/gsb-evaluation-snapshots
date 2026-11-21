/** The reference ghost: which moment of another animation goes with the playhead. */
import { describe, expect, it } from 'vitest';
import { referenceGhost, referenceTime } from '@/editor/ghosts';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { Scene } from '@/store/scene';

describe('reference time', () => {
  it('is the playhead time inside the animation', () => {
    expect(referenceTime(0.5, 2, true)).toBe(0.5);
    expect(referenceTime(2, 2, false)).toBe(2);
    expect(referenceTime(-1, 2, true)).toBe(0);
  });

  it('wraps round a loop past the end, holds the last frame without one', () => {
    expect(referenceTime(2.5, 2, true)).toBeCloseTo(0.5, 9);
    expect(referenceTime(5, 2, true)).toBeCloseTo(1, 9);
    expect(referenceTime(2.5, 2, false)).toBe(2);
  });

  it('an animation with no length shows its first frame', () => {
    expect(referenceTime(3, 0, true)).toBe(0);
  });
});

describe('reference ghost', () => {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const arm = newBone({ name: 'arm', parent: root.id, length: 40, rotation: 10 });
  p.skeleton.bones.push(root, arm);
  const a = newAnimation('wave', 1);
  a.bones[arm.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [90] },
    ],
  };
  p.skeleton.animations.push(a);
  const data = compileSkeleton(p.skeleton);
  const scene = { data } as unknown as Scene;
  const armOf = (g: { skeleton: ReturnType<typeof createSkeleton> }) => g.skeleton.boneById(arm.id)!;

  it('poses the skeleton as the other animation is at that time', () => {
    const g = referenceGhost(scene, a, 0.5, true, null);
    expect(armOf(g).rotation).toBeCloseTo(10 + 45, 6);
    expect(g.alpha).toBeGreaterThan(0);
  });

  it('shows the setup pose for null, and a later call re-poses the same skeleton', () => {
    const g = referenceGhost(scene, null, 0.5, true, null);
    expect(armOf(g).rotation).toBeCloseTo(10, 6);
    const again = referenceGhost(scene, a, 1, true, null);
    expect(again.skeleton).toBe(g.skeleton);
    expect(armOf(again).rotation).toBeCloseTo(10 + 90, 6);
    expect(armOf(referenceGhost(scene, null, 0, true, null)).rotation).toBeCloseTo(10, 6);
  });
});
