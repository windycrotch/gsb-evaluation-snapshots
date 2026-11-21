/** Motion trails: the sampled path of a bone is the path the solver gives, frame by frame. */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { sampleTrails, trailAt, trailLength, trailTimes } from '../src/core/trails';
import { uid } from '../src/core/ids';
import type { ImageRef } from '../src/core/model';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';

function kit() {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}

describe('trail times', () => {
  it('are every frame, from the first to the end', () => {
    const t = trailTimes(1, 10);
    expect(t).toHaveLength(11);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(1);
  });

  it('thin out for a very long animation and still end at the duration', () => {
    const t = trailTimes(100, 30, 240);
    expect(t.length).toBeLessThanOrEqual(242);
    expect(t.at(-1)).toBe(100);
    expect(trailTimes(0, 30)).toEqual([0]);
  });
});

describe('sampled trails', () => {
  const p = kit();
  const doc = p.skeleton;
  const data = compileSkeleton(structuredClone(doc));
  const walk = doc.animations.find((a) => a.name === 'walk')!;
  const foot = doc.bones.find((b) => b.name.startsWith('ik'))!;

  it('has a point per sample time, each where the solver puts the bone', () => {
    const [trail] = sampleTrails(data, walk, [foot.id], doc.fps, null);
    expect(trail.points).toHaveLength(trailTimes(walk.duration, doc.fps).length);
    const sk = createSkeleton(data, null);
    for (const pt of [trail.points[0], trail.points[Math.floor(trail.points.length / 2)], trail.points.at(-1)!]) {
      applyAnimation(sk, walk, pt.time);
      sk.updateWorldTransform('reset');
      const b = sk.bones[data.boneIndex.get(foot.id)!];
      expect(pt.x).toBeCloseTo(b.worldX, 6);
      expect(pt.y).toBeCloseTo(b.worldY, 6);
    }
    expect(trailLength(trail)).toBeGreaterThan(1);
  });

  it('follows the tip of a bone when asked, which is further out than its origin', () => {
    const arm = doc.bones.find((b) => b.length > 20 && b.parent)!;
    const [origin] = sampleTrails(data, walk, [arm.id], doc.fps, null, 'origin');
    const [tip] = sampleTrails(data, walk, [arm.id], doc.fps, null, 'tip');
    const gap = Math.hypot(tip.points[0].x - origin.points[0].x, tip.points[0].y - origin.points[0].y);
    expect(gap).toBeCloseTo(arm.length * Math.hypot(1, 0) * 1, -1);
  });

  it('skips bones that do not exist, and interpolates the position of the playhead between samples', () => {
    const trails = sampleTrails(data, walk, ['nope', foot.id], doc.fps, null);
    expect(trails).toHaveLength(1);
    const t = trails[0];
    const a = t.points[3];
    const b = t.points[4];
    const mid = trailAt(t, (a.time + b.time) / 2)!;
    expect(mid[0]).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(mid[1]).toBeCloseTo((a.y + b.y) / 2, 6);
    expect(trailAt({ boneId: 'x', points: [] }, 1)).toBeNull();
    expect(trailAt(t, -5)).toEqual([t.points[0].x, t.points[0].y]);
    expect(trailAt(t, 999)).toEqual([t.points.at(-1)!.x, t.points.at(-1)!.y]);
  });
});
