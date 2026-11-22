import DomSmith from '../../lib/dom/DomSmith.js';

/**
 * The Play component shows a button which is used to start and pause playing the media.
 * Also listens to the appropriate events should the media be paused or played by other means,
 * and adapts the play button state accordingly (i.e. Showing the 'play' or 'pause' icon).
 * @exports module:src/controller/Play
 * @requires lib/dom/DomSmith
 * @author   Frank Kudermann - alphanull
 * @version  1.2.0
 * @license  MIT
 */
export default class Play {

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
     * Set to `true` once {@link module:src/controller/Play#destroy} ran, so late (async) events become no-ops
     * instead of touching detached DOM.
     * @type {boolean}
     */
    #destroyed = false;

    /**
     * Reference to the DomSmith instance of the play button.
     * @type {module:lib/dom/DomSmith}
     */
    #dom;

    /**
     * Creates an instance of the Play component.
     * @param {module:src/core/Player}           player  Reference to the VisionPlayer instance.
     * @param {module:src/controller/Controller} parent  Reference to the parent instance, in this case the controller component.
     */
    constructor(player, parent) {

        if (!player.initConfig('playControl', true)) return [false];

        this.#player = player;

        const playText = this.#player.locale.t('commands.play'),
              pauseText = this.#player.locale.t('commands.pause');

        this.#dom = new DomSmith({
            _tag: 'button',
            _ref: 'playButton',
            className: 'play icon',
            disabled: true,
            style: 'display: none;',
            ariaLabel: '',
            'data-sort': 10,
            click: this.#togglePlay,
            $tooltip: { player, text: () => this.#player.getState('media.paused') ? playText : pauseText }
        }, parent.getElement('left'));

        this.#engineSetSub = this.#player.subscribe('player/engine/set', this.#onEngineSet);
        this.#engineFailedSub = this.#player.subscribe('player/engine/switchfailed', this.#onEngineSwitchFailed);

    }

    /**
     * Sets up the component as soon as the media data is available.
     * @listens module:src/core/Data#data/ready
     */
    #onDataReady = () => {

        if (this.#destroyed) return;

        this.#enable();
        if (this.#player.getState('media.paused') === false) this.#onPlay();
        else this.#onPause();

    };

    /**
     * Invoked when the user presses the play button. Toggles between 'play' and 'pause'.
     */
    #togglePlay = () => {

        if (this.#destroyed) return;

        if (this.#player.getState('media.paused')) this.#player.media.play();
        else this.#player.media.pause();

    };

    /**
     * This method switches the appearance of the play button to the play state.
     * @listens module:src/core/Media#media/play
     */
    #onPlay = () => {

        if (this.#destroyed) return;

        this.#dom.playButton.classList.remove('play');
        this.#dom.playButton.classList.add('pause');
        this.#dom.playButton.setAttribute('aria-pressed', 'true');
        this.#dom.playButton.setAttribute('aria-label', this.#player.locale.t('commands.pause'));

    };

    /**
     * This method switches the appearance of the play button to the pause state.
     * @listens module:src/core/Media#media/pause
     */
    #onPause = () => {

        if (this.#destroyed) return;

        this.#dom.playButton.classList.add('play');
        this.#dom.playButton.classList.remove('pause');
        this.#dom.playButton.setAttribute('aria-pressed', 'false');
        this.#dom.playButton.setAttribute('aria-label', this.#player.locale.t('commands.play'));

    };

    /**
     * Invoked when an engine switch is requested. Manages the capability-bound subscriptions as paired
     * add/remove operations: entering a playback-capable engine adds them exactly once, leaving it removes
     * them exactly once, so repeated switches (including re-entering the same capability state) never
     * accumulate subscriptions.
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
                this.#dom.playButton.style.display = '';
                this.#addCapabilitySubscriptions();
            }

        }

        if (from.capabilities.play && !to.capabilities.play) {

            if (options.suspend) {
                this.#disable();
            } else {
                this.#dom.playButton.style.display = 'none';
                this.#removeCapabilitySubscriptions();
            }

        }

    };

    /**
     * Invoked when an engine switch failed and the player rolled back to the previously active engine.
     * Reconciles the button with the engine that is actually current instead of leaving it in the
     * intermediate state produced by the failed `player/engine/set`.
     * @param {Object} data       The event data.
     * @param {Object} data.from  The engine that remained active after rollback.
     * @listens module:src/core/Player#player/engine/switchfailed
     */
    #onEngineSwitchFailed = ({ from }) => {

        if (this.#destroyed) return;

        if (from.capabilities.play) {

            // rolled back onto a playback-capable engine: make sure the button is visible, has exactly one
            // set of capability subscriptions and reflects the actual paused/playing state again
            this.#dom.playButton.style.display = '';
            this.#addCapabilitySubscriptions();

            if (this.#player.getState('media.paused') === false) this.#onPlay();
            else this.#onPause();

            this.#enable();

        } else {

            this.#dom.playButton.style.display = 'none';
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
            ['data/ready', this.#onDataReady],
            ['media/pause', this.#onPause],
            ['media/play', this.#onPlay],
            ['data/nomedia', this.#disable],
            ['media/error', this.#disable],
            ['media/canplay', this.#enable]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

        this.#capabilitySubsActive = true;

    }

    /**
     * Removes the capability-bound subscriptions added by {@link module:src/controller/Play#addCapabilitySubscriptions}.
     * Is idempotent and safe to call when no subscriptions are active.
     */
    #removeCapabilitySubscriptions() {

        if (!this.#capabilitySubsActive) return;

        this.#player.unsubscribe(this.#subscriptions);
        this.#subscriptions = null;
        this.#capabilitySubsActive = false;

    }

    /**
     * Enables the play button functionality. This method listens to canplay events in order to restore a usable state again
     * when the player recovered from a media error (for example by loading another file).
     * @listens module:src/core/Media#media/canplay
     */
    #enable = () => {

        if (this.#destroyed) return;

        this.#dom.playButton.disabled = false;

    };

    /**
     * Disables the button functionality. This method listens to media error events which cause the button to be disabled.
     * @listens module:src/core/Media#media/error
     * @listens module:src/core/Data#data/nomedia
     */
    #disable = () => {

        if (this.#destroyed) return;

        this.#dom.playButton.disabled = true;

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
        this.#dom.destroy();
        this.#player = this.#dom = null;

    }

}
