import DomSmith from '../../lib/dom/DomSmith.js';

/**
 * The PlayOverlay component displays a large play button centered in the viewport, allowing the user to toggle media playback.
 * It dynamically hides or shows itself in response to player events and can optionally dim the background when paused.
 * The overlay can be shown only once after media load, based on configuration.
 * @exports module:src/controller/PlayOverlay
 * @requires lib/dom/DomSmith
 * @author   Frank Kudermann - alphanull
 * @version  1.2.0
 * @license  MIT
 */
export default class PlayOverlay {

    /**
     * Holds the instance configuration.
     * @type     {Object}
     * @property {boolean} [dimmer=false]    If enabled, dims the viewport background when paused.
     * @property {boolean} [showOnce=false]  If enabled, shows the overlay only once after the media has loaded.
     */
    #config = {
        dimmer: false,
        showOnce: false
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
     * Token of the permanent subscription to engine switch requests.
     * @type {number}
     */
    #engineSetSub;

    /**
     * Token of the subscription to failed engine switches.
     * @type {number}
     */
    #engineFailedSub;

    /**
     * Whether the capability-bound subscriptions are currently active. Guarantees that re-entering the same
     * capability state does not accumulate subscriptions.
     * @type {boolean}
     */
    #capabilitySubsActive = false;

    /**
     * Set to `true` once {@link module:src/controller/PlayOverlay#destroy} ran, so late (async) events become no-ops
     * instead of touching detached DOM.
     * @type {boolean}
     */
    #destroyed = false;

    /**
     * Reference to the DomSmith Instance for the UI element.
     * @type {module:lib/dom/DomSmith}
     */
    #overlay;

    /**
     * Internal disabled flag to track whether the overlay is currently active.
     * @type {boolean}
     */
    #isDisabled = false;

    /**
     * Creates an instance of the PlayOverlay component.
     * @param {module:src/core/Player} player  Reference to the VisionPlayer instance.
     * @param {module:src/ui/UI}       parent  Reference to the parent instance, in this case the UI component.
     */
    constructor(player, parent) {

        this.#config = player.initConfig('playOverlay', this.#config);

        if (!this.#config) return [false];

        this.#player = player;

        const domConfig = {
            _ref: 'wrapper',
            className: 'vip-play-overlay is-hidden',
            style: 'display: none;',
            'data-sort': 50,
            _nodes: []
        };

        if (!this.#player.getConfig('media.autoPlay') || !this.#config.showOnce) {
            domConfig._nodes.push({
                className: 'icon-bg',
                _nodes: [{
                    _ref: 'button',
                    _tag: 'button',
                    className: 'play icon',
                    ariaLabel: this.#player.locale.t('commands.play'),
                    pointerup: this.#togglePlay
                }]
            });
        }

        if (this.#config.dimmer) domConfig._nodes.push({ className: 'vip-play-overlay-dimmer' });

        this.#overlay = new DomSmith(domConfig, parent.getElement());

        this.#engineSetSub = this.#player.subscribe('player/engine/set', this.#onEngineSet);
        this.#engineFailedSub = this.#player.subscribe('player/engine/switchfailed', this.#onEngineSwitchFailed);

    }

    /**
     * Invoked when the media has loaded and metadata is available.
     * @listens module:src/core/Media#media/ready
     */
    #onMediaReady = () => {

        if (this.#destroyed) return;

        this.#isDisabled = false;

        if (this.#player.getState('media.paused') === false) this.#onPlay();
        else this.#onPause();

    };

    /**
     * This method toggles play / pause.
     */
    #togglePlay = () => {

        if (this.#destroyed || this.#isDisabled) return;

        if (this.#player.getState('media.paused')) this.#player.media.play();
        else this.#player.media.pause();

    };

    /**
     * This method switches the appearance of the play button to the 'play' state.
     * @listens module:src/core/Media#media/play
     */
    #onPlay = () => {

        if (this.#destroyed || this.#isDisabled) return;

        if (this.#config.showOnce) this.#isDisabled = true;
        this.#overlay.wrapper.classList.add('is-hidden');

    };

    /**
     * This method switches the appearance of the play button to the 'pause' state.
     * @listens module:src/core/Media#media/pause
     */
    #onPause = () => {

        if (this.#destroyed || this.#isDisabled) return;

        this.#overlay.wrapper.classList.remove('is-hidden');

    };

    /**
     * Invoked when an engine switch is requested. Manages the capability-bound subscriptions as paired
     * add/remove operations, so repeated switches never accumulate subscriptions.
     * @param {Object} data          The event data.
     * @param {Object} data.from     The previous engine.
     * @param {Object} data.to       The new engine.
     * @param {Object} data.options  The options for the engine switch.
     * @listens module:src/core/Player#player/engine/set
     */
    #onEngineSet = ({ from, to, options }) => {

        if (this.#destroyed) return;

        if (!from.capabilities.play && to.capabilities.play) {
            if (options.resume) {
                this.#enable();
            } else {
                this.#overlay.wrapper.style.display = '';
                this.#addCapabilitySubscriptions();
            }
        }

        if (from.capabilities.play && !to.capabilities.play) {
            if (options.suspend) {
                this.#disable();
            } else {
                this.#overlay.wrapper.style.display = 'none';
                this.#removeCapabilitySubscriptions();
            }
        }

    };

    /**
     * Invoked when an engine switch failed and the player rolled back to the previously active engine.
     * Reconciles the overlay with the engine that is actually current.
     * @param {Object} data       The event data.
     * @param {Object} data.from  The engine that remained active after rollback.
     * @listens module:src/core/Player#player/engine/switchfailed
     */
    #onEngineSwitchFailed = ({ from }) => {

        if (this.#destroyed) return;

        if (from.capabilities.play) {

            this.#overlay.wrapper.style.display = '';
            this.#addCapabilitySubscriptions();

            if (this.#player.getState('media.paused') === false) this.#onPlay();
            else this.#onPause();

            this.#enable();

        } else {

            this.#overlay.wrapper.style.display = 'none';
            this.#removeCapabilitySubscriptions();
            this.#disable();

        }

    };

    /**
     * Adds the capability-bound subscriptions once. Is idempotent: calling it while the subscriptions are
     * already active is a no-op, so re-entering the same capability state cannot stack duplicates.
     */
    #addCapabilitySubscriptions() {

        if (this.#capabilitySubsActive || this.#destroyed) return;

        this.#subscriptions = [
            ['media/ready', this.#onMediaReady],
            ['media/play', this.#onPlay],
            ['media/pause', this.#onPause],
            ['media/canplay', this.#enable],
            ['media/error', this.#disable],
            ['data/nomedia', this.#disable]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

        this.#capabilitySubsActive = true;

    }

    /**
     * Removes the capability-bound subscriptions added by {@link module:src/controller/PlayOverlay#addCapabilitySubscriptions}.
     * Is idempotent and safe to call when no subscriptions are active.
     */
    #removeCapabilitySubscriptions() {

        if (!this.#capabilitySubsActive) return;

        this.#player.unsubscribe(this.#subscriptions);
        this.#subscriptions = null;
        this.#capabilitySubsActive = false;

    }

    /**
     * This method enables the play button.
     * @listens module:src/core/Media#media/canplay
     */
    #enable = () => {

        if (this.#destroyed) return;

        if (this.#isDisabled && this.#config.showOnce) return;

        this.#isDisabled = false;
        if (this.#overlay.button) this.#overlay.button.disabled = false;
        this.#overlay.wrapper.classList.remove('is-disabled');

    };

    /**
     * This method disables the play button, for example after an error occurred.
     * @listens module:src/core/Media#media/error
     * @listens module:src/core/Data#data/nomedia
     */
    #disable = () => {

        if (this.#destroyed) return;

        this.#isDisabled = true;
        if (this.#overlay.button) this.#overlay.button.disabled = true;
        this.#overlay.wrapper.classList.add('is-disabled');

    };

    /**
     * This method removes all events, subscriptions and DOM nodes created by this component.
     */
    destroy() {

        if (this.#destroyed) return;
        this.#destroyed = true;

        this.#removeCapabilitySubscriptions();
        this.#player.unsubscribe(this.#engineSetSub);
        this.#player.unsubscribe(this.#engineFailedSub);
        this.#overlay.destroy();
        this.#player = this.#overlay = null;

    }

}
