import DomSmith from '../../lib/dom/DomSmith.js';
import AsyncTask from '../../lib/util/AsyncTask.js';
import ConsentError from '../consent/ConsentError.js';
import ExtendedMediaError from '../util/ExtendedMediaError.js';
import Looper from '../../lib/util/Looper.js';
import { clone } from '../../lib/util/object.js';
import scriptLoader from '../../lib/util/scriptLoader.js';

/**
 * VisionPlayer engine that connects the YouTube IFrame API and the players' media API.
 * Emits synthetic media events and mirrors YouTube player state to the VisionPlayer state and controls the YouTube iframe element.
 * Supports playback, pause, loop, volume mute, playback rate and seek.
 * @exports  module:src/providers/YouTube
 * @requires module:lib/dom/DomSmith
 * @requires module:lib/util/AsyncTask
 * @requires module:src/util/ExtendedMediaError
 * @requires module:lib/util/Looper
 * @requires module:lib/util/object
 * @requires module:src/consent/ConsentError
 * @requires module:lib/util/scriptLoader
 * @author   Frank Kudermann - alphanull
 * @version  1.1.0
 * @license  MIT
 */
export default class YouTube {

    /**
     * Holds the instance configuration for this component.
     * @type     {Object}
     * @property {boolean} [lazyLoadLib=true]  If `true`, load YouTube Player API on engine activation as opposed to the earlier initialisation stage.
     * @property {boolean} [noCookie=true]     If `true`, use YouTube's no-cookie domain (youtube-nocookie.com) for the player iframe. Note: The API script itself must still be loaded from youtube.com. This reduces but does not eliminate cookies, and does not provide full GDPR compliance.
     */
    #config = {
        lazyLoadLib: true,
        noCookie: true
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
     * Reference to the YouTube player instance (IFrame API).
     * @type {Object}
     */
    #youtubePlayer;

    /**
     * Holds metadata information provided by media.load.
     * @type {module:src/core/Media~metaData}
     */
    #metaData = {};

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
     * Local state mirror exposed via player state API.
     * @type {Object}
     */
    #state = YouTube.#defaultState;

    /**
     * Loop helper for synthetic timeupdate polling.
     * @type {module:lib/util/Looper|null}
     */
    #timeLoop = null;

    /**
     * Loop helper for synthetic progress polling.
     * @type {module:lib/util/Looper|null}
     */
    #progressLoop = null;

    /**
     * Container element for the YouTube iframe.
     * @type {HTMLElement|null}
     */
    #container;

    /**
     * Creates an instance of the YouTube engine.
     * @param {module:src/core/Player} player          Reference to the player instance.
     * @param {Object}                 parent          Reference to the parent component (unused for engines).
     * @param {Object}                 options         Additional options.
     * @param {symbol}                 options.apiKey  Token for extended access to the player API.
     */
    constructor(player, parent, { apiKey }) {

        this.#config = player.initConfig('youtube', this.#config);

        if (!this.#config) return [false];

        this.#player = player;
        this.#apiKey = apiKey;
        this.#timeLoop = new Looper(() => this.#player.publish('media/timeupdate', this.#apiKey), 150);
        this.#progressLoop = new Looper(() => {
            this.#updateRanges();
            this.#player.publish('media/progress', this.#apiKey);
        }, 500);

        this.#player.addEngine('youtube', this, {
            capabilities: {
                play: true,
                playbackRate: true,
                loop: true,
                seek: true,
                volume: true,
                time: true
            }
        }, this.#apiKey);

        [
            ['youtube:media.load', this.#load],
            ['youtube:media.getMetaData', this.#getMetaData],
            ['youtube:media.canPlay', this.canPlay],
            ['youtube:media.play', this.#play],
            ['youtube:media.pause', this.#pause],
            ['youtube:media.loop', this.#loop],
            ['youtube:media.playbackRate', this.#playbackRate],
            ['youtube:media.seek', this.#seek],
            ['youtube:media.volume', this.#volume],
            ['youtube:media.mute', this.#mute],
            ['youtube:media.getElement', this.#getIFrameElement]
        ].map(([name, handler]) => this.#player.setApi(name, handler, this.#apiKey));

        if (this.#player.consent) {
            this.#player.consent.register('youtube', 'YouTube', {
                thirdCountry: 'US',
                purposes: ['playback', 'cookies', 'advertising']
            }, this.#apiKey);
        }

        this.#container = new DomSmith({
            _ref: 'root',
            id: 'vip-engine-youtube',
            className: 'vip-engine-wrapper',
            _nodes: [{
                _ref: 'iframe',
                className: 'vip-engine-youtube-iframe'
            }]
        });

        if (!this.#config.lazyLoadLib && !this.#player.consent) this.#scriptLoadPromise = this.#loadLib().catch(() => {});

    }

    /**
     * Checks if this engine can play the given media data, by checking if the source contains a valid YouTube video ID.
     * @param   {module:src/core/Media~metaData} metaData      The data to test.
     * @param   {string}                         metaData.src  The source URL to test.
     * @returns {'probably'|''}                                Indicates if stream can be played.
     */
    canPlay({ src }) { // eslint-disable-line class-methods-use-this

        const id = YouTube.#extractVideoId(src);
        return id ? 'probably' : '';

    }

    /**
     * Loads YouTube IFrame API via CDN if not present.
     * Uses scriptLoader for deduplication, wraps in custom Promise for API-ready callback.
     * @returns {Promise<Object>} Cancelable promise that resolves with the YT namespace.
     */
    #loadLib() {

        // Wrap both script loading AND API ready callback into one cancelable promise
        const promise = new Promise((resolve, reject) => {

            // If API is already ready, resolve immediately
            if (window.YT?.Player) {
                resolve(window.YT);
                return;
            }

            // Set up API-ready callback (YouTube-specific mechanism)
            const prev = window.onYouTubeIframeAPIReady;
            const readyCallback = () => {
                prev?.();
                if (window.YT?.Player) resolve(window.YT);
                else reject(new Error('[VisionPlayer] YouTube IFrame API loaded but YT.Player not available.'));
            };
            window.onYouTubeIframeAPIReady = readyCallback;

            // Use scriptLoader to load the script (handles deduplication)
            // Note: The API must always be loaded from youtube.com, not youtube-nocookie.com
            const loadPromise = scriptLoader.request('https://www.youtube.com/iframe_api', {
                // Note: YT namespace exists but YT.Player only after onYouTubeIframeAPIReady
                global: 'YT'
            });

            // If scriptLoader rejects (error or cancellation), reject this promise too
            loadPromise.catch(error => {
                // Clean up callback on error
                if (window.onYouTubeIframeAPIReady === readyCallback) {
                    window.onYouTubeIframeAPIReady = prev;
                }

                if (error.name !== 'AbortError') {
                    this.#player.dom.getElement(this.#apiKey).classList.add('has-no-media');
                    this.#player.publish('data/nomedia', this.#apiKey);
                    this.#player.publish('notification', {
                        type: 'error',
                        title: this.#player.locale.t('errors.library.scriptLoaderErrorTitle'),
                        message: this.#player.locale.t('errors.library.scriptLoaderErrorMessage', { libraryName: 'YouTube' })
                    }, this.#apiKey);
                }

                reject(error);
            });

        });

        // Make it cancelable
        const cancelablePromise = Object.assign(promise, {
            cancel: () => Promise.reject(new Error('AbortError'))
        });

        // Auto-cleanup when promise settles
        cancelablePromise.finally(() => {
            if (this.#scriptLoadPromise === cancelablePromise) {
                this.#scriptLoadPromise = null;
            }
        });

        return cancelablePromise;

    }

    /**
     * Loads media into the YouTube player.
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

        const videoId = YouTube.#extractVideoId(metaData?.src);
        if (!videoId) throw new Error('[VisionPlayer] Invalid YouTube video id.');

        const { play, paused = true, seek = 0, volume = 1, muted = false } = options,
              doPlay = typeof play === 'boolean' ? play : !paused,
              prevTask = this.#loadTask;

        if (metaData.src && metaData.src === this.#metaData?.src && prevTask?.status === 'pending') return prevTask.promise;
        if (prevTask?.status === 'pending') await prevTask.cancel().catch(() => {});

        this.#metaData = { ...metaData, videoId };
        this.#loadTask = new AsyncTask();

        const denied = await this.#requireConsent();
        if (denied) {
            this.#loadTask.reject(denied);
            return this.#loadTask.promise;
        }

        if (this.#youtubePlayer) {
            this.#loadVideo(videoId, seek, doPlay, volume, muted);
            return this.#loadTask.promise;
        }

        this.#scriptLoadPromise = this.#loadLib();
        let yt;
        try {
            yt = await this.#scriptLoadPromise;
        } catch (error) {
            if (error.name === 'AbortError') return; // Cancelled - stop execution
            throw error; // Real error - propagate
        }

        const playerConfig = {
            host: this.#config.noCookie ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com',
            playerVars: {
                autoplay: play ? 1 : 0,
                playsinline: 1,
                controls: 0,
                disablekb: 1,
                fs: 0,
                rel: 0,
                iv_load_policy: 3, // eslint-disable-line camelcase
                origin: typeof window === 'undefined' ? null : window.location.origin,
                start: seek > 0 ? seek : 0
            },
            events: {
                onReady: () => { this.#loadVideo(videoId, seek, doPlay, volume, muted); },
                onStateChange: this.#onStateChange,
                onPlaybackRateChange: () => this.#player.publish('media/ratechange', this.#apiKey),
                onError: event => {
                    const error = new ExtendedMediaError(2, { status: 404, message: `ERROR: ${event?.data || event}` });
                    this.#player.publish('media/error', { error }, this.#apiKey);
                    this.#loadTask.reject(error);
                }
            }
        };

        this.#youtubePlayer = new yt.Player(this.#container.iframe, playerConfig);

        return this.#loadTask.promise;

    };

    /**
     * Cues a video and primes seek/volume/mute state before playback.
     * @param {string}  videoId  Identifier of the YouTube video to load.
     * @param {number}  seek     Start position in seconds for initial cue.
     * @param {boolean} play     Whether playback should start after cueing.
     * @param {number}  volume   Initial volume fraction (0..1).
     * @param {boolean} muted    Whether audio starts muted.
     */
    #loadVideo = (videoId, seek, play, volume, muted) => {

        const args = seek > 0 ? { videoId, startSeconds: seek } : { videoId };
        this.#youtubePlayer.cueVideoById(args);
        this.#volume(volume);
        this.#mute(muted);
        this.#progressLoop?.start();
        this.#state.savedPlayed = play;

    };

    /**
     * Syncs metadata after the player signals it is cued and emits Media API events.
     * @fires module:src/core/Media#media/loadedmetadata
     * @fires module:src/core/Media#media/ready
     * @fires module:src/core/Media#media/loadeddata
     * @fires module:src/core/Media#media/canplay
     * @fires module:src/core/Media#media/canplaythrough
     * @fires module:src/core/Media#media/progress
     * @fires module:src/core/Media#media/timeupdate
     */
    #onLoaded = () => {

        const data = this.#youtubePlayer?.getVideoData?.();
        this.#metaData.videoId = data?.video_id || null;
        this.#metaData.title = data?.title || null;
        this.#metaData.duration = this.#youtubePlayer.getDuration?.() ?? Infinity;
        this.#metaData.isLive = this.#state.liveStream;
        this.#metaData.width = this.#state.videoWidth;
        this.#metaData.height = this.#state.videoHeight;

        this.#updateRanges();
        this.#progressLoop?.start();

        // Publish (synthetic) media events to match the Media API
        this.#player.publish('media/loadedmetadata', this.#apiKey);
        this.#player.publish('media/ready', clone(this.#metaData), this.#apiKey);
        this.#player.publish('media/loadeddata', this.#apiKey);
        this.#player.publish('media/canplay', this.#apiKey);
        this.#player.publish('media/canplaythrough', this.#apiKey);
        this.#player.publish('media/progress', this.#apiKey);
        this.#player.publish('media/timeupdate', this.#apiKey);

        if (this.#state.savedPlayed) this.#play();

        this.#loadTask.resolve(clone(this.#metaData));

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

        this.#youtubePlayer.playVideo();
        this.#timeLoop?.start();
        this.#progressLoop?.start();
        this.#player.publish('media/play', this.#apiKey);

    };

    /**
     * Pauses the media.
     * @fires module:src/core/Media#media/pause
     */
    #pause = () => {

        this.#youtubePlayer.pauseVideo();
        this.#timeLoop?.stop();
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
        // YouTube IFrame does not support native loop for single videos; handle on state change.
        this.#player.publish('media/loop', this.#apiKey);

    };

    /**
     * Sets the playback rate.
     * @param {number} rate  The playback rate (0.25 to 2).
     * @fires module:src/core/Media#media/ratechange
     */
    #playbackRate = rate => {

        const parsed = Number(rate);
        if (!Number.isFinite(parsed) || parsed <= 0) return;

        this.#youtubePlayer.setPlaybackRate(parsed);
        this.#player.publish('media/ratechange', this.#apiKey);

    };

    /**
     * Seeks to a specific time.
     * @param {number} time  The time to seek to (in seconds).
     * @fires module:src/core/Media#media/seeked
     */
    #seek = time => {

        if (this.#youtubePlayer?.getPlayerState?.() === YouTube.#STATE.CUED) {
            this.#youtubePlayer.playVideo();
            this.#pause();
        }

        const clamped = Math.max(0, Number(time) || 0);
        this.#youtubePlayer.seekTo(clamped, true);
        this.#player.publish('media/seeked', this.#apiKey);

    };

    /**
     * Sets the volume.
     * @param {number} volume  The volume (0 to 1).
     * @fires module:src/core/Media#media/volumechange
     */
    #volume = volume => {

        const vol = Math.min(1, Math.max(0, Number(volume) || 0));
        this.#youtubePlayer.setVolume(vol * 100);
        this.#player.publish('media/volumechange', this.#apiKey);

    };

    /**
     * Sets the mute state.
     * @param {boolean} mute  Whether to mute.
     * @fires module:src/core/Media#media/volumechange
     */
    #mute = mute => {

        const doMute = Boolean(mute);
        if (doMute) this.#youtubePlayer.mute(); else this.#youtubePlayer.unMute();
        this.#state.isMuted = doMute;
        this.#player.publish('media/volumechange', this.#apiKey);

    };

    /**
     * Recomputes buffered/played ranges from the current player state.
     */
    #updateRanges = () => {

        const duration = this.#youtubePlayer?.getDuration?.(),
              current = this.#youtubePlayer?.getCurrentTime?.(),
              fraction = this.#youtubePlayer?.getVideoLoadedFraction?.();

        if (Number.isFinite(duration) && Number.isFinite(current)) {
            this.#state.playedRange = YouTube.#toRange(0, Math.min(current, duration));
        } else {
            this.#state.playedRange = YouTube.#emptyRange;
        }

        if (Number.isFinite(duration) && Number.isFinite(fraction)) {
            this.#state.bufferedRange = YouTube.#toRange(0, Math.min(duration * fraction, duration));
        } else {
            this.#state.bufferedRange = YouTube.#emptyRange;
        }

    };

    /**
     * Maps YouTube player states to Media API events and timers.
     * @param {Object} event  State change payload from YT IFrame API.
     * @fires module:src/core/Media#media/play
     * @fires module:src/core/Media#media/playing
     * @fires module:src/core/Media#media/pause
     * @fires module:src/core/Media#media/ended
     * @fires module:src/core/Media#media/waiting
     * @fires module:src/core/Media#media/ready
     */
    #onStateChange = event => {
        const state = event?.data;

        switch (state) {
            case YouTube.#STATE.PLAYING:
                this.#timeLoop?.start();
                this.#progressLoop?.start();
                this.#state.isPaused = false;
                this.#player.publish('media/play', this.#apiKey);
                this.#player.publish('media/playing', this.#apiKey);
                break;
            case YouTube.#STATE.PAUSED:
                this.#timeLoop?.stop();
                this.#state.isPaused = true;
                this.#player.publish('media/pause', this.#apiKey);
                break;
            case YouTube.#STATE.ENDED:
                this.#timeLoop?.stop();
                if (this.#state.doLoop) {
                    this.#youtubePlayer?.seekTo(0, true);
                    this.#youtubePlayer?.playVideo();
                    break;
                }
                this.#state.isPaused = true;
                this.#progressLoop?.stop();
                this.#player.publish('media/ended', this.#apiKey);
                break;
            case YouTube.#STATE.BUFFERING:
                this.#progressLoop?.start();
                this.#player.publish('media/waiting', this.#apiKey);
                break;
            case YouTube.#STATE.CUED:
                this.#onLoaded();
                break;
            case YouTube.#STATE.UNSTARTED:
                break;
            default:
                break;
        }

    };

    /**
     * Returns the YouTube iframe element.
     * @returns {HTMLIFrameElement|null} The iframe element or null if not mounted.
     */
    #getIFrameElement = () => this.#youtubePlayer?.getIframe?.();

    /**
     * Requests consent before contacting YouTube. When denied, publishes `data/nomedia`
     * and returns a ConsentError so the caller can abort its load path.
     * @returns {Promise<module:src/consent/ConsentError|undefined>} ConsentError when denied, otherwise undefined.
     */
    async #requireConsent() {

        if (await this.#player.consent?.request('youtube', this.#apiKey) ?? true) return;

        this.#player.dom.getElement(this.#apiKey).classList.add('has-no-media');
        this.#player.publish('data/nomedia', this.#apiKey);
        return new ConsentError(this.#player.locale.t('errors.consent.denied', { name: 'YouTube' }));

    }

    /**
     * Enables the YouTube engine.
     * When consent is on, the IFrame API is not loaded here so `setEngine` can finish and
     * `data/ready` can clear the previous item before `#load` shows the overlay.
     */
    async enable() {

        if (!this.#player.consent) {
            this.#scriptLoadPromise = this.#loadLib();
            try {
                await this.#scriptLoadPromise;
            } catch (error) {
                if (error.name === 'AbortError') return; // Cancelled - stop execution
                throw error; // Real error - propagate
            }
        }

        this.#container.mount({ ele: this.#player.dom.getElement(this.#apiKey) });

        this.#state = clone(YouTube.#defaultState);

        const stateFuncs = {
            src: () => this.#youtubePlayer?.getVideoUrl?.(),
            duration: () => this.#youtubePlayer?.getDuration?.() ?? Infinity,
            currentTime: () => this.#youtubePlayer?.getCurrentTime?.() ?? 0,
            remainingTime: () => {
                const dur = this.#youtubePlayer?.getDuration?.(),
                      cur = this.#youtubePlayer?.getCurrentTime?.();
                return Number.isFinite(dur) && Number.isFinite(cur) ? dur - cur : NaN;
            },
            paused: () => this.#state.isPaused,
            ended: () => this.#youtubePlayer?.getPlayerState?.() === YouTube.#STATE.ENDED,
            loop: () => Boolean(this.#state.doLoop),
            volume: () => Number(this.#youtubePlayer?.getVolume?.()) / 100,
            muted: () => this.#state.isMuted, // this.#youtubePlayer?.isMuted?.(),
            playbackRate: () => this.#youtubePlayer?.getPlaybackRate?.(),
            videoWidth: () => this.#youtubePlayer?.getSize?.().width,
            videoHeight: () => this.#youtubePlayer?.getSize?.().height,
            buffered: () => this.#state.bufferedRange || YouTube.#emptyRange,
            played: () => this.#state.playedRange || YouTube.#emptyRange,
            liveStream: () => this.#youtubePlayer?.getVideoData?.()?.isLive || !Number.isFinite(this.#youtubePlayer?.getDuration?.()) || this.#youtubePlayer?.getDuration?.() === 0
        };

        for (const [key, fn] of Object.entries(stateFuncs)) {
            const descriptor = { get: fn, enumerable: true, configurable: true };
            Object.defineProperty(this.#state, key, descriptor);
            this.#player.setState(`media.${key}`, descriptor, this.#apiKey);
        }

    }

    /**
     * Disables the YouTube engine.
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

        this.#youtubePlayer?.destroy?.();
        this.#youtubePlayer = null;
        this.#container.unmount();
        this.#timeLoop?.stop();
        this.#progressLoop?.stop();

    }

    /**
     * This method removes all events, subscriptions and DOM nodes created by this component.
     */
    destroy() {

        this.disable();
        this.#container.destroy();
        this.#player.removeEngine('youtube', this.#apiKey);
        this.#timeLoop?.destroy();
        this.#progressLoop?.destroy();
        // eslint-disable-next-line @stylistic/max-len
        this.#player.removeApi(['youtube:media.load', 'youtube:media.getMetaData', 'youtube:media.canPlay', 'youtube:media.play', 'youtube:media.pause', 'youtube:media.loop', 'youtube:media.playbackRate', 'youtube:media.seek', 'youtube:media.volume', 'youtube:media.mute', 'youtube:media.getElement'], this.#apiKey);
        this.#player = this.#youtubePlayer = this.#metaData = this.#apiKey = this.#timeLoop = this.#progressLoop = null;

    }

    /**
     * Mapping of YouTube IFrame API player states.
     * @type {{UNSTARTED:number, ENDED:number, PLAYING:number, PAUSED:number, BUFFERING:number, CUED:number}}
     */
    static #STATE = {
        UNSTARTED: -1,
        ENDED: 0,
        PLAYING: 1,
        PAUSED: 2,
        BUFFERING: 3,
        CUED: 5
    };

    /**
     * Default state object for the YouTube engine.
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
     * Fallback empty TimeRanges-like object.
     * @type {{length:number, start:Function, end:Function}}
     */
    static #emptyRange = {
        length: 0,
        start: () => NaN,
        end: () => NaN
    };

    /**
     * Creates a minimal TimeRanges-like object for a single range.
     * @param   {number}                                        start  Range start in seconds.
     * @param   {number}                                        end    Range end in seconds.
     * @returns {{length:number, start:Function, end:Function}}        Range accessor.
     */
    static #toRange = (start, end) => {

        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return YouTube.#emptyRange;

        return {
            length: 1,
            start: index => (index === 0 ? start : NaN),
            end: index => (index === 0 ? end : NaN)
        };

    };

    /**
     * Extracts a YouTube video id from a URL.
     * @param   {string}      src  Source URL.
     * @returns {string|null}      Video id if found.
     */
    static #extractVideoId = src => {

        if (typeof src === 'string' && src.startsWith('youtube:')) {
            const directId = src.slice('youtube:'.length).trim();
            return /^[A-Za-z0-9_-]{11}$/.test(directId) ? directId : null;
        }

        let url;
        try {
            url = new URL(src);
        } catch { return null; }

        const host = url.hostname.toLowerCase(),
              isYouTubeHost = host.includes('youtube.com') || host === 'youtu.be';

        if (!isYouTubeHost || url.searchParams.has('list') || url.pathname.startsWith('/playlist')) return null;

        const videoIdFromParam = url.searchParams.get('v'),
              pathSegments = url.pathname.split('/').filter(Boolean),
              videoIdFromPath = host === 'youtu.be' ? pathSegments[0] : pathSegments[1] || pathSegments[0],
              videoId = (videoIdFromParam || videoIdFromPath || '').trim();

        return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;

    };

}
