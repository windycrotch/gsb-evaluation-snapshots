/** Tween: a pose between the keys on either side of the playhead. */
import { beforeEach, describe, expect, it } from 'vitest';
import { neighbours, tweenBone, tweenValue } from '@/core/tween';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import { tweenSelected } from '@/store/animToolActions';
import { addLimit } from '@/store/limitActions';
import { docStore } from '@/store/doc';
import { uiStore } from '@/store/ui';

function rig() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const arm = newBone({ name: 'arm', parent: root.id, length: 50 });
  p.skeleton.bones.push(root, arm);
  const a = newAnimation('a', 2);
  a.bones[arm.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [40], curve: [0.2, 0, 0.8, 1] },
      { time: 2, value: [100] },
    ],
    translate: [
      { time: 0, value: [0, 0] },
      { time: 2, value: [10, -20] },
    ],
  };
  p.skeleton.animations.push(a);
  docStore.replace(p);
  uiStore.patch({
    mode: 'animate',
    animationId: a.id,
    time: 0.5,
    selection: { ...uiStore.get().selection, bones: [arm.id] },
    overrides: {},
  });
  return { root, arm, a };
}

describe('tween', () => {
  beforeEach(() => void rig());

  it('neighbours: the keys around a time, a key at the time is neither, one side repeats', () => {
    const keys = [
      { time: 0, value: [0] },
      { time: 1, value: [10] },
      { time: 2, value: [30] },
    ];
    expect(neighbours(keys, 0.5)).toEqual({ prev: keys[0], next: keys[1] });
    expect(neighbours(keys, 1)).toEqual({ prev: keys[0], next: keys[2] });
    expect(neighbours(keys, 3)).toEqual({ prev: keys[2], next: keys[2] });
    expect(neighbours(keys, -1)).toEqual({ prev: keys[0], next: keys[0] });
    expect(neighbours([], 1)).toBeNull();
    expect(neighbours(undefined, 1)).toBeNull();
  });

  it('values blend, overshoot and undershoot', () => {
    expect(tweenValue([0, 10], [10, 30], 0.5)).toEqual([5, 20]);
    expect(tweenValue([0], [10], 1.25)).toEqual([12.5]);
    expect(tweenValue([0], [10], -0.25)).toEqual([-2.5]);
  });

  it('a bone gets a value per channel that has neighbours', () => {
    const { arm, a } = rig();
    const v = tweenBone(a, arm.id, 0.5, 0.5);
    expect(v.rotate).toEqual([20]);
    expect(v.translate).toEqual([5, -10]);
    expect(v.scale).toBeUndefined();
  });

  it('tweenSelected keys every channel at the playhead, once more only changes the value, one undo step per call', () => {
    const { arm } = rig();
    expect(tweenSelected(0.25)).toBe(1);
    let tl = docStore.get().skeleton.animations[0].bones[arm.id];
    expect(tl.rotate!.find((k) => k.time === 0.5)!.value).toEqual([10]);
    expect(tl.translate!.find((k) => k.time === 0.5)!.value).toEqual([2.5, -5]);
    expect(tl.rotate!.length).toBe(4);
    tweenSelected(0.75);
    tl = docStore.get().skeleton.animations[0].bones[arm.id];
    expect(tl.rotate!.length).toBe(4);
    expect(tl.rotate!.find((k) => k.time === 0.5)!.value).toEqual([30]);
    docStore.undo();
    tl = docStore.get().skeleton.animations[0].bones[arm.id];
    expect(tl.rotate!.find((k) => k.time === 0.5)!.value).toEqual([10]);
  });

  it('nothing happens in Setup mode or without keys around', () => {
    const { arm } = rig();
    uiStore.patch({ mode: 'setup' });
    expect(tweenSelected(0.5)).toBe(0);
    uiStore.patch({ mode: 'animate', selection: { ...uiStore.get().selection, bones: [docStore.get().skeleton.bones[0].id] } });
    expect(tweenSelected(0.5)).toBe(0);
    void arm;
  });

  it('a bone with a rotation limit is tweened through its control bone', () => {
    const { arm } = rig();
    uiStore.patch({ mode: 'setup' });
    const control = addLimit(arm.id, 60)!;
    uiStore.patch({ mode: 'animate', time: 0.5 });
    expect(tweenSelected(0.5)).toBe(1);
    const a = docStore.get().skeleton.animations[0];
    expect(a.bones[control].rotate!.find((k) => k.time === 0.5)!.value).toEqual([20]);
    expect(a.bones[arm.id].rotate).toBeUndefined();
  });
});
