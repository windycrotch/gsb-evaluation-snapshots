import DomSmith from '../../lib/dom/DomSmith.js';
import AsyncTask from '../../lib/util/AsyncTask.js';
import ConsentError from '../consent/ConsentError.js';
import ExtendedMediaError from '../util/ExtendedMediaError.js';
import { clone } from '../../lib/util/object.js';
import scriptLoader from '../../lib/util/scriptLoader.js';

/**
 * VisionPlayer engine that connects the Vimeo Player API with the media API and controls the Vimeo iframe element.
 * Emits synthetic media events and mirrors Vimeo state into the unified player state.
 * Supports playback, pause, loop, seek, playback rate, PiP, volume/mute, subtitles, quality and language.
 * @exports  module:src/providers/Vimeo
 * @requires module:lib/dom/DomSmith
 * @requires module:lib/util/AsyncTask
 * @requires module:src/util/ExtendedMediaError
 * @requires module:lib/util/object
 * @requires module:src/consent/ConsentError
 * @requires module:lib/util/scriptLoader
 * @author   Frank Kudermann - alphanull
 * @version  1.1.0
 * @license  MIT
 */
export default class Vimeo {

    /**
     * Holds the instance configuration for this component.
     * @type     {Object}
     * @property {boolean} [lazyLoadLib=true]  If `true`, load Vimeo Player API on engine activation as opposed to the earlier initialisation stage.
     * @property {boolean} [doNotTrack=true]   If `true`, enables Vimeo's Do Not Track parameter to reduce tracking and cookie usage. Note: Essential cookies (e.g., for security and bot protection) may still be set even when enabled.
     */
    #config = {
        lazyLoadLib: true,
        doNotTrack: true
    };

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Secret key only known to the player instance and initialized components.
     * Used to restrict access to API methods in secure mode.
     * @type {symbol}
     */
    #apiKey;

    /**
     * Holds metadata information provided by media.load.
     * @type {module:src/core/Media~metaData}
     */
    #metaData = {};

    /**
     * Reference to the Vimeo player instance.
     * @type {Object}
     */
    #vimeoPlayer;

    /**
     * Reference to the Async Task instance. Used to handle async tasks, which can be cancelled, resolved or rejected.
     * @type {module:lib/util/AsyncTask}
     */
    #loadTask;

    /**
     * Cancelable promise for script loading. Used to prevent callbacks when destroyed.
     * @type {Promise|null}
     */
    #scriptLoadPromise = null;

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Local state mirror (backing values).
     * @type {Object}
     */
    #state = Vimeo.#defaultState;

    /**
     * DOM helper wrapper around the Vimeo iframe container.
     * @type {module:lib/dom/DomSmith}
     */
    #container;

    /**
     * Subtitle renderer instance used to mirror cue changes into the player UI.
     * @type {{ update: Function }|null}
     */
    #subtitleRenderer;

    /**
     * Internal flag for PiP state.
     * @type {boolean}
     */
    #pipActive = false;

    /**
     * Remembers the last invoked Vimeo API method to disambiguate error handling.
     * @type {'requestPictureInPicture'|null}
     */
    #pendingVimeoMethod = null;

    /**
     * List of available qualities (could be numeric or textual, but can also be "null" which means "auto").
     * @type {Array<(null|number|string)>}
     */
    #qualities = [240, 360, 480, 720, 1080, 1440, 2160];

    /**
     * Creates an instance of the Vimeo engine.
     * @param {module:src/core/Player} player          Reference to the player instance.
     * @param {Object}                 parent          Reference to the parent component (unused for engines).
     * @param {Object}                 options         Additional options.
     * @param {symbol}                 options.apiKey  Token for extended access to the player API.
     */
    constructor(player, parent, { apiKey }) {

        this.#config = player.initConfig('vimeo', this.#config);

        if (!this.#config) return [false];

        this.#player = player;
        this.#apiKey = apiKey;

        this.#player.addEngine('vimeo', this, {
            capabilities: {
                play: true,
                playbackRate: true,
                loop: true,
                seek: true,
                volume: true,
                pictureInPicture: true,
                title: true,
                time: true
            }
        }, this.#apiKey);

        [
            ['vimeo:media.load', this.#load],
            ['vimeo:media.getMetaData', this.#getMetaData],
            ['vimeo:media.canPlay', this.canPlay],
            ['vimeo:media.play', this.#play],
            ['vimeo:media.pause', this.#pause],
            ['vimeo:media.loop', this.#loop],
            ['vimeo:media.playbackRate', this.#playbackRate],
            ['vimeo:media.seek', this.#seek],
            ['vimeo:media.volume', this.#volume],
            ['vimeo:media.mute', this.#mute],
            ['vimeo:media.getElement', this.#getIFrameElement],
            ['vimeo:media.requestPictureInPicture', this.#requestPictureInPicture],
            ['vimeo:media.exitPictureInPicture', this.#exitPictureInPicture]
        ].map(([name, handler]) => this.#player.setApi(name, handler, this.#apiKey));

        if (this.#player.consent) {
            this.#player.consent.register('vimeo', 'Vimeo', {
                thirdCountry: 'US',
                purposes: ['playback', 'cookies']
            }, this.#apiKey);
        }

        this.#container = new DomSmith({
            _ref: 'root',
            id: 'vip-engine-vimeo',
            className: 'vip-engine-wrapper'
        });

        if (!this.#config.lazyLoadLib && !this.#player.consent) this.#scriptLoadPromise = this.#loadLib().catch(() => {});

    }

    /**
     * Checks if this engine can play the given media data, by checking if the source contains a valid Vimeo video ID.
     * @param   {module:src/core/Media~metaData} metaData      The data to test.
     * @param   {string}                         metaData.src  The source URL to test.
     * @returns {'probably'|''}                                Indicates if stream can be played.
     */
    canPlay({ src }) { // eslint-disable-line class-methods-use-this

        const id = Vimeo.#extractVideoId(src);
        return id ? 'probably' : '';

    }

    /**
     * Loads Vimeo Player API via CDN if not present.
     * Uses the centralized scriptLoader utility for deduplication and reliability.
     * @returns {Promise<Object>} Cancelable promise that resolves with the Vimeo namespace.
     */
    #loadLib() {

        const promise = scriptLoader.request('https://player.vimeo.com/api/player.js', {
            global: 'Vimeo',
            checkAvailable: () => window.Vimeo?.Player
        }).then(vimeo => vimeo).catch(error => {
            // Show error notification for load errors (not for cancellation)
            if (error.name !== 'AbortError') {
                this.#player.dom.getElement(this.#apiKey).classList.add('has-no-media');
                this.#player.publish('data/nomedia', this.#apiKey);
                this.#player.publish('notification', {
                    type: 'error',
                    title: this.#player.locale.t('errors.library.scriptLoaderErrorTitle'),
                    message: this.#player.locale.t('errors.library.scriptLoaderErrorMessage', { libraryName: 'Vimeo' }),
                    messageSecondary: error.message
                }, this.#apiKey);
            }
            throw error; // Always propagate error (including AbortError)
        });

        // Auto-cleanup when promise settles
        promise.finally(() => {
            if (this.#scriptLoadPromise === promise) {
                this.#scriptLoadPromise = null;
            }
        });

        return promise;

    }

    /**
     * Loads media into the Vimeo player.
     * @param   {module:src/core/Media~metaData}          metaData                  The media data to load.
     * @param   {Object}                                  [options]                 Additional options.
     * @param   {number}                                  [options.seek]            Seek position.
     * @param   {boolean}                                 [options.play]            Whether to play after loading.
     * @param   {boolean}                                 [options.paused=true]     When true, keep paused unless `play` overrides.
     * @param   {number}                                  [options.volume=1]        Initial volume between 0 and 1.
     * @param   {boolean}                                 [options.muted=false]     Whether to start muted.
     * @param   {boolean}                                 [options.ignoreAutoplay]  If true, ignore autoplay setting.
     * @returns {Promise<module:src/core/Media~metaData>}                           Resolves with current metadata once API is available.
     */
    #load = async(metaData, options = {}) => {

        const videoId = Vimeo.#extractVideoId(metaData?.src);
        if (!videoId) throw new Error('[VisionPlayer] Invalid Vimeo video id.');

        const { play, paused = true, seek = 0, volume = 1, muted = false } = options,
              doPlay = typeof play === 'boolean' ? play : !paused,
              prevTask = this.#loadTask;

        if (metaData.src && metaData.src === this.#metaData?.src && prevTask?.status === 'pending') return prevTask.promise;
        if (prevTask?.status === 'pending') await prevTask.cancel().catch(() => {});

        this.#metaData = metaData;
        this.#loadTask = new AsyncTask();

        const denied = await this.#requireConsent();
        if (denied) {
            this.#loadTask.reject(denied);
            return this.#loadTask.promise;
        }

        this.#player.publish('media/loadstart', this.#apiKey);
        this.#state.paused = !doPlay;

        if (this.#vimeoPlayer) {
            const loadOptions = { id: videoId };
            if (seek > 0) loadOptions.start = seek;

            this.#vimeoPlayer.loadVideo(loadOptions).then(() => {
                if (doPlay) this.#vimeoPlayer.play().catch(() => {});
                this.#vimeoPlayer.setVolume(volume).catch(() => {});
                this.#vimeoPlayer.setMuted(muted).catch(() => {});
                this.#onLoaded();
            }).catch(error => {
                const wrapped = new ExtendedMediaError(2, { status: 400, message: `ERROR: ${error?.message || error}` });
                this.#loadTask.reject(wrapped);
                throw wrapped;
            }).then();
            return this.#loadTask.promise;
        }

        this.#scriptLoadPromise = this.#loadLib();
        let VimeoLib;
        try {
            VimeoLib = await this.#scriptLoadPromise;
        } catch (error) {
            if (error.name === 'AbortError') return; // Cancelled - stop execution
            // Reject loadTask instead of throwing to prevent uncaught exception
            if (this.#loadTask?.status === 'pending') this.#loadTask.reject(error);
            return this.#loadTask.promise;
        }

        const bestQuality = this.#getBestQuality(this.#player.getState('ui.playerHeight') * (window.devicePixelRatio ?? 1));

        this.#vimeoPlayer = new VimeoLib.Player(this.#container.root, {
            id: videoId,
            autoplay: Boolean(play),
            controls: false,
            muted: false,
            responsive: false,
            pip: true,
            playsinline: true,
            background: false,
            chromecast: false,
            dnt: this.#config.doNotTrack,
            quality: `${bestQuality}p`,
            preload: 'auto'
        });

        this.#vimeoPlayer.on('play', this.#onPlay);
        this.#vimeoPlayer.on('playing', this.#onPlaying);
        this.#vimeoPlayer.on('pause', this.#onPause);
        this.#vimeoPlayer.on('ended', this.#onEnded);
        this.#vimeoPlayer.on('timeupdate', this.#onTimeUpdate);
        this.#vimeoPlayer.on('progress', this.#onProgress);
        this.#vimeoPlayer.on('seeked', this.#onSeeked);
        this.#vimeoPlayer.on('bufferstart', this.#onBufferStart);
        this.#vimeoPlayer.on('bufferend', this.#onBufferEnd);
        this.#vimeoPlayer.on('playbackratechange', this.#onRateChange);
        this.#vimeoPlayer.on('volumechange', this.#onVolumeChange);
        this.#vimeoPlayer.on('cuechange', this.#onCueChange);
        this.#vimeoPlayer.on('error', this.#onError);
        this.#vimeoPlayer.on('enterpictureinpicture', this.#onPipEnter);
        this.#vimeoPlayer.on('leavepictureinpicture', this.#onPipExit);

        this.#vimeoPlayer.ready?.().then(() => {
            if (doPlay) this.#vimeoPlayer.play().catch(() => {});
            this.#vimeoPlayer.setVolume(volume).catch(() => {});
            this.#vimeoPlayer.setMuted(muted).catch(() => {});
            this.#onLoaded();
        }).catch(error => {
            // Catch early readiness errors (e.g., invalid ID) and reject loadTask
            const wrapped = new ExtendedMediaError(2, { status: 404, message: `[Vimeo] ${error?.message || error}` });
            this.#player.publish('media/error', { error: wrapped }, this.#apiKey);
            if (this.#loadTask?.status === 'pending') this.#loadTask.reject(wrapped);
        });

        return this.#loadTask.promise;

    };

    /**
     * Syncs metadata after load and emits Media API events.
     * @returns {Promise<void>} Resolves when metadata propagation is complete.
     * @fires module:src/settings/Quality#quality/update
     * @fires module:src/settings/Quality#quality/active
     * @fires module:src/settings/Language#language/update
     * @fires module:src/settings/Language#language/active
     * @fires module:src/core/Media#media/loadedmetadata
     * @fires module:src/core/Media#media/ready
     * @fires module:src/core/Media#media/loadeddata
     * @fires module:src/core/Media#media/canplay
     * @fires module:src/core/Media#media/canplaythrough
     * @fires module:src/core/Media#media/progress
     */
    #onLoaded = async() => {

        try {
            // extract metadata, keep in mind this is an async operation and the values are not immediately available
            const [currentTime, duration, title, videoWidth, videoHeight, qualities, textTracks, audioTracks, enabledAudioTrack, chapters, currentQuality] = await Promise.all([
                this.#vimeoPlayer?.getCurrentTime?.().catch(() => null),
                this.#vimeoPlayer?.getDuration?.().catch(() => null),
                this.#vimeoPlayer?.getVideoTitle?.().catch(() => null),
                this.#vimeoPlayer?.getVideoWidth?.().catch(() => null),
                this.#vimeoPlayer?.getVideoHeight?.().catch(() => null),
                this.#vimeoPlayer?.getQualities?.().catch(() => null),
                this.#vimeoPlayer?.getTextTracks?.().catch(() => null),
                this.#vimeoPlayer?.getAudioTracks?.().catch(() => null),
                this.#vimeoPlayer?.getEnabledAudioTrack?.().catch(() => null),
                this.#vimeoPlayer?.getChapters?.().catch(() => null),
                this.#vimeoPlayer?.getQuality?.().catch(() => null)
            ]);

            if (title) {
                this.#metaData.title = title;
                this.#player.data.updateMediaData(title, { property: 'title' });
            }

            this.#metaData.duration = Number.isFinite(duration) ? duration : Infinity;
            this.#metaData.width = videoWidth ?? NaN;
            this.#metaData.height = videoHeight ?? NaN;
            this.#metaData.quality = currentQuality ?? NaN;
            this.#metaData.language = enabledAudioTrack?.language ?? null;

            this.#state.currentTime = currentTime ?? 0;
            this.#state.duration = this.#metaData.duration;
            this.#state.remainingTime = Number.isFinite(this.#state.duration) ? this.#state.duration - this.#state.currentTime : NaN;
            this.#state.videoWidth = this.#metaData.width = videoWidth ?? NaN;
            this.#state.videoHeight = this.#metaData.height = this.#metaData.quality = videoHeight ?? NaN;
            this.#state.bufferedRange = Vimeo.#emptyRange;
            this.#state.playedRange = Vimeo.#emptyRange;

            // update chapters if available
            if (chapters?.length) {
                const mappedChapters = chapters.map(chapter => ({ title: chapter.title, start: chapter.startTime }));
                this.#player.data.updateMediaData(mappedChapters, { property: 'chapters' });
            }

            // check support for quality settings and make selected quality available if possible
            if (qualities?.length > 2) {
                const qualityDataRaw = Array.isArray(qualities)
                    ? qualities.map(q => (q?.id === 'auto' ? null : Number(q?.id?.replace?.('p', '') || q))).filter(v => Number.isFinite(v) || v === null)
                    : [];

                this.#qualities = qualityDataRaw;
                this.#state.videoHeight = NaN;
                this.#state.videoWidth = NaN;

                try {

                    const playerHeight = this.#player.getState('ui.playerHeight') * (window.devicePixelRatio ?? 1),
                          bestQuality = currentQuality === 'auto'
                              ? `${this.#getBestQuality(playerHeight)}p`
                              : currentQuality;

                    await this.#vimeoPlayer.setQuality(bestQuality);

                    const activeQuality = Number(bestQuality?.replace?.('p', '')),
                          qualityData = [...new Set(this.#qualities)].sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b));

                    this.#state.videoHeight = this.#metaData.height = this.#metaData.quality = activeQuality;
                    this.#player.publish('quality/update', { qualityData }, this.#apiKey);
                    this.#player.publish('quality/active', { value: activeQuality }, this.#apiKey);

                } catch {
                    this.#qualities = [];
                }

            } else {
                this.#qualities = [];
            }

            // check support for language (aka audiotrack) settings and make selection via the language menu available if possible
            if (audioTracks?.length > 1) {

                const mappedLanguages = audioTracks.map(track => ({ language: track.language })).filter(entry => entry.language),
                      currentAudio = enabledAudioTrack?.language ? { language: enabledAudioTrack.language } : mappedLanguages.find(l => l.language === this.#metaData.language) || null,
                      initialLang = currentAudio?.language || mappedLanguages[0]?.language;

                try {
                    await this.#vimeoPlayer.selectAudioTrack(initialLang);
                    this.#metaData.language = initialLang;
                    this.#player.publish('language/update', { languages: mappedLanguages, current: { language: initialLang } }, this.#apiKey);
                    this.#player.publish('language/active', { language: initialLang }, this.#apiKey);
                } catch {}
            }

            // next we need to check if there are text tracks and if so, we need to publish the text tracks to the player
            if (textTracks?.length) {

                const mappedTextTracks = textTracks.map(textTrack => ({
                    language: textTrack.language,
                    label: textTrack.label,
                    kind: textTrack.kind
                })).filter(track => track.language);

                this.#subtitleRenderer = this.#player.getComponent('subtitles.subtitleRendererVTT', this.#apiKey);
                this.#player.data.updateMediaData(mappedTextTracks, { property: 'text' }, this.#apiKey);
            }

            // Publish (synthetic) media events to match the Media API
            this.#player.publish('media/loadedmetadata', this.#apiKey);
            this.#player.publish('media/ready', clone(this.#metaData), this.#apiKey);
            this.#player.publish('media/loadeddata', this.#apiKey);
            this.#player.publish('media/canplay', this.#apiKey);
            this.#player.publish('media/canplaythrough', this.#apiKey);
            this.#player.publish('media/progress', this.#apiKey);

            if (this.#loadTask?.status === 'pending') this.#loadTask.resolve(clone(this.#metaData));
        } catch (error) {
            if (this.#loadTask?.status === 'pending') this.#loadTask.reject(error);
        }

    };

    /**
     * Returns the current metadata.
     * @returns {module:src/core/Media~metaData} The current metadata.
     */
    #getMetaData = () => this.#metaData;

    /**
     * Plays the media.
     * @fires module:src/core/Media#media/play
     */
    #play = () => {

        this.#state.isPaused = false;
        this.#vimeoPlayer.play().catch(() => {});
        this.#player.publish('media/play', this.#apiKey);

    };

    /**
     * Pauses the media.
     * @fires module:src/core/Media#media/pause
     */
    #pause = () => {

        this.#state.isPaused = true;
        this.#vimeoPlayer.pause().catch(() => {});
        this.#player.publish('media/pause', this.#apiKey);

    };

    /**
     * Sets the loop state.
     * @param {boolean} loop  Whether to loop.
     * @fires module:src/core/Media#media/loop
     */
    #loop = loop => {

        const doLoop = Boolean(loop);
        this.#state.doLoop = doLoop;
        this.#vimeoPlayer.setLoop(doLoop).catch(() => {});
        this.#player.publish('media/loop', this.#apiKey);

    };

    /**
     * Sets the playback rate.
     * @param {number} rate  The playback rate (0.5 to 2).
     * @fires module:src/core/Media#media/ratechange
     */
    #playbackRate = rate => {

        const parsed = Number(rate);
        if (!Number.isFinite(parsed) || parsed <= 0) return;

        this.#vimeoPlayer.setPlaybackRate(parsed).then(() => {
            this.#state.playbackRate = parsed;
            this.#player.publish('media/ratechange', this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Seeks to a specific time.
     * @param {number} time  The time to seek to (in seconds).
     * @fires module:src/core/Media#media/seeking
     * @fires module:src/core/Media#media/seeked
     * @fires module:src/core/Media#media/canplay
     * @fires module:src/core/Media#media/canplaythrough
     * @fires module:src/core/Media#media/progress
     */
    #seek = time => {

        this.#player.publish('media/seeking', this.#apiKey);
        const clamped = Math.max(0, Number(time) || 0);
        this.#vimeoPlayer.setCurrentTime(clamped).then(() => {
            this.#state.currentTime = clamped;
            this.#state.playedRange = Vimeo.#toRange(0, Math.min(clamped, this.#state.duration));
            this.#state.remainingTime = Number.isFinite(this.#state.duration) ? this.#state.duration - clamped : NaN;
            this.#player.publish('media/timeupdate', this.#apiKey);
            this.#player.publish('media/seeked', this.#apiKey);
            this.#player.publish('media/canplay', this.#apiKey);
            this.#player.publish('media/canplaythrough', this.#apiKey);
            this.#player.publish('media/progress', this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Sets the volume.
     * @param {number} volume  The volume (0 to 1).
     * @fires module:src/core/Media#media/volumechange
     */
    #volume = volume => {

        const vol = Math.min(1, Math.max(0, Number(volume) || 0));
        this.#vimeoPlayer.setVolume(vol).then(() => {
            this.#state.volume = vol;
            this.#state.isMuted = vol === 0;
            this.#player.publish('media/volumechange', this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Sets the mute state.
     * @param {boolean} mute  Whether to mute.
     * @fires module:src/core/Media#media/volumechange
     */
    #mute = mute => {

        const doMute = Boolean(mute);
        const mutedPromise = typeof this.#vimeoPlayer.setMuted === 'function'
            ? this.#vimeoPlayer.setMuted(doMute)
            : this.#vimeoPlayer.setVolume(doMute ? 0 : this.#state.volume || 1);

        Promise.resolve(mutedPromise).then(() => {
            this.#state.isMuted = doMute || this.#state.volume === 0;
            this.#player.publish('media/volumechange', this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Requests Picture-in-Picture mode via Vimeo API.
     * @fires module:src/core/Media#media/enterpictureinpicture
     */
    #requestPictureInPicture = async() => {

        this.#pendingVimeoMethod = 'requestPictureInPicture';
        try {
            await this.#vimeoPlayer.requestPictureInPicture();
        } catch { }

    };

    /**
     * Exits Picture-in-Picture mode via Vimeo API.
     * @fires module:src/core/Media#media/leavepictureinpicture
     */
    #exitPictureInPicture = async() => {

        try {
            await this.#vimeoPlayer.exitPictureInPicture();
        } catch {}

    };

    /**
     * Handles Vimeo "play" to keep internal state aligned and propagate the Media API event.
     * @fires module:src/core/Media#media/play
     */
    #onPlay = () => {

        this.#state.isPaused = false;
        this.#state.isEnded = false;
        this.#player.publish('media/play', this.#apiKey);

    };

    /**
     * Handles Vimeo "playing" to mirror the active playback state.
     * @fires module:src/core/Media#media/playing
     */
    #onPlaying = () => {

        this.#state.isPaused = false;
        this.#player.publish('media/playing', this.#apiKey);

    };

    /**
     * Handles Vimeo "pause" and forwards the Media API event.
     * @fires module:src/core/Media#media/pause
     */
    #onPause = () => {

        this.#state.isPaused = true;
        this.#player.publish('media/pause', this.#apiKey);

    };

    /**
     * Handles Vimeo "ended", optionally restarts on loop, and fires Media API events.
     * @fires module:src/core/Media#media/ended
     */
    #onEnded = () => {

        if (this.#state.doLoop) {
            this.#vimeoPlayer.setCurrentTime(0).then(() => this.#vimeoPlayer.play()).catch(() => {});
            return;
        }

        this.#state.isPaused = true;
        this.#state.isEnded = true;
        this.#player.publish('media/ended', this.#apiKey);

    };

    /**
     * Handles Vimeo "timeupdate" payloads and recomputes derived timing state.
     * @param {Object} data             Event data from Vimeo.
     * @param {number} [data.duration]  Reported duration.
     * @param {number} [data.seconds]   Current playback position.
     * @fires module:src/core/Media#media/timeupdate
     */
    #onTimeUpdate = data => {

        const duration = Number.isFinite(data?.duration) ? data.duration : this.#state.duration,
              current = Number.isFinite(data?.seconds) ? data.seconds : this.#state.currentTime;

        this.#state.duration = duration ?? Infinity;
        this.#state.currentTime = current ?? 0;
        this.#state.playedRange = Vimeo.#toRange(0, Math.min(this.#state.currentTime, this.#state.duration));
        this.#state.remainingTime = Number.isFinite(this.#state.duration) ? this.#state.duration - this.#state.currentTime : NaN;
        this.#player.publish('media/timeupdate', this.#apiKey);

    };

    /**
     * Handles Vimeo "progress" events and updates buffered range.
     * @param {Object} data             Event data from Vimeo.
     * @param {number} [data.duration]  Reported duration.
     * @param {number} [data.percent]   Buffered percent (0..1).
     * @fires module:src/core/Media#media/progress
     */
    #onProgress = data => {

        const duration = Number.isFinite(data?.duration) ? data.duration : this.#state.duration,
              buffered = Number.isFinite(duration) && Number.isFinite(data?.percent) ? duration * data.percent : NaN;

        if (Number.isFinite(buffered) && buffered >= 0) {
            this.#state.bufferedRange = Vimeo.#toRange(0, Math.min(buffered, duration));
        } else {
            this.#state.bufferedRange = Vimeo.#emptyRange;
        }

        this.#player.publish('media/progress', this.#apiKey);

    };

    /**
     * Handles Vimeo "seeked" and forwards Media API event.
     * @fires module:src/core/Media#media/seeked
     */
    #onSeeked = () => { this.#player.publish('media/seeked', this.#apiKey); };

    /**
     * Handles Vimeo "bufferstart".
     * @fires module:src/core/Media#media/waiting
     */
    #onBufferStart = () => { this.#player.publish('media/waiting', this.#apiKey); };

    /**
     * Handles Vimeo "bufferend".
     * @fires module:src/core/Media#media/canplay
     */
    #onBufferEnd = () => { this.#player.publish('media/canplay', this.#apiKey); };

    /**
     * Handles Vimeo cue changes and feeds them into the subtitle renderer.
     * @param {Object} event         Vimeo cue event.
     * @param {Array}  [event.cues]  Active cues.
     */
    #onCueChange = event => { this.#subtitleRenderer?.update?.(event?.cues, this.#apiKey); };

    /**
     * Handles Vimeo playback-rate changes.
     * @param {Object} data                 Event data from Vimeo.
     * @param {number} [data.playbackRate]  Updated playback rate.
     * @fires module:src/core/Media#media/ratechange
     */
    #onRateChange = data => {

        const rate = Number(data?.playbackRate);
        if (Number.isFinite(rate) && rate > 0) this.#state.playbackRate = rate;
        this.#player.publish('media/ratechange', this.#apiKey);

    };

    /**
     * Handles Vimeo volume changes.
     * @param {Object}  data           Event data from Vimeo.
     * @param {number}  [data.volume]  Updated volume (0..1).
     * @param {boolean} [data.muted]   Muted flag.
     * @fires module:src/core/Media#media/volumechange
     */
    #onVolumeChange = data => {

        const volume = Number.isFinite(data?.volume) ? data.volume : this.#state.volume;
        this.#state.volume = volume;
        this.#state.isMuted = volume === 0 || Boolean(data?.muted);
        this.#player.publish('media/volumechange', this.#apiKey);

    };

    /**
     * Handles Vimeo enter-PiP.
     * @fires module:src/core/Media#media/enterpictureinpicture
     */
    #onPipEnter = () => {

        this.#pendingVimeoMethod = null;
        this.#pipActive = true;
        this.#player.publish('media/enterpictureinpicture', this.#apiKey);

    };

    /**
     * Handles Vimeo leave-PiP.
     * @fires module:src/core/Media#media/leavepictureinpicture
     */
    #onPipExit = () => {

        this.#pendingVimeoMethod = null;
        this.#pipActive = false;
        this.#player.publish('media/leavepictureinpicture', this.#apiKey);

    };

    /**
     * Reacts to player subtitle selection updates.
     * @param {Object}  [payload]           Selection payload.
     * @param {string}  [payload.language]  Target language or null to disable.
     * @param {boolean} [payload.off]       When true, disable subtitles.
     * @param {string}  [payload.type]      Track kind, defaults to "subtitles".
     * @param {number}  [payload.index]     Index of the selected track.
     * @fires module:src/core/Player#subtitles/active
     * @listens module:src/core/Player#subtitles/selected
     */
    #onSubtitlesSelected = ({ language, off, type, index } = {}) => {

        if (!this.#vimeoPlayer?.enableTextTrack) return;

        // Disable subtitles explicitly and notify UI state
        if (off || language === null || typeof language === 'undefined') {
            this.#vimeoPlayer.disableTextTrack?.().catch(() => {});
            this.#subtitleRenderer?.update?.([], this.#apiKey);
            this.#player.publish('subtitles/active', { index: -1, language: null, type: null }, this.#apiKey);
            return;
        }

        const targetLang = language;
        const targetKind = type || 'subtitles';

        // showing=false disables native rendering while still emitting cue events (see player.js docs)
        this.#vimeoPlayer.enableTextTrack(targetLang, targetKind, false).then(track => {

            const kind = track?.kind || targetKind;
            this.#player.publish('subtitles/active', {
                index: typeof index === 'number' ? index : 0,
                language: targetLang,
                type: kind
            }, this.#apiKey);

        }).catch(() => { });

    };

    /**
     * Applies a quality selection coming from the player UI.
     * @param {Object}      payload          Payload emitted by the quality menu.
     * @param {number|null} payload.quality  Selected resolution (e.g., 720) or null for auto.
     * @fires module:src/settings/Quality#quality/active
     * @listens module:src/settings/Quality#quality/selected
     */
    #onQualitySelected = ({ quality }) => {

        const target = typeof quality === 'undefined' || quality === null
            ? `${this.#getBestQuality(this.#player.getState('ui.playerHeight') * (window.devicePixelRatio ?? 1))}p`
            : `${quality}p`;

        this.#vimeoPlayer?.setQuality?.(target).then(resolvedQuality => {
            const active = resolvedQuality === 'auto' ? null : Number(resolvedQuality.replace('p', ''));
            this.#state.videoHeight = this.#metaData.height = this.#metaData.quality = active;
            this.#player.publish('quality/active', { value: active }, this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Handler for 'quality/resize' event. Caps the max bitrate if display size is small.
     * @param {Object} size         Object containing size information.
     * @param {number} size.height  The new container height in px.
     * @listens module:src/settings/Quality#quality/resize
     */
    #onQualityResize = ({ height }) => {

        if (!this.#qualities.length) return;

        const bestQuality = this.#getBestQuality(height);
        this.#vimeoPlayer.setQuality(`${bestQuality}p`).catch(() => { });
        this.#player.publish('quality/active', { value: bestQuality }, this.#apiKey);

    };

    /**
     * Picks the best quality for a given height.
     * @param   {number}      height  The height in pixels.
     * @returns {number|null}         The best quality or null if no quality is available.
     */
    #getBestQuality = height => {

        const bestQuality = this.#qualities
            .sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b))
            .reduce((acc, h) => h < height * 1.2 ? h : acc, {});

        return bestQuality;

    };

    /**
     * Applies an audio language selection coming from the player UI.
     * @param {Object} langObj             Payload emitted by the language menu.
     * @param {string} [langObj.language]  Language code.
     * @param {string} [langObj.value]     Alternative language key.
     * @fires module:src/settings/Language#language/active
     * @listens module:src/settings/Language#language/selected
     */
    #onLanguageSelected = langObj => {

        const target = langObj?.language || langObj?.value;
        if (!target) return;

        this.#vimeoPlayer.selectAudioTrack(target).then(() => {
            this.#player.publish('language/active', { language: target }, this.#apiKey);
        }).catch(() => {});

    };

    /**
     * Normalizes Vimeo errors into ExtendedMediaError and forwards notifications where appropriate.
     * @param {Object} error  Vimeo error object.
     * @fires module:src/core/Media#media/error
     * @fires module:src/ui/Notification#notification
     */
    #onError = error => {

        if (error?.method === 'setQuality' || error?.message?.includes('is not a valid quality')) return; // ignore quality errors

        if (this.#pendingVimeoMethod === 'requestPictureInPicture' && !error.method) {
            // catch errors from the requestPictureInPicture method and publish a notification instead of an error
            this.#pendingVimeoMethod = null;
            this.#player.publish('media/leavepictureinpicture', this.#apiKey);
            this.#player.publish('notification', {
                type: 'warning',
                title: this.#player.locale.t('pip.iFrameNotEnabled'),
                message: this.#player.locale.t('pip.enableIframe'),
                options: { timeout: 5 }
            }, this.#apiKey);
            return;
        }

        const wrapped = new ExtendedMediaError(2, { status: 404, message: `ERROR: ${error?.message || error}` });
        this.#player.publish('media/error', { error: wrapped }, this.#apiKey);
        if (this.#loadTask?.status === 'pending') this.#loadTask.reject(wrapped);

    };

    /**
     * Returns the Vimeo iframe element (falls back to the wrapper if not mounted yet).
     * @returns {HTMLElement|null} The Vimeo iframe element or wrapper node.
     */
    #getIFrameElement = () => this.#container?.root?.querySelector?.('iframe') || this.#container?.root || null;

    /**
     * Requests consent before contacting Vimeo. When denied, publishes `data/nomedia`
     * and returns a ConsentError so the caller can abort its load path.
     * @returns {Promise<module:src/consent/ConsentError|undefined>} ConsentError when denied, otherwise undefined.
     */
    async #requireConsent() {

        if (await this.#player.consent?.request('vimeo', this.#apiKey) ?? true) return;

        this.#player.dom.getElement(this.#apiKey).classList.add('has-no-media');
        this.#player.publish('data/nomedia', this.#apiKey);
        return new ConsentError(this.#player.locale.t('errors.consent.denied', { name: 'Vimeo' }));

    }

    /**
     * Enables the Vimeo engine by mounting the iframe container and exposing state accessors.
     * When consent is on, the Player API is not loaded here so `setEngine` can finish and
     * `data/ready` can clear the previous item before `#load` shows the overlay.
     */
    async enable() {

        if (!this.#player.consent) {
            try {
                this.#scriptLoadPromise = this.#loadLib();
                await this.#scriptLoadPromise;
            } catch (error) {
                if (error.name === 'AbortError') return; // Cancelled - stop execution
                throw error; // Real error - propagate
            }
        }

        this.#container.mount({ ele: this.#player.dom.getElement(this.#apiKey) });
        this.#state = clone(Vimeo.#defaultState);

        const stateFuncs = {
            src: () => this.#metaData?.src,
            duration: () => this.#state.duration ?? NaN,
            currentTime: () => this.#state.currentTime ?? 0,
            remainingTime: () => this.#state.remainingTime ?? NaN,
            paused: () => this.#state.isPaused,
            ended: () => this.#state.isEnded,
            loop: () => Boolean(this.#state.doLoop),
            volume: () => this.#state.volume ?? 1,
            muted: () => this.#state.isMuted,
            playbackRate: () => this.#state.playbackRate ?? 1,
            videoWidth: () => this.#state.videoWidth ?? NaN,
            videoHeight: () => this.#state.videoHeight ?? NaN,
            buffered: () => this.#state.bufferedRange || Vimeo.#emptyRange,
            played: () => this.#state.playedRange || Vimeo.#emptyRange,
            pictureInPicture: () => this.#pipActive,
            liveStream: () => {
                const dur = this.#state.duration;
                return !Number.isFinite(dur) || dur === 0;
            }
        };

        for (const [key, fn] of Object.entries(stateFuncs)) {
            const descriptor = { get: fn, enumerable: true, configurable: true };
            this.#player.setState(`media.${key}`, descriptor, this.#apiKey);
        }

        this.#subscriptions = [
            this.#player.subscribe('quality/selected', this.#onQualitySelected),
            this.#player.subscribe('quality/resize', this.#onQualityResize),
            this.#player.subscribe('language/selected', this.#onLanguageSelected),
            this.#player.subscribe('subtitles/selected', this.#onSubtitlesSelected)
        ];

    }

    /**
     * Disables the Vimeo engine and removes all registered state accessors.
     */
    disable() {

        if (this.#loadTask?.status === 'pending') this.#loadTask.cancel().catch(() => { });

        // Cancel script loading if still in progress
        if (this.#scriptLoadPromise) {
            this.#scriptLoadPromise.cancel().catch(() => {});
            this.#scriptLoadPromise = null;
        }

        Object.keys(this.#state).forEach(key => {
            this.#player.removeState(`media.${key}`, this.#apiKey);
            delete this.#state[key];
        });

        this.#vimeoPlayer?.destroy?.();
        this.#vimeoPlayer = null;
        this.#container.unmount();
        this.#player.unsubscribe(this.#subscriptions);
        this.#subscriptions = null;

    }

    /**
     * This method removes all events, subscriptions and DOM nodes created by this component.
     */
    destroy() {

        this.disable();
        this.#container.destroy();
        this.#player.removeEngine('vimeo', this.#apiKey);
        // eslint-disable-next-line @stylistic/max-len
        this.#player.removeApi(['vimeo:media.load', 'vimeo:media.getMetaData', 'vimeo:media.canPlay', 'vimeo:media.play', 'vimeo:media.pause', 'vimeo:media.loop', 'vimeo:media.playbackRate', 'vimeo:media.seek', 'vimeo:media.volume', 'vimeo:media.mute', 'vimeo:media.getElement', 'vimeo:media.requestPictureInPicture', 'vimeo:media.exitPictureInPicture'], this.#apiKey);
        this.#player = this.#vimeoPlayer = this.#metaData = this.#apiKey = null;

    }

    /**
     * Fallback empty TimeRanges-like object.
     * @type {{length:number, start:Function, end:Function}}
     */
    static #emptyRange = {
        length: 0,
        start: () => NaN,
        end: () => NaN
    };

    /**
     * Default state object for the Vimeo engine.
     * @type {Object}
     */
    static #defaultState = {
        doLoop: false,
        isMuted: false,
        isPaused: true,
        isEnded: false,
        bufferedRange: null,
        playedRange: null,
        duration: Infinity,
        liveStream: false,
        currentTime: 0,
        remainingTime: NaN,
        volume: 1,
        playbackRate: 1,
        pictureInPicture: false,
        videoWidth: NaN,
        videoHeight: NaN
    };

    /**
     * Converts start and end times to a TimeRanges-like object.
     * @param   {number}                                        start  Start time.
     * @param   {number}                                        end    End time.
     * @returns {{length:number, start:Function, end:Function}}        TimeRanges-like object.
     */
    static #toRange = (start, end) => !Number.isFinite(start) || !Number.isFinite(end) || end < start
        ? Vimeo.#emptyRange
        : {
            length: 1,
            start: index => (index === 0 ? start : NaN),
            end: index => (index === 0 ? end : NaN)
        };

    /**
     * Extracts a Vimeo video id from a URL.
     * @param   {string}      src  Source URL.
     * @returns {string|null}      Video id if found.
     */
    static #extractVideoId = src => {

        if (typeof src === 'string' && src.startsWith('vimeo:')) {
            const directId = src.slice('vimeo:'.length).trim().replace(/[^\d]/g, '');
            return /^\d{6,}$/.test(directId) ? directId : null;
        }

        let url;
        try {
            url = new URL(src);
        } catch { return null; }

        const host = url.hostname.toLowerCase(),
              isVimeoHost = host.includes('vimeo.com');

        if (!isVimeoHost) return null;

        const segments = url.pathname.split('/').filter(Boolean),
              idCandidate = segments.pop() || '',
              videoId = idCandidate.replace(/[^\d]/g, '');

        return /^\d{6,}$/.test(videoId) ? videoId : null;

    };

}
