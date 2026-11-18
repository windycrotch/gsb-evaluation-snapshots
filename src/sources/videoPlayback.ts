// Playback progress tracking for video-backed sources.
//
// Deliberately free of DOM/Three.js imports so the accounting rules can be
// unit-tested offline with a fabricated clock and callback sequence.
//
// Frame counting strategy:
//   * When HTMLVideoElement.requestVideoFrameCallback is available, every
//     *presented* media frame is counted exactly once from the callback.
//   * Otherwise playback falls back to counting render-loop ticks.
//   The counting mode is fixed at construction, so the two paths can never
//   both contribute to the same counter.
//
// Paused media does not advance the counter: rVFC callbacks stop while the
// element is paused, and tick counting is gated on the element actually
// playing.

export type VideoSourceKind = 'file' | 'webcam';

export type FrameCountingMode = 'video-frame-callback' | 'render-tick';

/** Read-only view of a video source's playback state. */
export interface VideoPlaybackSnapshot {
  /** Where the media came from. */
  readonly kind:              VideoSourceKind;
  /** Playback position in seconds.  For live webcam streams this is elapsed
   *  play time, because `currentTime` is not meaningful for a MediaStream. */
  readonly currentTime:       number;
  /** Total duration in seconds, or null when the media has no finite duration
   *  (live webcam streams).  Never fabricated. */
  readonly duration:          number | null;
  readonly paused:            boolean;
  /** Media frames presented since construction (or render ticks on fallback). */
  readonly frameCount:        number;
  /** True after dispose(); the remaining fields describe the final state. */
  readonly disposed:          boolean;
}

/** Minimal surface of HTMLVideoElement used by the tracker. */
export interface VideoPlaybackProbe {
  readonly currentTime: number;
  readonly duration:    number;
  readonly paused:      boolean;
}

export interface VideoPlaybackProgressOptions {
  /** Monotonic millisecond clock.  Injectable for tests. */
  now?: () => number;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Accumulates presented-frame counts and elapsed play time.
 *
 * Callers are expected to:
 *   - call markPlaying() when playback starts,
 *   - call markPaused() when it stops (progress is retained),
 *   - feed presented frames to noteVideoFrame() in rVFC mode,
 *   - feed render ticks to noteRenderTick() in tick mode,
 *   - call dispose() once the source is torn down.
 */
export class VideoPlaybackProgress {
  private readonly kind:      VideoSourceKind;
  private readonly mode:      FrameCountingMode;
  private readonly now:       () => number;

  private video:              VideoPlaybackProbe | null;
  private frameCount:         number = 0;
  private playing:            boolean;
  private disposed:           boolean = false;
  private frozen:             VideoPlaybackSnapshot | null = null;

  private elapsedMs:          number = 0;
  private lastClockAt:        number;
  private lastMediaTime:      number | null = null;

  constructor(
    kind:      VideoSourceKind,
    video:     VideoPlaybackProbe,
    mode:      FrameCountingMode,
    options:   VideoPlaybackProgressOptions = {},
  ) {
    this.kind         = kind;
    this.mode         = mode;
    this.now          = options.now ?? defaultNow;
    this.video        = video;
    this.playing      = !video.paused;
    this.lastClockAt  = this.now();
  }

  get countingMode(): FrameCountingMode {
    return this.mode;
  }

  /** Resume accounting for play time.  Does not itself touch the media. */
  markPlaying(): void {
    if (this.disposed) return;
    this.advanceClock();
    this.playing = true;
  }

  /** Stop accounting play time, retaining frame count and elapsed time. */
  markPaused(): void {
    if (this.disposed) return;
    this.advanceClock();
    this.playing = false;
  }

  /**
   * Record one presented media frame (rVFC path).
   * No-op in tick-counting mode, guaranteeing the two paths never double-count.
   */
  noteVideoFrame(mediaTime?: number): boolean {
    if (this.disposed || this.mode !== 'video-frame-callback') return false;
    if (!this.isPlaying()) return false;

    // Some browsers can deliver a duplicate callback for the same presented
    // frame; only count it once.
    if (typeof mediaTime === 'number' && Number.isFinite(mediaTime)) {
      if (this.lastMediaTime !== null && mediaTime === this.lastMediaTime) {
        return false;
      }
      this.lastMediaTime = mediaTime;
    }

    this.frameCount++;
    return true;
  }

  /**
   * Record one render-loop tick (fallback path).
   * No-op in rVFC mode and while playback is paused.
   */
  noteRenderTick(): boolean {
    if (this.disposed || this.mode !== 'render-tick') return false;
    if (!this.isPlaying()) return false;

    this.frameCount++;
    return true;
  }

  /** Immutable snapshot.  Safe to call repeatedly after dispose(). */
  snapshot(): VideoPlaybackSnapshot {
    if (this.disposed) {
      return this.frozen ?? this.buildSnapshot(true, 0, true);
    }

    this.advanceClock();
    return this.buildSnapshot(false, this.positionSeconds(), this.isPaused());
  }

  /** Freeze the snapshot and release the reference to the media element. */
  dispose(): void {
    if (this.disposed) return;

    this.advanceClock();
    this.playing  = false;
    this.frozen   = Object.freeze(
      this.buildSnapshot(true, this.positionSeconds(), true),
    );
    this.video    = null;
    this.disposed = true;
  }

  // -------------------------------------------------------------------------

  private isPaused(): boolean {
    // The element is the source of truth: play()/pause() both update the
    // `paused` attribute synchronously, so a toggle is reflected right away.
    return this.video ? this.video.paused : true;
  }

  private isPlaying(): boolean {
    return (
      !this.disposed &&
      this.playing &&
      this.video !== null &&
      !this.video.paused
    );
  }

  private advanceClock(): void {
    const t = this.now();
    if (this.playing && !this.disposed) {
      this.elapsedMs += Math.max(0, t - this.lastClockAt);
    }
    this.lastClockAt = t;
  }

  private positionSeconds(): number {
    if (!this.video) return 0;
    if (this.kind === 'webcam') return this.elapsedMs / 1000;
    const t = this.video.currentTime;
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  private durationSeconds(): number | null {
    if (!this.video) return null;
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  private buildSnapshot(
    disposed:     boolean,
    currentTime:  number,
    paused:       boolean,
  ): VideoPlaybackSnapshot {
    return {
      kind:       this.kind,
      currentTime,
      duration:   this.durationSeconds(),
      paused,
      frameCount: this.frameCount,
      disposed,
    };
  }
}

/** True when the element can report presented video frames. */
export function supportsVideoFrameCallback(
  video: object,
): boolean {
  return typeof (video as { requestVideoFrameCallback?: unknown })
    .requestVideoFrameCallback === 'function';
}

/** Minimal surface of the requestVideoFrameCallback API. */
export interface VideoFrameCallbackHost {
  requestVideoFrameCallback?(
    cb: (now: number, metadata: { mediaTime: number }) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}

const NOOP = (): void => {};

/**
 * Subscribe to presented video frames and feed each one to `progress`.
 *
 * Re-arms itself after every callback, which is how rVFC works: one request
 * yields exactly one presented frame.  Returns an unsubscribe function that
 * cancels the pending request.  Browsers deliver frames only while the
 * element is playing, so paused media naturally stops advancing the count.
 *
 * Returns a no-op when the host lacks rVFC support, leaving tick counting as
 * the only active path.
 */
export function trackPresentedVideoFrames(
  host:     VideoFrameCallbackHost,
  progress: VideoPlaybackProgress,
  isActive: () => boolean = () => true,
): () => void {
  if (progress.countingMode !== 'video-frame-callback') return NOOP;
  const request = host.requestVideoFrameCallback;
  if (typeof request !== 'function') return NOOP;

  let handle: number | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped || !isActive()) return;
    handle = request.call(host, (_now, metadata) => {
      handle = null;
      if (stopped || !isActive()) return;
      progress.noteVideoFrame(metadata?.mediaTime);
      schedule();
    });
  };

  schedule();

  return () => {
    stopped = true;
    if (handle !== null) {
      host.cancelVideoFrameCallback?.(handle);
      handle = null;
    }
  };
}

function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${safe.toFixed(1)}s`;
}

export interface PlaybackStateLabels {
  playing?:  string;
  paused?:   string;
  released?: string;
  /** Overrides the per-kind media label ("video" for files, "webcam"). */
  kind?:     Partial<Record<VideoSourceKind, string>>;
  /** Overrides the frame-count text. */
  frames?:   (count: number) => string;
}

const DEFAULT_KIND_LABELS: Record<VideoSourceKind, string> = {
  file:   'video',
  webcam: 'webcam',
};

function pluralizeFrames(count: number): string {
  return `${count} ${count === 1 ? 'frame' : 'frames'}`;
}

/**
 * Human-readable status line used by the UI overlay, e.g.
 *   "video 12.3s / 45.0s · 734 frames · paused"
 *   "webcam 12.3s · 351 frames · playing"   (no fabricated total duration)
 */
export function formatPlaybackSnapshot(
  snapshot: VideoPlaybackSnapshot,
  labels:   PlaybackStateLabels = {},
): string {
  const total = snapshot.duration !== null
    ? ` / ${formatSeconds(snapshot.duration)}`
    : '';
  const state = snapshot.disposed
    ? (labels.released ?? 'released')
    : snapshot.paused
      ? (labels.paused ?? 'paused')
      : (labels.playing ?? 'playing');
  const kindLabel = labels.kind?.[snapshot.kind] ?? DEFAULT_KIND_LABELS[snapshot.kind];
  const frames    = labels.frames?.(snapshot.frameCount)
    ?? pluralizeFrames(snapshot.frameCount);

  return [
    `${kindLabel} ${formatSeconds(snapshot.currentTime)}${total}`,
    frames,
    state,
  ].join(' · ');
}
