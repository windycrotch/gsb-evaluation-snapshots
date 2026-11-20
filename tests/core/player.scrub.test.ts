import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { core, type Output, type Playback, type PlayerOptions } from "../../src/core";

// Time is driven by hand: the fake clock and the fake timer queue advance
// together in one-millisecond steps, exactly as the real transport expects.
let clock = 0;
let renders: Playback[] = [];
let latency = 0;

const output: Output = { now: () => clock, render: (p) => void renders.push(p), latency: () => latency };
const last = () => renders[renders.length - 1];
const previous = () => renders[renders.length - 2];
const jumped = () => renders.length > 1 && !core.continues(previous(), last());
const advance = (seconds: number) => {
  for (let ms = 0; ms < Math.round(seconds * 1000); ms++) {
    clock += 0.001;
    vi.advanceTimersByTime(1);
  }
};
const make = (options: Partial<PlayerOptions> = {}) =>
  core.createPlayer(output, { duration: 60, position: 12, loop: { start: 10, end: 20 }, loopMode: { type: "automatic", delay: 0 }, speed: 1, ...options });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 100;
  renders = [];
  latency = 0;
});
afterEach(() => vi.useRealTimers());

test("a drag owns the playhead: the clock cannot move it, and the old trajectory does not return", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  advance(2);
  const before = p.position();
  p.startScrub(15);
  expect(p.position()).toBe(15);
  advance(30);
  expect(p.position()).toBe(15);
  expect(p.getState().playState).toBe("playing");
  p.scrubTo(17);
  expect(p.position()).toBe(17);
  p.endScrub();
  expect(p.position()).toBe(17);
  expect(last()).toMatchObject({ mode: "playing", anchorPosition: 17 });
  expect(p.position()).toBeGreaterThanOrEqual(17);
  expect(before).toBeLessThan(15);
});

test("dropping the playhead lands in the loop when playing and outside it stays paused", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(45);
  p.endScrub();
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(10);
  expect(last()).toMatchObject({ mode: "playing", anchorPosition: 10 });

  const paused = make();
  paused.startScrub(45);
  paused.endScrub();
  expect(paused.getState().playState).toBe("paused");
  expect(paused.position()).toBe(45);
  expect(last()).toMatchObject({ mode: "silent", anchorPosition: 45 });
});

test("dragging away from an audible position does not rewind the reported playhead", () => {
  latency = 0.2;
  const p = make({ loop: null, position: 10 });
  p.dispatch({ type: "toggle-play" });
  advance(1);
  const heard = p.position();
  expect(heard).toBeCloseTo(10.8, 5);
  p.startScrub(30);
  expect(p.position()).toBe(30);
  p.scrubTo(31);
  expect(p.position()).toBe(31);
  p.endScrub();
  expect(p.position()).toBe(31);
  expect(p.getState().playState).toBe("playing");
});

test("a drag started while waiting leaves the wait at once and cancels its timer", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(9);
  expect(p.getState().playState).toBe("waiting");
  expect(p.delayRemaining()).toBeGreaterThan(0.9);

  p.startScrub(15);
  expect(p.getState().playState).toBe("playing");
  expect(p.getState().waitingUntil).toBeNull();
  expect(p.delayRemaining()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);

  // The old delay deadline passes mid-drag: nothing may revive the wait or
  // pull the playhead back to the loop start.
  advance(1.5);
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(15);

  p.endScrub();
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(15);
});

test("pausing while waiting leaves the wait and the old timer never resurrects playback", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(9);
  expect(p.getState().playState).toBe("waiting");
  p.dispatch({ type: "toggle-play" });
  expect(p.getState().playState).toBe("paused");
  expect(p.position()).toBe(10);
  expect(vi.getTimerCount()).toBe(0);
  advance(5);
  expect(p.getState().playState).toBe("paused");
  expect(p.position()).toBe(10);
});

test("moving while waiting plays from the drop instead of waiting out the old delay", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(9);
  p.dispatch({ type: "move", position: 15 });
  expect(p.getState().playState).toBe("playing");
  expect(p.getState().waitingUntil).toBeNull();
  expect(p.position()).toBe(15);
  advance(1);
  expect(p.position()).toBeCloseTo(16, 3);
});

test("switching away from waiting applies the new loop mode now, not when the old timer fires", () => {
  const cases: Array<[PlayerOptions["loopMode"], "paused" | "playing"]> = [
    [{ type: "manual" }, "paused"],
    [{ type: "automatic", delay: 0 }, "playing"],
  ];
  for (const [mode, expected] of cases) {
    const p = make({ loopMode: { type: "automatic", delay: 2 } });
    p.dispatch({ type: "toggle-play" });
    advance(9);
    expect(p.getState().playState).toBe("waiting");
    p.setLoopMode(mode);
    expect(p.getState().playState).toBe(expected);
    expect(p.getState().waitingUntil).toBeNull();
    expect(p.position()).toBe(10);
  }
});

test("shortening the delay restarts the wait from its original start; lengthening extends it", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(9); // waiting began at ~t+8, 1s of the 2s delay has passed
  p.setLoopMode({ type: "automatic", delay: 0.5 });
  expect(p.getState().playState).toBe("playing");
  advance(0.6);
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBeCloseTo(10.6, 1);

  const q = make({ loopMode: { type: "automatic", delay: 2 } });
  q.dispatch({ type: "toggle-play" });
  advance(9);
  q.setLoopMode({ type: "automatic", delay: 3 });
  expect(q.getState().playState).toBe("waiting");
  expect(q.delayRemaining()).toBeCloseTo(2, 1);
  advance(1.1);
  expect(q.getState().playState).toBe("waiting");
  advance(1.1);
  expect(q.getState().playState).toBe("playing");
});

test("a speed change re-anchors but never jumps the playhead", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  advance(2);
  const before = p.position();
  p.setSpeed(1.5);
  expect(p.position()).toBeCloseTo(before, 9);
  expect(jumped()).toBe(false);
  advance(2);
  expect(p.position()).toBeCloseTo(before + 3, 6);
});

test("successive speed changes during the latency window stay continuous", () => {
  latency = 0.2;
  const p = make({ loop: null, position: 10 });
  p.dispatch({ type: "toggle-play" });
  advance(1);
  p.setSpeed(2);
  advance(0.02);
  const heard = p.position();
  p.setSpeed(0.5);
  expect(p.position()).toBeCloseTo(heard, 6);
  p.setSpeed(0.25);
  expect(p.position()).toBeCloseTo(heard, 6);
  // From here the display must keep moving at a bounded rate with no jump.
  let previous = p.position();
  for (let i = 0; i < 1000; i++) {
    advance(0.001);
    const now = p.position();
    const step = now - previous;
    expect(step).toBeGreaterThanOrEqual(-1e-9);
    expect(step).toBeLessThanOrEqual(2 * 0.001 + 1e-6);
    previous = now;
  }
  expect(p.position()).toBeGreaterThan(heard);
});

test("a speed change during a drag only takes effect after the drop", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(14);
  p.setSpeed(0.5);
  expect(p.position()).toBe(14);
  advance(5);
  expect(p.position()).toBe(14);
  p.endScrub();
  expect(p.position()).toBe(14);
  advance(2);
  expect(p.position()).toBeCloseTo(15, 6);
});

test("the reported playhead never leaves [0, duration] and never runs past a non-wrapping loop", () => {
  latency = 0.15;
  const p = make({ loopMode: { type: "manual" }, position: 18 });
  p.dispatch({ type: "toggle-play" });
  for (let i = 0; i < 850; i++) {
    clock += 0.01;
    vi.advanceTimersByTime(10);
    expect(p.position()).toBeGreaterThanOrEqual(0);
    expect(p.position()).toBeLessThanOrEqual(p.duration);
  }
  expect(p.getState().playState).toBe("paused");
  expect(p.position()).toBe(10);
});

test("a non-wrapping loop end is detected at the moment it is heard, not earlier", () => {
  latency = 0.2;
  const p = make({ loopMode: { type: "manual" } });
  p.dispatch({ type: "toggle-play" });
  advance(7.6);
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBeCloseTo(19.4, 1);
  // The audio reaches the loop end at wall-clock 8.0 s and is heard 0.2 s later.
  advance(0.7);
  expect(p.getState().playState).toBe("paused");
  expect(p.position()).toBe(10);
});

test("dispose is idempotent and leaves no pending work, renders, or subscriptions", () => {
  const listener = vi.fn();
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.subscribe(listener);
  p.dispatch({ type: "toggle-play" });
  advance(9);
  expect(p.getState().playState).toBe("waiting");

  p.dispose();
  expect(last().mode).toBe("silent");
  expect(vi.getTimerCount()).toBe(0);
  const rendersAtDispose = renders.length;
  const calls = listener.mock.calls.length;

  advance(10);
  expect(renders.length).toBe(rendersAtDispose);
  expect(listener.mock.calls.length).toBe(calls);
  expect(p.getState().waitingUntil).toBeNull();

  expect(() => p.dispose()).not.toThrow();
  expect(() => p.dispatch({ type: "toggle-play" })).not.toThrow();
  expect(() => p.setSpeed(0.5)).not.toThrow();
  expect(() => p.startScrub(3)).not.toThrow();
  expect(renders.length).toBe(rendersAtDispose);
});

test("a stale timer cannot fire after disposal even if the clock jumped", () => {
  const p = make({ loopMode: { type: "manual" } });
  p.dispatch({ type: "toggle-play" });
  advance(2);
  p.dispose();
  const count = renders.length;
  clock += 1000;
  vi.runAllTimers();
  expect(renders.length).toBe(count);
  expect(p.getState().playState).toBe("playing");
});

test("correctPosition is ignored mid-drag but honoured afterwards", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(15);
  p.correctPosition(30);
  expect(p.position()).toBe(15);
  p.endScrub();
  p.correctPosition(30);
  expect(p.position()).toBe(30);
});
