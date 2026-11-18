/*!
 * Voice orb by UV · https://github.com/imuvrays1/voice-orb
 * Copyright (c) 2026 UV · MIT License (see LICENSE). Keep this notice in copies.
 */

/**
 * The handoff between voice sources — one per listener the orb has (the page
 * keeps two: one passed to the orb as `voice`, one as `caller`).
 *
 * Every change of what a listener hears goes through `switchTo`, which ends
 * the old source before the new one opens: the microphone's tracks are
 * released, a tab share stops capturing, a file or the sample stops playing.
 * The handoff itself is the `LevelSource` the orb is given, so the orb's
 * convention is untouched — it still reads `voice` only while talking and
 * `caller` only while listening, with its own fast attack and slow release on
 * top — and two sources can never drive the orb at once, because the orb only
 * ever reads the handoff and the handoff only ever reads one source.
 *
 * When a source ends — the person stops it, the browser declines the
 * microphone, a tab share is cancelled or comes back without an audio track —
 * the handoff stops reading it and what it last heard fades smoothly to zero
 * over a fraction of a second, instead of freezing on the last loud frame.
 * The caller keeps a readable error (the page shows its own message); the orb
 * just goes quiet.
 */

import type { Bands, LevelSource, OrbLevels } from "./audio";

/** A voice that is ready to be read, plus how to end it. */
export interface OpenedVoice {
  levels: LevelSource;
  /** Releases everything the voice holds: tracks, captures, playback. */
  stop(): void;
}

export type SwitchResult =
  /** The new source opened and is now the one read. */
  | "attached"
  /** The new source failed to open; nothing is read and the levels fade out. */
  | "failed"
  /** A newer switch happened while this one was opening; its source was closed at once. */
  | "superseded";

/* The fade to silence once nothing is read, per second: quick enough that a
   dead source reads as gone within about half a second, slow enough to land
   softly rather than cut. */
const FADE = 6;
/* Below this a faded band is exactly zero, so a still orb can stop drawing. */
const ZERO = 0.001;

export class VoiceHandoff implements LevelSource {
  private current: OpenedVoice | null = null;
  private generation = 0;
  private bands: Bands = [0, 0, 0, 0];
  private level = 0;
  private onError?: (error: unknown) => void;

  constructor(onError?: (error: unknown) => void) {
    this.onError = onError;
  }

  /**
   * End whatever is heard now, then open the next source. The old source's
   * `stop()` runs before `open()` is called, so a microphone is released
   * before the next one is asked for. If `open` throws, the error is reported
   * and the last heard levels fade to zero.
   */
  async switchTo(open: () => Promise<OpenedVoice> | OpenedVoice): Promise<SwitchResult> {
    const generation = ++this.generation;
    this.endCurrent();
    let opened: OpenedVoice;
    try {
      opened = await open();
    } catch (error) {
      if (generation === this.generation) this.onError?.(error);
      return "failed";
    }
    // Another switch (or a release) happened while this one was opening:
    // close what arrived late rather than letting two sources overlap.
    if (generation !== this.generation) {
      opened.stop();
      return "superseded";
    }
    this.current = opened;
    return "attached";
  }

  /** Stop the current source without opening another; the levels fade out. */
  release(): void {
    this.generation++;
    this.endCurrent();
  }

  private endCurrent() {
    const old = this.current;
    this.current = null;
    try {
      old?.stop();
    } catch {
      /* A source that fails to stop must not break the handoff. */
    }
  }

  read(dt: number): OrbLevels {
    const current = this.current;
    if (current) {
      const levels = current.levels.read(dt);
      this.bands = levels.bands;
      this.level = levels.level;
      return levels;
    }
    // Nothing to hear: what was last heard fades smoothly to zero.
    const step = dt || 1 / 60;
    const keep = Math.exp(-step * FADE);
    for (let i = 0; i < 4; i++) {
      this.bands[i] = this.bands[i] < ZERO ? 0 : this.bands[i] * keep;
    }
    this.level = this.level < ZERO ? 0 : this.level * keep;
    return { bands: [...this.bands] as Bands, level: this.level };
  }

  /**
   * A passive reader for a second orb showing the same voice (the tuning
   * preview): it reports the last levels the handoff produced and never
   * advances the source, so the two orbs stay in step.
   */
  twin(): LevelSource {
    return {
      read: () => ({ bands: [...this.bands] as Bands, level: this.level }),
    };
  }
}
