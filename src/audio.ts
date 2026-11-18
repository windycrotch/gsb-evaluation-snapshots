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
  isValidObject,
} from 'helpers/common';
import { getLatestState, listen, notify } from 'helpers/notifier';
import { shuffleQueue } from 'helpers/shuffleHelper';

import { attachMediaSessionHandlers, updateMetaData } from 'mediasession/mediasessionHandler';
import { READY_STATE } from 'states/audioState';
import type {
  AudioInit,
  AudioState,
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
  private _queue: MediaTrack[] = [];
  private _currentQueueIndex = 0;
  /**
   * Set when the currently playing track was removed from the queue. Points at
   * the entry playNext has to resume from, because that entry moved into the
   * slot the removed track used to occupy.
   */
  private _pendingQueueIndex: number | null = null;
  private _fetchFn: (mediaTrack: MediaTrack) => Promise<void>;
  private eqStatus: EqualizerStatus = 'IDEAL';
  private isEqEnabled = false;
  private eqInstance: Equalizer;
  private showNotificationsActions = false;
  private originalQueue: MediaTrack[] = [];
  private isShuffled = false;
  private loopMode: LoopMode = 'OFF';

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

    if (customEventListeners !== null) {
      if (useDefaultEventListeners) {
        console.warn(
          `useDefaultEventListeners is set to true at init, are you trying to use the default event listeners?
            set customEventListeners to null to use default event listeners`,
        );
      }
      attachEventListeners(customEventListeners, false);
    } else {
      attachEventListeners(BASE_EVENT_CALLBACK_MAP, enablePlayLog);
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
        // The track is being started explicitly, so any resume position left
        // over from a removed track is no longer relevant.
        this._pendingQueueIndex = null;
      }
    }

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

  attachEq() {
    if (this.eqStatus === 'IDEAL') {
      try {
        const eq = new Equalizer();
        this.eqStatus = eq.status();
        this.eqInstance = eq;
      } catch (_e) {
        console.log('failed to enable equalizer');
      }
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
              await this.play();
              if (this.isEqEnabled) {
                this.attachEq();
              }
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
   */
  async reset() {
    if (audioInstance) {
      this.stop();
      audioInstance.src = '';
      audioInstance.srcObject = null;
    }
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
    if (this.isEqEnabled) {
      this.eqInstance.setPreset(id);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  setCustomEQ(gains: number[]) {
    if (this.isEqEnabled) {
      this.eqInstance.setCustomEQ(gains);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  setBassBoost(enabled: boolean, boost: number) {
    if (this.isEqEnabled) {
      this.eqInstance.setBassBoost(enabled, boost);
    } else {
      console.error('Equalizer not initialized, please set enableEq at init');
    }
  }

  addQueue(queue: MediaTrack[], playbackType: QueuePlaybackType) {
    this.clearQueue();
    const audioState = getLatestState('AUDIO_X_STATE') as AudioState;
    const playerQueue = isValidArray(queue) ? queue.slice() : [];
    const currentTrack = isValidObject(audioState?.currentTrack)
      ? audioState.currentTrack
      : undefined;

    switch (playbackType) {
      case 'DEFAULT':
        this._queue = playerQueue;
        break;
      case 'REVERSE':
        this._queue = playerQueue.reverse();
        break;
      case 'SHUFFLE': {
        // Keep the order the caller handed us so shuffle can be turned back off.
        this.originalQueue = playerQueue.slice();
        this._queue = shuffleQueue(playerQueue, currentTrack?.id);
        this.isShuffled = true;
        // The current track is kept by shuffleQueue, make sure the cursor
        // still points at it so playNext continues in the shuffled order.
        this.syncCurrentQueueIndex(currentTrack?.id);
        break;
      }
      default:
        this._queue = playerQueue;
        break;
    }
    handleQueuePlayback();
    /* Attaching MediaSession Handler again as this will make sure that
     the next and previous button show up in notification */
    if (this.showNotificationsActions) {
      attachMediaSessionHandlers();
    }
  }

  playNext() {
    const index = this.getNextQueueIndex();
    if (this?._queue?.length > index) {
      const nextTrack = this._queue[index];
      this.addMediaAndPlay(nextTrack, this._fetchFn);
      this._currentQueueIndex = index;
      this._pendingQueueIndex = null;
    } else {
      // stop the audio and end trigger queue ended
      this._pendingQueueIndex = null;
      this.stop();
      notify('AUDIO_STATE', {
        playbackState: PLAYBACK_STATE.QUEUE_ENDED,
      });
    }
  }

  playPrevious() {
    const index = this.getPreviousQueueIndex();

    if (index >= 0) {
      const previousTrack = this?._queue[index];
      this.addMediaAndPlay(previousTrack, this._fetchFn);
      this._currentQueueIndex = index;
      this._pendingQueueIndex = null;
    } else {
      console.log('At the beginning of the queue');
    }
  }

  clearQueue() {
    this._queue = [];
    this._currentQueueIndex = 0;
    this._pendingQueueIndex = null;
    this.originalQueue = [];
    this.isShuffled = false;
  }

  addToQueue(mediaTracks: MediaTrack | MediaTrack[]) {
    if (!mediaTracks) {
      return;
    }

    const tracks = Array.isArray(mediaTracks) ? mediaTracks : [mediaTracks];
    if (!tracks.length) {
      return;
    }

    if (!this._queue) {
      this._queue = [];
    }
    this._queue = [...this._queue, ...tracks];

    // While shuffled the original order is the source of truth when shuffle is
    // turned off, so newly added tracks have to land there too.
    if (this.isShuffled) {
      this.originalQueue = [...this.originalQueue, ...tracks];
    }
  }

  toggleShuffle() {
    // isShuffled is false initially
    const audioState = getLatestState('AUDIO_X_STATE') as AudioState;
    const previousQueue = this.getQueue().slice();
    const previousIndex = this._currentQueueIndex;
    // Only a track that is actually playing has to keep its slot; with an
    // idle player the whole queue is free to be shuffled.
    const currentTrackId = isValidObject(audioState?.currentTrack)
      ? audioState.currentTrack.id
      : undefined;

    if (!this.isShuffled) {
      // Remember the order the caller originally gave us, not the current one.
      this.originalQueue = previousQueue;
      this._queue = shuffleQueue(previousQueue, currentTrackId);
      this.syncCurrentQueueIndex(currentTrackId);
      this.isShuffled = true;
    } else {
      if (!this.originalQueue.length) {
        this.isShuffled = false;
        return;
      }
      // Restore the pre-shuffle order and keep the cursor on the current track.
      const restoredQueue = this.originalQueue.slice();
      const restoredIndex = currentTrackId
        ? restoredQueue.findIndex((track) => track.id === currentTrackId)
        : -1;
      this._queue = restoredQueue;
      this._currentQueueIndex = restoredIndex > -1 ? restoredIndex : previousIndex;
      this._pendingQueueIndex = null;
      this.isShuffled = false;
    }
    this.clampQueueIndex();
    handleQueuePlayback();
    if (this.showNotificationsActions) {
      attachMediaSessionHandlers();
    }
  }

  loop(loopMode: LoopMode) {
    this.loopMode = loopMode;
    switch (loopMode) {
      case 'SINGLE':
        handleLoopPlayback(loopMode);
        break;
      case 'QUEUE':
        handleLoopPlayback(loopMode);
        break;
      case 'OFF':
        handleLoopPlayback(loopMode);
        break;
      default:
        handleLoopPlayback('OFF');
        break;
    }
  }

  isShuffledEnabled() {
    return this.isShuffled;
  }

  getLoopMode() {
    return this.loopMode;
  }

  removeFromQueue(mediaTrack: MediaTrack) {
    if (!mediaTrack || !this._queue || !isValidArray(this._queue)) {
      return;
    }

    const index = this._queue.findIndex((track: MediaTrack) => track.id === mediaTrack.id);
    if (index === -1) {
      return;
    }

    // Remove only the matching entry so the remaining order is preserved.
    this._queue = [...this._queue.slice(0, index), ...this._queue.slice(index + 1)];

    if (this.originalQueue.length) {
      const originalIndex = this.originalQueue.findIndex(
        (track: MediaTrack) => track.id === mediaTrack.id,
      );
      if (originalIndex > -1) {
        this.originalQueue = [
          ...this.originalQueue.slice(0, originalIndex),
          ...this.originalQueue.slice(originalIndex + 1),
        ];
      }
    }

    if (this._queue.length === 0) {
      this._currentQueueIndex = 0;
      this._pendingQueueIndex = null;
      return;
    }

    // Keep a pending resume position (set when the playing track was removed)
    // pointing at the same successor after this removal.
    if (this._pendingQueueIndex !== null) {
      if (index < this._pendingQueueIndex) {
        this._pendingQueueIndex -= 1;
      }
      this._pendingQueueIndex = Math.min(this._pendingQueueIndex, this._queue.length - 1);
    }

    if (index < this._currentQueueIndex) {
      // Everything left of the cursor shifted one position left.
      this._currentQueueIndex -= 1;
    } else if (index === this._currentQueueIndex) {
      // The playing track is gone. The next track now sits in the slot the
      // removed track occupied; point the cursor just before it so playNext
      // continues with the original next track instead of skipping one.
      this._pendingQueueIndex = this._currentQueueIndex;
      this._currentQueueIndex = Math.min(this._currentQueueIndex, this._queue.length - 1);
      return;
    }
    this._currentQueueIndex = Math.min(
      Math.max(this._currentQueueIndex, 0),
      this._queue.length - 1,
    );
  }

  /**
   * Starts playback of the queue entry at the given position.
   * Used by queue loop to jump back to the first track.
   */
  playFromQueue(index: number) {
    const queue = this.getQueue();
    if (!isValidArray(queue)) {
      return;
    }
    const target = Math.min(Math.max(index, 0), queue.length - 1);
    this._currentQueueIndex = target;
    this._pendingQueueIndex = null;
    this.addMediaAndPlay(queue[target], this._fetchFn);
  }

  getQueue() {
    return this._queue && isValidArray(this._queue) ? this._queue : [];
  }

  private getNextQueueIndex() {
    if (this._pendingQueueIndex !== null) {
      return this._pendingQueueIndex;
    }
    return this._currentQueueIndex + 1;
  }

  private getPreviousQueueIndex() {
    if (this._pendingQueueIndex !== null) {
      return this._pendingQueueIndex - 1;
    }
    return this._currentQueueIndex - 1;
  }

  private syncCurrentQueueIndex(currentTrackId?: string) {
    this._pendingQueueIndex = null;
    if (currentTrackId) {
      const index = this._queue.findIndex((track) => track.id === currentTrackId);
      if (index > -1) {
        this._currentQueueIndex = index;
        return;
      }
    }
    this.clampQueueIndex();
  }

  private clampQueueIndex() {
    const length = this._queue?.length ?? 0;
    if (length === 0) {
      this._currentQueueIndex = 0;
      return;
    }
    this._currentQueueIndex = Math.min(Math.max(this._currentQueueIndex, 0), length - 1);
  }

  get id() {
    return audioInstance?.getAttribute('id');
  }

  static getAudioInstance() {
    return audioInstance;
  }
}

export { AudioX };
