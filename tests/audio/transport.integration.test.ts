import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AudioEngine } from "../../src/audio";
import type { Playback } from "../../src/core";
import { installFakeAudio, type FakeAudio } from "./fakes";

// End-to-end through the transport: a real player drives a real engine, with
// only the browser audio graph faked. These tests check that the playhead the
// player reports and the Playback the engine renders agree at the same instant.

let fake: FakeAudio;
let engine: AudioEngine;
let clock = 0;

const createPlayer = async () => {
  vi.resetModules();
  const { audio } = await import("../../src/audio");
  const { core } = await import("../../src/core");
  const recording = await audio.decode(new ArrayBuffer(8));
  const built = await audio.createEngine(recording);
  fake.ctx.currentTime = clock;
  const output = {
    now: () => fake.ctx.currentTime,
    render: (p: Playback) => built.render(p),
    latency: () => built.latency?.() ?? 0,
  };
  const player = core.createPlayer(output, {
    duration: 30,
    position: 5,
    loop: { start: 2, end: 8 },
    loopMode: { type: "automatic", delay: 0 },
    speed: 1,
  });
  return { player, engine: built };
};

const tick = (seconds: number) => {
  for (let ms = 0; ms < Math.round(seconds * 1000); ms++) {
    clock += 0.001;
    fake.ctx.currentTime = clock;
    vi.advanceTimersByTime(1);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  fake = installFakeAudio();
});

afterEach(() => {
  fake.restore();
  vi.useRealTimers();
});

test("a dragged playhead is what the engine renders at drop time", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.dispatch({ type: "toggle-play" });
  tick(1);
  player.startScrub(6);
  tick(0.5);
  player.scrubTo(4);
  tick(0.5);
  player.endScrub();

  expect(player.position()).toBe(4);
  const sources = fake.ctx.sources;
  expect(sources).toHaveLength(2);
  expect(sources[1].starts[0]).toEqual({ when: 0, offset: 4 });
});

test("freezing renders the same position the player displays and the gain rises", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.dispatch({ type: "toggle-play" });
  tick(1);
  const shown = player.position();
  player.dispatch({ type: "toggle-freeze" });
  expect(player.position()).toBeCloseTo(shown, 9);

  const seek = fake.recorder.posts.filter((p) => p.type === "seek").at(-1);
  expect(seek?.type === "seek" && seek.jump).toBe(true);
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(1);

  // The playing source is gone, so nothing else can make sound.
  expect(fake.ctx.sources.every((s) => s.ended)).toBe(true);
});

test("silence after a freeze leaves no audible source and fades the freeze out", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.dispatch({ type: "toggle-freeze" });
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(1);
  player.dispatch({ type: "toggle-freeze" });
  expect(player.getState().playState).toBe("paused");
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(0);
  expect(fake.ctx.sources.every((s) => s.ended)).toBe(true);
});

test("a loop wait silences playback; the delay-end resumes from the loop start", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.setLoopMode({ type: "automatic", delay: 1 });
  player.dispatch({ type: "toggle-play" });
  const wait = built.engine.latency?.() ?? 0;
  tick(3.05 + wait);
  expect(player.getState().playState).toBe("waiting");
  expect(fake.ctx.sources.every((s) => s.ended)).toBe(true);
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(0);

  tick(1.05);
  expect(player.getState().playState).toBe("playing");
  const running = fake.ctx.sources.filter((s) => !s.ended);
  expect(running).toHaveLength(1);
  expect(player.position()).toBeCloseTo(2, 1);
});

test("dragging out of a wait resumes immediately and the old timer cannot re-silence", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.setLoopMode({ type: "automatic", delay: 1 });
  player.dispatch({ type: "toggle-play" });
  const wait = built.engine.latency?.() ?? 0;
  tick(3.05 + wait);
  expect(player.getState().playState).toBe("waiting");

  player.startScrub(5);
  expect(player.getState().playState).toBe("playing");
  const beforeSources = fake.ctx.sources.length;
  tick(1.5); // crosses the abandoned delay deadline

  expect(player.getState().playState).toBe("playing");
  expect(player.position()).toBe(5);
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(1);
  player.endScrub();
  expect(fake.ctx.sources.length).toBe(beforeSources + 1);
  expect(fake.ctx.sources.at(-1)!.starts[0]).toEqual({ when: 0, offset: 5 });
});

test("disposing the pair leaves no running source, oscillator or freeze voice", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.dispatch({ type: "toggle-play" });
  tick(1);
  engine.playTone(440);
  player.dispatch({ type: "toggle-freeze" });
  tick(0.1);

  player.dispose();
  engine.dispose();

  expect(fake.ctx.sources.every((s) => s.ended)).toBe(true);
  expect(fake.ctx.oscillators.every((o) => o.ended)).toBe(true);
  expect(fake.ctx.gains[1].gain.lastScheduled).toBe(0);
  expect(fake.recorder.posts.filter((p) => p.type === "active").at(-1)).toEqual({ type: "active", active: false });
  expect(vi.getTimerCount()).toBe(0);

  // Late work from either side is ignored rather than reviving audio.
  const sources = fake.ctx.sources.length;
  engine.render({ mode: "playing", anchorPosition: 1, anchorTime: clock, rate: 1, loop: { start: 2, end: 8 }, loopWraps: true });
  engine.playTone(660);
  expect(fake.ctx.sources.length).toBe(sources);
  expect(fake.ctx.oscillators.every((o) => o.ended)).toBe(true);
});

test("a speed change keeps the engine's source alive and in step with the display", async () => {
  const built = await createPlayer();
  engine = built.engine;
  const { player } = built;
  player.dispatch({ type: "toggle-play" });
  tick(1);
  const shown = player.position();
  player.setSpeed(0.5);
  expect(player.position()).toBeCloseTo(shown, 9);
  expect(fake.ctx.sources).toHaveLength(1);
  expect(fake.ctx.sources[0].playbackRate.value).toBe(0.5);
  tick(2);
  // The engine keeps the same source alive; the display advances at the new rate.
  expect(fake.ctx.sources[0].ended).toBe(false);
  const delta = player.position() - shown;
  expect(delta).toBeGreaterThan(0.9);
  expect(delta).toBeLessThan(1.2);
});
