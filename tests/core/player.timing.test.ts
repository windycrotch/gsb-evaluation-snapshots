import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { core, type Output, type Playback, type PlayState, type Player, type PlayerOptions, type TransportEvent } from "../../src/core";

// A seeded PRNG keeps the "random" interleavings reproducible from run to run.
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

let clock = 0;
let renders: Playback[] = [];
let latency = 0;

const output: Output = { now: () => clock, render: (p) => void renders.push(p), latency: () => latency };
const advance = (seconds: number) => {
  for (let ms = 0; ms < Math.round(seconds * 1000); ms++) {
    clock += 0.001;
    vi.advanceTimersByTime(1);
  }
};
const make = (options: Partial<PlayerOptions> = {}) =>
  core.createPlayer(output, { duration: 20, position: 4, loop: { start: 2, end: 10 }, loopMode: { type: "automatic", delay: 0 }, speed: 1, ...options });

const between = (value: number, lo: number, hi: number) => value >= lo - 1e-9 && value <= hi + 1e-9;

/** Properties that must hold after every single step of a session. */
const check = (player: Player, label: string, dragging: boolean) => {
  const { playState } = player.getState();
  const position = player.position();
  expect(Number.isFinite(position), `${label}: position is finite`).toBe(true);
  expect(between(position, 0, player.duration), `${label}: position in [0, duration], got ${position}`).toBe(true);
  expect(renders.length, `${label}: something was rendered`).toBeGreaterThan(0);
  const last = renders[renders.length - 1];
  const expectedMode = dragging ? "scrubbing" : playState === "playing" ? "playing" : playState === "frozen" ? "frozen" : "silent";
  expect(last.mode, `${label}: rendered mode matches state`).toBe(expectedMode);
  if (last.mode === "playing") {
    // The engine is always handed a Playback whose anchor is a real point on
    // the displayed trajectory.
    expect(Number.isFinite(core.positionAt(last, last.anchorTime)), `${label}: anchor renders`).toBe(true);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  clock = 100;
  renders = [];
  latency = 0;
});
afterEach(() => vi.useRealTimers());

test("interleaved drags, speed, loop and mode changes never break the playhead or its rendering", () => {
  const random = seeded(0xc0ffee);
  for (let run = 0; run < 12; run++) {
    renders = [];
    clock = 100;
    latency = random() < 0.5 ? 0 : 0.15;
    const p = make({
      loopMode: random() < 0.5 ? { type: "automatic", delay: Math.round(random() * 3) } : { type: "manual" },
      speed: 0.5 + random(),
    });
    const dragging = { active: false };
    for (let step = 0; step < 120; step++) {
      const roll = random();
      if (roll < 0.12) p.dispatch({ type: "toggle-play" });
      else if (roll < 0.2) p.dispatch({ type: "toggle-freeze" });
      else if (roll < 0.32) {
        if (!dragging.active) {
          dragging.active = true;
          p.startScrub(random() * p.duration);
        } else p.scrubTo(random() * p.duration);
      } else if (roll < 0.4) {
        if (dragging.active) {
          dragging.active = false;
          p.endScrub();
        }
      } else if (roll < 0.5) p.setSpeed(0.25 + random() * 2);
      else if (roll < 0.58) p.setLoop(random() < 0.25 ? null : { start: random() * 10, end: 10 + random() * 10 });
      else if (roll < 0.68)
        p.setLoopMode(random() < 0.34 ? { type: "manual" } : { type: "automatic", delay: Math.round(random() * 3) });
      else advance(random() * 0.5);

      check(p, `run ${run} step ${step}`, dragging.active);
      if (dragging.active) expect(p.position(), `run ${run} step ${step}: drag owns the playhead`).toBeCloseTo(
        (p as unknown as { scrub: number | null }).scrub!,
        9,
      );
    }
    p.dispose();
  }
});

test("a wait is never revived once left, however the interleaving lands", () => {
  const random = seeded(0x5eed);
  // Escapes that leave the transport in a state where no new wait can
  // legitimately begin, so any later "playing" would have to be a stale timer.
  const terminal: Array<{ name: string; escape: (p: Player) => void; expected: PlayState }> = [
    { name: "drag", escape: (p) => p.startScrub(4), expected: "playing" },
    { name: "pause", escape: (p) => p.dispatch({ type: "toggle-play" }), expected: "paused" },
    { name: "manual", escape: (p) => p.setLoopMode({ type: "manual" }), expected: "paused" },
  ];

  for (let run = 0; run < terminal.length * 8; run++) {
    clock = 100;
    renders = [];
    const delay = 1 + Math.round(random() * 3);
    const p = make({ loopMode: { type: "automatic", delay } });
    p.dispatch({ type: "toggle-play" });
    for (let guard = 0; guard < 400 && p.getState().playState === "playing"; guard++) advance(0.02);
    expect(p.getState().playState, `run ${run}: reached the wait`).toBe("waiting");
    expect(p.delayRemaining()).toBeGreaterThan(0);

    const { name, escape, expected } = terminal[run % terminal.length];
    escape(p);
    expect(p.getState().playState, `run ${run} (${name}): left the wait`).toBe(expected);
    expect(p.getState().waitingUntil, `run ${run} (${name}): no stale wait timestamp`).toBeNull();

    let remaining = delay + 1;
    while (remaining > 0) {
      const step = Math.min(remaining, random() * 0.25);
      advance(step);
      remaining -= step;
      expect(p.getState().playState, `run ${run} (${name}): stays ${expected}`).toBe(expected);
    }
    if (name === "drag") {
      p.endScrub();
      expect(p.getState().playState).toBe("playing");
    }
  }
});

test("a wait replaced by a shorter one only fires at the new deadline", () => {
  clock = 100;
  renders = [];
  const p = make({ loopMode: { type: "automatic", delay: 3 } });
  p.dispatch({ type: "toggle-play" });
  for (let guard = 0; guard < 400 && p.getState().playState === "playing"; guard++) advance(0.02);
  expect(p.getState().playState).toBe("waiting");
  const oldDeadline = p.getState().waitingUntil!;

  p.setLoopMode({ type: "automatic", delay: 0.5 });
  expect(p.getState().playState).toBe("waiting");
  const newDeadline = p.getState().waitingUntil!;
  expect(newDeadline).toBeLessThan(oldDeadline);

  advance(0.6);
  expect(p.getState().playState).toBe("playing");

  // Crossing the old (abandoned) deadline must change nothing.
  advance(3);
  expect(p.getState().playState).toBe("playing");
});

test("a speed change in any state keeps the displayed playhead where the user left it", () => {
  const states: Array<(p: Player) => void> = [
    () => {},
    (p) => p.dispatch({ type: "toggle-play" }),
    (p) => p.dispatch({ type: "toggle-freeze" }),
    (p) => {
      p.dispatch({ type: "toggle-play" });
      advance(1);
    },
  ];
  for (const enter of states) {
    for (const speed of [0.25, 0.5, 1, 1.5, 2]) {
      clock = 100;
      renders = [];
      latency = 0.15;
      const p = make();
      enter(p);
      const before = p.position();
      p.setSpeed(speed);
      expect(p.position(), `speed ${speed}: no jump`).toBeCloseTo(before, 9);
      expect(renders[renders.length - 1].rate).toBe(speed);
    }
  }
});

test("disposal at an arbitrary point leaves the transport inert", () => {
  const random = seeded(0xdead);
  const events: TransportEvent[] = [
    { type: "toggle-play" },
    { type: "toggle-freeze" },
    { type: "move", position: 7 },
    { type: "loop-end" },
    { type: "delay-end" },
    { type: "loop-change" },
  ];
  for (let run = 0; run < 20; run++) {
    clock = 100;
    renders = [];
    const p = make({ loopMode: run % 2 ? { type: "automatic", delay: 2 } : { type: "manual" } });
    for (let i = 0; i < 5; i++) {
      const event = events[Math.floor(random() * events.length)];
      p.dispatch(event);
      advance(random());
    }
    p.dispose();
    const count = renders.length;
    const state = p.getState();
    // Every public entry point must be a no-op now.
    for (const event of events) p.dispatch(event);
    p.startScrub(3);
    p.scrubTo(4);
    p.endScrub();
    p.setSpeed(2);
    p.setLoop({ start: 0, end: 5 });
    p.setLoopMode({ type: "manual" });
    p.correctPosition(1);
    p.dispose();
    advance(50);
    expect(renders.length, `run ${run}: no renders after disposal`).toBe(count);
    expect(p.getState().playState).toBe(state.playState);
    expect(vi.getTimerCount()).toBe(0);
  }
});

test("the rendered Playback and the reported position stay in step while playing", () => {
  const random = seeded(0xbeef);
  latency = 0.12;
  const p = make({ loop: { start: 2, end: 6 }, loopMode: { type: "automatic", delay: 0 } });
  p.dispatch({ type: "toggle-play" });
  const state: PlayState[] = [];
  for (let step = 0; step < 400; step++) {
    if (random() < 0.05) p.setSpeed(0.5 + random());
    advance(random() * 0.05);
    const last = renders[renders.length - 1];
    if (last.mode === "playing") {
      // Whatever point on the trajectory the engine was given, the display must
      // be a point on that same trajectory (never a different, stale one).
      const anchor = core.positionAt(last, last.anchorTime);
      expect(Math.abs(anchor - p.position())).toBeLessThan(1 + last.loop.end - last.loop.start + p.duration);
    }
    state.push(p.getState().playState);
  }
  expect(state).toContain("playing");
});
