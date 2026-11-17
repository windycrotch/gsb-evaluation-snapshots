import Menu from '../util/Menu.js';

/**
 * UI component for subtitle selection and font size control.
 * Keeps presentation separated from the subtitle engine and talks via events.
 * @exports module:src/text/SubtitlesUi
 * @requires src/util/Menu
 * @author   Frank Kudermann - alphanull
 * @version  1.0.0
 * @license  MIT
 */
export default class SubtitlesUi {

    /**
     * UI-related configuration derived from the subtitles config.
     * @type {Object}
     */
    #config = {
        mode: 'custom',
        fontSize: 'medium',
        showFontSizeControl: true,
        showPlaceholder: false
    };

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Reference to the parent popup/controller.
     * @type {Object}
     */
    #parent;

    /**
     * Secret key only known to the player instance and initialized components.
     * @type {symbol}
     */
    #apiKey;

    /**
     * Reference to the subtitle selection menu.
     * @type {module:src/util/Menu}
     */
    #menu;

    /**
     * Reference to the font size menu (optional).
     * @type {module:src/util/Menu}
     */
    #fontMenu;

    /**
     * Available subtitle tracks (without the "off" entry).
     * @type {Array}
     */
    #tracks = [];

    /**
     * Currently active subtitle index (-1 for off).
     * @type {number}
     */
    #currentIndex = -1;

    /**
     * Allowed font sizes.
     * @type {string[]}
     */
    #fontSizes = ['small', 'medium', 'big'];

    /**
     * Current font size.
     * @type {string}
     */
    #currentFontSize = 'medium';

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Creates an instance of the Subtitles UI component.
     * @param {module:src/core/Player} player            Reference to the media player instance.
     * @param {module:src/ui/Popup}    parent            Reference to the parent instance (popup).
     * @param {Object}                 [options]         Additional options.
     * @param {symbol}                 [options.apiKey]  Token for extended access to the player API.
     */
    constructor(player, parent, { apiKey }) {

        this.#config = player.initConfig('subtitles', this.#config);

        if (!this.#config) return [false];

        this.#player = player;
        this.#parent = parent;
        this.#apiKey = apiKey;
        this.#currentFontSize = this.#config.fontSize || 'medium';

        this.#menu = new Menu(
            this.#player,
            {
                target: this.#parent.getElement('center'),
                id: 'subtitles',
                header: this.#player.locale.t('subtitles.header'),
                showPlaceholder: this.#config.showPlaceholder,
                selected: 0,
                highlighted: 0,
                verticalMenuThreshold: 2,
                selectMenuThreshold: 3,
                onSelected: this.#onMenuSelected
            }
        );

        if (this.#config.showFontSizeControl && this.#config.mode === 'custom') {
            this.#fontMenu = new Menu(
                this.#player,
                {
                    target: this.#menu.getDomSmithInstance().menu,
                    id: 'subtitlefont',
                    className: 'vip-menu-sub',
                    selectMenuThreshold: 1,
                    onSelected: this.#onFontSelected
                }
            );

            this.#fontMenu.create(this.#fontSizes.map(size => ({ value: size, label: this.#player.locale.t(`subtitles.fontSize_${size}`) })));
            this.#fontMenu.setIndex(this.#fontSizes.findIndex(size => size === this.#currentFontSize));
        }

        this.#subscriptions = [
            ['subtitles/active', this.#onActive],
            ['data/ready', this.#onDataReady],
            ['data/update', this.#onDataReady],
            ['data/nomedia', this.#onNoMedia]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

        // initialize empty menus
        this.#menu.create([]);

    }

    /**
     * Resets UI state and builds menu when new media data arrives.
     * @param {Object}                                data       Event data.
     * @param {module:src/core/Data~mediaItem_text[]} data.text  Updated text tracks.
     * @param {string}                                topic      Event topic.
     * @listens module:src/core/Data#data/ready
     * @listens module:src/core/Data#data/update
     */
    #onDataReady = ({ text } = {}, topic) => {

        if (topic?.endsWith('data/update') && typeof text === 'undefined') return;

        this.#resetMenus();

        this.#tracks = Array.isArray(text)
            ? text
                .filter(track => track && (track.type === 'subtitles' || track.type === 'captions' || track.kind === 'subtitles' || track.kind === 'captions') && track.language)
                .map(track => ({
                    language: track.language,
                    label: track.label || this.#player.locale.getNativeLang(track.language) || track.language,
                    type: track.type || track.kind,
                    disabled: false
                }))
            : [];

        this.#createMenu();

    };

    /**
     * Resets UI state when no media is available.
     * @listens module:src/core/Data#data/nomedia
     */
    #onNoMedia = () => {

        this.#resetMenus();

    };

    /**
     * Handles active track notifications from the engine.
     * @param {Object} data        Active payload.
     * @param {number} data.index  Active track index.
     * @listens module:src/text/Subtitles#subtitles/active
     */
    #onActive = ({ index = -1 } = {}) => {

        this.#currentIndex = typeof index === 'number' ? index : -1;
        this.#menu.setIndex(this.#currentIndex + 1);

    };

    /**
     * Handles subtitle menu selections.
     * @param {number} sel  Selected menu index (includes "off" at position 0).
     * @fires module:src/text/Subtitles#subtitles/selected
     */
    #onMenuSelected = sel => {

        const trackIndex = sel - 1,
              track = trackIndex >= 0 ? this.#tracks[trackIndex] : null;

        this.#player.publish('subtitles/selected', {
            index: trackIndex,
            language: track ? track.language : null,
            type: track ? track.type : null
        }, this.#apiKey);

    };

    /**
     * Handles font size menu selections.
     * @param {number} index       Selected index.
     * @param {Object} item        Selected menu item.
     * @param {string} item.value  The font size value.
     * @fires module:src/text/Subtitles#subtitles/fontsize
     */
    #onFontSelected = (index, { value }) => {

        this.#currentFontSize = value ?? this.#config.fontSize;
        this.#player.publish('subtitles/fontsize', this.#currentFontSize, this.#apiKey);

    };

    /**
     * Builds the menu entries based on current tracks.
     */
    #createMenu() {

        const items = [{ value: null, label: this.#player.locale.t('misc.off') }].concat(
            this.#tracks.map(track => ({
                value: track.language,
                label: track.label || track.language,
                disabled: track.disabled
            }))
        );

        this.#menu.create(items);
        this.#menu.setIndex((this.#currentIndex ?? -1) + 1);

    }

    /**
     * Syncs font menu UI selection.
     * @param {string} fontSize  The font size to select.
     */
    #setFontMenu(fontSize) {

        const idx = this.#fontSizes.findIndex(size => size === fontSize);
        if (idx > -1) this.#fontMenu.setIndex(idx);
        this.#currentFontSize = fontSize;

    }

    /**
     * Resets menus to an empty state and restores font selection.
     */
    #resetMenus() {

        this.#tracks = [];
        this.#currentIndex = -1;

        this.#menu.create([]);
        this.#menu.setIndex(0);

        if (this.#fontMenu) this.#setFontMenu(this.#currentFontSize);

    }

    /**
     * Cleans up menus and subscriptions.
     */
    destroy() {

        if (this.#fontMenu) this.#fontMenu.destroy();
        this.#menu.destroy();
        this.#player.unsubscribe(this.#subscriptions);
        this.#player = this.#parent = this.#menu = this.#fontMenu = this.#apiKey = null;

    }

}
