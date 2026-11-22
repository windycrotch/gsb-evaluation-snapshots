import { HTMLVideoElementWithControlsList } from './types';

/**
 * Callbacks used by the SegmentManager to notify the player about
 * the outcome of a branch segment session.
 */
export type SegmentManagerCallbacks = {
  /** A branch segment failed to load or its playback was rejected. The main video has already been restored. */
  onSegmentError?: (segmentUrl: string, error: unknown) => void;
  /** A branch segment finished playing and the main video is being restored. */
  onSegmentEnd?: (segmentUrl: string) => void;
};

/**
 * Manages the logic for switching to and from video segments.
 *
 * A segment session is fully tracked: entering a branch saves the main video
 * source and position, and every exit path (segment ended, load failure,
 * playback rejection, destroy) restores that exact state at most once.
 * Temporary `loadedmetadata` listeners are tracked so they never leak into a
 * subsequent segment session or survive `destroy()`.
 */
export class SegmentManager {
  private videoElement: HTMLVideoElementWithControlsList;
  private callbacks: SegmentManagerCallbacks;

  private _mainVideoSrc: string | null = null;
  private _mainVideoCurrentTime: number = 0;
  private _activeSegmentUrl: string | null = null;
  private destroyed = false;

  /** Pending one-shot listeners, tracked so they can be removed deterministically. */
  private segmentLoadHandler: (() => void) | null = null;
  private resumeHandler: (() => void) | null = null;

  constructor(
    videoElement: HTMLVideoElementWithControlsList,
    callbacks: SegmentManagerCallbacks = {},
  ) {
    this.videoElement = videoElement;
    this.callbacks = callbacks;
    this.handleEnded = this.handleEnded.bind(this);
    this.handleError = this.handleError.bind(this);
    this.bindEvents();
  }

  private bindEvents(): void {
    this.videoElement.addEventListener('ended', this.handleEnded);
    this.videoElement.addEventListener('error', this.handleError);
  }

  /** The main video (or the current segment) reached its end. */
  private handleEnded(): void {
    if (this.destroyed) return;
    if (!this._activeSegmentUrl || !this._mainVideoSrc) return;

    const segmentUrl = this._activeSegmentUrl;
    this.restoreMainVideo();
    this.callbacks.onSegmentEnd?.(segmentUrl);
  }

  /** The video element reported a load/playback error. */
  private handleError(): void {
    if (this.destroyed) return;
    // Only errors while a branch segment is active belong to this session.
    if (!this._activeSegmentUrl) return;

    this.failSegment(new Error(`Failed to load segment video: ${this._activeSegmentUrl}`));
  }

  /**
   * Handles the transition to a new video segment.
   * Saves the current main video state and plays the new segment.
   * Ignored while another segment session is still active or after destroy.
   * @param newSegmentUrl The URL of the new video segment to play.
   */
  public playSegment(newSegmentUrl: string): void {
    if (this.destroyed) return;
    if (this._activeSegmentUrl) return; // a branch session is already in flight

    // Drop any listener left over from a previous branch session.
    this.clearSegmentLoadHandler();
    this.clearResumeHandler();

    this._mainVideoSrc = this.videoElement.src;
    this._mainVideoCurrentTime = this.videoElement.currentTime;
    this._activeSegmentUrl = newSegmentUrl;

    this.videoElement.src = newSegmentUrl;
    this.videoElement.load();

    const onLoaded = () => {
      this.clearSegmentLoadHandler();
      if (this.destroyed) return;
      this.videoElement.play().catch((error) => {
        this.failSegment(error);
      });
    };
    this.segmentLoadHandler = onLoaded;
    this.videoElement.addEventListener('loadedmetadata', onLoaded, { once: true });
  }

  /**
   * Converges a failed segment session back to the main video:
   * restores the original source and position, resumes playback,
   * then notifies the player so it can converge state and report.
   */
  private failSegment(error: unknown): void {
    if (this.destroyed) return;
    const segmentUrl = this._activeSegmentUrl;
    if (!segmentUrl) return;

    this.restoreMainVideo();
    this.callbacks.onSegmentError?.(segmentUrl, error);
  }

  /**
   * Restores the main video source and the exact playback position saved
   * when the branch was entered. Any previous resume listener is removed
   * first, so no stale restore can fire afterwards.
   */
  private restoreMainVideo(): void {
    const resumeSrc = this._mainVideoSrc;
    const resumeTime = this._mainVideoCurrentTime;

    this._mainVideoSrc = null;
    this._mainVideoCurrentTime = 0;
    this._activeSegmentUrl = null;

    this.clearSegmentLoadHandler();
    this.clearResumeHandler();

    if (!resumeSrc) return;

    this.videoElement.src = resumeSrc;
    this.videoElement.load();

    const onLoaded = () => {
      this.clearResumeHandler();
      if (this.destroyed) return;
      this.videoElement.currentTime = resumeTime;
      this.videoElement.play().catch((err) => {
        console.error('Error resuming main video:', err);
      });
    };
    this.resumeHandler = onLoaded;
    this.videoElement.addEventListener('loadedmetadata', onLoaded, { once: true });
  }

  private clearSegmentLoadHandler(): void {
    if (this.segmentLoadHandler) {
      this.videoElement.removeEventListener('loadedmetadata', this.segmentLoadHandler);
      this.segmentLoadHandler = null;
    }
  }

  private clearResumeHandler(): void {
    if (this.resumeHandler) {
      this.videoElement.removeEventListener('loadedmetadata', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  /**
   * Destroys the SegmentManager instance.
   * Removes every listener it registered and neutralizes late callbacks:
   * after destroy, no pending load, ended, error, or play-rejection handler
   * may touch the video element anymore.
   */
  public destroy(): void {
    this.destroyed = true;
    this.videoElement.removeEventListener('ended', this.handleEnded);
    this.videoElement.removeEventListener('error', this.handleError);
    this.clearSegmentLoadHandler();
    this.clearResumeHandler();
    this._mainVideoSrc = null;
    this._mainVideoCurrentTime = 0;
    this._activeSegmentUrl = null;
  }
}
