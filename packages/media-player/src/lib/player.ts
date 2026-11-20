import {
  CDGPlayer,
  HEIGHT,
  WIDTH,
  type CdgInstructionLike,
  type CdgRenderContext,
} from '@cxing/media-parser-cdg';
import { createScopedLogger } from '@cxing/logger';
import {
  createLoader,
  type CdgLoader,
  LoaderError,
  type LoadedTrack,
  type LoadedTrackMediaKind,
  type LoaderInput,
  type LoaderOptions,
  loadInWorker,
} from '@cxing/media-loader';
import { createRenderer, type CdgRenderer } from './renderer.js';
import {
  createAudioEngine,
  type CdgAudioEngine,
  type PlayerAudioEngineMode,
} from './audio-engine.js';
import {
  MAX_PITCH_SEMITONES,
  MAX_SEEK_PERCENT,
  MAX_TEMPO,
  MAX_VOLUME,
  MIN_PITCH_SEMITONES,
  MIN_SEEK_PERCENT,
  MIN_TEMPO,
  MIN_VOLUME,
} from './utils/player.constants.js';
import {
  asMilliseconds,
  canElementPlayMimeType,
  clamp,
  createInitialState,
} from './utils/player.functions.js';

/** Playback lifecycle states for high-level player consumers. */
export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

/** Snapshot of externally observable player state. */
export interface PlayerState {
  status: PlayerStatus;
  trackId: string | null;
  currentTimeMs: number;
  durationMs: number;
  volume: number;
  playbackRate: number;
  pitchSemitones: number;
}

/** Input options for load requests. */
export interface PlayerLoadOptions {
  input: LoaderInput;
  loaderOptions?: LoaderOptions;
  autoplay?: boolean;
}

/** Construction options for CdgPlayer runtime wrapper. */
export interface CdgPlayerOptions {
  canvas: HTMLCanvasElement;
  audio: HTMLAudioElement;
  video?: HTMLVideoElement;
  loader?: CdgLoader;
  debug?: boolean;
  renderMode?: 'auto' | 'main-thread' | 'worker';
  loadTransport?: 'auto' | 'main-thread' | 'worker';
  audioEngineMode?: PlayerAudioEngineMode;
}

/** Event detail payload for `statechange` events. */
export interface PlayerStateChangeDetail {
  previous: PlayerState;
  next: PlayerState;
}

type CdgCorePlayerAsyncLoad = CDGPlayer & {
  loadAsync?: (args: { data: Uint8Array }) => Promise<CDGPlayer>;
};

/**
 * Per-load bookkeeping so a superseded or failed session can release only the
 * resources it created without disturbing a newer session.
 */
interface LoadSession {
  readonly id: number;
  /** Aborts pending worker/loader/media waits owned by this session. */
  readonly controller: AbortController;
  /** Identity token for the media listener binding this session installed. */
  readonly bindingToken: object;
  /** Object URL created by this session while it was the newest session. */
  objectUrl: string | null;
  /** Media element this session bound player listeners to, if any. */
  boundMedia: HTMLMediaElement | null;
  /** True when this session performed the listener bind (vs. reused one). */
  ownsBinding: boolean;
  /** Identity token for the CDG data committed by this session. */
  cdgToken: object | null;
  /** Whether this session wrote parsed CDG instructions. */
  cdgLoaded: boolean;
  /** Whether this session reached the committed `ready` state. */
  committed: boolean;
}

/**
 * Internal control-flow signal: a session completed some work after it had
 * already been superseded, so its result must be discarded with no effects.
 */
class SessionSupersededError extends Error {
  constructor() {
    super('Load session was superseded by a newer load.');
    this.name = 'SessionSupersededError';
  }
}

/**
 * High-level karaoke player that orchestrates loading and audio playback.
 * CDG rendering/synchronization are enabled only when the loaded track includes
 * a graphics stream.
 */
export class CdgPlayer extends EventTarget {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio: HTMLAudioElement;
  private readonly video: HTMLVideoElement | null;
  private readonly loader: CdgLoader;
  private readonly ownsLoader: boolean;
  private readonly logger: ReturnType<typeof createScopedLogger>;
  private readonly debug: boolean;
  private readonly loadTransport: 'auto' | 'main-thread' | 'worker';
  private readonly cdgPlayer: CDGPlayer;
  private readonly renderer: CdgRenderer;
  private readonly audioEngineMode: PlayerAudioEngineMode;
  private readonly audioEnginesByMedia = new Map<
    HTMLMediaElement,
    CdgAudioEngine
  >();

  private audioEngine: CdgAudioEngine;
  private activeMedia: HTMLMediaElement;
  private activeMediaKind: LoadedTrackMediaKind = 'audio';

  private state: PlayerState = createInitialState();
  private currentObjectUrl: string | null = null;
  private hasGraphicsTrack = false;

  /** Monotonic session counter; only the newest session may commit. */
  private loadSessionId = 0;
  private activeSession: LoadSession | null = null;
  private disposed = false;
  /** Media element that currently has player media listeners bound. */
  private boundMedia: HTMLMediaElement | null = null;
  /** Identity token of the session that installed the current binding. */
  private mediaBindingToken: object | null = null;
  /** Identity token of the session that committed the current CDG data. */
  private committedCdgToken: object | null = null;
  /** URLs already revoked, so repeated cleanup cannot double-revoke. */
  private readonly revokedObjectUrls = new Set<string>();

  /**
   * Creates a player bound to canvas/audio elements and optional strategy overrides.
   */
  constructor({
    canvas,
    audio,
    video,
    loader,
    debug = false,
    renderMode = 'auto',
    loadTransport = 'auto',
    audioEngineMode = 'auto',
  }: CdgPlayerOptions) {
    super();
    this.canvas = canvas;
    this.audio = audio;
    this.video = video ?? null;
    this.debug = debug;
    this.logger = createScopedLogger({ scope: 'cdg-player', debug });
    this.loader = loader ?? createLoader({ debug });
    this.ownsLoader = !loader;
    this.loadTransport = loadTransport;
    this.audioEngineMode = audioEngineMode;
    this.activeMedia = this.audio;

    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;

    const resolvedContext = this.canvas.getContext('2d');
    if (!resolvedContext) {
      throw new Error('Unable to create 2D context for karaoke player canvas.');
    }

    this.ctx = resolvedContext;
    this.ctx.imageSmoothingEnabled = false;

    this.renderer = createRenderer({
      mode: renderMode,
      canvas: this.canvas,
      ctx: this.ctx,
    });

    this.audioEngine = createAudioEngine({
      media: this.activeMedia,
      mode: audioEngineMode,
      debug,
    });
    this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);

    this.cdgPlayer = new CDGPlayer({
      afterRender: (renderContext: CdgRenderContext) => {
        this.renderer.render({ renderContext });
      },
    });

    this.audio.preload = 'auto';
    if (this.video) {
      this.video.preload = 'auto';
      this.video.controls = false;
      this.video.playsInline = true;
    }

    this.boundMedia = this.activeMedia;
    this.bindMediaListeners({ media: this.activeMedia });
  }

  /**
   * Returns immutable player state snapshot.
   */
  getState(): Readonly<PlayerState> {
    return this.state;
  }

  /**
   * Loads track assets and prepares playback for either karaoke (audio+graphics)
   * or audio-only content.
   *
   * Each invocation owns a monotonically increasing session id. Only the newest
   * session may commit state, bind a media source, or render CDG frames; early
   * in-flight sessions discard their results when they settle.
   */
  async load({
    input,
    loaderOptions,
    autoplay = false,
  }: PlayerLoadOptions): Promise<LoadedTrack> {
    if (this.disposed) {
      throw new Error('CdgPlayer cannot load after dispose().');
    }

    const session = this.beginLoadSession();
    this.applyState({ status: 'loading' });
    this.logger.debug({
      message: 'load:start',
      sessionId: session.id,
      inputKind: input.kind,
      loadTransport: this.loadTransport,
      autoplay,
    });

    try {
      const useWorkerLoader = this.shouldUseWorkerLoader();
      this.logger.debug({
        message: 'load:transport-selected',
        useWorkerLoader,
        loadTransport: this.loadTransport,
      });
      let loadedTrack: LoadedTrack;
      const effectiveLoaderOptions: LoaderOptions = {
        ...(loaderOptions ?? {}),
        debug: loaderOptions?.debug ?? this.debug,
      };

      if (useWorkerLoader) {
        try {
          loadedTrack = await loadInWorker({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:worker-success',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        } catch (errorValue: unknown) {
          this.logger.debug({ message: 'load:worker-error', errorValue });
          // Never spend a fallback attempt on a session that was replaced.
          if (
            !this.isActiveSession(session) ||
            !this.shouldFallbackToMainThreadLoad({ errorValue })
          ) {
            throw errorValue;
          }

          this.logger.debug({ message: 'load:fallback-main-thread' });

          loadedTrack = await this.loader.load({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:main-thread-success-after-fallback',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        }
      } else {
        loadedTrack = await this.loader.load({
          input,
          options: effectiveLoaderOptions,
        });
        this.logger.debug({
          message: 'load:main-thread-success',
          trackId: loadedTrack.trackId,
          sourceSummary: loadedTrack.sourceSummary,
        });
      }

      // The loader finished; refuse to touch player state if a newer session
      // (or dispose) replaced this one while the load was in flight.
      this.assertActiveSession(session);

      await this.attachLoadedTrack({ loadedTrack, session });

      this.assertActiveSession(session);

      this.applyState({
        status: 'ready',
        trackId: loadedTrack.trackId,
      });
      session.committed = true;

      if (autoplay) {
        await this.play();
      }

      this.logger.debug({
        message: 'load:ready',
        trackId: loadedTrack.trackId,
      });

      return loadedTrack;
    } catch (errorValue: unknown) {
      if (errorValue instanceof SessionSupersededError) {
        // The load lost the session race (a newer load or dispose replaced it):
        // release whatever this session created and report the discard to the
        // caller without touching player state or emitting `error`.
        this.cleanupSession({ session });
        this.logger.debug({
          message: 'load:superseded-discard',
          sessionId: session.id,
        });
        throw errorValue;
      }

      this.handleLoadFailure({ errorValue, session });
      throw errorValue;
    }
  }

  /**
   * Starts media playback and, when graphics exist, advances CDG frame playback.
   */
  async play(): Promise<void> {
    this.logger.debug({
      message: 'play:called',
      currentTime: this.activeMedia.currentTime,
      paused: this.activeMedia.paused,
      readyState: this.activeMedia.readyState,
      src: this.activeMedia.src,
      media: this.activeMedia,
    });
    try {
      await this.audioEngine.play();
      this.logger.debug({
        message: 'play:resolved',
        currentTime: this.activeMedia.currentTime,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        src: this.activeMedia.src,
        media: this.activeMedia,
      });
    } catch (err) {
      this.logger.debug({ message: 'play:error', errorValue: err });
    }
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  }

  /**
   * Pauses media playback and, when graphics exist, pauses CDG frame playback.
   */
  pause(): void {
    this.audioEngine.pause();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }

    if (this.state.status !== 'error') {
      this.applyState({ status: 'paused' });
    }
  }

  /**
   * Stops playback and rewinds to beginning.
   */
  stop(): void {
    this.pause();
    this.audioEngine.stop();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.reset().render();
    }
    this.applyState({
      status: this.state.trackId ? 'ready' : 'idle',
      currentTimeMs: 0,
    });
  }

  /**
   * Seeks by percentage of track duration and re-syncs CDG timing when graphics
   * are present.
   */
  seek({ percentage }: { percentage: number }): void {
    if (
      !Number.isFinite(this.activeMedia.duration) ||
      this.activeMedia.duration <= 0
    ) {
      return;
    }

    const clampedPercentage = clamp({
      value: percentage,
      min: MIN_SEEK_PERCENT,
      max: MAX_SEEK_PERCENT,
    });
    const targetSeconds = (clampedPercentage / 100) * this.activeMedia.duration;
    this.activeMedia.currentTime = targetSeconds;
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: asMilliseconds({ seconds: targetSeconds }) });
    }
    this.applyState({
      currentTimeMs: asMilliseconds({ seconds: targetSeconds }),
    });
  }

  /**
   * Sets playback output volume.
   */
  setVolume({ value }: { value: number }): void {
    const nextVolume = clamp({
      value,
      min: MIN_VOLUME,
      max: MAX_VOLUME,
    });
    this.audioEngine.setVolume({ value: nextVolume });
    this.applyState({ volume: nextVolume });
  }

  /**
   * Backward-compatible alias for tempo adjustment.
   */
  setPlaybackRate({ value }: { value: number }): void {
    this.setTempo({ value });
  }

  /**
   * Sets tempo multiplier.
   */
  setTempo({ value }: { value: number }): void {
    const nextTempo = clamp({
      value,
      min: MIN_TEMPO,
      max: MAX_TEMPO,
    });
    this.audioEngine.setTempo({ value: nextTempo });
    this.applyState({ playbackRate: nextTempo });
  }

  /**
   * Sets key shift in semitones.
   */
  setPitchSemitones({ value }: { value: number }): void {
    const nextPitchSemitones = Math.round(
      clamp({
        value,
        min: MIN_PITCH_SEMITONES,
        max: MAX_PITCH_SEMITONES,
      }),
    );
    this.audioEngine.setPitchSemitones({ value: nextPitchSemitones });
    this.applyState({ pitchSemitones: nextPitchSemitones });
  }

  /**
   * Releases player resources and event listeners.
   *
   * Any in-flight load is invalidated first: a late session can never commit
   * state, bind a source, or create another object URL after dispose.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.logger.debug({ message: 'dispose:start' });
    this.disposed = true;

    const activeSession = this.activeSession;
    this.activeSession = null;
    if (activeSession) {
      this.cleanupSession({ session: activeSession });
    }

    this.stop();
    this.unbindMediaListeners({ media: this.activeMedia });
    this.boundMedia = null;
    this.releaseObjectUrl();

    if (this.ownsLoader) {
      this.logger.debug({ message: 'dispose:loader' });
      this.loader.dispose();
    }

    this.logger.debug({ message: 'dispose:renderer' });
    this.renderer.dispose();
    this.logger.debug({ message: 'dispose:audioEngine' });
    for (const engine of new Set(this.audioEnginesByMedia.values())) {
      engine.dispose();
    }
    this.audioEnginesByMedia.clear();
    this.logger.debug({ message: 'dispose:done' });
  }

  /**
   * Starts a new load session, superseding any still-in-flight session.
   */
  private beginLoadSession(): LoadSession {
    this.supersedeActiveSession();

    this.loadSessionId += 1;
    const session: LoadSession = {
      id: this.loadSessionId,
      controller: new AbortController(),
      bindingToken: {},
      objectUrl: null,
      boundMedia: null,
      ownsBinding: false,
      cdgToken: null,
      cdgLoaded: false,
      committed: false,
    };
    this.activeSession = session;
    return session;
  }

  /**
   * Invalidates a still-in-flight session and releases what it created. A
   * committed session keeps its resources until the new session commits.
   */
  private supersedeActiveSession(): void {
    const previousSession = this.activeSession;
    if (!previousSession) {
      return;
    }

    if (previousSession.committed) {
      this.logger.debug({
        message: 'load:supersede-committed',
        sessionId: previousSession.id,
      });
      return;
    }

    this.logger.debug({
      message: 'load:superseded',
      sessionId: previousSession.id,
    });
    this.cleanupSession({ session: previousSession });
  }

  /**
   * Returns true only while the session is the newest and the player is alive.
   */
  private isActiveSession(session: LoadSession): boolean {
    return !this.disposed && this.activeSession?.id === session.id;
  }

  /**
   * Throws when the session lost ownership, so callers stop committing work.
   */
  private assertActiveSession(session: LoadSession): void {
    if (!this.isActiveSession(session)) {
      throw new SessionSupersededError();
    }
  }

  /**
   * Releases only the resources a specific session created. Safe to call more
   * than once and never touches resources owned by a newer session.
   */
  private cleanupSession({ session }: { session: LoadSession }): void {
    session.controller.abort();

    if (session.objectUrl) {
      const createdUrl = session.objectUrl;
      session.objectUrl = null;
      if (this.currentObjectUrl === createdUrl) {
        this.currentObjectUrl = null;
      }
      this.revokeObjectUrl({ url: createdUrl });
    }

    if (
      session.ownsBinding &&
      session.boundMedia &&
      session.bindingToken === this.mediaBindingToken
    ) {
      if (this.boundMedia === session.boundMedia) {
        this.unbindMediaListeners({ media: session.boundMedia });
        this.boundMedia = null;
      }
      this.mediaBindingToken = null;
    }
    session.boundMedia = null;

    if (session.cdgLoaded && session.cdgToken === this.committedCdgToken) {
      // Discard instructions written by this session; a newer session installs
      // its own before rendering.
      this.cdgPlayer.instructions = [];
      this.committedCdgToken = null;
      this.hasGraphicsTrack = false;
    }
    session.cdgLoaded = false;
    session.cdgToken = null;
  }

  /**
   * Converges load failures: only the newest session may enter the error state.
   */
  private handleLoadFailure({
    errorValue,
    session,
  }: {
    errorValue: unknown;
    session: LoadSession;
  }): void {
    const superseded =
      errorValue instanceof SessionSupersededError ||
      !this.isActiveSession(session);

    // Always release resources this session created, even when superseded.
    this.cleanupSession({ session });

    if (superseded) {
      this.logger.debug({
        message: 'load:superseded-error',
        sessionId: session.id,
        errorValue,
      });
      return;
    }

    this.logger.error({ message: 'load:error', errorValue });
    this.applyState({ status: 'error' });
    this.dispatchEvent(new CustomEvent('error', { detail: { errorValue } }));
  }

  private async attachLoadedTrack({
    loadedTrack,
    session,
  }: {
    loadedTrack: LoadedTrack;
    session: LoadSession;
  }): Promise<void> {
    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';
    const resolvedMediaMimeType =
      loadedTrack.mediaMimeType ?? loadedTrack.audioMimeType;

    // Resolve the destination media element before mutating shared state.
    const nextMedia = this.resolveMediaElementForTrack({ loadedTrack });
    this.assertActiveSession(session);

    this.logger.debug({
      message: 'attach:start',
      sessionId: session.id,
      trackId: loadedTrack.trackId,
      mediaKind: resolvedMediaKind,
      mediaMimeType: resolvedMediaMimeType,
      hasGraphics: loadedTrack.hasGraphics,
      cdgBytes: loadedTrack.cdgBytes?.byteLength ?? 0,
      audioBytes: loadedTrack.audioBuffer.byteLength,
    });

    // Video preflight happens before any resource is created.
    if (
      resolvedMediaKind === 'video' &&
      !canElementPlayMimeType({
        media: nextMedia,
        mimeType: resolvedMediaMimeType,
      })
    ) {
      throw new Error(
        `This browser cannot play ${resolvedMediaKind} format ${resolvedMediaMimeType}.`,
      );
    }

    const nextHasGraphics =
      loadedTrack.hasGraphics && loadedTrack.cdgBytes !== null;
    if (nextHasGraphics && loadedTrack.cdgBytes) {
      await this.loadCdgInstructions({ data: loadedTrack.cdgBytes, session });
    }
    this.assertActiveSession(session);

    // Bind listeners when this session is adopting a different media element.
    if (this.boundMedia !== nextMedia) {
      if (this.boundMedia) {
        this.unbindMediaListeners({ media: this.boundMedia });
      }
      this.boundMedia = nextMedia;
      this.mediaBindingToken = session.bindingToken;
      session.boundMedia = nextMedia;
      session.ownsBinding = true;

      this.logger.debug({
        message: 'bindMediaListeners',
        media: nextMedia,
      });
      this.bindMediaListeners({ media: nextMedia });
    }

    if (this.activeMedia !== nextMedia) {
      this.activeMedia = nextMedia;

      const cachedEngine = this.audioEnginesByMedia.get(nextMedia);
      if (cachedEngine) {
        this.audioEngine = cachedEngine;
        this.logger.debug({
          message: 'audioEngine:reused',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      } else {
        this.logger.debug({
          message: 'audioEngine:create',
          media: this.activeMedia,
        });
        this.audioEngine = createAudioEngine({
          media: this.activeMedia,
          mode: this.audioEngineMode,
          debug: this.debug,
        });
        this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);
        this.logger.debug({
          message: 'audioEngine:created',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      }

      this.logger.debug({
        message: 'attachLoadedTrack:active-media-switched',
        src: this.activeMedia.src,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        media: this.activeMedia,
      });
    }

    this.activeMediaKind = resolvedMediaKind;
    this.releaseObjectUrl();
    this.hasGraphicsTrack = nextHasGraphics;
    this.cdgPlayer.reset();

    const mediaBlob = new Blob([loadedTrack.audioBuffer], {
      type: resolvedMediaMimeType,
    });

    // Only the newest session may allocate a new object URL.
    this.assertActiveSession(session);
    const objectUrl = URL.createObjectURL(mediaBlob);
    session.objectUrl = objectUrl;
    this.currentObjectUrl = objectUrl;

    this.activeMedia.src = objectUrl;
    this.activeMedia.load();

    if (resolvedMediaKind === 'video') {
      await this.waitForMediaCanPlay({
        media: this.activeMedia,
        mediaKind: resolvedMediaKind,
        session,
      });
      this.assertActiveSession(session);
    }

    if (this.activeMedia === this.audio && this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }

    if (this.activeMedia === this.video) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }

    // Render only after confirming the session still owns the canvas.
    this.assertActiveSession(session);
    this.cdgPlayer.render();

    this.logger.debug({
      message: 'attach:media-bound',
      mediaKind: this.activeMediaKind,
      objectUrl: this.currentObjectUrl,
    });
  }

  /**
   * Parses CDG instructions for a session and commits them only if it is still
   * the newest session, so a superseded session can never overwrite the CDG
   * data owned by a newer session.
   */
  private async loadCdgInstructions({
    data,
    session,
  }: {
    data: Uint8Array;
    session: LoadSession;
  }): Promise<void> {
    const corePlayer = this.cdgPlayer as CdgCorePlayerAsyncLoad;

    if (typeof corePlayer.loadAsync === 'function') {
      // Parse into a throwaway core player so shared CDG state is untouched
      // until the session is confirmed active.
      this.logger.debug({ message: 'attach:core-loadAsync' });
      const scratch = new CDGPlayer();
      await scratch.loadAsync({ data });
      this.assertActiveSession(session);
      this.commitCdgInstructions({
        instructions: scratch.instructions,
        session,
      });
      return;
    }

    this.logger.debug({ message: 'attach:core-load-sync' });
    const parsedInstructions = this.parseCdgInstructions({ data });
    this.assertActiveSession(session);
    this.commitCdgInstructions({ instructions: parsedInstructions, session });
  }

  private parseCdgInstructions({
    data,
  }: {
    data: Uint8Array;
  }): CdgInstructionLike[] {
    const previousInstructions = this.cdgPlayer.instructions;
    try {
      this.cdgPlayer.load({ data });
      return this.cdgPlayer.instructions;
    } finally {
      this.cdgPlayer.instructions = previousInstructions;
    }
  }

  private commitCdgInstructions({
    instructions,
    session,
  }: {
    instructions: CdgInstructionLike[];
    session: LoadSession;
  }): void {
    this.cdgPlayer.instructions = instructions;
    session.cdgLoaded = true;
    session.cdgToken = {};
    this.committedCdgToken = session.cdgToken;
  }

  private revokeObjectUrl({ url }: { url: string }): void {
    if (this.revokedObjectUrls.has(url)) {
      return;
    }

    this.revokedObjectUrls.add(url);
    URL.revokeObjectURL(url);
  }

  private releaseObjectUrl(): void {
    if (!this.currentObjectUrl) {
      return;
    }

    const releasedUrl = this.currentObjectUrl;
    this.currentObjectUrl = null;
    this.revokeObjectUrl({ url: releasedUrl });
  }

  private resolveMediaElementForTrack({
    loadedTrack,
  }: {
    loadedTrack: LoadedTrack;
  }): HTMLMediaElement {
    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';

    if (resolvedMediaKind === 'video') {
      if (!this.video) {
        throw new Error(
          'Loaded video media but no video element was provided to the player.',
        );
      }

      return this.video;
    }

    return this.audio;
  }

  private async waitForMediaCanPlay({
    media,
    mediaKind,
    session,
  }: {
    media: HTMLMediaElement;
    mediaKind: LoadedTrackMediaKind;
    session: LoadSession;
  }): Promise<void> {
    if (mediaKind === 'video' && media instanceof HTMLVideoElement) {
      await this.waitForVideoMetadata({ video: media, session });
      if (media.videoWidth <= 0 || media.videoHeight <= 0) {
        throw new Error('Video track could not be decoded by this browser.');
      }
    }

    if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onCanPlay = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(new Error(`Unable to load ${mediaKind} media in this browser.`));
      };

      const onAbort = (): void => {
        cleanup();
        reject(new SessionSupersededError());
      };

      const cleanup = (): void => {
        media.removeEventListener('canplay', onCanPlay);
        media.removeEventListener('error', onError);
        session.controller.signal.removeEventListener('abort', onAbort);
      };

      if (session.controller.signal.aborted) {
        reject(new SessionSupersededError());
        return;
      }

      media.addEventListener('canplay', onCanPlay, { once: true });
      media.addEventListener('error', onError, { once: true });
      session.controller.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    });
  }

  private async waitForVideoMetadata({
    video,
    session,
  }: {
    video: HTMLVideoElement;
    session: LoadSession;
  }): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(new Error('Unable to read video metadata in this browser.'));
      };

      const onAbort = (): void => {
        cleanup();
        reject(new SessionSupersededError());
      };

      const cleanup = (): void => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
        session.controller.signal.removeEventListener('abort', onAbort);
      };

      if (session.controller.signal.aborted) {
        reject(new SessionSupersededError());
        return;
      }

      video.addEventListener('loadedmetadata', onLoadedMetadata, {
        once: true,
      });
      video.addEventListener('error', onError, { once: true });
      session.controller.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    });
  }

  private bindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    this.logger.debug({ message: 'bindMediaListeners', media });
    media.addEventListener('timeupdate', this.handleTimeUpdate);
    media.addEventListener('play', this.handlePlay);
    media.addEventListener('pause', this.handlePause);
    media.addEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'bindMediaListeners:attached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private unbindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    this.logger.debug({ message: 'unbindMediaListeners', media });
    media.removeEventListener('timeupdate', this.handleTimeUpdate);
    media.removeEventListener('play', this.handlePlay);
    media.removeEventListener('pause', this.handlePause);
    media.removeEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'unbindMediaListeners:detached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private shouldUseWorkerLoader(): boolean {
    if (this.loadTransport === 'main-thread') {
      return false;
    }

    if (this.loadTransport === 'worker') {
      return true;
    }

    if (!this.ownsLoader) {
      return false;
    }

    return typeof Worker === 'function';
  }

  private shouldFallbackToMainThreadLoad({
    errorValue,
  }: {
    errorValue: unknown;
  }): boolean {
    if (this.loadTransport !== 'auto' || !this.ownsLoader) {
      return false;
    }

    if (!(errorValue instanceof LoaderError)) {
      return true;
    }

    const loaderError = errorValue as LoaderError;
    return loaderError.code === 'INTERNAL' || loaderError.code === 'ABORTED';
  }

  private applyState(nextStatePatch: Partial<PlayerState>): void {
    const previous = this.state;
    const next = { ...previous, ...nextStatePatch };
    this.state = next;

    // `statechange` is the primary external state notification contract.
    this.dispatchEvent(
      new CustomEvent<PlayerStateChangeDetail>('statechange', {
        detail: {
          previous,
          next,
        },
      }),
    );
  }

  private handleTimeUpdate = (): void => {
    const timeMs = asMilliseconds({ seconds: this.activeMedia.currentTime });
    const durationMs = asMilliseconds({ seconds: this.activeMedia.duration });
    // Audio timeline is always tracked; CDG sync is only needed when graphics exist.
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: timeMs });
    }
    this.applyState({ currentTimeMs: timeMs, durationMs });
  };

  private handlePlay = (): void => {
    this.logger.debug({
      message: 'handlePlay',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  };

  private handlePause = (): void => {
    this.logger.debug({
      message: 'handlePause',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    if (this.state.status !== 'error' && this.state.status !== 'idle') {
      this.applyState({ status: 'paused' });
    }
  };

  private handleEnded = (): void => {
    this.logger.debug({
      message: 'handleEnded',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    this.applyState({ status: 'ready', currentTimeMs: 0 });
  };
}

/**
 * Factory helper for constructing a CdgPlayer from named options.
 */
export const createPlayer = ({
  options,
}: {
  options: CdgPlayerOptions;
}): CdgPlayer => new CdgPlayer(options);
