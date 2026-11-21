/** Saved easing curves: kept under a name from a key, put on other keys, stored in the settings and read strictly. */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SAVED_CURVES, cleanSavedCurves, curveOfKey, validCurve, withSavedCurve } from '../src/core/savedCurves';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { readSettings, setSettings, settingsStore } from '../src/store/settings';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

describe('what a curve is', () => {
  it('has the x of both handles between 0 and 1 and a y that does not run away', () => {
    expect(validCurve([0.3, 1.4, 0.7, -0.4])).toBe(true);
    expect(validCurve([0, 0, 1, 1])).toBe(true);
    expect(validCurve([1.2, 0, 0.5, 1])).toBe(false);
    expect(validCurve([0.3, 9, 0.7, 1])).toBe(false);
    expect(validCurve([0.3, 0, NaN, 1])).toBe(false);
    expect(validCurve([0.3, 0, 0.7])).toBe(false);
    expect(validCurve('x')).toBe(false);
  });

  it('is read from the first channel of a key, only when the key has a bezier', () => {
    expect(curveOfKey([0.3, 0.1, 0.6, 0.9, 0.2, 0, 0.5, 1])).toEqual([0.3, 0.1, 0.6, 0.9]);
    expect(curveOfKey('stepped')).toBeNull();
    expect(curveOfKey(undefined)).toBeNull();
    expect(curveOfKey([0.3, 0.1, 0.6])).toBeNull();
    expect(curveOfKey([2, 0, 0.6, 1])).toBeNull();
  });
});

describe('the list', () => {
  it('keeps only well formed entries, names them uniquely and drops a curve twice', () => {
    const list = cleanSavedCurves([
      { name: '  Pop ', curve: [0.3, 1.4, 0.7, 1] },
      { name: 'Pop', curve: [0.2, 0, 0.8, 1] },
      { name: 'Same as the first', curve: [0.3, 1.4, 0.7, 1] },
      { name: 5, curve: [0, 0, 1, 1] },
      { name: 'Bad', curve: [3, 0, 1, 1] },
      null,
      'x',
    ]);
    expect(list.map((c) => c.name)).toEqual(['Pop', 'Pop 2']);
    expect(cleanSavedCurves('nope')).toEqual([]);
    expect(cleanSavedCurves(undefined)).toEqual([]);
  });

  it('is cut to the limit (the oldest go) and the names are short', () => {
    const many = Array.from({ length: MAX_SAVED_CURVES + 4 }, (_, i) => ({ name: 'x'.repeat(60) + i, curve: [0.1, i / 100, 0.9, 1] }));
    const list = cleanSavedCurves(many);
    expect(list.length).toBe(MAX_SAVED_CURVES);
    expect(list.every((c) => c.name.length <= 24)).toBe(true);
    expect(list[list.length - 1].curve[1]).toBeCloseTo((MAX_SAVED_CURVES + 3) / 100, 6);
  });

  it('withSavedCurve numbers the unnamed ones and does not add a curve it already has', () => {
    let list = withSavedCurve([], [0.3, 0.1, 0.6, 0.9]);
    expect(list.map((c) => c.name)).toEqual(['Curve 1']);
    list = withSavedCurve(list, [0.1, 0, 0.9, 1]);
    expect(list.map((c) => c.name)).toEqual(['Curve 1', 'Curve 2']);
    expect(withSavedCurve(list, [0.3, 0.1, 0.6, 0.9]).length).toBe(2);
    expect(withSavedCurve(list, [9, 0, 0, 0] as never).length).toBe(2);
  });
});

describe('the settings', () => {
  it('read the list strictly', () => {
    const s = readSettings(
      JSON.stringify({
        savedCurves: [
          { name: 'A', curve: [0.2, 0, 0.8, 1] },
          { name: 'B', curve: [5, 0, 0, 0] },
        ],
      }),
    );
    expect(s.savedCurves).toEqual([{ name: 'A', curve: [0.2, 0, 0.8, 1] }]);
    expect(readSettings(JSON.stringify({ savedCurves: 'x' })).savedCurves).toEqual([]);
  });
});

describe('the actions', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'animate',
      animationId: f.project.skeleton.animations[0].id,
      selection: emptySelection,
      time: 0,
      selectedKeys: [],
    });
    setSettings({ savedCurves: [] });
  });

  const keysOf = () => {
    const anim = A.currentAnimation()!;
    const id = Object.keys(anim.bones).find((b) => (anim.bones[b].rotate?.length ?? 0) >= 2)!;
    return { id, keys: anim.bones[id].rotate! };
  };

  it('Save this curve keeps the curve of a key, and Saved curves put it on other keys', () => {
    const { id, keys } = keysOf();
    const a = { kind: 'bone' as const, target: id, prop: 'rotate', time: keys[0].time };
    const b = { kind: 'bone' as const, target: id, prop: 'rotate', time: keys[1].time };
    A.setKeysCurve([a], [0.31, 1.25, 0.62, 0.8]);
    expect(A.saveKeyCurve(a)).toBe(true);
    expect(settingsStore.get().savedCurves).toEqual([{ name: 'Curve 1', curve: [0.31, 1.25, 0.62, 0.8] }]);
    // put on another key, channel for channel
    A.setKeysCurve([b], settingsStore.get().savedCurves[0].curve);
    expect(keysOf().keys[1].curve).toEqual([0.31, 1.25, 0.62, 0.8]);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('refuses a key with a linear or stepped interpolation, and a curve that is already saved', () => {
    const { id, keys } = keysOf();
    const a = { kind: 'bone' as const, target: id, prop: 'rotate', time: keys[0].time };
    A.setKeysCurve([a], 'linear');
    expect(A.saveKeyCurve(a)).toBe(false);
    A.setKeysCurve([a], 'stepped');
    expect(A.saveKeyCurve(a)).toBe(false);
    A.setKeysCurve([a], [0.4, 0, 0.6, 1]);
    expect(A.saveKeyCurve(a)).toBe(true);
    expect(A.saveKeyCurve(a)).toBe(false);
    expect(settingsStore.get().savedCurves.length).toBe(1);
  });

  it('forgets a curve by its place and ignores a place that is not there', () => {
    setSettings({
      savedCurves: [
        { name: 'A', curve: [0.2, 0, 0.8, 1] },
        { name: 'B', curve: [0.4, 0, 0.6, 1] },
      ],
    });
    A.forgetSavedCurve(0);
    expect(settingsStore.get().savedCurves.map((c) => c.name)).toEqual(['B']);
    A.forgetSavedCurve(7);
    A.forgetSavedCurve(-1);
    expect(settingsStore.get().savedCurves.map((c) => c.name)).toEqual(['B']);
  });
});
