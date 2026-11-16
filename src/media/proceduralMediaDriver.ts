/**
 * High-precision virtual media clock driver for `procedural://` blueprint demo scenes
 * or missing video fallbacks. Runs at 60fps via `performance.now()`.
 */

import type {
  MediaClockDriver,
  MediaClockStateCallbacks,
} from './mediaTypes';

export class ProceduralMediaDriver implements MediaClockDriver {
  public readonly kind = 'procedural' as const;
  private durationSec: number;
  private callbacks: MediaClockStateCallbacks;
  private playing = false;
  private muted = false;
  private playbackRate = 1.0;
  private anchorTimeSec = 0;
  private anchorPerfMs = 0;
  private destroyed = false;

  constructor(
    durationSec: number,
    callbacks: MediaClockStateCallbacks = {}
  ) {
    this.durationSec = Math.max(0.5, durationSec);
    this.callbacks = callbacks;
    this.anchorPerfMs = performance.now();
  }

  public isReady(): boolean {
    return true;
  }

  public isPlaying(): boolean {
    return this.playing;
  }

  public getCurrentTime(): number {
    if (this.destroyed || !this.playing) {
      return this.anchorTimeSec;
    }
    const now = performance.now();
    const elapsed = ((now - this.anchorPerfMs) / 1000) * this.playbackRate;
    const current = this.anchorTimeSec + elapsed;
    if (current >= this.durationSec) {
      this.anchorTimeSec = this.durationSec;
      this.playing = false;
      this.callbacks.onPlayStateChange?.(false);
      this.callbacks.onEnded?.();
      return this.durationSec;
    }
    return Math.max(0, current);
  }

  public getDuration(): number {
    return this.durationSec;
  }

  public setDuration(newDurationSec: number): void {
    if (this.destroyed) return;
    const clampedDuration = Math.max(0.5, newDurationSec);
    this.durationSec = clampedDuration;
    // Shrinking the timeline past the current playhead clamps it to the new end,
    // whether the clock is paused or playing.
    if (this.anchorTimeSec > clampedDuration) {
      this.anchorTimeSec = clampedDuration;
      this.anchorPerfMs = performance.now();
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public async play(): Promise<void> {
    if (this.destroyed) return;
    if (this.anchorTimeSec >= this.durationSec - 0.02) {
      this.anchorTimeSec = 0;
    }
    this.anchorPerfMs = performance.now();
    this.playing = true;
    this.callbacks.onPlayStateChange?.(true);
  }

  public pause(): void {
    if (this.destroyed) return;
    if (this.playing) {
      this.anchorTimeSec = this.getCurrentTime();
      this.playing = false;
      this.callbacks.onPlayStateChange?.(false);
    }
  }

  public seek(timeSec: number): void {
    if (this.destroyed) return;
    const clamped = Math.max(0, Math.min(this.durationSec, timeSec));
    this.anchorTimeSec = clamped;
    this.anchorPerfMs = performance.now();
  }

  public setPlaybackRate(rate: number): void {
    if (this.destroyed) return;
    const safeRate = Math.max(0.25, Math.min(2.0, rate));
    // Always re-anchor at the currently displayed time before applying the new
    // rate so the playhead never jumps or extrapolates at the moment of switching.
    this.anchorTimeSec = this.getCurrentTime();
    this.anchorPerfMs = performance.now();
    this.playbackRate = safeRate;
    this.callbacks.onRateChange?.(safeRate);
  }

  public setMuted(muted: boolean): void {
    if (this.destroyed) return;
    this.muted = muted;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.anchorTimeSec = this.getCurrentTime();
    this.playing = false;
    this.destroyed = true;
  }
}
