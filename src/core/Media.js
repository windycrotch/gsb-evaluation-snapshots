import { clone, isNumber } from '../../lib/util/object.js';
import AsyncTask from '../../lib/util/AsyncTask.js';
import ExtendedMediaError from '../util/ExtendedMediaError.js';

/**
 * The Media component is the heart of the player, as it controls the actual video.
 * Also provides the media state and the basic media API to the player, and also wraps the various media events in publish topics.
 * **Note:** this component is **mandatory** and required for normal player operations, so it cannot be switched off.
 * @exports module:src/core/Media
 * @requires lib/util/object
 * @requires lib/util/AsyncTask
 * @requires src/util/ExtendedMediaError
 * @author Frank Kudermann - alphanull
 * @version 1.1.0
 * @license MIT
 */
export default class Media {

    /**
     * Holds the instance configuration for this component.
     * @type     {Object}
     * @property {boolean} [autoPlay=false]           If `true`, the video plays as soon as it is loaded.
     * @property {boolean} [autoMute=true]            If `true`, the player will automatically mute and retry playback if autoplay fails.
     * @property {boolean} [loop=false]               If `true`, the video is loop.
     * @property {boolean} [muted=false]              Sets the initial mute state of the media.
     * @property {number}  [volume=1]                 Sets the initial volume (range 0 to 1).
     * @property {string}  [preload='metadata']       Determines how much of the data is preloaded. Possible values: 'metadata', 'auto' or 'none'. It is strongly recommended to leave this setting as it is, as many components require to have metadata loaded. In addition, not all browsers behave identically here, some seem to simply ignore values like „none“.
     * @property {string}  [crossOrigin='anonymous']  Use 'anonymous' or 'use-credentials' to enable CORS support.
     * @property {number}  [stallTimeout=2]           Timeout (in seconds) after which the stall event is triggered. Use `0` to disable stall checks.
     */
    #config = {
        autoPlay: false,
        autoMute: true,
        loop: false,
        muted: false,
        volume: 1,
        preload: 'metadata',
        crossOrigin: 'anonymous',
        stallTimeout: 2
    };

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Secret key only known to the player instance and initialized components.
     * Used to be able to restrict access to API methods in conjunction with secure mode.
     * @type {symbol}
     */
    #apiKey;

    /**
     * A Map of registered plugins that may handle special media types or override source logic.
     * @type {Map}
     */
    #plugins = new Set();

    /**
     * The current state of the Media. All of its properties should be using a getter, but no setter, so the state is always readonly in effect.
     * Use the players' `getState()` API to read from this object.
     * @type     {Object}
     * @property {string}     src            The current media source URL.
     * @property {number}     width          Original width of the video in pixels.
     * @property {number}     height         Original height of the video in pixels.
     * @property {string}     preload        Preload setting of the media element.
     * @property {number}     networkState   Network state of the media element.
     * @property {number}     readyState     Ready state of the media element.
     * @property {Object}     error          Current error object if any, otherwise this returns 'null'.
     * @property {number}     duration       Total duration of the current media in seconds.
     * @property {number}     currentTime    Current playhead position, in seconds.
     * @property {number}     remainingTime  Current remaining time (duration - currentTime), in seconds.
     * @property {boolean}    paused         Whether the media is currently paused.
     * @property {boolean}    ended          Whether the media has ended.
     * @property {boolean}    loop           Whether looping is enabled.
     * @property {boolean}    muted          Whether the media is muted.
     * @property {number}     volume         The current volume, ranges from 0 (silent) to 1 (full Volume).
     * @property {number}     playbackRate   The current playback speed (1 means normal speed).
     * @property {boolean}    seeking        Whether the media is currently seeking.
     * @property {TimeRanges} seekable       Seekable time ranges.
     * @property {TimeRanges} buffered       Buffered time ranges.
     * @property {TimeRanges} played         Played time ranges.
     * @property {boolean}    liveStream     Whether the media is a live stream.
     * @property {number}     frameRate      The frameRate of the current stream (might not always be available).
     */
    #state = {};

    /**
     * Picture-in-Picture support flags for the current environment.
     * @type {{ supported: boolean, needsWebkit: boolean }}
     */
    #pipSupport = { supported: false, needsWebkit: false };

    /**
     * If loading a new source, the current state may be needed to be restored.
     * If that's the case, the former state is saved in this object.
     * @type     {Object}
     * @property {string}  src             The src of the stream.
     * @property {?number} time            The currentTime value of the former media state.
     * @property {boolean} paused          Set to 'true' if the former media state was paused.
     * @property {boolean} play            If 'true', play when restoring.
     * @property {boolean} ignoreAutoplay  If 'true', ingore autoPlay when restoring.
     */
    #savedState = {
        time: null,
        paused: true
    };

    /**
     * Object containing stall related data.
     * @type     {Object}
     * @property {'clear'|'delaying'|'stalled'} state         Indicates current stall status: can be 'clear', 'delaying', or 'stalled'.
     * @property {number}                       preStallTime  Stores the playback time just before stalling begins, for stall detection logic.
     * @property {number}                       checkId       Timeout id for stall check.
     */
    #stall = {
        state: 'clear',
        preStallTime: -1,
        checkId: -1
    };

    /**
     * Holds metadata information provided by media.load and loaded metadata.
     * @type {module:src/core/Media~metaData}
     */
    #metaData = {};

    /**
     * Reference to the Async Task instance. Used to handle async tasks, which can be cancelled, resolved or rejected.
     * @type {module:lib/util/AsyncTask}
     */
    #loadTask;

    /**
     * The underlying video element.
     * @type {HTMLVideoElement}
     */
    #videoEle = document.createElement('video');

    /**
     * Creates an instance of the Media component.
     * @param  {module:src/core/Player} player            The player instance.
     * @param  {module:src/core/Player} parent            Reference to the parent instance.
     * @param  {Object}                 [options]         Additional options.
     * @param  {symbol}                 [options.apiKey]  Token for extended access to the player API.
     * @throws {Error}                                    If trying to disable this component.
     */
    constructor(player, parent, { apiKey }) {

        this.#config = player.initConfig('media', this.#config);

        if (!this.#config) throw new Error('[Visionplayer] Cannot disable the Media component by configuration.');

        this.#player = player;
        this.#apiKey = apiKey;

        const hasPiP = 'pictureInPictureEnabled' in document,
              needsPiPWebkit = !hasPiP && this.#videoEle.webkitSupportsPresentationMode && typeof this.#videoEle.webkitSetPresentationMode === 'function';

        this.#pipSupport = {
            supported: hasPiP || needsPiPWebkit,
            needsWebkit: !hasPiP && needsPiPWebkit
        };

        this.#player.addEngine('default', this, {
            capabilities: {
                nativeVideoElement: true, // i.e. the <video> element is the native media element
                play: true,
                playbackRate: true,
                loop: true,
                seek: true,
                time: true,
                volume: true,
                title: true,
                subtitles: true,
                cast: true,
                pictureInPicture: this.#pipSupport.supported,
                analyseVideo: true,
                analyseAudio: true,
                filterVideo: true,
                filterAudio: true
            }
        }, this.#apiKey);

        [
            ['default:media.load', this.#load],
            ['default:media.getMetaData', this.#getMetaData],
            ['default:media.canPlay', this.canPlay],
            ['default:media.play', this.#play],
            ['default:media.pause', this.#pause],
            ['default:media.loop', this.#loop],
            ['default:media.playbackRate', this.#playbackRate],
            ['default:media.seek', this.#seek],
            ['default:media.volume', this.#volume],
            ['default:media.mute', this.#mute],
            ['default:media.getElement', this.#getMediaElement],
            this.#pipSupport.supported ? ['default:media.requestPictureInPicture', this.#requestPictureInPicture] : null,
            this.#pipSupport.supported ? ['default:media.exitPictureInPicture', this.#exitPictureInPicture] : null
        ].filter(Boolean).map(([name, handler]) => this.#player.setApi(name, handler, this.#apiKey));

    }

    /**
     * In essence, this is just a wrapper for the media elements' 'canPlay' method.
     * @param   {module:src/core/Media~metaData} metaData  The data to test.
     * @returns {string}                                   Results are: 'probably': The specified media type appears to be playable. 'maybe': Cannot tell if the media type is playable without playing it. '' (empty string): The specified media type definitely cannot be played.
     */
    canPlay(metaData) {

        // check plugins first
        for (const plugin of this.#plugins) {
            const result = plugin?.canPlay(metaData);
            if (result === 'maybe' || result === 'probably') return result;
        }

        // fallback to default if no plugin can handle this
        return metaData.drmSystem ? '' : this.#videoEle.canPlayType(metaData.mimeType);

    }

    /**
     * Registers a new plugin. Plugins can 'takeover' certain functions, esp media.load to add their own functionality
     * Used by Components like Dash or Hls.
     * @param {Object} plugin  The plugin to add.
     */
    registerPlugin(plugin) {

        this.#plugins.add(plugin);

    }

    /**
     * UNRegisters a plugin.
     * @param {Object} plugin  The plugin to remove.
     */
    unregisterPlugin(plugin) {

        this.#plugins.delete(plugin);

    }

    /**
     * Wires Media to core player events, mainly to track stall state.
     * Subscribes once and stores the unsubscribe callbacks for cleanup.
     */
    #setupSubscriptions = () => {

        this.#subscriptions = [
            ['data/ready', this.#onDataReady],
            ['data/ready', this.#onStallEnd],
            ['data/nomedia', this.#removeElement],
            ['media/ready', this.#onStallEnd],
            ['media/pause', this.#onStallEnd],
            ['media/playing', this.#onStallEnd],
            ['media/waiting', this.#onStall],
            ['media/play', this.#onStall]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

    };

    /**
     * Sets up the engine as soon as the media data is available.
     * @listens module:src/core/Data#data/ready
     */
    #onDataReady = () => {

        // before executing new requests, cancel the previous one first.
        if (this.#loadTask?.status === 'pending') this.#loadTask.cancel().catch(() => {});

        // we have to completely rebuild the video element, or else TextTracks will be retained when switching source
        this.#removeElement();

        this.#videoEle = document.createElement('video');
        this.#videoEle.className = 'vip-media-ele';
        this.#videoEle.id = 'vip-engine-video';
        this.#videoEle.preload = this.#config.preload || 'metadata';
        this.#videoEle.setAttribute('x-webkit-airplay', 'allow');
        this.#videoEle.setAttribute('playsInline', 'playsInline');
        if (this.#config.crossOrigin) this.#videoEle.crossOrigin = this.#config.crossOrigin;

        this.#enableElement();

        this.#loop(this.#config.loop);
        this.#mute(this.#config.muted);
        this.#volume(this.#config.volume);

        this.#savedState = { time: 0, paused: true };

    };

    /**
     * Sets a new source for the media, in effect loading the video or audio. May delegate to plugins for formats with certain mine types and / or extensions.
     * @param   {module:src/core/Media~metaData}         metaData   The source to load.
     * @param   {module:src/core/Media~mediaLoadOptions} [options]  Options to control additional behavior.
     * @returns {Promise}                                           A promise that resolves with the loaded metadata or rejects with the resulting media error.
     */
    #load = async(metaData = {}, options = {}) => {

        const {
                  rememberState = false,
                  ignoreAutoplay = false,
                  play,
                  paused = true,
                  seek = 0,
                  volume = 1,
                  muted = false,
                  pictureInPicture = false } = options,
              { src } = metaData,
              prevTask = this.#loadTask;

        // prevent double loading of the same resource, just reuse the pending promise instead
        if (src && src === this.#metaData?.src && prevTask?.status === 'pending') return prevTask.promise;
        // before executing new requests, cancel the previous one first.
        if (prevTask?.status === 'pending') await prevTask.cancel().catch(() => {});

        this.#metaData = metaData;
        this.#loadTask = new AsyncTask();

        this.#videoEle.removeEventListener('loadedmetadata', this.#onLoaded);
        this.#videoEle.addEventListener('loadedmetadata', this.#onLoaded);

        this.#savedState = {
            src,
            ignoreAutoplay,
            time: rememberState ? this.#state.currentTime : seek,
            paused: rememberState ? this.#state.paused : typeof play === 'boolean' ? !play : paused,
            volume: rememberState ? this.#state.volume : volume,
            muted: rememberState ? this.#state.muted : muted,
            pictureInPicture: rememberState ? this.#state.pictureInPicture : pictureInPicture
        };

        // any stall detection from the former source must not carry over to the new load
        clearTimeout(this.#stall.checkId);
        this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
        this.#stall.state = 'clear';
        this.#stall.preStallTime = -1;

        // try plugins first for a suitable handler
        for (const plugin of this.#plugins) {
            if (!plugin.canPlay(metaData)) continue;
            options.loadTask = this.#loadTask;
            return await plugin.load(metaData, options);
        }

        // no plugins found to handle? OK, so lets try the default native handling
        this.#videoEle.src = src;
        this.#videoEle.load();
        this.#volume(volume);

        return this.#loadTask.promise;

    };

    /**
     * This method is called when a new source was successfully loaded.
     * If saved state is found, it also tries to restore the former state (like the currentTime by seeking).
     * @fires module:src/core/Media#media/ready
     */
    #onLoaded = () => {

        this.#videoEle.removeEventListener('loadedmetadata', this.#onLoaded);

        // check if plugins provide a hook to add more media metadata
        for (const plugin of this.#plugins) {
            if (!plugin.canPlay(this.#metaData) || !plugin.onLoaded) continue;
            plugin.onLoaded(this.#metaData);
            break;
        }

        if (typeof this.#metaData.duration === 'undefined') this.#metaData.duration = this.#videoEle.duration;
        this.#metaData.width = this.#videoEle.videoWidth;
        this.#metaData.height = this.#videoEle.videoHeight;

        this.#player.publish('media/ready', clone(this.#metaData), this.#apiKey);
        // AsyncTask resolves only while pending, so a late event of a cancelled load is a no-op
        this.#loadTask.resolve(clone(this.#metaData));

        if (this.#savedState.time > 0 && this.#state.seekable.length && !this.#state.liveStream) {
            this.#seek(this.#savedState.time);
        }

        if (this.#savedState.pictureInPicture === true) {
            this.#requestPictureInPicture();
        }

        if (this.#savedState.muted === true) {
            this.#mute(true);
        }

        if (/* this.#savedState.time === -1 ||  */this.#savedState.paused !== true) {
            this.#play();
        } else if (this.#config.autoPlay && !this.#savedState.ignoreAutoplay) {
            this.#play().catch(() => {
                if (this.#config.autoMute) {
                    this.#mute(true);
                    this.#play().catch();
                }
            });
        }

    };

    /**
     * Returns a cpoy of the current media metadata.
     * @returns {module:src/core/Media~metaData} Object with current metadata.
     */
    #getMetaData = () => clone(this.#metaData);

    /**
     * Starts playing the media.
     * @returns {Promise|undefined} If browser supports it, returns the play() promise.
     */
    #play = () => {

        const promise = this.#videoEle.play();
        // eslint-disable-next-line no-console
        promise?.catch(() => console.warn('[VisionPlayer] Play was prevented, probably due to autoplay restrictions.'));
        return promise;

    };

    /**
     * Pauses the current media.
     */
    #pause = () => {

        this.#videoEle.pause();

    };

    /**
     * Disables or enables looping.
     * @param {boolean} doLoop  If `true`, media is looping.
     * @fires module:src/core/Media#media/loop
     */
    #loop = doLoop => {

        this.#videoEle.loop = this.#config.loop = doLoop;
        this.#player.publish('media/loop', this.#apiKey);

    };

    /**
     * Changes current playback rate.
     * @param {number} rate  The new rate to set.
     */
    #playbackRate = rate => {

        this.#videoEle.playbackRate = Number(rate);

    };

    /**
     * Seeks the media to the specified position. This method also tries to mitigate rounding errors when frame precise seeking is required.
     * @param {number} position  The position (measured in seconds) to seek to.
     */
    #seek = position => {

        // try to round seektime to nearest frame if frameRate is detected
        // should work around rounding errors with some browsers
        const frameRate = this.#player.getState('media.frameRate'),
              duration = this.#player.getState('media.duration');

        let seekTime = frameRate
            ? Math.round(Number(position) * frameRate) / frameRate + 0.00001
            : Number(position);

        if (seekTime > duration) seekTime = duration - 0.00001;

        try {
            this.#videoEle.currentTime = Math.max(seekTime, 0);
        } catch (e) {
            console.warn(`[VisionPlayer] invalid seek value: ${position}.`, { cause: e }); // eslint-disable-line no-console
        }

    };

    /**
     * Sets a new volume.
     * @param {number} vol  The new volume, number should be in the range of 0...1.
     */
    #volume = vol => {

        if (!isNumber(Number(vol))) return;
        this.#videoEle.volume = this.#config.volume = Number(vol);

    };

    /**
     * Mutes, or unmutes the media.
     * @param {boolean} doMute  If `true`, media is muted, otherwise it is unmuted.
     */
    #mute = doMute => {

        this.#videoEle.muted = this.#config.muted = Boolean(doMute);

    };

    /**
     * Requests Picture-in-Picture if supported.
     * @returns {Promise<void>}
     */
    #requestPictureInPicture = async() => {

        try {
            if (this.#pipSupport.needsWebkit) {
                this.#videoEle.webkitSetPresentationMode('picture-in-picture');
            } else {
                await this.#videoEle.requestPictureInPicture();
            }
        } catch {}

    };

    /**
     * Exits Picture-in-Picture if active.
     * @returns {Promise<void>}
     */
    #exitPictureInPicture = async() => {

        try {
            if (this.#pipSupport.needsWebkit) {
                this.#videoEle.webkitSetPresentationMode('inline');
            } else if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            }
        } catch {}

    };

    /**
     * Called when certain events indicate the stream might be stalling (e.g. Waiting, play).
     * @listens module:src/core/Media#media/waiting
     * @listens module:src/core/Media#media/play
     */
    #onStall = () => {

        // stallTimeout of 0 disables stall checks entirely
        if (!this.#config.stallTimeout) return;
        // do not (re)start detection while paused, AirPlay casting, or a check is already running
        if (this.#state.paused || this.#player.getState('media.airPlayActive')) return;
        if (this.#stall.state === 'delaying' || this.#stall.state === 'stalled') return;

        this.#stall.preStallTime = this.#state.currentTime;

        const delayCheck = () => {

            clearTimeout(this.#stall.checkId);

            // playback resumed before the timeout elapsed, so there is no stall
            if (Math.abs(this.#state.currentTime - this.#stall.preStallTime) > 0.2) {
                this.#stall.state = 'clear';
                this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
                return;
            }
            // prevent AirPlay stalling in certain situations (eg casting a live stream)
            if (this.#player.getState('media.airPlayActive') || this.#state.paused) {
                this.#stall.state = 'clear';
                this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
                return;
            }
            // playhead hasnt moved more than 0.2 seconds within the timeout window, so it seems we are stalled
            this.#stall.state = 'stalled';
            this.#player.publish('media/stall/begin', this.#apiKey);

        };

        this.#stall.state = 'delaying';
        clearTimeout(this.#stall.checkId);
        this.#stall.checkId = setTimeout(delayCheck, this.#config.stallTimeout * 1000);
        this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
        this.#player.subscribe('media/timeupdate', this.#onStallEnd);

    };

    /**
     * Called when events suggest the stalling might have ended (e.g. Timeupdate, pause, data/ready).
     * @listens module:src/core/Media#media/pause
     * @listens module:src/core/Media#media/ready
     * @listens module:src/core/Media#media/playing
     * @listens module:src/core/Media#media/timeupdate
     * @listens module:src/core/Data#data/ready
     */
    #onStallEnd = () => {

        // recovery means the playhead advanced more than 0.2 seconds since the stall began, or playback was paused
        if (this.#stall.state !== 'clear' && (this.#state.currentTime - this.#stall.preStallTime > 0.2 || this.#state.paused)) {
            // end is published only once, and only if a begin was actually fired
            if (this.#stall.state === 'stalled') this.#player.publish('media/stall/end', this.#apiKey);
            clearTimeout(this.#stall.checkId);
            this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
            this.#stall.preStallTime = -1;
            this.#stall.state = 'clear';
        }

    };

    /**
     * This listens to native media events and sends them through the pubsub library in order to abstract and wrap the native HTML5 media events.
     * Any components should avoid listening to the native event directly on the video element, but subscribe to the various events emitted here.
     * @param {Event} event  The native HTML5 media event.
     * @fires module:src/core/Media#media/abort
     * @fires module:src/core/Media#media/canplay
     * @fires module:src/core/Media#media/canplaythrough
     * @fires module:src/core/Media#media/durationchange
     * @fires module:src/core/Media#media/emptied
     * @fires module:src/core/Media#media/ended
     * @fires module:src/core/Media#media/error
     * @fires module:src/core/Media#media/loadeddata
     * @fires module:src/core/Media#media/loadedmetadata
     * @fires module:src/core/Media#media/loadstart
     * @fires module:src/core/Media#media/play
     * @fires module:src/core/Media#media/pause
     * @fires module:src/core/Media#media/progress
     * @fires module:src/core/Media#media/ratechange
     * @fires module:src/core/Media#media/seeked
     * @fires module:src/core/Media#media/seeking
     * @fires module:src/core/Media#media/stalled
     * @fires module:src/core/Media#media/suspend
     * @fires module:src/core/Media#media/timeupdate
     * @fires module:src/core/Media#media/volumechange
     * @fires module:src/core/Media#media/waiting
     * @fires module:src/core/Media#media/webkitbeginfullscreen
     * @fires module:src/core/Media#media/webkitendfullscreen
     */
    #onStreamEvent = async event => {

        const { type } = event;

        if (type === 'timeupdate' && (isNaN(this.#videoEle.duration) || !isFinite(this.#videoEle.duration))) {
            // prevent chrome from firing timeupdates when medium is not loaded yet
            return;
        }

        if (type !== 'error') {
            this.#player.publish(`media/${type}`, this.#apiKey);
            return;
        }

        // Fire a pause event in case an error occurred (Because native engines seem to forget that!)
        this.#player.publish('media/pause', this.#apiKey);

        const error = await this.#classifyStreamError(event);

        // classification was aborted because the load was cancelled, so nothing to report
        if (!error) return;

        const loadTask = this.#loadTask;

        this.#player.publish('media/error', { error }, this.#apiKey);
        if (loadTask?.status === 'pending') loadTask.reject(error);

    };

    /**
     * Normalizes a native media error into either a network error (code 2, carrying HTTP status or reason)
     * or an unsupported-format error (code 4). A 'MEDIA_ERR_SRC_NOT_SUPPORTED' on a non blob: URL is
     * probed with a HEAD request first, because browsers often report unreachable or CORS-blocked
     * resources as unsupported format.
     * @param   {Event}                          event  The native error event.
     * @returns {Promise<ExtendedMediaError|MediaError>}  The classified error.
     */
    #classifyStreamError = async event => {

        const error = event.error || event.target.error || {},
              src = this.#metaData?.src || this.#player.getState('media.src') || '';

        // native network errors (e.g. connection loss) stay network errors, enriched with a reason
        if (error.code === ExtendedMediaError.MEDIA_ERR_NETWORK) {
            if (error instanceof ExtendedMediaError) return error;
            return new ExtendedMediaError(ExtendedMediaError.MEDIA_ERR_NETWORK, {
                message: error.message || 'Network error while loading media.',
                cause: error
            });
        }

        const isUnsupported = error.code === ExtendedMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;

        // format error on blob: URLs cannot be re-validated over HTTP, and other codes (abort/decode/drm) pass through unchanged
        if (!isUnsupported || src.startsWith('blob:')) return error;

        // the browser claims the format is unsupported - verify whether the resource is actually reachable first
        let response;

        try {
            response = await fetch(src, { method: 'HEAD', signal: this.#loadTask?.signal });
        } catch (e) {
            // a cancelled load must not produce any error classification
            if (e.name === 'AbortError') return null;
            // request failed without response, most likely a CORS issue, but still counts as a network error
            return new ExtendedMediaError(ExtendedMediaError.MEDIA_ERR_NETWORK, { message: e.message, cause: e });
        }

        // definitely an http error, so switch errors with a more appropriate (synthetic) one
        if (response.status >= 300) {
            return new ExtendedMediaError(ExtendedMediaError.MEDIA_ERR_NETWORK, { status: response.status, message: `HTTP ERROR: ${response.status}` });
        }

        // resource is reachable, so the browser was right: the format is genuinely not supported
        return error instanceof ExtendedMediaError
            ? error
            : new ExtendedMediaError(ExtendedMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, { message: error.message || 'Media format not supported.', cause: error });

    };

    /**
     * Used by components to retrieve the video element.
     * @param   {symbol}      apiKey  Token needed to grant access in secure mode.
     * @returns {HTMLElement}         The element designated by the component as attachable container.
     * @throws  {Error}               If safe mode access was denied.
     */
    #getMediaElement = apiKey => {

        if (this.#apiKey && this.#apiKey !== apiKey) throw new Error('[Visionplayer] Secure mode: access denied.');
        return this.#videoEle;

    };

    /**
     * Enables the media element, ie adds event listeners and sets the state functions.
     */
    #enableElement = () => {

        Media.#eventList.forEach(eventName => {
            this.#videoEle.addEventListener(eventName, this.#onStreamEvent);
        });

        if (!this.#videoEle.parentElement) this.#player.dom.getElement(this.#apiKey).appendChild(this.#videoEle);

        const stateFuncs = {
            src: () => this.#videoEle.src,
            videoWidth: () => this.#videoEle.videoWidth,
            videoHeight: () => this.#videoEle.videoHeight,
            preload: () => this.#videoEle.preload,
            networkState: () => this.#videoEle.networkState,
            readyState: () => this.#videoEle.readyState,
            error: () => this.#videoEle.error,
            duration: () => this.#videoEle.duration,
            currentTime: () => this.#videoEle.currentTime,
            remainingTime: () => this.#videoEle.duration - this.#videoEle.currentTime,
            paused: () => this.#videoEle.paused,
            ended: () => this.#videoEle.ended,
            loop: () => Boolean(this.#videoEle.loop),
            volume: () => this.#videoEle.volume,
            muted: () => this.#videoEle.muted,
            playbackRate: () => this.#videoEle.playbackRate,
            seeking: () => this.#videoEle.seeking,
            seekable: () => this.#videoEle.seekable,
            buffered: () => this.#videoEle.buffered,
            played: () => this.#videoEle.played,
            frameRate: () => this.#metaData?.frameRate,
            bitRate: () => this.#metaData?.bitRate,
            stalled: () => this.#stall.state === 'stalled',
            liveStream: () => this.#videoEle.dataset.isLive === 'true' || Boolean(this.#state.mediaReady && (isNaN(this.#videoEle.duration) || !isFinite(this.#videoEle.duration))),
            pictureInPicture: () => {
                if (!this.#pipSupport.supported || !this.#videoEle) return false;
                if (this.#pipSupport.needsWebkit) return this.#videoEle.webkitPresentationMode === 'picture-in-picture';
                return document.pictureInPictureElement === this.#videoEle;
            }
        };

        for (const [key, fn] of Object.entries(stateFuncs)) {
            const descriptor = { get: fn, enumerable: true, configurable: true };
            Object.defineProperty(this.#state, key, descriptor);
            this.#player.setState(`media.${key}`, descriptor, this.#apiKey);
        }
    };

    /**
     * Disables the media element, ie removes all event listeners and clears the state.
     */
    #disableElement = () => {

        if (this.#state.pictureInPicture) {
            this.#exitPictureInPicture().then(() => {
                this.#player.publish('media/leavepictureinpicture', this.#apiKey);
            });
        }

        Object.keys(this.#state).forEach(key => {
            this.#player.removeState(`media.${key}`, this.#apiKey);
            delete this.#state[key];
        });

        Media.#eventList.forEach(eventName => {
            this.#videoEle.removeEventListener(eventName, this.#onStreamEvent);
        });

        clearTimeout(this.#stall.checkId);
        this.#stall.checkId = -1;
        this.#player.unsubscribe('media/timeupdate', this.#onStallEnd);
        this.#videoEle.removeEventListener('loadedmetadata', this.#onLoaded);

    };

    /**
     * Removes the old media element, unsubscribes from native events, and clears state.
     */
    #removeElement = () => {

        this.#disableElement();
        this.#videoEle.querySelectorAll('track').forEach(track => track.remove());
        this.#videoEle.remove();

    };

    /**
     * Enables the media engine.
     * @param {Object}  options         The options for the enable method.
     * @param {boolean} options.resume  If `true`, the media will be resumed.
     * @param {Object}  options.params  The parameters for the enable method.
     */
    enable({ resume, params } = { params: {} }) {

        this.#setupSubscriptions();
        this.#enableElement();

        if (resume) {
            // has source changed?
            const currentSource = this.#player.data.getPreferredMetaData();

            this.#player.media.volume(this.#videoEle.volume);
            this.#player.publish('media/volumechange', this.#apiKey);

            if (params.playbackRate !== this.#state.playbackRate) this.#playbackRate(params.playbackRate);

            if (currentSource.src === this.#videoEle.src) {
                if (params.seek) this.#seek(params.seek);
                if (!params.paused) this.#play();
            } else {
                this.#load(currentSource, { seek: params.seek, ignoreAutoplay: true, play: !params.paused });
            }
        }
    }

    /**
     * Disables the media engine.
     * @param {Object}  options          The options for the disable method.
     * @param {boolean} options.suspend  If `true`, the media will be suspended.
     */
    disable({ suspend } = {}) {

        this.#pause();
        if (suspend) this.#disableElement(); else this.#removeElement();
        this.#player.unsubscribe(this.#subscriptions);
        this.#loadTask?.cancel().catch(() => { });

    }

    /**
     * This method removes all events, subscriptions and DOM nodes created by this component.
     */
    destroy() {

        this.disable();
        this.#player.removeEngine('default', this.#apiKey);
        // eslint-disable-next-line @stylistic/max-len
        this.#player.removeApi(['default:media.load', 'default:media.getMetaData', 'default:media.canPlay', 'default:media.play', 'default:media.pause', 'default:media.loop', 'default:media.playbackRate', 'default:media.seek', 'default:media.volume', 'default:media.mute', 'default:media.getElement', 'default:media.requestPictureInPicture', 'default:media.exitPictureInPicture'], this.#apiKey);
        this.#player = this.#videoEle = this.#state = this.#plugins = this.#metaData = this.#apiKey = null;

    }

    /**
     * This is a list of supported events by this engine. Corresponds to the HTML5 media event names.
     * @static
     * @type {string[]}
     */
    static #eventList = [
        'abort',
        'canplay',
        'canplaythrough',
        'durationchange',
        'emptied',
        'ended',
        'error',
        'loadeddata',
        'loadedmetadata',
        'loadstart',
        'play',
        'playing',
        'pause',
        'progress',
        'ratechange',
        'seeked',
        'seeking',
        'stalled',
        'suspend',
        'timeupdate',
        'volumechange',
        'waiting',
        'enterpictureinpicture',
        'leavepictureinpicture',
        'webkitbeginfullscreen',
        'webkitendfullscreen',
        'encrypted',
        'waitingforkey'
    ];

}

/**
 * Fired when media is 'ready', i.e. A source has been loaded and metadata is available.
 * @event  module:src/core/Media#media/ready
 * @param {module:src/core/Media~metaData} metaData  The currently selected media meta data.
 */

/**
 * This corresponds to the standard HTML5 media 'abort' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/abort
 */

/**
 * This corresponds to the standard HTML5 media 'canplay' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/canplay
 */

/**
 * This corresponds to the standard HTML5 media 'canplaythrough' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/canplaythrough
 */

/**
 * This corresponds to the standard HTML5 media 'error' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/error
 */

/**
 * This corresponds to the standard HTML5 media 'durationchange' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/durationchange
 */

/**
 * This corresponds to the standard HTML5 media 'emptied' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/emptied
 */

/**
 * This corresponds to the standard HTML5 media 'ended' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/ended
 */

/**
 * This corresponds to the standard HTML5 media 'loadstart' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/loadstart
 */

/**
 * This corresponds to the standard HTML5 media 'loadeddata' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/loadeddata
 */

/**
 * This corresponds to the standard HTML5 media 'loadedmetadata' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/loadedmetadata
 */

/**
 * This corresponds to the standard HTML5 media 'play' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/play
 */

/**
 * This corresponds to the standard HTML5 media 'pause' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/pause
 */

/**
 * This corresponds to the standard HTML5 media 'playing' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/playing
 */

/**
 * This corresponds to the standard HTML5 media 'progress' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/progress
 */

/**
 * This corresponds to the standard HTML5 media 'ratechange' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/ratechange
 */

/**
 * This corresponds to the standard HTML5 media 'seeked' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/seeked
 */

/**
 * This corresponds to the standard HTML5 media 'seeking' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/seeking
 */

/**
 * This corresponds to the standard HTML5 media 'stalled' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/stalled
 */

/**
 * This corresponds to the standard HTML5 media 'suspend' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/suspend
 */

/**
 * This corresponds to the standard HTML5 media 'timeupdate' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/timeupdate
 */

/**
 * This corresponds to the standard HTML5 media 'volumechange' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/volumechange
 */

/**
 * This corresponds to the standard HTML5 media 'waiting' event (wrapped by the pubsub engine).
 * @event  module:src/core/Media#media/waiting
 */

/**
 * This event is fired when looping starts or ends.
 * @event  module:src/core/Media#media/loop
 */

/**
 * This event is fired by iOS only, when the media tag enters fullscreen.
 * (On these systems, only the media itself can enter fullscreen, not an arbitrary HTML element).
 * @event  module:src/core/Media#media/webkitbeginfullscreen
 */

/**
 * This event is fired by iOS only, when the media tag leaves fullscreen.
 * (On these systems, only the media itself can enter fullscreen, not an arbitrary HTML element).
 * @event  module:src/core/Media#media/webkitendfullscreen
 */

/**
 * This event is fired when the media enters Picture in Picture mode.
 * @event  module:src/core/Media#media/enterpictureinpicture
 */

/**
 * This event is fired when the media leaves Picture in Picture mode.
 * @event  module:src/core/Media#media/leavepictureinpicture
 */

/**
 * Fired when media playback begins to stall, usually because bandwidth is not sufficient to achieve continuous playback, or also if the buffer is not filled with data yet.
 * Note that there are similar media events like 'stalled', but these are not really reliable and browser implementation varies.
 * This event tries to solve these inconsistencies and should also cover edge cases the browser don't handle.
 * @event  module:src/core/Media#media/stall/begin
 */

/**
 * Fired when media playback has recovered from stalling and is playing (or playable when paused) again.
 * @event  module:src/core/Media#media/stall/end
 */

/**
 * The mediaSource is a representation of the currently selected media source.
 * @typedef  {Object} module:src/core/Media~metaData
 * @property {string}          src                   The source url of the video (can be absolute, relative or blob:).
 * @property {'video'|'audio'} mediaType             The type of the current media (currently 'video' or 'audio' is supported).
 * @property {string}          mimeType              The mimetype, optionally extended with codec param if available.
 * @property {Object[]}        [encodings]           Available additional encodings.
 * @property {string}          encodings.src         Contains the  encodings' Source.
 * @property {string}          [encodings.mimeType]  Contains the encodings' Mime-Type.
 * @property {number}          [width]               Width of the video in pixel.
 * @property {number}          [height]              Height of the video in pixel.
 * @property {number}          [frameRate]           Framerate of the video (might not always be available).
 * @property {number}          [bitRate]             Bitrate of the video (might not always be available).
 * @property {string}          [language]            The language of the current media.
 * @property {string|number}   [langId]              The language id of the current media.
 * @property {string}          [langName]            The language (extended) name of the current media.
 */

/**
 * @typedef  {Object}  module:src/core/Media~mediaLoadOptions
 * @property {boolean} [rememberState=false]   If `true`, player will attempt to restore seek position and play state after setting the new source. Useful for lang / quality switches.
 * @property {boolean} [ignoreAutoplay=false]  If `true`, player does NOT autoplay if player was paused during the switch.
 * @property {boolean} [play=false]            If `true`, stream is automatically played after switching, ignoring the play state before switch.
 * @property {number}  [seek=0]                If `number`, stream is seeked to the specified position after loading.
 */
