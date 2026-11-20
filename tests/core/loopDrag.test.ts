import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { core, type Output, type Playback, type Player, type PlayerOptions } from "../../src/core";

let clock = 0;
let renders: Playback[] = [];
const output: Output = { now: () => clock, render: (p) => void renders.push(p) };
const last = () => renders[renders.length - 1];
const jumped = () => renders.length > 1 && !core.continues(renders[renders.length - 2], last());
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
});
afterEach(() => vi.useRealTimers());

const dragLoop = (p: Player, sections: { start: number; end: number }[], commit = true) => {
  p.setLoop(null);
  for (const section of sections) p.setLoop(section);
  if (commit) p.setLoop(sections[sections.length - 1]);
};

test("lifting the loop while playing frees the trajectory without a jump", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  advance(2);
  p.setLoop(null);
  expect(jumped()).toBe(false);
  expect(last().loop).toEqual({ start: 0, end: 60 });
  advance(5);
  expect(p.position()).toBeCloseTo(19);
});

test("committing a loop outside the playhead lands on the loop start; inside it keeps moving", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  advance(2);
  p.setLoop(null);
  advance(1);
  p.setLoop({ start: 30, end: 40 });
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(30);
  expect(last().loop).toEqual({ start: 30, end: 40 });
  p.setLoop(null);
  p.setLoop({ start: 25, end: 45 });
  expect(p.position()).toBe(30);
});

test("rapid repeated drags produce exactly one committed transition and never leave the old loop active", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  const states: string[] = [];
  p.subscribe(() => states.push(p.getState().playState));
  dragLoop(p, [
    { start: 30, end: 40 },
    { start: 31, end: 41 },
    { start: 32, end: 42 },
  ]);
  expect(p.getState().loop).toEqual({ start: 32, end: 42 });
  expect(p.position()).toBe(32);
  const commits = states.filter((s, i) => i === 0 || s !== states[i - 1]);
  expect(commits).toEqual(["playing"]);
});

test("a double-click style full reset during a drag commits full song exactly once", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.setLoop(null);
  p.setLoop({ start: 30, end: 40 });
  p.setLoop({ start: 0, end: 60 });
  p.setLoop({ start: 0, end: 60 });
  expect(p.getState().loop).toEqual({ start: 0, end: 60 });
  expect(p.position()).toBeGreaterThanOrEqual(12);
});

test("speed changes while the loop is lifted stay on the same audible trajectory", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  advance(2);
  p.setLoop(null);
  const atLift = p.position();
  expect(atLift).toBeCloseTo(14);
  p.setSpeed(0.5);
  expect(jumped()).toBe(false);
  advance(2);
  expect(p.position()).toBeCloseTo(atLift + 1);
  p.setLoop({ start: 10, end: 20 });
  expect(p.getState().loop).toEqual({ start: 10, end: 20 });
  expect(p.position()).toBeCloseTo(atLift + 1);
});

test("committing a loop while waiting ends the wait and plays from the new loop start", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(8.1);
  expect(p.getState().playState).toBe("waiting");
  expect(p.delayRemaining()).toBeGreaterThan(1);
  p.setLoop(null);
  p.setLoop({ start: 30, end: 40 });
  expect(p.getState().playState).toBe("playing");
  expect(p.delayRemaining()).toBe(0);
  expect(p.position()).toBe(30);
  advance(1);
  expect(p.position()).toBeCloseTo(31);
  advance(10);
  expect(p.getState().playState).toBe("waiting");
  expect(p.position()).toBe(40);
});

test("lifting during the wait stays silent; the old delay cannot fire mid-drag", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(8.1);
  p.setLoop(null);
  expect(p.getState().playState).toBe("waiting");
  expect(last().mode).toBe("silent");
  advance(3);
  expect(p.getState().playState).toBe("waiting");
  p.setLoop({ start: 30, end: 40 });
  expect(p.getState().playState).toBe("playing");
});

test("releasing a no-op drag with the same loop keeps the remaining wait instead of swallowing the delay", () => {
  const p = make({ loopMode: { type: "automatic", delay: 2 } });
  p.dispatch({ type: "toggle-play" });
  advance(8.1);
  const remaining = p.delayRemaining();
  p.setLoop(null);
  p.setLoop({ start: 10, end: 20 });
  expect(p.getState().playState).toBe("waiting");
  expect(p.delayRemaining()).toBeCloseTo(remaining, 1);
  advance(2.5);
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBeGreaterThanOrEqual(10);
  expect(p.position()).toBeLessThan(10.7);
});

test("frozen dragging streams the freeze at the drag position and returns to frozen at the drop", () => {
  const p = make();
  p.dispatch({ type: "toggle-freeze" });
  expect(last().mode).toBe("frozen");
  p.startScrub(35);
  expect(last()).toMatchObject({ mode: "scrubbing", anchorPosition: 35 });
  advance(10);
  expect(p.position()).toBe(35);
  p.scrubTo(40);
  expect(p.position()).toBe(40);
  p.endScrub();
  expect(p.getState().playState).toBe("frozen");
  expect(last().mode).toBe("frozen");
  expect(p.position()).toBe(40);
  advance(10);
  expect(p.position()).toBe(40);
});

test("changing speed while frozen changes only the transport rate: the frozen point never drifts", () => {
  const p = make();
  p.dispatch({ type: "toggle-freeze" });
  const frozenAt = p.position();
  p.setSpeed(0.5);
  p.setSpeed(1.75);
  expect(last().mode).toBe("frozen");
  expect(last().rate).toBe(1.75);
  advance(5);
  expect(p.position()).toBe(frozenAt);
  expect(last().anchorPosition).toBe(frozenAt);
});

test("scrubbing then changing speed keeps streaming the same scrub position with no drift", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(15);
  p.setSpeed(0.5);
  expect(last()).toMatchObject({ mode: "scrubbing", anchorPosition: 15, rate: 0.5 });
  advance(3);
  expect(p.position()).toBe(15);
  p.setSpeed(1.5);
  advance(3);
  expect(p.position()).toBe(15);
  p.endScrub();
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(15);
});

test("a scrub dropped outside the resting loop still obeys the loop-start rule", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(15);
  p.setSpeed(1.5);
  p.scrubTo(50);
  p.endScrub();
  expect(p.getState().playState).toBe("playing");
  expect(p.position()).toBe(10);
  expect(p.getState().loop).toEqual({ start: 10, end: 20 });
});

test("toggling freeze in the middle of a scrub resumes at the drag position in the new state", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.startScrub(25);
  p.dispatch({ type: "toggle-freeze" });
  expect(p.getState().playState).toBe("frozen");
  p.scrubTo(30);
  p.endScrub();
  expect(p.getState().playState).toBe("frozen");
  expect(p.position()).toBe(30);
});

test("a loop drag interleaved with a scrub leaves the playhead inside the committed loop", () => {
  const p = make();
  p.dispatch({ type: "toggle-play" });
  p.setLoop(null);
  p.startScrub(35);
  p.setLoop({ start: 30, end: 40 });
  p.endScrub();
  expect(p.position()).toBe(35);
  expect(p.getState().loop).toEqual({ start: 30, end: 40 });
  p.setLoop(null);
  p.startScrub(50);
  p.setLoop({ start: 30, end: 40 });
  p.endScrub();
  expect(p.position()).toBe(30);
});

test("speed changes while playing never cause an audible backward jump", () => {
  const delayed: Output = { ...output, latency: () => 0.2 };
  const p = core.createPlayer(delayed, { duration: 100, position: 10, loop: null, loopMode: { type: "automatic", delay: 0 }, speed: 1 });
  p.dispatch({ type: "toggle-play" });
  clock += 1;
  let previous = p.position();
  for (const speed of [1.5, 0.75, 1.25, 0.4]) {
    p.setSpeed(speed);
    const now = p.position();
    expect(now).toBeGreaterThanOrEqual(previous - 1e-9);
    clock += 0.5;
    previous = p.position();
    expect(previous).toBeGreaterThan(now - 1e-9);
  }
  expect(jumped()).toBe(false);
  p.dispose();
});
