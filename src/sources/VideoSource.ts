import * as THREE from 'three';
import { BaseSource } from './BaseSource';
import {
  VideoPlaybackProgress,
  supportsVideoFrameCallback,
  trackPresentedVideoFrames,
  type VideoFrameCallbackHost,
  type VideoPlaybackSnapshot,
  type FrameCountingMode,
} from './videoPlayback';
import {
  validateMediaFile,
  ALLOWED_VIDEO_TYPES,
  MAX_VIDEO_BYTES,
} from '@utils/sanitize';

/**
 * Video source — MP4/WebM file playback or live webcam stream.
 *
 * Uses THREE.VideoTexture, which overrides the `needsUpdate` getter to
 * return true whenever video.readyState >= HAVE_CURRENT_DATA.  This means
 * the Three.js render loop automatically uploads new frames to the GPU
 * without any explicit tick() work.
 *
 * Playback progress:
 * - The source maintains a VideoPlaybackProgress accounting object exposed
 *   through `playbackSnapshot` (read-only, always safe to read).
 * - Presented media frames are counted via requestVideoFrameCallback when
 *   available; otherwise tick() counts render-loop ticks.  Exactly one of
 *   the two paths is active, so frames are never double counted.
 * - stop() pauses playback but retains elapsed time and frame count.
 * - dispose() freezes the snapshot with `disposed: true`; later reads never
 *   throw and never touch the detached media element.
 *
 * Security notes:
 * - File MIME type validated before blob URL creation.
 * - Blob URL revoked immediately after canplay fires.
 * - Video element is not appended to the DOM; it holds no reference to
 *   user credentials or cookie-bearing requests.
 * - crossOrigin = 'anonymous' prevents credential-bearing CORS requests
 *   if the src ever resolves cross-origin in the future.
 * - Webcam access requires a user gesture at the call site (enforced by
 *   the browser's autoplay policy).  This class never auto-requests the
 *   camera; fromWebcam() must be called in response to a UI event.
 * - getUserMedia is gated on secure context (HTTPS / localhost); an
 *   explicit check surfaces a clear error message instead of a silent
 *   browser rejection.
 * - All MediaStream tracks are stopped on dispose() so the OS camera
 *   indicator light turns off promptly.
 */
export class VideoSource extends BaseSource {
  private readonly video:  HTMLVideoElement;
  private readonly stream: MediaStream | null;
  private readonly progress: VideoPlaybackProgress;
  private readonly countingMode: FrameCountingMode;

  private stopFrameTracking: (() => void) | null = null;
  private disposed: boolean = false;

  private readonly handlePlay  = (): void => this.progress.markPlaying();
  private readonly handlePause = (): void => this.progress.markPaused();

  private constructor(
    video: HTMLVideoElement,
    texture: THREE.VideoTexture,
    stream: MediaStream | null = null,
    kind: 'file' | 'webcam' = 'file',
  ) {
    super(texture);
    this.video  = video;
    this.stream = stream;

    this.countingMode = supportsVideoFrameCallback(video)
      ? 'video-frame-callback'
      : 'render-tick';

    this.progress = new VideoPlaybackProgress(kind, video, this.countingMode);

    // Keep the accounting in sync even if playback is paused/started outside
    // of this class (e.g. by the browser or another control).
    video.addEventListener('play',  this.handlePlay);
    video.addEventListener('pause', this.handlePause);

    if (this.countingMode === 'video-frame-callback') {
      this.stopFrameTracking = trackPresentedVideoFrames(
        video as unknown as VideoFrameCallbackHost,
        this.progress,
        () => !this.disposed,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Factory methods
  // -------------------------------------------------------------------------

  static async fromFile(file: File): Promise<VideoSource> {
    const check = validateMediaFile(file, ALLOWED_VIDEO_TYPES, MAX_VIDEO_BYTES);
    if (!check.ok) throw new Error(check.error);

    const video  = VideoSource.makeVideoElement();
    const blobUrl = URL.createObjectURL(file);

    await new Promise<void>((resolve, reject) => {
      video.oncanplay = () => {
        URL.revokeObjectURL(blobUrl); // revoke once the browser has buffered enough
        resolve();
      };
      video.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Video failed to load. The file may be corrupt or use an unsupported codec.'));
      };
      video.src = blobUrl;
      video.load();
    });

    const texture       = VideoSource.makeTexture(video);
    return new VideoSource(video, texture, null, 'file');
  }

  static async fromWebcam(): Promise<VideoSource> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Camera access requires a secure context (HTTPS or localhost). ' +
        'Reload the page over HTTPS to enable this feature.',
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width:      { ideal: 1280 },
          height:     { ideal: 720 },
          facingMode: 'user',
        },
        audio: false,
      });
    } catch (err) {
      const msg = err instanceof DOMException ? err.message : 'Camera permission denied.';
      throw new Error(msg);
    }

    const video = VideoSource.makeVideoElement();
    video.srcObject = stream;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    const texture = VideoSource.makeTexture(video);
    return new VideoSource(video, texture, stream, 'webcam');
  }

  // -------------------------------------------------------------------------
  // BaseSource API
  // -------------------------------------------------------------------------

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();

    // Mark optimistic play state before play() settles: the 'play' event that
    // normally drives the accounting is dispatched asynchronously, and frames
    // presented in that gap must still be counted.
    this.progress.markPlaying();

    // play() returns a Promise; catch autoplay-policy rejections gracefully
    return this.video.play().catch(() => {
      this.progress.markPaused();
      console.warn(
        '[VideoSource] Autoplay was blocked. The user must interact with the page first.',
      );
    });
  }

  stop(): void {
    if (this.disposed) return;
    this.video.pause();
    // Pause retains both elapsed time and the accumulated frame count.
    this.progress.markPaused();
  }

  tick(): void {
    if (this.disposed) return;
    // In fallback mode this counts render-loop ticks; in rVFC mode it is a
    // no-op so the two counting paths never double-count.
    this.progress.noteRenderTick();
  }

  dispose(): void {
    if (this.disposed) return;

    // Pause while still live so the media element stops before detaching.
    this.video.pause();
    this.progress.markPaused();
    this.disposed = true;

    this.video.removeEventListener('play',  this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);

    if (this.stopFrameTracking) {
      this.stopFrameTracking();
      this.stopFrameTracking = null;
    }

    // Freeze the progress snapshot before the media element is detached so
    // subsequent reads are safe and report the final playback state.
    this.progress.dispose();

    this._texture.dispose();
    // Release webcam: stops the OS camera indicator immediately
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.video.src       = '';
    this.video.load();     // abort any pending network request
  }

  // -------------------------------------------------------------------------
  // Playback observability
  // -------------------------------------------------------------------------

  /** Read-only playback snapshot.  Never throws, even after dispose(). */
  get playbackSnapshot(): VideoPlaybackSnapshot {
    return this.progress.snapshot();
  }

  /** Which mechanism is used to count presented frames. */
  get frameCountingMode(): FrameCountingMode {
    return this.countingMode;
  }

  // -------------------------------------------------------------------------

  private static makeVideoElement(): HTMLVideoElement {
    const v         = document.createElement('video');
    v.muted         = true;      // required for autoplay policy
    v.loop          = true;
    v.playsInline   = true;      // prevents full-screen on mobile Safari
    v.crossOrigin   = 'anonymous';
    return v;
  }

  private static makeTexture(video: HTMLVideoElement): THREE.VideoTexture {
    const tex       = new THREE.VideoTexture(video);
    tex.minFilter   = THREE.LinearFilter;
    tex.magFilter   = THREE.LinearFilter;
    tex.colorSpace  = THREE.SRGBColorSpace;
    return tex;
  }
}
