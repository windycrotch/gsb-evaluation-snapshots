/** Simplifying keys and baking constraints into bone keys. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE,
  bakeAnimation,
  constrainedBoneIndices,
  countSimplifiable,
  poseFrames,
  simplifyAnimation,
  simplifyKeys,
} from '../src/core/bake';
import { sampleKeys } from '../src/core/curve';
import { uid } from '../src/core/ids';
import type { Animation, ImageRef, Key, Project } from '../src/core/model';
import { compileSkeleton } from '../src/core/skeleton';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';

function kit(): Project {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}

const key = (time: number, ...value: number[]): Key => ({ time, value });

/** Largest difference between two timelines over the frame grid. */
function maxDifference(a: Key[], b: Key[], fps: number): number {
  const out: number[] = [];
  const out2: number[] = [];
  let worst = 0;
  const end = a[a.length - 1].time;
  for (let t = 0; t <= end + 1e-9; t += 1 / fps / 2) {
    sampleKeys(a, t, out);
    sampleKeys(b, t, out2);
    for (let c = 0; c < a[0].value.length; c++) worst = Math.max(worst, Math.abs(out[c] - out2[c]));
  }
  return worst;
}

describe('simplifyKeys', () => {
  it('reduces keys on a straight line to the two ends', () => {
    const keys = Array.from({ length: 31 }, (_, i) => key(i / 30, i * 2));
    const out = simplifyKeys(keys, 0.01, 30);
    expect(out).toHaveLength(2);
    expect(out[0].time).toBe(0);
    expect(out[1].time).toBeCloseTo(1, 9);
  });

  it('keeps a curve within the tolerance and drops keys', () => {
    const keys = Array.from({ length: 61 }, (_, i) => key(i / 30, 40 * Math.sin((i / 30) * Math.PI * 2)));
    for (const tol of [0.1, 0.5, 2]) {
      const out = simplifyKeys(keys, tol, 30);
      expect(out.length).toBeLessThan(keys.length);
      expect(maxDifference(keys, out, 30)).toBeLessThanOrEqual(tol + 1e-9);
    }
    // a looser tolerance never needs more keys
    expect(simplifyKeys(keys, 2, 30).length).toBeLessThanOrEqual(simplifyKeys(keys, 0.1, 30).length);
  });

  it('keeps the keys of a sharp peak', () => {
    const keys = [key(0, 0), key(0.1, 0), key(0.2, 0), key(0.3, 50), key(0.4, 0), key(0.5, 0), key(0.6, 0)];
    const out = simplifyKeys(keys, 0.5, 30);
    expect(out.some((k) => Math.abs(k.time - 0.3) < 1e-9)).toBe(true);
    expect(maxDifference(keys, out, 30)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('does not smooth a stepped jump away', () => {
    const keys: Key[] = [
      { time: 0, value: [0], curve: 'stepped' },
      { time: 0.2, value: [0], curve: 'stepped' },
      { time: 0.4, value: [90], curve: 'stepped' },
      { time: 0.6, value: [90] },
    ];
    const out = simplifyKeys(keys, 0.5, 30);
    expect(maxDifference(keys, out, 30)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('works on several channels at once', () => {
    const keys = Array.from({ length: 41 }, (_, i) => key(i / 30, i, 100 - i * 3));
    expect(simplifyKeys(keys, 0.01, 30)).toHaveLength(2);
    const wavy = Array.from({ length: 41 }, (_, i) => key(i / 30, i, 30 * Math.sin(i / 4)));
    const out = simplifyKeys(wavy, 0.4, 30);
    expect(maxDifference(wavy, out, 30)).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it('leaves short timelines and a zero tolerance alone', () => {
    const two = [key(0, 1), key(1, 2)];
    expect(simplifyKeys(two, 5, 30)).toBe(two);
    const three = [key(0, 1), key(0.5, 1.5), key(1, 2)];
    expect(simplifyKeys(three, 0, 30)).toBe(three);
  });
});

describe('simplifyAnimation', () => {
  const p = kit();
  const doc = p.skeleton;

  it('removes keys from bone timelines only and reports how many', () => {
    const anim = structuredClone(doc.animations.find((a) => a.name === 'walk')!);
    const boneId = Object.keys(anim.bones)[0];
    anim.bones[boneId].rotate = Array.from({ length: 31 }, (_, i) => key(i / 30, i * 0.5));
    const before = anim.bones[boneId].rotate.length;
    const tolerance = DEFAULT_TOLERANCE;
    expect(countSimplifiable(anim, tolerance, doc.fps)).toBeGreaterThanOrEqual(before - 2);
    // counting does not touch the animation
    expect(anim.bones[boneId].rotate).toHaveLength(before);
    const removed = simplifyAnimation(anim, tolerance, doc.fps);
    expect(removed).toBeGreaterThanOrEqual(before - 2);
    expect(anim.bones[boneId].rotate).toHaveLength(2);
  });

  it('can be limited to some bones', () => {
    const anim = structuredClone(doc.animations.find((a) => a.name === 'walk')!);
    const ids = Object.keys(anim.bones);
    for (const id of ids) anim.bones[id].rotate = Array.from({ length: 21 }, (_, i) => key(i / 30, i));
    simplifyAnimation(anim, DEFAULT_TOLERANCE, doc.fps, [ids[0]]);
    expect(anim.bones[ids[0]].rotate).toHaveLength(2);
    if (ids[1]) expect(anim.bones[ids[1]].rotate).toHaveLength(21);
  });
});

function poses(doc: Project['skeleton'], anim: Animation) {
  return { out: poseFrames(doc, anim), names: compileSkeleton(structuredClone(doc)).bones.map((b) => b.name) };
}

function worstDifference(a: number[][][], b: number[][][], names: string[]): { bone: string; frame: number; diff: number } {
  let worst = { bone: '', frame: 0, diff: 0 };
  a.forEach((frame, f) =>
    frame.forEach((m, i) =>
      m.forEach((v, k) => {
        const d = Math.abs(v - b[f][i][k]);
        if (d > worst.diff) worst = { bone: names[i], frame: f, diff: d };
      }),
    ),
  );
  return worst;
}

describe('bakeAnimation', () => {
  const p = kit();
  const doc = p.skeleton;
  const walk = doc.animations.find((a) => a.name === 'walk')!;

  it('finds the bones that constraints move', () => {
    const data = compileSkeleton(structuredClone(doc));
    const names = constrainedBoneIndices(data).map((i) => data.bones[i].name);
    expect(names.length).toBeGreaterThan(2);
    expect(data.constraints.some((c) => c.kind === 'ik')).toBe(true);
    expect(data.constraints.some((c) => c.kind === 'physics')).toBe(true);
  });

  it('gives the same pose on every frame with the constraints turned off', () => {
    const baked = bakeAnimation(doc, walk, { simplify: null });
    expect(baked.id).not.toBe(walk.id);
    const withBaked = { ...structuredClone(doc), animations: [...doc.animations, baked] };
    const original = poses(doc, walk);
    const result = poses(withBaked, baked);
    const worst = worstDifference(original.out, result.out, original.names);
    expect(worst.diff, `${worst.bone} frame ${worst.frame}`).toBeLessThan(1e-6);
  });

  it('stays close to the original after simplification, with far fewer keys', () => {
    const full = bakeAnimation(doc, walk, { simplify: null });
    const lean = bakeAnimation(doc, walk);
    const count = (a: Animation) =>
      Object.values(a.bones).reduce((n, tl) => n + Object.values(tl).reduce((m, keys) => m + (keys?.length ?? 0), 0), 0);
    expect(count(lean)).toBeLessThan(count(full));
    const withBaked = { ...structuredClone(doc), animations: [...doc.animations, lean] };
    const worst = worstDifference(poses(doc, walk).out, poses(withBaked, lean).out, poses(doc, walk).names);
    expect(worst.diff, `${worst.bone} frame ${worst.frame}`).toBeLessThan(3);
  });

  it('keys every N-th frame when asked, and always ends on the last frame', () => {
    const baked = bakeAnimation(doc, walk, { simplify: null, step: 4 });
    const id = Object.keys(baked.bones).find((b) => baked.bones[b].rotate && baked.bones[b].rotate.length > 3)!;
    const times = baked.bones[id].rotate!.map((k) => k.time);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBeCloseTo(walk.duration, 6);
    expect(times[1]).toBeCloseTo(4 / doc.fps, 6);
  });

  it('can bake every bone, or just the ones named', () => {
    const all = bakeAnimation(doc, walk, { bones: 'all', simplify: null, mute: false });
    expect(Object.keys(all.bones).length).toBeGreaterThanOrEqual(Object.keys(walk.bones).length);
    const only = [doc.bones[1].id];
    const one = bakeAnimation(doc, walk, { bones: only, simplify: null, mute: false });
    // the other bones keep the keys they had
    for (const id of Object.keys(walk.bones)) if (id !== only[0]) expect(one.bones[id]).toEqual(walk.bones[id]);
  });

  it('switches every constraint off in the result, and leaves the source animation alone', () => {
    const before = JSON.stringify(walk);
    const baked = bakeAnimation(doc, walk);
    expect(JSON.stringify(walk)).toBe(before);
    for (const c of doc.constraints) {
      if (c.type === 'ik') expect(baked.ik[c.id]?.[0].value[0]).toBe(0);
      if (c.type === 'transform') expect(baked.transform[c.id]?.[0].value.every((v) => v === 0)).toBe(true);
      if (c.type === 'physics') expect(baked.physics[c.id]?.mix?.[0].value[0]).toBe(0);
    }
    const kept = bakeAnimation(doc, walk, { mute: false });
    for (const c of doc.constraints) if (c.type === 'ik') expect(kept.ik[c.id]).toEqual(walk.ik[c.id]);
  });
});
