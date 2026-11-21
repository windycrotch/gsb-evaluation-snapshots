/** Favor and Scale time on selected keys. */
import { describe, expect, it } from 'vitest';
import { favorKeys, neutralOf, scaledTimes } from '../src/core/keytools';
import { newAnimation } from '../src/core/model';
import { encodeKey } from '../src/core/keyrefs';
import { favorSelectedKeys, keyStash, scaleSelectedKeyTimes, storeSelectedKeys, swapStoredKeys } from '../src/store/keyToolActions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const keys = (...v: [number, number][]) => v.map(([time, value]) => ({ time, value: [value] }));

describe('favorKeys', () => {
  it('moves a key toward the one before, the one after, or the mean of both', () => {
    const mk = () => keys([0, 0], [1, 10], [2, 4]);
    let k = mk();
    expect(favorKeys(k, [1], 'previous', 0.5)).toBe(1);
    expect(k[1].value[0]).toBeCloseTo(5, 9);
    k = mk();
    favorKeys(k, [1], 'next', 0.5);
    expect(k[1].value[0]).toBeCloseTo(7, 9);
    k = mk();
    favorKeys(k, [1], 'average', 1);
    expect(k[1].value[0]).toBeCloseTo(2, 9);
    k = mk();
    favorKeys(k, [1], 'average', 0.25);
    expect(k[1].value[0]).toBeCloseTo(10 + (2 - 10) * 0.25, 9);
  });

  it('at an end only the neighbour there is counts, and a missing side does nothing', () => {
    const k = keys([0, 6], [1, 2]);
    expect(favorKeys(k, [0], 'previous', 1)).toBe(0);
    expect(favorKeys(k, [0], 'average', 1)).toBe(1);
    expect(k[0].value[0]).toBeCloseTo(2, 9);
  });

  it('keys next to each other are measured against the values from before the call', () => {
    const k = keys([0, 0], [1, 10], [2, 20], [3, 0]);
    favorKeys(k, [1, 2], 'previous', 1);
    expect(k[1].value[0]).toBe(0);
    expect(k[2].value[0]).toBe(10); // the old value of key 1, not the new one
  });

  it('neutral takes every channel to the setup value; amounts are clamped; no change returns 0', () => {
    const k = [
      { time: 0, value: [2, 3] },
      { time: 1, value: [4, 5] },
    ];
    favorKeys(k, [1], 'neutral', 2, [1, 1]);
    expect(k[1].value).toEqual([1, 1]);
    expect(favorKeys(k, [1], 'neutral', 0, [1, 1])).toBe(0);
    expect(favorKeys(k, [1], 'neutral', 1, undefined)).toBe(0);
    expect(favorKeys([{ time: 0 }, { time: 1 }], [1], 'previous', 1)).toBe(0);
  });

  it('knows what a timeline rests on', () => {
    expect(neutralOf('bone', 'rotate', 1)).toEqual([0]);
    expect(neutralOf('bone', 'scale', 2)).toEqual([1, 1]);
    expect(neutralOf('bone', 'translatex', 1)).toEqual([0]);
    expect(neutralOf('bone', 'scaley', 1)).toEqual([1]);
    expect(neutralOf('slot', 'rgba', 4)).toBeUndefined();
  });
});

describe('favorKeys as a block', () => {
  it('moves the selected keys together until the first meets the key before it, the differences kept', () => {
    const k = keys([0, 0], [1, 10], [2, 14], [3, 30]);
    expect(favorKeys(k, [1, 2], 'shiftPrevious', 1)).toBe(2);
    expect(k.map((x) => x.value[0])).toEqual([0, 0, 4, 30]);
  });
  it('or until the last meets the key after it, by an amount', () => {
    const k = keys([0, 0], [1, 10], [2, 14], [3, 30]);
    favorKeys(k, [1, 2], 'shiftNext', 0.5);
    expect(k.map((x) => x.value[0])).toEqual([0, 18, 22, 30]);
  });
  it('does nothing without a neighbour on that side', () => {
    const k = keys([0, 5], [1, 10]);
    expect(favorKeys(k, [0], 'shiftPrevious', 1)).toBe(0);
    expect(favorKeys(k, [1], 'shiftNext', 1)).toBe(0);
    expect(k.map((x) => x.value[0])).toEqual([5, 10]);
  });
});

describe('scaledTimes', () => {
  const k = [{ time: 0 }, { time: 0.5 }, { time: 1 }, { time: 2 }];
  it('stretches around the pivot on the frame grid', () => {
    expect(scaledTimes(k, [1, 2], 2, 0.5, 20)).toEqual([0.5, 1.5]);
    expect(scaledTimes(k, [1, 2], 0.5, 0.5, 20)).toEqual([0.5, 0.75]);
  });
  it('refuses a result that crosses another key, collides on a frame, or goes below 0', () => {
    expect(scaledTimes(k, [1, 2], 3, 0.5, 30)).toBeNull(); // 1 -> 2.0 meets the key at 2
    expect(scaledTimes(k, [1, 2], 0.01, 0.5, 30)).toBeNull(); // both land on the pivot frame
    expect(scaledTimes(k, [1], 0, 0.5, 30)).toBeNull();
    expect(scaledTimes(k, [0, 1], 1, -1, 30)).not.toBeNull();
    expect(scaledTimes(k, [0], 2, 1, 30)).toBeNull(); // 0 -> -1
  });
});

describe('the actions', () => {
  function open() {
    const { project } = buildFixture();
    const bone = project.skeleton.bones[1];
    const anim = newAnimation('a', 2);
    anim.bones[bone.id] = {
      rotate: [0, 0.5, 1, 1.5].map((time, i) => ({ time, value: [i * 10] })),
      scale: [
        { time: 0, value: [1, 1] },
        { time: 1, value: [2, 3] },
      ],
    };
    project.skeleton.animations.push(anim);
    project.skeleton.fps = 20;
    docStore.replace(project);
    uiStore.patch({ animationId: anim.id, mode: 'animate', time: 0, selectedKeys: [] });
    return { bone, anim };
  }
  const sel = (id: string, prop: string, ...times: number[]) => times.map((time) => encodeKey({ kind: 'bone', target: id, prop, time }));

  it('Favor: one step, undoable, bone keys go to setup', () => {
    const { bone, anim } = open();
    uiStore.patch({ selectedKeys: [...sel(bone.id, 'rotate', 1), ...sel(bone.id, 'scale', 1)] });
    expect(favorSelectedKeys('neutral', 1)).toBe(2);
    expect(docStore.undoLabel).toBe('Favor keys');
    const got = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id];
    expect(got.rotate![2].value).toEqual([0]);
    expect(got.scale![1].value).toEqual([1, 1]);
    docStore.undo();
    expect(docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id].rotate![2].value).toEqual([20]);
  });

  it('Scale time: moves the keys, keeps the selection on them, grows the duration, refuses a clash', () => {
    const { bone, anim } = open();
    uiStore.patch({ selectedKeys: sel(bone.id, 'rotate', 0.5, 1) });
    expect(scaleSelectedKeyTimes(1.5)).toBe(1);
    const rot = docStore.get().skeleton.animations.find((a) => a.id === anim.id)!.bones[bone.id].rotate!;
    expect(rot.map((k) => k.time)).toEqual([0, 0.5, 1.25, 1.5]);
    expect(uiStore.get().selectedKeys).toEqual(sel(bone.id, 'rotate', 0.5, 1.25));
    expect(docStore.undoLabel).toBe('Scale key times');
    // 4x from 0.5 would pass the key at 1.5 (and the end)
    const before = docStore.get();
    expect(scaleSelectedKeyTimes(4)).toBe(0);
    expect(docStore.get()).toBe(before);
    uiStore.patch({ selectedKeys: [] });
    expect(scaleSelectedKeyTimes(2)).toBe(0);
  });
  it('Store and Swap: set the values aside, trade them with the keys, trade back', () => {
    const { bone, anim } = open();
    const rot = () =>
      docStore
        .get()
        .skeleton.animations.find((a) => a.id === anim.id)!
        .bones[bone.id].rotate!.map((k) => k.value[0]);
    uiStore.patch({ selectedKeys: sel(bone.id, 'rotate', 0.5, 1) });
    expect(storeSelectedKeys()).toBe(2);
    expect(keyStash.get().items.map((i) => i.value)).toEqual([[10], [20]]);
    // change the keys, then swap
    expect(favorSelectedKeys('neutral', 1)).toBe(2);
    expect(rot()).toEqual([0, 0, 0, 30]);
    expect(swapStoredKeys()).toBe(2);
    expect(docStore.undoLabel).toBe('Swap with stored keys');
    expect(rot()).toEqual([0, 10, 20, 30]);
    // the stash now holds the zeros: swapping again goes back
    expect(swapStoredKeys()).toBe(2);
    expect(rot()).toEqual([0, 0, 0, 30]);
    docStore.undo();
    expect(rot()).toEqual([0, 10, 20, 30]);
  });

  it('Swap needs stored keys of this animation, and skips keys that are gone', () => {
    const { bone, anim } = open();
    keyStash.set({ animId: null, items: [] });
    expect(swapStoredKeys()).toBe(0);
    uiStore.patch({ selectedKeys: sel(bone.id, 'rotate', 1.5) });
    expect(storeSelectedKeys()).toBe(1);
    // the key is deleted before the swap
    docStore.update('x', (d) => {
      const a = d.skeleton.animations.find((x) => x.id === anim.id)!;
      a.bones[bone.id].rotate = a.bones[bone.id].rotate!.filter((k) => k.time !== 1.5);
    });
    const before = docStore.get();
    expect(swapStoredKeys()).toBe(0);
    expect(docStore.get().skeleton.animations).toEqual(before.skeleton.animations);
    uiStore.patch({ selectedKeys: [] });
    expect(storeSelectedKeys()).toBe(0);
  });
  it('moving a block works on bone keys only: a colour or a mix would leave its range', () => {
    const { bone, anim } = open();
    const slot = docStore.get().skeleton.slots[0];
    docStore.update('x', (d) => {
      const a = d.skeleton.animations.find((x) => x.id === anim.id)!;
      a.slots[slot.id] = {
        rgba: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 1, value: [0.9, 0.9, 0.9, 1] },
          { time: 1.5, value: [0.2, 0.2, 0.2, 1] },
        ],
      };
    });
    uiStore.patch({ selectedKeys: [encodeKey({ kind: 'slot', target: slot.id, prop: 'rgba', time: 1 })] });
    const before = docStore.get();
    expect(favorSelectedKeys('shiftNext', 1)).toBe(0);
    expect(docStore.get().skeleton.animations).toEqual(before.skeleton.animations);
    uiStore.patch({ selectedKeys: sel(bone.id, 'rotate', 0.5) });
    expect(favorSelectedKeys('shiftNext', 1)).toBe(1);
  });
});
