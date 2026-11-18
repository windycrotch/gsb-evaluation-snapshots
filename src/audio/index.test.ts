import Note from "@/audio/note";
import Player from "@/audio/play";
import { Track } from "@/audio/track";
import { durationToSeconds } from "@/audio/util";
import { afterEach, expect, test, vi } from "vitest";

class MockTrack implements Track {
  name: string;

  notes: Array<Note>;

  record: Array<[number, number]>;

  constructor() {
    this.name = "MockTrack";
    this.notes = [];
    this.record = [];
  }

  play(
    _context: AudioContext,
    _destination: AudioNode,
    index: number,
    time: number
  ) {
    this.record.push([index, time]);
  }
}

/** Mutable stand-in for the audio context clock. */
class MockContext {
  currentTime: number;

  constructor(currentTime = 0) {
    this.currentTime = currentTime;
  }
}

const destination = {} as AudioNode;

function asAudioContext(context: MockContext): AudioContext {
  return context as unknown as AudioContext;
}

/**
 * Advance the fake timer clock and the mock audio context clock together so
 * the scheduler observes a realistic passage of time.
 */
function advance(
  context: MockContext,
  milliseconds: number,
  interval = 5
): void {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += interval) {
    context.currentTime += interval / 1000;
    vi.advanceTimersByTime(interval);
  }
}

/** Assert that the recorded steps form a single evenly spaced sequence. */
function expectEvenSteps(
  record: Array<[number, number]>,
  offset: number,
  stepDuration: number,
  length: number
): void {
  record.forEach(([index], position) => {
    expect(index).toBe(position % length);
  });
  for (
    let position = Math.max(offset, 1);
    position < record.length;
    position++
  ) {
    expect(record[position][1] - record[position - 1][1]).toBeCloseTo(
      stepDuration,
      6
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
});

test("Sanity check for durationToSeconds", () => {
  const actual = durationToSeconds(60.0, 1);
  expect(actual).toBe(4.0);
});

test("Check timing for playing tracks", () => {
  const context = { currentTime: 0.1 } as AudioContext;
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.playTick(context, destination, [track]);

  expect(track.record).toEqual([[0, 0.15]]);
});

test("Playback schedules every step in order", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 800);

  expect(track.record.length).toBeGreaterThan(2);
  expectEvenSteps(track.record, 0, 0.15, player.length);
});

test("Playback starts from the first step once more after stopping", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 800);
  const played = track.record.length;
  expect(played).toBeGreaterThan(2);

  player.stop();
  advance(context, 500);
  expect(track.record.length).toBe(played);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 200);

  expect(track.record.length).toBeGreaterThan(played);
  expect(track.record[played][0]).toBe(0);
  expectEvenSteps(track.record.slice(played), 0, 0.15, player.length);
});

test("Stopping clears pending scheduling and resets internal state", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 100);
  player.stop();

  expect(player.loop).toBe(false);
  expect(player.index).toBe(-1);
  expect(player.timer).toBe(0);
  expect(player.timeout).toBeNull();

  const stopped = track.record.length;
  advance(context, 1000);
  expect(track.record.length).toBe(stopped);
});

test("Changing the tempo reschedules subsequent steps at the new duration", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 800);
  const scheduled = track.record.slice();
  expect(scheduled.length).toBeGreaterThan(2);

  player.tempo = 240.0;
  advance(context, 800);

  // Steps already handed to the audio context keep their original time.
  expect(track.record.slice(0, scheduled.length)).toEqual(scheduled);

  const added = track.record.slice(scheduled.length);
  expect(added.length).toBeGreaterThan(2);
  for (let position = 1; position < added.length; position++) {
    expect(added[position][1] - added[position - 1][1]).toBeCloseTo(0.075, 6);
  }
});

test("Repeated play requests run a single scheduler", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  player.start(asAudioContext(context), destination, [track]);
  player.start(asAudioContext(context), destination, [track]);

  // Only the most recent start may keep a scheduling loop alive.
  expect(vi.getTimerCount()).toBe(1);

  advance(context, 1000);

  expect(vi.getTimerCount()).toBe(1);
  expect(track.record.length).toBeGreaterThan(2);
  expectEvenSteps(track.record, 0, 0.15, player.length);
});

test("Rapid stop and restart leaves only one scheduler", () => {
  vi.useFakeTimers();
  const context = new MockContext();
  const track = new MockTrack();
  const player = new Player(16, 0.1, 0.075, 120.0, 0.025);

  player.start(asAudioContext(context), destination, [track]);
  advance(context, 100);
  player.stop();
  advance(context, 200);
  const stopped = track.record.length;

  player.start(asAudioContext(context), destination, [track]);
  expect(vi.getTimerCount()).toBe(1);
  advance(context, 1000);

  expect(track.record.length).toBeGreaterThan(stopped);
  expect(track.record[stopped][0]).toBe(0);
  expectEvenSteps(track.record.slice(stopped), 0, 0.15, player.length);
});
