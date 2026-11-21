/** The floating tool windows: what is remembered, where a window may sit, and open / move / raise. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATS,
  FLOAT_LIST,
  clampFloat,
  floatStore,
  isFloating,
  moveFloat,
  raiseFloat,
  readFloats,
  toggleFloat,
} from '../src/store/floats';

describe('readFloats', () => {
  it('keeps defaults for nothing, damage or unknown windows', () => {
    expect(readFloats(null)).toEqual(DEFAULT_FLOATS);
    expect(readFloats('not json')).toEqual(DEFAULT_FLOATS);
    expect(readFloats(JSON.stringify({ open: { nope: true, weights: 'yes' }, pos: { weights: { x: 'a', y: 1 } } }))).toEqual(
      DEFAULT_FLOATS,
    );
  });
  it('takes what is valid, and completes the stacking order', () => {
    const s = readFloats(
      JSON.stringify({ open: { weights: true }, pos: { weights: { x: 10, y: 20 } }, order: ['weights', 'weights', 'zzz'] }),
    );
    expect(s.open.weights).toBe(true);
    expect(s.pos.weights).toEqual({ x: 10, y: 20 });
    expect(s.order).toEqual(['weights', 'slotColor', 'meshTools']);
  });
  it('names every window once', () => {
    expect(FLOAT_LIST.map((f) => f.id).sort()).toEqual(['meshTools', 'slotColor', 'weights']);
  });
});

describe('clampFloat', () => {
  it('keeps the window and its title bar on the screen', () => {
    const size = { w: 300, h: 200 };
    const screen = { w: 1000, h: 700 };
    expect(clampFloat({ x: -50, y: -9 }, size, screen)).toEqual({ x: 0, y: 0 });
    expect(clampFloat({ x: 5000, y: 5000 }, size, screen)).toEqual({ x: 700, y: 660 });
    expect(clampFloat({ x: 120, y: 80 }, size, screen)).toEqual({ x: 120, y: 80 });
    expect(clampFloat({ x: 40, y: 40 }, { w: 300, h: 0 }, { w: 200, h: 100 })).toEqual({ x: 0, y: 40 });
  });
});

describe('the store', () => {
  beforeEach(() => floatStore.set(readFloats(null)));
  it('opens, closes and raises', () => {
    expect(isFloating('weights')).toBe(false);
    toggleFloat('weights');
    expect(isFloating('weights')).toBe(true);
    expect(floatStore.get().order.at(-1)).toBe('weights');
    toggleFloat('slotColor', true);
    expect(floatStore.get().order.at(-1)).toBe('slotColor');
    raiseFloat('weights');
    expect(floatStore.get().order.at(-1)).toBe('weights');
    toggleFloat('weights', false);
    expect(isFloating('weights')).toBe(false);
  });
  it('remembers where a window was left', () => {
    moveFloat('meshTools', { x: 12, y: 34 });
    expect(floatStore.get().pos.meshTools).toEqual({ x: 12, y: 34 });
    expect(floatStore.get().pos.weights).toEqual(DEFAULT_FLOATS.pos.weights);
  });
});
