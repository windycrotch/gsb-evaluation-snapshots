export function formatVideoTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) return '0:00';

  const totalSeconds = Math.floor(time);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  return minutes + ':' + String(seconds).padStart(2, '0');
}

export type AudioAvailability = 'available' | 'unavailable' | 'unknown';

export function detectAudioAvailability(video: HTMLVideoElement): AudioAvailability {
  const audioTrackVideo = video as HTMLVideoElement & { audioTracks?: { length: number } };
  const webkitVideo = video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
  const isWebKit = typeof webkitVideo.webkitAudioDecodedByteCount === 'number';
  if (audioTrackVideo.audioTracks && typeof audioTrackVideo.audioTracks.length === 'number') {
    if (audioTrackVideo.audioTracks.length > 0) return 'available';
    // iOS Safari reports audioTracks.length === 0 at HAVE_METADATA even when
    // audio is present. On WebKit, fall through to webkitAudioDecodedByteCount
    // for a reliable answer after playback starts.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && !isWebKit) return 'unavailable';
  }

  const firefoxVideo = video as HTMLVideoElement & { mozHasAudio?: boolean };
  if (typeof firefoxVideo.mozHasAudio === 'boolean') {
    return firefoxVideo.mozHasAudio ? 'available' : 'unavailable';
  }

  const streamVideo = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  const captureStream = streamVideo.captureStream ?? streamVideo.mozCaptureStream;
  if (captureStream && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    try {
      if (captureStream.call(video).getAudioTracks().length > 0) return 'available';
    } catch {
      // Cross-origin media can block captureStream; keep probing with other browser hints.
    }
  }

  if (
    isWebKit &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.currentTime > 0.25
  ) {
    if (webkitVideo.webkitAudioDecodedByteCount! > 0) return 'available';
    // Safari skips audio decoding for muted playback, so 0 decoded bytes
    // does not prove absence of audio. Only trust it when unmuted.
    if (!video.muted) return 'unavailable';
  }

  return 'unknown';
}

export function isAudioAvailabilityPending(video: HTMLVideoElement): boolean {
  const webkitVideo = video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
  if (typeof webkitVideo.webkitAudioDecodedByteCount !== 'number') return false;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return true;
  return video.currentTime <= 0.25;
}

/**
 * Tracks load attempts for one source lifecycle and hands out epoch tokens.
 *
 * Every hydration attempt (initial load, retry, or fresh `src`) gets a new
 * epoch. Async first-frame callbacks, retry timers and `error` events capture
 * the epoch they were scheduled with and bail out when it no longer matches,
 * so an old source can never mutate the state of a newer one.
 */
export class MediaLoadSession {
  readonly #maxAttempts: number;
  #attempts = 0;
  #epoch = 0;
  #failed = false;

  constructor(maxAttempts = 3) {
    this.#maxAttempts = maxAttempts;
  }

  /**
   * Begin a brand new source lifecycle: attempts and failure state reset and
   * the epoch advances so callbacks scheduled against the old source die.
   * No attempt is counted here — the first hydration calls beginAttempt().
   */
  beginSource(): number {
    this.#attempts = 0;
    this.#failed = false;
    this.#epoch += 1;
    return this.#epoch;
  }

  /** Record one concrete hydration (initial load or a retry). */
  beginAttempt(): number {
    this.#attempts += 1;
    this.#epoch += 1;
    this.#failed = false;
    return this.#epoch;
  }

  /** A retry may still be scheduled within the attempt cap. */
  canRetry(): boolean {
    return this.#attempts < this.#maxAttempts && !this.#failed;
  }

  /** All retries are exhausted: the current source has failed terminally. */
  markFailed(): void {
    this.#failed = true;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get hasFailed(): boolean {
    return this.#failed;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch;
  }
}
