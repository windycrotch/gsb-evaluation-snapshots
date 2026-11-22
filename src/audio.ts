import { Equalizer } from 'adapters/equalizer';
import HlsAdapter from 'adapters/hls';
import { AUDIO_X_CONSTANTS, PLAYBACK_STATE } from 'constants/common';
import { BASE_EVENT_CALLBACK_MAP } from 'events/baseEvents';
import { attachEventListeners } from 'events/listeners';
import {
  calculateActualPlayedLength,
  handleLoopPlayback,
  handleQueuePlayback,
  isValidArray,
  isValidFunction,
} from 'helpers/common';
import { listen, notify } from 'helpers/notifier';
import { shuffleQueue, unshuffleQueue } from 'helpers/shuffleHelper';

import { attachMediaSessionHandlers, updateMetaData } from 'mediasession/mediasessionHandler';
import { READY_STATE } from 'states/audioState';
import type {
  AudioInit,
  LoopMode,
  MediaTrack,
  PlaybackRate,
  QueuePlaybackType,
} from 'types/audio.types';
import type { EqualizerStatus, Preset } from 'types/equalizer.types';

let audioInstance: HTMLAudioElement;

class AudioX {
  private _audio: HTMLAudioElement;
  private isPlayLogEnabled: boolean;
  private static _instance: AudioX;
  private _queue: MediaTrack[];
  private _currentQueueIndex = 0;
  private _currentTrack: MediaTrack | undefined;
  private _fetchFn: (mediaTrack: MediaTrack) => Promise<void>;
  private eqStatus: EqualizerStatus = 'IDEAL';
  private isEqEnabled = false;
  private eqInstance: Equalizer;
  private showNotificationsActions = false;
  private originalQueue: MediaTrack[] = [];
  private isShuffled = false;
  private loopMode: LoopMode = 'OFF';
  /**
   * A queue session is the single source of truth for queue, current index and
   * every listener that reacts to queue lifecycle events (track ended ->
   * playNext, queue ended -> loop replay). Bumping the id invalidates every
   * listener registered by previous sessions.
   */
  private _queueSessionId = 0;
  private _sessionCleanups: Array<() => void> = [];
  private _loopCleanup: (() => void) | undefined;
  private _eventListenersAttached = false;

  constructor() {
    if (AudioX._instance) {
      console.warn(
        'Instantiation failed: cannot create multiple instance of AudioX returning existing instance',
      );
      // biome-ignore lint/correctness/noConstructorReturn: <explanation>
      return AudioX._instance;
    }
    if (process.env.NODE_ENV !== AUDIO_X_CONSTANTS?.DEVELOPMENT && audioInstance) {
      throw new Error('Cannot create multiple audio instance');
    }

    AudioX._instance = this;
    this._audio = new Audio();
    audioInstance = this._audio;
  }

  /** Guard passed to session listeners: is the given session still the active one? */
  private _isQueueSessionActive = (sessionId: number) => sessionId === this._queueSessionId;

  /**
   * Ends the current queue session: invalidates and unsubscribes every
   * session-scoped listener (queue-end auto advance, queue loop replay).
   */
  private _endQueueSession() {
    this._queueSessionId += 1;
    const cleanups = this._sessionCleanups.splice(0);
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (_e) {
        // an already-removed listener must never break session teardown
      }
    }
    this._loopCleanup = undefined;
  }

  /**
   * Registers the queue-loop listener for the active session, making sure any
   * previously registered one is removed first (loop replay stays idempotent).
   */
  private _attachQueueLoopListener() {
    this._loopCleanup?.();
    const cleanup = handleLoopPlayback(
      'QUEUE',
      this,
      this._queueSessionId,
      this._isQueueSessionActive,
    );
    this._loopCleanup = cleanup;
    if (cleanup) {
      this._sessionCleanups.push(cleanup);
    }
  }

  /**
   * The single commit point for queue mutations: every change of the queue and
   * the current index (addQueue, toggleShuffle) goes through here so both are
   * always updated together, a fresh queue session is started and exactly one
   * set of session listeners is attached for it.
   */
  private _commitQueue(queue: MediaTrack[], currentTrackId = this._currentTrack?.id) {
    this._endQueueSession();
    this._queue = queue;
    const currentIndex = currentTrackId
      ? queue.findIndex((track) => track.id === currentTrackId)
      : -1;
    // keep the current track at a playable position; fall back to queue start
    this._currentQueueIndex = currentIndex > -1 ? currentIndex : 0;
    this._sessionCleanups.push(
      handleQueuePlayback(this, this._queueSessionId, this._isQueueSessionActive),
    );
    // re-arm queue looping for the new session if it was active
    if (this.loopMode === 'QUEUE') {
      this._attachQueueLoopListener();
    }
  }

  /** Resets queue / shuffle / loop state and listeners to a clean baseline. */
  private _resetToBaseline() {
    this._endQueueSession();
    this._queue = [];
    this._currentQueueIndex = 0;
    this._currentTrack = undefined;
    this.originalQueue = [];
    this.isShuffled = false;
    this.loopMode = 'OFF';
    if (audioInstance) {
      audioInstance.loop = false;
    }
  }

  /**
   *
   * @param initProps  initial config to initialize AudioX
   * @param initProps.mediaTrack mediaTrack Object containing metadata and source of the media
   * @param initProps.mediaTrack.title title of the Audio
   * @param initProps.mediaTrack.source URI of the Audio
   * @param initProps.mediaTrack.artwork artwork of the Audio
   * @param initProps.mediaTrack.duration  duration of the audio
   * @param initProps.mediaTrack.genre genre of the audio
   * @param initProps.mediaTrack.album album of the audio
   * @param initProps.mediaTrack.comment comment for the audio
   * @param initProps.mediaTrack.year release year of the audio
   * @param initProps.mediaTrack.artist artist of the audio
   * @param mode mode of operation for AudioX
   * @param autoplay flag for autoplay
   * @param preloadStrategy strategy for preloading audio
   * @param playbackRate default playbackRate of the audio
   * @param attachAudioEventListeners flag for registering audio events
   * @param attachMediaSessionHandlers flag for registering mediaSession handlers
   */

  async init(initProps: AudioInit) {
    const {
      preloadStrategy = 'auto',
      autoPlay = false,
      useDefaultEventListeners = true,
      customEventListeners = null,
      showNotificationActions = false,
      enablePlayLog = false,
      enableHls = false,
      enableEQ = false,
      crossOrigin = null,
      hlsConfig = {},
    } = initProps;

    this._audio?.setAttribute('id', 'audio_x_instance');
    this._audio.preload = preloadStrategy;
    this._audio.autoplay = autoPlay;
    this._audio.crossOrigin = crossOrigin;
    this.isPlayLogEnabled = enablePlayLog;
    this.isEqEnabled = enableEQ;

    if (this._eventListenersAttached) {
      // re-init after reset/destroy must not stack duplicate element listeners
      console.warn('AudioX event listeners are already attached, skipping re-attachment');
    } else if (customEventListeners !== null) {
      if (useDefaultEventListeners) {
        console.warn(
          `useDefaultEventListeners is set to true at init, are you trying to use the default event listeners?
            set customEventListeners to null to use default event listeners`,
        );
      }
      attachEventListeners(customEventListeners, false);
      this._eventListenersAttached = true;
    } else {
      attachEventListeners(BASE_EVENT_CALLBACK_MAP, enablePlayLog);
      this._eventListenersAttached = true;
    }

    if (showNotificationActions) {
      this.showNotificationsActions = true;
      attachMediaSessionHandlers();
    }

    if (enableHls) {
      const hls = new HlsAdapter();
      hls.init(enablePlayLog, hlsConfig);
    }
  }

  async addMedia(mediaTrack: MediaTrack, mediaFetchFn?: (mediaTrack: MediaTrack) => Promise<void>) {
    if (!mediaTrack) {
      return;
    }

    if (mediaFetchFn && !mediaTrack.source.length) {
      this._fetchFn = mediaFetchFn;
    }

    const queue = this.getQueue();
    if (isValidArray(queue)) {
      const index = queue.findIndex((track) => mediaTrack.id === track.id);
      if (index > -1) {
        this._currentQueueIndex = index;
      }
    }
    // the queue session itself is the source of truth for the current track
    this._currentTrack = mediaTrack;

    const mediaType = mediaTrack.source.includes('.m3u8') ? 'HLS' : 'DEFAULT';

    if (this.isPlayLogEnabled) {
      calculateActualPlayedLength(audioInstance, 'TRACK_CHANGE');
    }

    if (mediaType === 'HLS' && !audioInstance.canPlayType('application/vnd.apple.mpegurl')) {
      const hls = new HlsAdapter();
      const hlsInstance = hls.getHlsInstance();
      if (hlsInstance) {
        hlsInstance.detachMedia();
        hls.addHlsMedia(mediaTrack);
      } else {
        console.warn(
          'The source provided seems to be a HLS stream but, hls playback is not enabled. Please have a look at init method of AudioX',
        );
        await this.reset();
      }
    } else {
      audioInstance.src = mediaTrack.source;
    }

    notify('AUDIO_STATE', {
      playbackState: PLAYBACK_STATE.TRACK_CHANGE,
      currentTrackPlayTime: 0,
      currentTrack: mediaTrack,
    });

    updateMetaData(mediaTrack);
    audioInstance.load();
  }

  /**
   * Attaches the equalizer to the playback chain.
   * Idempotent: repeated calls (multiple play() / track changes) neither create
   * a new AudioContext nor re-connect nodes once the equalizer is ACTIVE.
   * A failed attempt is remembered as 'FAILED' and retried on the next call,
   * while playback itself is never interrupted by an equalizer failure.
   */
  attachEq() {
    if (this.eqStatus === 'ACTIVE' && this.eqInstance) {
      return;
    }
    try {
      // the Equalizer singleton returns the existing instance if present
      const eq = new Equalizer();
      if (eq.status() === 'FAILED') {
        eq.init(); // retry wiring the node graph after a previous failure
      }
      this.eqInstance = eq;
      this.eqStatus = eq.status();
    } catch (_e) {
      this.eqStatus = 'FAILED';
      console.log('failed to enable equalizer, playback continues without it');
    }
  }

  async play() {
    const isSourceAvailable = audioInstance.src !== '';
    if (
      audioInstance?.paused &&
      audioInstance.HAVE_ENOUGH_DATA === READY_STATE.HAVE_ENOUGH_DATA &&
      isSourceAvailable
    ) {
      await audioInstance
        .play()
        .then(() => {
          console.log('PLAYING');
        })
        .catch(() => {
          console.warn('cancelling current audio playback, track changed');
        });
    }
    if (this.isEqEnabled) {
      this.attachEq();
    }
  }

  /**
   *
   * @param mediaTrack MediaTrack to be added and played
   *
   * Note: Use this method when you want to add media and do playback or want continuous playback
   * You can also call addMedia and Play Separately to achieve playback.
   */

  async addMediaAndPlay(
    mediaTrack?: MediaTrack | null,
    fetchFn?: (mediaTrack: MediaTrack) => Promise<void>,
    // this should be passed when there something needs to be done before the audio starts playing
  ) {
    const currentTrack = mediaTrack || (this._queue.length > 0 ? this._queue[0] : undefined);
    if (fetchFn && isValidFunction(fetchFn) && currentTrack?.source.length) {
      this._fetchFn = fetchFn;
      await fetchFn(currentTrack as MediaTrack);
    }
    try {
      if (currentTrack) {
        this.addMedia(currentTrack).then(() => {
          if (audioInstance.HAVE_ENOUGH_DATA === READY_STATE.HAVE_ENOUGH_DATA) {
            setTimeout(async () => {
              // play() attaches the equalizer when enabled (idempotently)
              await this.play();
            }, 950);
          }
        });
      } else {
        console.error('Playback Failed, No MediaTrack Provided');
      }
    } catch (_error) {
      console.error('Playback Failed');
    }
  }

  pause() {
    if (audioInstance && !audioInstance?.paused) {
      audioInstance?.pause();
    }
  }

  stop() {
    if (audioInstance && !audioInstance.paused) {
      audioInstance?.pause();
      audioInstance.currentTime = 0;
    }
  }

  /**
   * @method reset :  This stops the playback and resets all the state of the audio
   * including the queue session, so a subsequent init + play starts from a
   * clean baseline with no leftover listeners.
   */
  async reset() {
    if (audioInstance) {
      this.stop();
      audioInstance.src = '';
      audioInstance.srcObject = null;
    }
    this._resetToBaseline();
  }

  /**
   * @param volume : numeric value between 1-100 to be used.
   */
  setVolume(volume: number) {
    const actualVolume = volume / 100;
    if (audioInstance) {
      audioInstance.volume = actualVolume;
      notify('AUDIO_STATE', {
        volume: volume,
      });
    }
  }
  /**
   * @param playbackRate : a number denoting speed at which the playback should happen,
   */
  setPlaybackRate(playbackRate: PlaybackRate) {
    if (audioInstance) {
      audioInstance.playbackRate = playbackRate;
      notify('AUDIO_STATE', {
        playbackRate,
      });
    }
  }

  mute() {
    if (audioInstance && !audioInstance.muted) {
      audioInstance.muted = true;
    }
  }

  seek(time: number) {
    if (audioInstance) {
      audioInstance.currentTime = time;
    }
  }

  seekBy(time: number) {
    if (audioInstance?.currentTime) {
      const currentProgress = audioInstance.currentTime;
      audioInstance.currentTime = currentProgress + time;
    }
  }

  async destroy() {
    if (audioInstance) {
      await this.reset();
      audioInstance.removeAttribute('src');
      audioInstance.load();
    }
  }

  subscribe(eventName: string, callback: (data: any) => void, state: any = {}) {
    const unsubscribe = listen(eventName, callback, state);
    return unsubscribe;
  }

  addEventListener(event: keyof HTMLMediaElementEventMap, callback: (data: any) => void) {
    audioInstance.addEventListener(event, callback);
  }

  getPresets() {
    return Equalizer.getPresets();
  }

  setPreset(id: keyof Preset) {
    if (this.isEqEnabled && this.eqStatus === 'ACTIVE' && this.eqInstance) {
      this.eqInstance.setPreset(id);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  setCustomEQ(gains: number[]) {
    if (this.isEqEnabled && this.eqStatus === 'ACTIVE' && this.eqInstance) {
      this.eqInstance.setCustomEQ(gains);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  setBassBoost(enabled: boolean, boost: number) {
    if (this.isEqEnabled && this.eqStatus === 'ACTIVE' && this.eqInstance) {
      this.eqInstance.setBassBoost(enabled, boost);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  addQueue(queue: MediaTrack[], playbackType: QueuePlaybackType = 'DEFAULT') {
    const playerQueue = isValidArray(queue) ? queue.slice() : [];
    const currentTrackId = this._currentTrack?.id;

    let finalQueue: MediaTrack[];
    switch (playbackType) {
      case 'REVERSE':
        finalQueue = [...playerQueue].reverse();
        this.isShuffled = false;
        this.originalQueue = [];
        break;
      case 'SHUFFLE': {
        // keep the original order so a later unshuffle can restore it
        this.originalQueue = [...playerQueue];
        this.isShuffled = true;
        finalQueue = shuffleQueue(playerQueue, currentTrackId);
        break;
      }
      default:
        finalQueue = playerQueue;
        this.isShuffled = false;
        this.originalQueue = [];
        break;
    }

    // single commit point: queue + current index + session listeners
    this._commitQueue(finalQueue, currentTrackId);

    /* Attaching MediaSession Handler again as this will make sure that
     the next and previous button show up in notification */
    if (this.showNotificationsActions) {
      attachMediaSessionHandlers();
    }
  }

  playNext() {
    const index = this._currentQueueIndex + 1;
    if (this?._queue?.length > index) {
      // commit the index synchronously so rapid consecutive track changes
      // always advance from the latest committed position
      this._currentQueueIndex = index;
      const nextTrack = this._queue[index];
      this.addMediaAndPlay(nextTrack, this._fetchFn);
    } else {
      // stop the audio and end trigger queue ended
      this.stop();
      notify('AUDIO_STATE', {
        playbackState: PLAYBACK_STATE.QUEUE_ENDED,
      });
    }
  }

  playPrevious() {
    const index = this?._currentQueueIndex - 1;

    if (index >= 0) {
      this._currentQueueIndex = index;
      const previousTrack = this?._queue[index];
      this.addMediaAndPlay(previousTrack, this._fetchFn);
    } else {
      console.log('At the beginning of the queue');
    }
  }

  clearQueue() {
    // ending the session first guarantees stale queue/loop listeners can
    // never fire against the cleared queue
    this._endQueueSession();
    this._queue = [];
    this._currentQueueIndex = 0;
    this.originalQueue = [];
    this.isShuffled = false;
  }

  addToQueue(mediaTracks: MediaTrack | MediaTrack[]) {
    if (this._queue && isValidArray(this._queue)) {
      if (Array.isArray(mediaTracks)) {
        this._queue = [...this._queue, ...mediaTracks];
      } else {
        this._queue.push(mediaTracks);
      }
    }
  }

  toggleShuffle() {
    const currentQueue = this.getQueue();
    if (!isValidArray(currentQueue)) {
      return;
    }
    const currentTrackId = this._currentTrack?.id;

    if (!this.isShuffled) {
      this.originalQueue = [...currentQueue];
      const shuffledQueue = shuffleQueue(currentQueue, currentTrackId);
      this.isShuffled = true;
      // same commit point as addQueue: queue + index + session stay consistent
      this._commitQueue(shuffledQueue, currentTrackId);
    } else {
      if (!isValidArray(this.originalQueue)) {
        return;
      }
      const restoredQueue = unshuffleQueue(this.originalQueue);
      this.isShuffled = false;
      // restores original order and re-anchors the index on the current track
      this._commitQueue(restoredQueue, currentTrackId);
    }
  }

  loop(loopMode: LoopMode) {
    const mode: LoopMode =
      loopMode === 'SINGLE' || loopMode === 'QUEUE' || loopMode === 'OFF' ? loopMode : 'OFF';
    this.loopMode = mode;

    // invalidate the previous queue-loop listener before applying the new mode
    this._loopCleanup?.();
    this._loopCleanup = undefined;

    if (mode === 'QUEUE') {
      this._attachQueueLoopListener();
    } else {
      handleLoopPlayback(mode, this, this._queueSessionId, this._isQueueSessionActive);
    }
  }

  isShuffledEnabled() {
    return this.isShuffled;
  }

  getLoopMode() {
    return this.loopMode;
  }

  removeFromQueue(mediaTrack: MediaTrack) {
    if (this._queue && isValidArray(this._queue)) {
      this._queue = this._queue.filter((track: MediaTrack) => track.id !== mediaTrack.id);
      // keep the current index at a playable position inside the shrunk queue
      if (this._currentQueueIndex >= this._queue.length) {
        this._currentQueueIndex = Math.max(0, this._queue.length - 1);
      }
    }
  }

  getQueue() {
    return this._queue && isValidArray(this._queue) ? this._queue : [];
  }

  getCurrentQueueIndex() {
    return this._currentQueueIndex;
  }

  getCurrentTrack() {
    return this._currentTrack;
  }

  get id() {
    return audioInstance?.getAttribute('id');
  }

  static getAudioInstance() {
    return audioInstance;
  }
}

export { AudioX };
