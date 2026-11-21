/** Clean Up, Shift (ripple) of keys, and the onion skin times. */
import { describe, expect, it } from 'vitest';
import { cleanUpAnimation, dropFlatKeys } from '../src/core/cleanup';
import { moveKeys } from '../src/core/keyrefs';
import { newAnimation } from '../src/core/model';
import type { Key } from '../src/core/model';
import { ghostTimes } from '../src/editor/ghosts';

const key = (time: number, ...value: number[]): Key => ({ time, value });

describe('clean up', () => {
  it('drops the middle of a run of equal keys and keeps both ends', () => {
    const keys = [key(0, 5), key(0.2, 5), key(0.4, 5), key(0.6, 5), key(0.8, 9)];
    expect(dropFlatKeys(keys)).toBe(2);
    expect(keys.map((k) => k.time)).toEqual([0, 0.6, 0.8]);
  });

  it('keeps a key that changes the value, and a hold of just two keys', () => {
    const keys = [key(0, 1), key(0.5, 1), key(1, 2)];
    expect(dropFlatKeys(keys)).toBe(0);
    const up = [key(0, 1), key(0.5, 2), key(1, 3)];
    expect(dropFlatKeys(up)).toBe(0);
  });

  it('compares every channel', () => {
    const keys = [key(0, 1, 1), key(0.5, 1, 2), key(1, 1, 1)];
    expect(dropFlatKeys(keys)).toBe(0);
  });

  it('works through every timeline of an animation and keeps rests on the setup pose', () => {
    const a = newAnimation('x', 1);
    a.bones['b1'] = { rotate: [key(0, 0), key(0.5, 0), key(1, 0)], translate: [key(0, 0, 0), key(1, 4, 4)] };
    a.slots['s1'] = { rgba: [key(0, 1, 1, 1, 1), key(0.3, 1, 1, 1, 1), key(0.6, 1, 1, 1, 1), key(1, 1, 1, 1, 0)] };
    expect(cleanUpAnimation(a)).toBe(2);
    expect(a.bones['b1'].rotate!.map((k) => k.time)).toEqual([0, 1]); // still there: a layered animation relies on it
    expect(a.slots['s1'].rgba!.map((k) => k.time)).toEqual([0, 0.6, 1]);
  });
});

describe('shift keys (ripple)', () => {
  const make = () => {
    const a = newAnimation('x', 2);
    a.bones['b'] = { rotate: [key(0, 0), key(0.5, 10), key(1, 20), key(1.5, 30)] };
    return a;
  };
  const times = (a: ReturnType<typeof make>) => a.bones['b'].rotate!.map((k) => Math.round(k.time * 1000) / 1000);

  it('moves only the picked key without ripple', () => {
    const a = make();
    moveKeys(a, [{ kind: 'bone', target: 'b', prop: 'rotate', time: 0.5 }], 0.25);
    expect(times(a)).toEqual([0, 0.75, 1, 1.5]);
  });

  it('takes the later keys of the timeline along with ripple', () => {
    const a = make();
    const out = moveKeys(a, [{ kind: 'bone', target: 'b', prop: 'rotate', time: 0.5 }], 0.25, true);
    expect(times(a)).toEqual([0, 0.75, 1.25, 1.75]);
    expect(out[0].time).toBeCloseTo(0.75);
  });

  it('moves them back the same way, and the earlier keys stay', () => {
    const a = make();
    moveKeys(a, [{ kind: 'bone', target: 'b', prop: 'rotate', time: 1 }], -0.25, true);
    expect(times(a)).toEqual([0, 0.5, 0.75, 1.25]);
  });
});

describe('offset keys (round the loop)', () => {
  const make = () => {
    const a = newAnimation('x', 2);
    a.bones['b'] = { rotate: [key(0, 0), key(0.5, 10), key(1, 20), key(1.5, 30)] };
    return a;
  };
  const ref = (time: number) => ({ kind: 'bone' as const, target: 'b', prop: 'rotate', time });
  const times = (a: ReturnType<typeof make>) => a.bones['b'].rotate!.map((k) => Math.round(k.time * 1000) / 1000);

  it('wraps keys that pass the end back to the start, leaving the others where they are', () => {
    const a = make();
    const out = moveKeys(a, [ref(1.5)], 0.75, false, 2);
    expect(times(a)).toEqual([0, 0.25, 0.5, 1]);
    expect(a.bones['b'].rotate!.map((k) => k.value[0])).toEqual([0, 30, 10, 20]);
    expect(out[0].time).toBeCloseTo(0.25);
  });

  it('wraps the other way too, and may move several keys together', () => {
    const a = make();
    moveKeys(a, [ref(0), ref(0.5)], -0.75, false, 2);
    expect(times(a)).toEqual([1, 1.25, 1.5, 1.75]);
    expect(a.bones['b'].rotate!.map((k) => k.value[0])).toEqual([20, 0, 30, 10]);
  });

  it('a key that lands on a key that stays replaces it, never extends the animation', () => {
    const a = make();
    moveKeys(a, [ref(1.5)], 0.5, false, 2); // 1.5 + 0.5 = 2 -> 0, where the first key is
    expect(times(a)).toEqual([0, 0.5, 1]);
    expect(a.bones['b'].rotate![0].value[0]).toBe(30);
  });

  it('without a length a move is clamped at the start as before', () => {
    const a = make();
    moveKeys(a, [ref(0.5)], -2);
    expect(times(a)[0]).toBe(0);
  });
});

describe('onion skin times', () => {
  const cfg = { before: 2, after: 2, gap: 3 };

  it('are spaced by the gap, before and after the playhead', () => {
    const g = ghostTimes(1, 2, 30, cfg, false);
    expect(g.map((x) => [x.side, x.index, Math.round(x.time * 1000) / 1000])).toEqual([
      ['before', 1, 0.9],
      ['before', 2, 0.8],
      ['after', 1, 1.1],
      ['after', 2, 1.2],
    ]);
  });

  it('leave out what falls outside a one-shot animation and wrap around in a loop', () => {
    const once = ghostTimes(0.05, 1, 30, cfg, false);
    expect(once.filter((x) => x.side === 'before')).toEqual([]);
    const loop = ghostTimes(0.05, 1, 30, cfg, true);
    expect(loop.filter((x) => x.side === 'before').map((x) => Math.round(x.time * 1000) / 1000)).toEqual([0.95, 0.85]);
  });

  it('draw nothing for an animation of no length', () => {
    expect(ghostTimes(0, 0, 30, cfg, true)).toEqual([]);
  });
});

describe('offset keys: keys that meet', () => {
  it('the key at 0 and the key at the end are one moment: moving both leaves a single key', () => {
    const a = newAnimation('x', 1);
    a.bones['b'] = { rotate: [key(0, 5), key(0.5, 10), key(1, 5)] };
    const ref = (time: number) => ({ kind: 'bone' as const, target: 'b', prop: 'rotate', time });
    moveKeys(a, [ref(0), ref(1)], 0.3, false, 1);
    const times = a.bones['b'].rotate!.map((k) => Math.round(k.time * 1000) / 1000);
    expect(times).toEqual([0.3, 0.5]);
  });
});
