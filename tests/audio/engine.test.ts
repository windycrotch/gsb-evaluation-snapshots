import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AudioEngine } from "../../src/audio";
import type { Playback } from "../../src/core";
import { installFakeAudio, type FakeAudio } from "./fakes";

// The engine is the seam between the transport and the audio graph. These tests
// drive `render()` with Playback snapshots and check what the engine asks of
// Web Audio: which sources/oscillators exist, what gains are scheduled and what
// the freeze worklet is told. Nothing here needs a browser.

let fake: FakeAudio;
let engine: AudioEngine;

const create = async () => {
  vi.resetModules();
  const { audio } = await import("../../src/audio");
  const recording = await audio.decode(new ArrayBuffer(8));
  return audio.createEngine(recording);
};

const playback = (overrides: Partial<Playback> = {}): Playback => ({
  mode: "playing",
  anchorPosition: 2,
  anchorTime: 0,
  rate: 1,
  loop: { start: 0, end: 10 },
  loopWraps: true,
  ...overrides,
});

const freezeGain = () => fake.ctx.gains[1];

beforeEach(async () => {
  fake = installFakeAudio();
  engine = await create();
});

afterEach(() => {
  fake.restore();
  vi.useRealTimers();
});

test("construction loads the freeze worklet with a private copy of every channel and stays silent", () => {
  const load = fake.recorder.posts.find((p) => p.type === "load");
  expect(load).toBeDefined();
  expect(load && "channels" in load && load.channels).toHaveLength(2);
  expect(fake.ctx.sources).toHaveLength(0);
  expect(fake.ctx.oscillators).toHaveLength(0);
  expect(freezeGain().gain.value).toBe(0);
});

test("playing starts one source at the rendered position and stopping tears it down", () => {
  engine.render(playback());
  expect(fake.ctx.sources).toHaveLength(1);
  expect(fake.ctx.sources[0].starts[0]).toEqual({ when: 0, offset: 2 });

  engine.render(playback({ mode: "silent", anchorPosition: 3, anchorTime: 1 }));
  expect(fake.ctx.sources[0].ended).toBe(true);
  expect(fake.ctx.sources).toHaveLength(1);
});

test("pausing, freezing and silence all fade the freeze gain out and eventually deactivate the worklet", () => {
  vi.useFakeTimers();
  engine.render(playback());
  engine.render(playback({ mode: "frozen", anchorPosition: 4, anchorTime: 1 }));
  expect(freezeGain().gain.lastScheduled).toBe(1);

  const seeksBefore = fake.recorder.posts.filter((p) => p.type === "seek").length;
  engine.render(playback({ mode: "silent", anchorPosition: 4, anchorTime: 2 }));
  expect(freezeGain().gain.lastScheduled).toBe(0);
  const seeksAfter = fake.recorder.posts.filter((p) => p.type === "seek").length;
  expect(seeksAfter).toBe(seeksBefore);

  vi.advanceTimersByTime(60);
  const active = fake.recorder.posts.filter((p) => p.type === "active");
  expect(active[active.length - 1]).toEqual({ type: "active", active: false });
});

test("entering freeze seeks the worklet with a jump to the rendered position and fades in", () => {
  engine.render(playback());
  fake.ctx.currentTime = 5;
  engine.render(playback({ mode: "frozen", anchorPosition: 6, anchorTime: 5 }));

  const seek = fake.recorder.posts.filter((p) => p.type === "seek").at(-1);
  expect(seek).toEqual({ type: "seek", position: 6, jump: true });
  expect(freezeGain().gain.lastScheduled).toBe(1);
  expect(fake.ctx.sources[0].ended).toBe(true);
});

test("a scrub streams continuous seeks while the gain stays up, and a drop jumps once", () => {
  vi.useFakeTimers();
  engine.render(playback());
  engine.render(playback({ mode: "scrubbing", anchorPosition: 3, anchorTime: 1 }));
  engine.render(playback({ mode: "scrubbing", anchorPosition: 4, anchorTime: 1.1 }));
  engine.render(playback({ mode: "scrubbing", anchorPosition: 5, anchorTime: 1.2 }));

  const seeks = fake.recorder.posts.filter((p) => p.type === "seek");
  // The first scrub is a mode change (jump); later scrub positions stream smoothly.
  expect(seeks.map((s) => s.type === "seek" && { position: s.position, jump: s.jump })).toEqual([
    { position: 3, jump: true },
    { position: 4, jump: false },
    { position: 5, jump: false },
  ]);
  expect(freezeGain().gain.lastScheduled).toBe(1);

  fake.ctx.currentTime = 1.3;
  engine.render(playback({ anchorPosition: 5, anchorTime: 1.3 }));
  expect(fake.ctx.sources).toHaveLength(2);
  expect(fake.ctx.sources[1].starts[0]).toEqual({ when: 0, offset: 5 });
  expect(freezeGain().gain.lastScheduled).toBe(0);
  vi.advanceTimersByTime(60);
  expect(fake.recorder.posts.filter((p) => p.type === "active").at(-1)).toEqual({ type: "active", active: false });
});

test("a jump while playing replaces the source instead of letting the old one run", () => {
  engine.render(playback());
  fake.ctx.currentTime = 3;
  engine.render(playback({ anchorPosition: 7, anchorTime: 3 }));
  expect(fake.ctx.sources).toHaveLength(2);
  expect(fake.ctx.sources[0].ended).toBe(true);
  // positionAt() renders where the new anchor says playback is at the moment of the jump.
  expect(fake.ctx.sources[1].starts[0]).toEqual({ when: 0, offset: 7 });
});

test("a seamless speed change reuses the running source and updates its rate", () => {
  engine.render(playback());
  const [source] = fake.ctx.sources;
  engine.render(playback({ rate: 0.5, anchorTime: 1, anchorPosition: 3 }));
  expect(fake.ctx.sources).toHaveLength(1);
  expect(source.playbackRate.value).toBe(0.5);
  expect(source.ended).toBe(false);
});

test("a non-wrapping loop arms a stop at the loop end and the stop is cancelled when wrapping resumes", () => {
  engine.render(playback({ loopWraps: false, anchorPosition: 2, anchorTime: 0, loop: { start: 0, end: 10 } }));
  const [source] = fake.ctx.sources;
  expect(source.stops).toEqual([8]);

  // Wrapping resumes while the source is still running: the engine restarts it
  // from the new anchor and retires the armed one rather than letting its
  // stop-in-the-past truncate the new trajectory.
  fake.ctx.currentTime = 3;
  engine.render(playback({ loopWraps: true, anchorPosition: 5, anchorTime: 3 }));
  expect(source.ended).toBe(true);
  expect(fake.ctx.sources).toHaveLength(2);
  expect(fake.ctx.sources[1].starts[0]).toEqual({ when: 0, offset: 5 });
});

test("the freeze worklet is silenced through the gain on dispose, even if a fade was in flight", () => {
  vi.useFakeTimers();
  engine.render(playback({ mode: "frozen", anchorPosition: 4, anchorTime: 1 }));
  expect(freezeGain().gain.lastScheduled).toBe(1);
  engine.dispose();
  expect(freezeGain().gain.lastScheduled).toBe(0);
  expect(fake.recorder.posts.filter((p) => p.type === "active").at(-1)).toEqual({ type: "active", active: false });
});

test("dispose stops the source and every oscillator, and repeat disposal is harmless", () => {
  engine.render(playback());
  engine.playTone(440);
  engine.playTone(523.25);
  expect(fake.ctx.oscillators).toHaveLength(2);
  expect(fake.ctx.oscillators[0].ended).toBe(true);

  engine.dispose();
  expect(fake.ctx.sources[0].ended).toBe(true);
  expect(fake.ctx.oscillators[1].ended).toBe(true);

  expect(() => engine.dispose()).not.toThrow();
  expect(() => engine.playTone(880)).not.toThrow();
  expect(fake.ctx.oscillators).toHaveLength(2);
});

test("after dispose the engine ignores render, tone, volume and pitch work", () => {
  engine.dispose();
  const resumeBefore = fake.ctx.resumeCount;
  const postsBefore = fake.recorder.posts.length;

  engine.render(playback());
  engine.playTone(440);
  engine.setVolume(0.5);
  engine.setPitch(3);

  expect(fake.ctx.sources).toHaveLength(0);
  expect(fake.ctx.oscillators).toHaveLength(0);
  expect(fake.ctx.resumeCount).toBe(resumeBefore);
  expect(fake.recorder.posts.length).toBe(postsBefore);
});

test("a pending freeze deactivation timer is cancelled by disposal", () => {
  vi.useFakeTimers();
  engine.render(playback({ mode: "frozen", anchorPosition: 4, anchorTime: 1 }));
  engine.render(playback({ mode: "silent", anchorPosition: 4, anchorTime: 2 }));
  const before = fake.recorder.posts.length;
  engine.dispose();
  const afterDispose = fake.recorder.posts.length;
  vi.advanceTimersByTime(500);
  expect(fake.recorder.posts.length).toBe(afterDispose);
  expect(afterDispose).toBeGreaterThan(before);
});

test("a spectrum stays readable after disposal", () => {
  const spectrum = engine.openSpectrum();
  engine.dispose();
  expect(() => spectrum.read()).not.toThrow();
  spectrum.close();
});

test("the engine reports its latency including the stretch stage", () => {
  fake.ctx.baseLatency = 0.01;
  fake.ctx.outputLatency = 0.02;
  expect(engine.latency?.()).toBeCloseTo(0.125 + 0.03, 9);
});
