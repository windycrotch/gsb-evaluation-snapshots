/** Automatic curves: smooth through the neighbours, never past a key's value, the same curve in the official runtime. */
import { describe, expect, it } from 'vitest';
import { autoCurve, autoSlope } from '../src/core/autocurve';
import type { AutoKey } from '../src/core/autocurve';
import { sampleKeys } from '../src/core/curve';
import { newAnimation } from '../src/core/model';
import { setKeysAutoCurve } from '../src/store/curveActions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { S, exportAndLoad } from './official';

const keys = (...pairs: [number, number][]): AutoKey[] => pairs.map(([time, v]) => ({ time, value: [v] }));
const at = (list: AutoKey[], t: number) => {
  const out: number[] = [];
  sampleKeys(list as any, t, out);
  return out[0];
};

describe('the slope at a key', () => {
  const t = [0, 1, 2];
  it('is the line through the neighbours, zero at a peak or a valley, capped on a steep side', () => {
    expect(autoSlope(t, [0, 5, 10], 1)).toBeCloseTo(5, 9);
    expect(autoSlope(t, [0, 10, 0], 1)).toBe(0);
    expect(autoSlope(t, [4, 0, 4], 1)).toBe(0);
    // a long climb then a flat bit: the slope may not exceed three times the gentle side, so the curve cannot overshoot
    expect(autoSlope(t, [0, 10, 10.1], 1)).toBeCloseTo(0.3, 9);
    // the ends use their one segment
    expect(autoSlope(t, [0, 4, 6], 0)).toBe(4);
    expect(autoSlope(t, [0, 4, 6], 2)).toBe(2);
  });
});

describe('autoCurve', () => {
  it('writes bezier handles on the segments around the chosen keys and leaves the others', () => {
    const k = keys([0, 0], [1, 10], [2, 4], [3, 4]);
    const n = autoCurve(k, [1]);
    expect(n).toBe(1);
    expect(Array.isArray(k[0].curve)).toBe(true); // the incoming handle of key 1
    expect(Array.isArray(k[1].curve)).toBe(true); // its outgoing handle
    expect(k[2].curve).toBeUndefined();
    // a peak: both handles are flat (they sit at the key's value)
    expect((k[0].curve as number[])[3]).toBeCloseTo(1, 9);
    expect((k[1].curve as number[])[1]).toBeCloseTo(0, 9);
  });

  it('the curve is smooth through a key: the tangent of the handle on both sides is the same', () => {
    const k = keys([0, 0], [1, 3], [2, 9], [3, 10]);
    autoCurve(k, [1, 2]);
    for (const i of [1, 2]) {
      const c = k[i].curve as number[];
      const p = k[i - 1].curve as number[];
      const dt = k[i + 1].time - k[i].time;
      const dv = k[i + 1].value![0] - k[i].value![0];
      const dtp = k[i].time - k[i - 1].time;
      const dvp = k[i].value![0] - k[i - 1].value![0];
      const out = (c[1] * dv) / (c[0] * dt);
      const inc = ((1 - p[3]) * dvp) / ((1 - p[2]) * dtp);
      expect(out).toBeCloseTo(inc, 9);
    }
  });

  it('never leaves the range of the two keys of a segment (no overshoot)', () => {
    const k = keys([0, 0], [0.5, 10], [1, 10.2], [1.5, 30], [2, 30], [2.5, -5]);
    autoCurve(k, [0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < k.length - 1; i++) {
      const lo = Math.min(k[i].value![0], k[i + 1].value![0]) - 1e-9;
      const hi = Math.max(k[i].value![0], k[i + 1].value![0]) + 1e-9;
      for (let s = 0; s <= 20; s++) {
        const v = at(k, k[i].time + ((k[i + 1].time - k[i].time) * s) / 20);
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('keeps a stepped segment stepped, does every channel by itself, ignores keys without values', () => {
    const k: AutoKey[] = [
      { time: 0, value: [0, 0], curve: 'stepped' },
      { time: 1, value: [5, 100] },
      { time: 2, value: [10, 100] },
    ];
    autoCurve(k, [1]);
    expect(k[0].curve).toBe('stepped');
    const c = k[1].curve as number[];
    expect(c).toHaveLength(8);
    expect(c[1]).not.toBeCloseTo(c[5], 3); // the channels differ
    expect(autoCurve([{ time: 0 }, { time: 1 }], [0])).toBe(0);
    expect(autoCurve(keys([0, 1]), [0])).toBe(0);
  });

  it('a key that does not move keeps flat handles (a hold)', () => {
    const k = keys([0, 5], [1, 5], [2, 5]);
    autoCurve(k, [1]);
    expect(at(k, 0.5)).toBeCloseTo(5, 9);
    expect(at(k, 1.5)).toBeCloseTo(5, 9);
  });
});

describe('the action and the official runtime', () => {
  function open() {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const bone = doc.bones[1];
    const anim = newAnimation('swing', 2);
    anim.bones[bone.id] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 0.5, value: [30] },
        { time: 1, value: [10] },
        { time: 1.5, value: [70] },
        { time: 2, value: [70] },
      ],
    };
    doc.animations.push(anim);
    docStore.replace(project);
    uiStore.patch({ animationId: anim.id, time: 0, playing: false, selectedKeys: [] });
    return { project, bone, anim };
  }

  it('one history step; the saved curves equal what the official runtime plays', () => {
    const { bone, anim } = open();
    const refs = [0.5, 1, 1.5].map((time) => ({ kind: 'bone' as const, target: bone.id, prop: 'rotate', time }));
    expect(setKeysAutoCurve(refs)).toBe(3);
    expect(docStore.undoLabel).toBe('Automatic curve');
    const saved = docStore.get();
    const mine = saved.skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id].rotate!;
    const { skeletonData } = exportAndLoad(saved);
    const index = skeletonData.bones.findIndex((b: any) => b.name === bone.name);
    const sk = new S.Skeleton(skeletonData);
    sk.setupPose();
    const setup = sk.bones[index].pose.rotation;
    const state = new S.AnimationState(new S.AnimationStateData(skeletonData));
    state.setAnimation(0, 'swing', false);
    let t = 0;
    for (const target of [0.1, 0.3, 0.5, 0.7, 0.95, 1.2, 1.4, 1.8]) {
      sk.setupPose();
      state.update(target - t);
      t = target;
      state.apply(sk);
      const out: number[] = [];
      sampleKeys(mine, target, out);
      expect(sk.bones[index].pose.rotation, `t=${target}`).toBeCloseTo(setup + out[0], 2);
    }
    docStore.undo();
    expect(docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id].rotate![1].curve).toBeUndefined();
  });

  it('does nothing without an animation or keys', () => {
    open();
    uiStore.patch({ animationId: '' });
    expect(setKeysAutoCurve([{ kind: 'bone', target: 'x', prop: 'rotate', time: 0 }])).toBe(0);
  });
});
