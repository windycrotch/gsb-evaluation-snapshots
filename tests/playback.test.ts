import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newAnimation } from '../src/core/model';
import { startPlaybackLoop } from '../src/editor/playback';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { setPlay } from '../src/store/actions';

/** Deterministic requestAnimationFrame: tests advance time by hand. */
let queue: ((t: number) => void)[] = [];
let clock = 1000;
const step = (ms: number) => {
  clock += ms;
  const run = queue;
  queue = [];
  for (const cb of run) cb(clock);
};

describe('playback loop', () => {
  let stop: () => void;
  let animId = '';

  beforeEach(() => {
    queue = [];
    clock = 1000;
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => queue.push(cb);
    (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {
      queue = [];
    };
    (globalThis as unknown as { performance: { now: () => number } }).performance = { now: () => clock };
    const anim = newAnimation('a', 1);
    animId = anim.id;
    docStore.update('add', (d) => void d.skeleton.animations.push(anim));
    uiStore.patch({ animationId: animId, time: 0, playing: true, loop: true, speed: 1, mode: 'animate' });
    stop = startPlaybackLoop();
  });
  afterEach(() => stop());

  it('advances the playhead in real time', () => {
    for (let i = 0; i < 30; i++) step(16);
    expect(uiStore.get().time).toBeGreaterThan(0.45);
    expect(uiStore.get().time).toBeLessThan(0.5);
  });

  it('honours speed', () => {
    uiStore.patch({ speed: 2 });
    for (let i = 0; i < 20; i++) step(20); // 0.4 s of wall time at 2x
    expect(uiStore.get().time).toBeCloseTo(0.8, 2);
  });

  it('loops at the end of the animation', () => {
    for (let i = 0; i < 80; i++) step(16); // 1.28s of play for a 1s animation
    const t = uiStore.get().time;
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(0.5);
    expect(uiStore.get().playing).toBe(true);
  });

  it('stops at the end when not looping', () => {
    setPlay({ loop: false });
    for (let i = 0; i < 80; i++) step(16);
    expect(uiStore.get().playing).toBe(false);
    expect(uiStore.get().time).toBe(1);
  });

  it('does nothing while paused', () => {
    uiStore.patch({ playing: false });
    for (let i = 0; i < 10; i++) step(16);
    expect(uiStore.get().time).toBe(0);
  });
});

import { advancePlayback, playSpan } from '../src/core/playback';

describe('advancePlayback', () => {
  const once = { loop: false, pingPong: false, range: null };
  const loop = { loop: true, pingPong: false, range: null };

  it('plays forward and stops at the end of a single play', () => {
    expect(advancePlayback({ time: 0.5, dir: 1 }, 0.25, 1, once)).toEqual({ time: 0.75, dir: 1, stopped: false });
    expect(advancePlayback({ time: 0.9, dir: 1 }, 0.25, 1, once)).toEqual({ time: 1, dir: 1, stopped: true });
  });

  it('wraps a loop, even over several lengths at once', () => {
    expect(advancePlayback({ time: 0.9, dir: 1 }, 0.25, 1, loop).time).toBeCloseTo(0.15);
    expect(advancePlayback({ time: 0.1, dir: 1 }, 2.5, 1, loop).time).toBeCloseTo(0.6);
  });

  it('plays only the range, looping inside it', () => {
    const range = { loop: true, pingPong: false, range: [0.4, 0.8] as [number, number] };
    expect(advancePlayback({ time: 0.7, dir: 1 }, 0.2, 1, range).time).toBeCloseTo(0.5);
    expect(advancePlayback({ time: 0, dir: 1 }, 0.1, 1, range).time).toBeCloseTo(0.5); // starts from the range
    expect(advancePlayback({ time: 0.7, dir: 1 }, 0.2, 1, { ...range, loop: false })).toMatchObject({ time: 0.8, stopped: true });
  });

  it('ping-pong turns round at both ends and keeps its direction', () => {
    const pp = { loop: true, pingPong: true, range: null };
    let s = { time: 0.8, dir: 1 as 1 | -1 };
    s = advancePlayback(s, 0.4, 1, pp);
    expect(s.time).toBeCloseTo(0.8);
    expect(s.dir).toBe(-1);
    s = advancePlayback(s, 0.5, 1, pp);
    expect(s.time).toBeCloseTo(0.3);
    expect(s.dir).toBe(-1);
    s = advancePlayback(s, 0.5, 1, pp); // past the start: turns forward
    expect(s.time).toBeCloseTo(0.2);
    expect(s.dir).toBe(1);
  });

  it('a single ping-pong goes there and back and stops at the start', () => {
    const once2 = { loop: false, pingPong: true, range: null };
    expect(advancePlayback({ time: 0.9, dir: 1 }, 0.3, 1, once2)).toMatchObject({ time: 0.8, dir: -1, stopped: false });
    expect(advancePlayback({ time: 0.1, dir: -1 }, 0.3, 1, once2)).toMatchObject({ time: 0, stopped: true });
  });

  it('an empty or reversed range means the whole animation', () => {
    expect(playSpan(2, null)).toEqual([0, 2]);
    expect(playSpan(2, [1, 1])).toEqual([0, 2]);
    expect(playSpan(2, [1.5, 1])).toEqual([0, 2]);
    expect(playSpan(2, [-1, 5])).toEqual([0, 2]);
    expect(playSpan(2, [0.5, 1.5])).toEqual([0.5, 1.5]);
  });

  it('never leaves the span, whatever the step', () => {
    for (const pingPong of [false, true]) {
      let s = { time: 0.3, dir: 1 as 1 | -1 };
      for (let i = 0; i < 500; i++) {
        const r = advancePlayback(s, 0.037 * ((i % 7) + 1), 1.2, { loop: true, pingPong, range: [0.2, 0.9] });
        expect(r.time).toBeGreaterThanOrEqual(0.2 - 1e-9);
        expect(r.time).toBeLessThanOrEqual(0.9 + 1e-9);
        s = r;
      }
    }
  });
});
