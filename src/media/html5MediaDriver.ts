/**
 * HTML5 <video> implementation of the unified MediaClockDriver.
 * Powers local .mp4 / .webm files and drag-and-dropped blob URLs.
 */

import type {
  MediaClockDriver,
  MediaClockStateCallbacks,
} from './mediaTypes';

export class Html5MediaDriver implements MediaClockDriver {
  public readonly kind = 'html5' as const;
  private video: HTMLVideoElement;
  private fallbackDurationSec: number;
  private callbacks: MediaClockStateCallbacks;
  private ready = false;
  private pendingSeekSec: number | null = null;
  private pendingSeekTimestampMs = 0;
  private destroyed = false;
  // Last displayed time, so reads after destroy() never touch the detached element again
  private lastCurrentTimeSec = 0;

  private handlePlay = () => {
    if (this.destroyed) return;
    this.callbacks.onPlayStateChange?.(true);
  };

  private handlePause = () => {
    if (this.destroyed) return;
    this.callbacks.onPlayStateChange?.(false);
  };

  private handleSeeked = () => {
    if (this.destroyed) return;
    this.pendingSeekSec = null;
    this.callbacks.onSeekSettled?.();
  };

  private handleLoadedMetadata = () => {
    if (this.destroyed) return;
    this.ready = true;
    const dur = this.getDuration();
    if (dur > 0) {
      this.callbacks.onDurationChange?.(dur);
    }
  };

  private handleRateChange = () => {
    if (this.destroyed) return;
    this.callbacks.onRateChange?.(this.video.playbackRate);
  };

  private handleEnded = () => {
    if (this.destroyed) return;
    this.callbacks.onPlayStateChange?.(false);
    this.callbacks.onEnded?.();
  };

  constructor(
    videoElement: HTMLVideoElement,
    fallbackDurationSec: number,
    callbacks: MediaClockStateCallbacks = {}
  ) {
    this.video = videoElement;
    this.fallbackDurationSec = Math.max(0.1, fallbackDurationSec);
    this.callbacks = callbacks;
    this.lastCurrentTimeSec = this.video.currentTime || 0;

    if (this.video.readyState >= 1) {
      this.ready = true;
    }

    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('seeked', this.handleSeeked);
    this.video.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.video.addEventListener('ratechange', this.handleRateChange);
    this.video.addEventListener('ended', this.handleEnded);
  }

  public isReady(): boolean {
    return this.ready || this.video.readyState >= 1;
  }

  public isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  public getCurrentTime(): number {
    if (this.destroyed) {
      return this.lastCurrentTimeSec;
    }
    if (this.pendingSeekSec !== null) {
      const now = performance.now();
      if (
        !this.video.seeking &&
        Math.abs((this.video.currentTime || 0) - this.pendingSeekSec) < 0.05
      ) {
        this.pendingSeekSec = null;
        this.lastCurrentTimeSec = this.video.currentTime || 0;
        return this.lastCurrentTimeSec;
      }
      if (now - this.pendingSeekTimestampMs > 500) {
        // Safety latch expired: keep displaying the requested target rather than
        // reverting to a stale decoder timestamp while paused.
        this.pendingSeekSec = null;
        this.lastCurrentTimeSec = this.video.currentTime || 0;
        return this.lastCurrentTimeSec;
      }
      this.lastCurrentTimeSec = this.pendingSeekSec;
      return this.pendingSeekSec;
    }
    this.lastCurrentTimeSec = this.video.currentTime || 0;
    return this.lastCurrentTimeSec;
  }

  public getDuration(): number {
    if (this.destroyed) {
      return this.fallbackDurationSec;
    }
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : this.fallbackDurationSec;
  }

  public setDuration(durationSec: number): void {
    this.fallbackDurationSec = Math.max(0.1, durationSec);
  }

  public getPlaybackRate(): number {
    return this.video.playbackRate || 1;
  }

  public isMuted(): boolean {
    return this.video.muted;
  }

  public async play(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.video.play();
    } catch {
      // Autoplay or missing source fallback handled gracefully
      this.callbacks.onPlayStateChange?.(false);
    }
  }

  public pause(): void {
    if (this.destroyed) return;
    this.video.pause();
  }

  public seek(timeSec: number): void {
    if (this.destroyed) return;
    const clamped = Math.max(0, Math.min(this.getDuration(), timeSec));
    this.pendingSeekSec = clamped;
    this.pendingSeekTimestampMs = performance.now();
    this.lastCurrentTimeSec = clamped;
    this.video.currentTime = clamped;
  }

  public setPlaybackRate(rate: number): void {
    if (this.destroyed) return;
    // Re-anchor at the currently displayed time first so changing rate never
    // causes an instantaneous playhead jump, then clamp to HTML5's 0.1x–4.0x range.
    const safeRate = Math.max(0.1, Math.min(4.0, rate));
    const displayedTime = this.getCurrentTime();
    if (this.pendingSeekSec !== null) {
      this.pendingSeekSec = displayedTime;
      this.pendingSeekTimestampMs = performance.now();
      this.video.currentTime = displayedTime;
    }
    this.video.playbackRate = safeRate;
  }

  public setMuted(muted: boolean): void {
    if (this.destroyed) return;
    this.video.muted = muted;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.lastCurrentTimeSec = this.getCurrentTime();
    this.destroyed = true;
    this.pendingSeekSec = null;
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.video.removeEventListener('ratechange', this.handleRateChange);
    this.video.removeEventListener('ended', this.handleEnded);
    this.video.pause();
  }
}
