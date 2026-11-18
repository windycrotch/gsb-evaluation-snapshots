/*!
 * Voice orb by UV · https://github.com/imuvrays1/voice-orb
 * Copyright (c) 2026 UV · MIT License (see LICENSE). Keep this notice in copies.
 */

/**
 * Tests for the source handoff (src/lib/orb/handoff.ts), run with Node's own
 * test runner — no packages to install:
 *
 *   npm test
 *
 * The sources are fakes: a loud voice that records every read and stop, and
 * openers that fail the way the browser does (a declined microphone, a
 * cancelled tab share, a share without an audio track).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { VoiceHandoff, type OpenedVoice } from "./handoff.ts";
import type { Bands, OrbLevels } from "./audio.ts";

const FRAME = 1 / 60;
const LOUD: OrbLevels = { bands: [0.9, 0.8, 0.7, 0.6], level: 0.8 };

/** A fake voice that stands in for an analyser: loud, and counting. */
interface FakeVoice extends OpenedVoice {
  reads: number;
  stops: number;
}

function fakeVoice(levels: OrbLevels = LOUD): FakeVoice {
  const fake: FakeVoice = {
    reads: 0,
    stops: 0,
    levels: {
      read: () => {
        fake.reads++;
        return { bands: [...levels.bands] as Bands, level: levels.level };
      },
    },
    stop: () => {
      fake.stops++;
    },
  };
  return fake;
}

/** Read `frames` frames, returning the last levels. */
function run(handoff: VoiceHandoff, frames: number): OrbLevels {
  let levels: OrbLevels = { bands: [0, 0, 0, 0], level: 0 };
  for (let i = 0; i < frames; i++) levels = handoff.read(FRAME);
  return levels;
}

test("a normal switch ends the old source before the new one opens, and only the new one is read", async () => {
  const handoff = new VoiceHandoff();
  const first = fakeVoice();
  const second = fakeVoice({ bands: [0.1, 0.2, 0.3, 0.4], level: 0.25 });
  const order: string[] = [];

  assert.equal(await handoff.switchTo(() => first), "attached");
  run(handoff, 5);
  assert.ok(first.reads > 0);

  const result = await handoff.switchTo(() => {
    order.push(first.stops > 0 ? "old already stopped" : "old still open");
    return second;
  });

  assert.equal(result, "attached");
  assert.deepEqual(order, ["old already stopped"]);
  assert.equal(first.stops, 1);

  const readsBefore = first.reads;
  const levels = run(handoff, 5);
  assert.equal(first.reads, readsBefore, "the old source is never read again");
  assert.ok(second.reads > 0);
  assert.deepEqual(levels.bands, [0.1, 0.2, 0.3, 0.4]);
});

test("a declined microphone keeps the error and fades the last levels to zero", async () => {
  const errors: unknown[] = [];
  const handoff = new VoiceHandoff((error) => errors.push(error));
  const previous = fakeVoice();
  await handoff.switchTo(() => previous);
  run(handoff, 5);

  const denied = new DOMException("Permission denied", "NotAllowedError");
  const result = await handoff.switchTo(() => Promise.reject(denied));

  assert.equal(result, "failed");
  assert.deepEqual(errors, [denied], "the error stays readable for the page");
  assert.equal(previous.stops, 1, "the previous source was ended first");

  // The fade: every frame is quieter than the last until it reaches zero,
  // never frozen high.
  let before = LOUD.level;
  for (let i = 0; i < 90; i++) {
    const { level } = handoff.read(FRAME);
    if (before > 0) assert.ok(level < before, `frame ${i}: level ${level} should be below ${before}`);
    else assert.equal(level, 0, "once silent, it stays silent");
    before = level;
  }
  const settled = run(handoff, 60);
  assert.equal(settled.level, 0);
  assert.deepEqual(settled.bands, [0, 0, 0, 0]);
});

test("a cancelled tab share, or one without an audio track, fails the same way", async () => {
  for (const failure of [
    new DOMException("Permission denied", "NotAllowedError"), // the share prompt declined
    new Error("The share had no audio."), // a share with no audio track
  ]) {
    const errors: unknown[] = [];
    const handoff = new VoiceHandoff((error) => errors.push(error));
    const previous = fakeVoice();
    await handoff.switchTo(() => previous);
    run(handoff, 5);

    const result = await handoff.switchTo(() => Promise.reject(failure));

    assert.equal(result, "failed");
    assert.deepEqual(errors, [failure]);
    assert.equal(previous.stops, 1);
    const readsBefore = previous.reads;
    const settled = run(handoff, 180);
    assert.equal(previous.reads, readsBefore, "the failed source is never read");
    assert.equal(settled.level, 0);
    assert.deepEqual(settled.bands, [0, 0, 0, 0]);
  }
});

test("stopping playback fades the levels to zero instead of freezing them", async () => {
  const handoff = new VoiceHandoff();
  const voice = fakeVoice();
  await handoff.switchTo(() => voice);
  run(handoff, 5);

  handoff.release();
  assert.equal(voice.stops, 1);

  const first = handoff.read(FRAME);
  assert.ok(first.level > 0, "the fade starts from the last heard level");
  assert.ok(first.level < LOUD.level, "and is already falling");
  const settled = run(handoff, 180);
  assert.equal(settled.level, 0);
  assert.deepEqual(settled.bands, [0, 0, 0, 0]);
});

test("a source that opens after a newer switch is closed at once, never read", async () => {
  const handoff = new VoiceHandoff();
  const slow = fakeVoice();
  let openSlow: (voice: OpenedVoice) => void;
  const slowOpened = new Promise<OpenedVoice>((resolve) => {
    openSlow = resolve;
  });

  const pending = handoff.switchTo(() => slowOpened);
  const fast = fakeVoice();
  assert.equal(await handoff.switchTo(() => fast), "attached");

  openSlow!(slow);
  assert.equal(await pending, "superseded");
  assert.equal(slow.stops, 1, "the late source was closed immediately");
  run(handoff, 5);
  assert.equal(slow.reads, 0, "the late source never drove the orb");
  assert.ok(fast.reads > 0);
});

test("a source whose stop throws still leaves the handoff", async () => {
  const handoff = new VoiceHandoff();
  await handoff.switchTo(() => ({
    levels: fakeVoice().levels,
    stop: () => {
      throw new Error("stuck");
    },
  }));
  const next = fakeVoice();
  assert.equal(await handoff.switchTo(() => next), "attached");
  run(handoff, 3);
  assert.ok(next.reads > 0);
});

test("the twin mirrors the last levels without advancing the source", async () => {
  const handoff = new VoiceHandoff();
  const voice = fakeVoice();
  await handoff.switchTo(() => voice);
  run(handoff, 5);

  const mirror = handoff.twin();
  const mirrored = mirror.read(FRAME);
  assert.deepEqual(mirrored.bands, LOUD.bands);
  assert.equal(mirror.read(FRAME).level, LOUD.level);
  assert.equal(voice.reads, 5, "reading the twin never reads the source");
});
