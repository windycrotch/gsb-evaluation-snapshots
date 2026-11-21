/**
 * An animation layer baked on top of another one: the sum matches what the official runtime gives for an additive second track
 * (additive, alpha = strength, looping), the action makes one history step, and the edge cases (no layer bones, weight 0, a held layer).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCE, scaleTolerance } from '../src/core/bake';
import { DEFAULT_LAYER, layerBones, layerTime, layeredLocal, stackLayer } from '../src/core/layers';
import { newAnimation } from '../src/core/model';
import type { Animation, Key } from '../src/core/model';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { S, exportAndLoad } from './official';

const key = (time: number, ...value: number[]): Key => ({ time, value });

/** The fixture plus a base animation (rotate, translate with a split axis, scale) and a shorter breathing layer on other and shared bones. */
function rig() {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const [a, b, c, d] = doc.bones.slice(1, 5);
  const base = newAnimation('base', 1);
  base.bones[a.id] = { rotate: [key(0, 0), key(0.5, 40), key(1, 0)], translate: [key(0, 0, 0), key(1, 10, -4)] };
  base.bones[b.id] = { translatex: [key(0, 0), key(1, 12)], scale: [key(0, 1, 1), key(1, 1.4, 0.8)] };
  base.bones[c.id] = { shear: [key(0, 0, 0), key(1, 20, 5)] };
  const breath = newAnimation('breath', 0.6);
  breath.bones[a.id] = { rotate: [key(0, 0), key(0.3, 6), key(0.6, 0)] };
  breath.bones[b.id] = { scale: [key(0, 1, 1), key(0.3, 1.1, 0.9), key(0.6, 1, 1)], translatey: [key(0, 0), key(0.6, 3)] };
  breath.bones[d.id] = { rotate: [key(0, 0), key(0.6, 30)] };
  doc.animations.push(base, breath);
  return { project, doc, base, breath, ids: { a: a.id, b: b.id, c: c.id, d: d.id }, all: new Set(doc.bones.map((x) => x.id)) };
}

const times = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.99];

describe('the sum of two animations', () => {
  it('adds a rotation, a translation and a shear; a scale as a multiplier', () => {
    const { base, breath, ids } = rig();
    const at = layeredLocal(base.bones[ids.a], breath.bones[ids.a], 0.3, 0.3, 1);
    expect(at.rotate).toBeCloseTo(24 + 6, 6);
    const s = layeredLocal(base.bones[ids.b], breath.bones[ids.b], 0.5, 0.3, 0.5);
    expect(s.scaleX).toBeCloseTo(1.2 + (1.1 - 1) * 0.5, 6);
    expect(s.scaleY).toBeCloseTo(0.9 + (0.9 - 1) * 0.5, 6);
    expect(s.x).toBeCloseTo(6, 6);
    expect(s.y).toBeCloseTo(0.5 * 1.5, 6);
  });

  it('repeats a looping layer and holds the last pose of a plain one', () => {
    const { breath } = rig();
    expect(layerTime(breath, 0.7, true)).toBeCloseTo(0.1, 9);
    expect(layerTime(breath, 0.7, false)).toBe(0.7);
  });

  it('writes keys only for the bones of the layer and leaves the rest of the base alone', () => {
    const { project, doc, base, breath, ids, all } = rig();
    const out = stackLayer(base, breath, all, doc.fps, { simplify: null });
    expect(out.id).not.toBe(base.id);
    expect(out.duration).toBe(base.duration);
    expect(out.bones[ids.c]).toEqual(base.bones[ids.c]);
    expect(out.bones[ids.d]?.rotate?.length).toBeGreaterThan(2);
    expect(out.bones[ids.b]?.translatex).toBeUndefined(); // the split axis is now in the combined translate
    expect(out.bones[ids.b]?.translate).toBeDefined();
    expect(layerBones(breath, all).sort()).toEqual([ids.a, ids.b, ids.d].sort());
    expect(project.skeleton.animations).toContain(base);
    expect(base.bones[ids.b].translatex).toBeDefined(); // the base animation is not touched
  });

  it('weight 0 gives the base back, a missing layer bone set gives a copy', () => {
    const { doc, base, breath, ids, all } = rig();
    const none = stackLayer(base, breath, all, doc.fps, { weight: 0, simplify: null });
    for (const t of times) {
      const want = layeredLocal(base.bones[ids.a], undefined, t, 0, 1);
      const got = layeredLocal(none.bones[ids.a], undefined, t, 0, 1);
      expect(got.rotate).toBeCloseTo(want.rotate, 5);
      expect(got.x).toBeCloseTo(want.x, 5);
    }
    const empty: Animation = newAnimation('empty', 1);
    const copy = stackLayer(base, empty, all, doc.fps);
    expect(copy.bones).toEqual(base.bones);
  });

  it('simplifies the keys within the tolerance', () => {
    const { doc, base, breath, ids, all } = rig();
    const exact = stackLayer(base, breath, all, doc.fps, { simplify: null });
    const light = stackLayer(base, breath, all, doc.fps, { simplify: scaleTolerance(DEFAULT_TOLERANCE, 1) });
    expect(light.bones[ids.a].rotate!.length).toBeLessThan(exact.bones[ids.a].rotate!.length);
    for (const t of times) {
      const e = layeredLocal(exact.bones[ids.a], undefined, t, 0, 1);
      const l = layeredLocal(light.bones[ids.a], undefined, t, 0, 1);
      expect(Math.abs(e.rotate - l.rotate)).toBeLessThan(0.3);
    }
  });

  it('keys every step-th frame', () => {
    const { doc, base, breath, ids, all } = rig();
    const out = stackLayer(base, breath, all, doc.fps, { simplify: null, step: 4 });
    const n = out.bones[ids.a].rotate!.length;
    expect(n).toBeLessThan(Math.round(doc.fps) / 2);
    expect(out.bones[ids.a].rotate![n - 1].time).toBeCloseTo(1, 9);
  });
});

/** Local pose of every bone from the official runtime: `base` on track 0, `layer` on track 1 as an additive loop. */
function officialLayered(sd: any, t: number, layered: { base: string; layer: string; weight: number } | null, single: string | null) {
  const sk = new S.Skeleton(sd);
  sk.setupPose();
  const state = new S.AnimationState(new S.AnimationStateData(sd));
  if (layered) {
    state.setAnimation(0, layered.base, true);
    const e = state.setAnimation(1, layered.layer, true);
    e.additive = true;
    e.alpha = layered.weight;
  } else state.setAnimation(0, single!, true);
  state.update(t);
  state.apply(sk);
  return sk.bones.map((b: any) => [b.pose.rotation, b.pose.x, b.pose.y, b.pose.scaleX, b.pose.scaleY, b.pose.shearX, b.pose.shearY]);
}

describe('against the official runtime', () => {
  it('equals an additive looping second track', () => {
    for (const weight of [1, 0.5, 1.5]) {
      const { project, doc, base, breath, all } = rig();
      const out = stackLayer(base, breath, all, doc.fps, { weight, simplify: null });
      doc.animations.push(out);
      const { skeletonData } = exportAndLoad(project);
      for (const t of times) {
        const want = officialLayered(skeletonData, t, { base: 'base', layer: 'breath', weight }, null);
        const got = officialLayered(skeletonData, t, null, out.name);
        want.forEach((row: number[], i: number) =>
          row.forEach((v, k) => expect(got[i][k], `weight ${weight} t=${t} bone ${i} channel ${k}`).toBeCloseTo(v, 3)),
        );
      }
    }
  });

  it('a layer that does not repeat holds its last pose, like a track that ended with the last key kept', () => {
    const { project, doc, base, breath, all } = rig();
    const out = stackLayer(base, breath, all, doc.fps, { loop: false, simplify: null });
    doc.animations.push(out);
    const { skeletonData } = exportAndLoad(project);
    const a = doc.bones[1].name;
    const bone = skeletonData.bones.findIndex((b: any) => b.name === a);
    // after 0.6 s the layer rests at its last key (rotate 0): the baked rotation is the base rotation alone
    const late = officialLayered(skeletonData, 0.8, null, out.name)[bone][0];
    const baseOnly = officialLayered(skeletonData, 0.8, null, 'base')[bone][0];
    expect(late).toBeCloseTo(baseOnly, 3);
  });
});

describe('the action', () => {
  function open() {
    const r = rig();
    docStore.replace(r.project);
    uiStore.patch({ animationId: r.base.id, time: 0, playing: false, selectedKeys: [] });
    return r;
  }

  it('adds one new animation in one history step and selects it', () => {
    const { breath, base } = open();
    const before = docStore.get().skeleton.animations.length;
    const id = A.layerCurrentAnimation(breath.id, { weight: 1, loop: true });
    expect(id).toBeTruthy();
    expect(docStore.get().skeleton.animations.length).toBe(before + 1);
    expect(uiStore.get().animationId).toBe(id);
    expect(docStore.get().skeleton.animations.find((a) => a.id === id)!.name).toBe(`${base.name} + ${breath.name}`);
    expect(docStore.undoLabel).toBe('Layer animation');
    docStore.undo();
    expect(docStore.get().skeleton.animations.length).toBe(before);
  });

  it('changes nothing for the animation itself or a layer that moves no bones', () => {
    const { breath, base, doc } = open();
    const rev = docStore.revision;
    expect(A.layerCurrentAnimation(base.id, {})).toBeNull();
    const none = newAnimation('still', 1);
    docStore.update('x', (d) => {
      d.skeleton.animations.push(none);
    });
    const rev2 = docStore.revision;
    expect(A.layerCurrentAnimation(none.id, {})).toBeNull();
    expect(docStore.revision).toBe(rev2);
    expect(rev).toBeLessThan(rev2);
    expect(breath.id).toBeTruthy();
    expect(doc.fps).toBeGreaterThan(0);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_LAYER.weight).toBe(1);
    expect(DEFAULT_LAYER.loop).toBe(true);
  });
});
