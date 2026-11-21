/** Close the loop: the end of an animation takes the value of its start. */
import { beforeEach, describe, expect, it } from 'vitest';
import { closeLoop } from '../src/core/loops';
import type { Animation, Key } from '../src/core/model';
import { newAnimation } from '../src/core/model';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const key = (time: number, ...value: number[]): Key => ({ time, value });

function anim(rot: Key[], translate: Key[] = []): Animation {
  const a = newAnimation('walk', 1);
  a.bones['b1'] = { rotate: rot, ...(translate.length ? { translate } : {}) };
  a.bones['b2'] = { rotate: [key(0, 5), key(1, 9)] };
  return a;
}

describe('closeLoop', () => {
  it('puts the value of the first key on the last key', () => {
    const a = anim([key(0, 10), key(0.5, 20), key(1, 30)]);
    expect(closeLoop(a)).toBe(2); // b1 and b2
    expect(a.bones['b1'].rotate!.map((k) => k.value[0])).toEqual([10, 20, 10]);
    expect(a.bones['b2'].rotate!.map((k) => k.value[0])).toEqual([5, 5]);
  });

  it('adds a key at the end when the last key is before it', () => {
    const a = anim([key(0, 10), key(0.8, 30)]);
    closeLoop(a, { bones: ['b1'] });
    expect(a.bones['b1'].rotate!.map((k) => [k.time, k.value[0]])).toEqual([
      [0, 10],
      [0.8, 30],
      [1, 10],
    ]);
    expect(a.bones['b2'].rotate!.map((k) => k.value[0])).toEqual([5, 9]); // not asked for
  });

  it('can keep the end instead, and does two-number keys', () => {
    const a = anim([key(0, 10), key(1, 30)], [key(0, 1, 2), key(1, 5, 6)]);
    closeLoop(a, { keep: 'last', bones: ['b1'] });
    expect(a.bones['b1'].rotate!.map((k) => k.value[0])).toEqual([30, 30]);
    expect(a.bones['b1'].translate!.map((k) => k.value)).toEqual([
      [5, 6],
      [5, 6],
    ]);
  });

  it('changes nothing that already matches, or has a single key', () => {
    const a = newAnimation('x', 1);
    a.bones['b1'] = { rotate: [key(0, 10), key(0.5, 40), key(1, 10)], translate: [key(0.3, 1, 1)] };
    expect(closeLoop(a)).toBe(0);
    expect(a.bones['b1'].translate).toHaveLength(1);
  });

  it('leaves the curves of the keys alone', () => {
    const a = newAnimation('x', 1);
    a.bones['b1'] = {
      rotate: [
        { time: 0, value: [1], curve: 'stepped' },
        { time: 1, value: [9], curve: [0.2, 0, 0.8, 1] },
      ],
    };
    closeLoop(a);
    expect(a.bones['b1'].rotate![1]).toEqual({ time: 1, value: [1], curve: [0.2, 0, 0.8, 1] });
    expect(a.bones['b1'].rotate![0].curve).toBe('stepped');
  });
});

describe('closing the loop of a real animation', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'animate',
      tool: 'select',
      animationId: f.project.skeleton.animations[0].id,
      skinId: null,
      time: 0,
      selection: emptySelection,
      overrides: {},
      autoKey: true,
      playing: false,
    });
  });

  it('makes every number timeline end where it started, still exports, and undoes', () => {
    const arm = docStore.get().skeleton.bones[1];
    A.selectBone(arm.id);
    A.setTime(0);
    A.setBonePose([{ id: arm.id, props: { rotation: 12 } }]);
    A.setTime(0.4);
    A.setBonePose([{ id: arm.id, props: { rotation: 55 } }]);
    A.setTime(0.9);
    A.setBonePose([{ id: arm.id, props: { rotation: 30 } }]);
    const before = JSON.stringify(docStore.get().skeleton.animations);
    const changed = A.closeCurrentLoop('first', false);
    expect(changed).toBeGreaterThan(0);
    const a = A.currentAnimation()!;
    const keys = a.bones[arm.id].rotate!;
    expect(keys[keys.length - 1].value[0]).toBeCloseTo(keys[0].value[0], 9);
    expect(keys[keys.length - 1].time).toBeCloseTo(a.duration, 9);
    expect(validateProject(docStore.get())).toEqual([]);
    expect(() => exportAndLoad(docStore.get())).not.toThrow();
    expect(A.closeCurrentLoop('first', false)).toBe(0); // a second time there is nothing to do
    docStore.undo();
    expect(JSON.stringify(docStore.get().skeleton.animations)).toBe(before);
  });
});
