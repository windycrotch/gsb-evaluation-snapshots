import DomSmith from '../../lib/dom/DomSmith.js';
import { isArray, isFunction, isString, isSymbol } from '../../lib/util/object.js';

export { default as ConsentError } from './ConsentError.js';

/**
 * Optional consent gate for third-party providers (YouTube, Vimeo).
 * Disabled by default. When enabled, `request()` pauses script loading until either an external
 * handler or the internal overlay/storage path grants or denies consent.
 * @exports  module:src/consent/Consent
 * @requires module:lib/dom/DomSmith
 * @requires module:lib/util/object
 * @requires module:src/consent/ConsentError
 * @author   Frank Kudermann - alphanull
 * @version  1.0.0
 * @license  MIT
 */
export default class Consent {

    /**
     * Purpose tokens the overlay can turn into translated fragments.
     * @type {string[]}
     */
    static #purposeIds = ['playback', 'cookies', 'advertising'];

    /**
     * Holds the instance configuration for this component.
     * @type     {Object}
     * @property {string} [storage='local']           Storage backend: `'local'`, `'session'` or `'none'`.
     * @property {string} [storageKey='vip-consent']  Key used in Web Storage.
     * @property {number} [expires=180]               Grant lifetime in days.
     * @property {Object} [privacyUrls]               Privacy-policy URLs keyed by service id. Set a value to `false` or `''` to hide that link.
     */
    #config = {
        storage: 'local',
        storageKey: 'vip-consent',
        expires: 180,
        privacyUrls: {
            youtube: 'https://policies.google.com/privacy',
            vimeo: 'https://vimeo.com/privacy'
        }
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
     * Registered services keyed by id.
     * @type {Map<string, module:src/consent/Consent~service>}
     */
    #services = new Map();

    /**
     * External consent handler. When set, it replaces the internal overlay/storage path.
     * @type {?module:src/consent/Consent~consentHandler}
     */
    #handler = null;

    /**
     * In-flight `request()` promises, keyed by service id, so parallel callers share one decision.
     * @type {Map<string, Promise<boolean>>}
     */
    #inFlight = new Map();

    /**
     * Fallback store used when Web Storage is unavailable or `storage` is `'none'`.
     * @type {Object}
     */
    #memoryStore = {};

    /**
     * Overlay DOM, created lazily and destroyed after the user decides.
     * @type {?module:lib/dom/DomSmith}
     */
    #dom;

    /**
     * Settings-menu row for revoking stored grants. Absent when the settings popup is not in the build.
     * @type {?module:lib/dom/DomSmith}
     */
    #settingsDom;

    /**
     * Resolver for the currently visible overlay.
     * @type {?Function}
     */
    #overlayResolver;

    /**
     * Rejects the overlay waiter when the pending request is cancelled (engine switch).
     * @type {?Function}
     */
    #overlayReject;

    /**
     * Subscription tokens for player events.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Creates an instance of the Consent component.
     * @param {module:src/core/Player} player            Reference to the VisionPlayer instance.
     * @param {module:src/core/Player} parent            Reference to the parent instance.
     * @param {Object}                 [options]         Additional options.
     * @param {symbol}                 [options.apiKey]  Token for extended access to the player API.
     */
    constructor(player, parent, { apiKey }) {

        // This component is disabled by default and has to be explicitly enabled via playerConfig
        if (!player.getConfig('consent')) return [false];

        this.#config = player.initConfig('consent', this.#config);

        this.#player = player;
        this.#apiKey = apiKey;

        this.#player.setApi('consent.register', this.#register, this.#apiKey);
        this.#player.setApi('consent.request', this.#request, this.#apiKey);
        this.#player.setApi('consent.setHandler', this.#setHandler, this.#apiKey);
        this.#player.setApi('consent.revoke', this.#revoke, this.#apiKey);

        this.#subscriptions = [
            this.#player.subscribe('player/engine/set', this.#abortOverlay)
        ];

        this.#mountSettings();

    }

    /**
     * Throws if secure mode is on and the caller did not pass the matching apiKey.
     * @param  {symbol} [apiKey]  Token for extended access to the player API.
     * @throws {Error}            If apiKey does not match in secure mode.
     */
    #assertApiKey(apiKey) {

        if (this.#apiKey && this.#apiKey !== apiKey) {
            throw new Error('[Visionplayer] Secure mode: access denied.');
        }

    }

    /**
     * Registers a service so the overlay can show a name, purposes and third-country notice.
     * Does not grant or deny anything; `request()` still asks even for unknown ids.
     * @param  {string}                                 id         Service id, e.g. `'youtube'`.
     * @param  {string}                                 name       Display name used in the overlay and events.
     * @param  {module:src/consent/Consent~serviceMeta} [options]  Optional overlay metadata. Omit when passing `apiKey` as the third argument.
     * @param  {symbol}                                 [apiKey]   Token for extended access to the player API.
     * @throws {Error}                                             If apiKey does not match in secure mode.
     */
    #register = (id, name, options, apiKey) => {

        let meta = options,
            key = apiKey;

        if (isSymbol(options)) {
            key = options;
            meta = {};
        }

        this.#assertApiKey(key);

        const purposes = isArray(meta?.purposes)
            ? meta.purposes.filter(item => Consent.#purposeIds.includes(item))
            : [];

        this.#services.set(id, {
            name: name || id,
            thirdCountry: isString(meta?.thirdCountry) ? meta.thirdCountry : '',
            purposes
        });

    };

    /**
     * Awaits a consent decision for `id`. Shared in-flight callers reuse the same Promise.
     * @param   {string}           id        Service id, e.g. `'youtube'`.
     * @param   {symbol}           [apiKey]  Token for extended access to the player API.
     * @returns {Promise<boolean>}           `true` if the resource may load, otherwise `false`.
     * @throws  {Error}                      If apiKey does not match in secure mode.
     * @throws  {DOMException}               AbortError if the overlay is dismissed because the engine changes.
     * @fires   module:src/consent/Consent#consent/required
     * @fires   module:src/consent/Consent#consent/granted
     * @fires   module:src/consent/Consent#consent/denied
     */
    #request = async(id, apiKey) => {

        this.#assertApiKey(apiKey);

        const pending = this.#inFlight.get(id);
        if (pending) return pending;

        const task = this.#resolveRequest(id);
        this.#inFlight.set(id, task);

        try {
            return await task;
        } finally {
            this.#inFlight?.delete(id);
        }

    };

    /**
     * Registers or clears an external consent handler. Intended for cookie managers.
     * A new handler replaces the previous one. Pass `null` to return to the internal path.
     * Does not require an apiKey, so it remains usable when `secureApi` is on.
     * @param {module:src/consent/Consent~consentHandler|null} handler  Handler that returns a boolean or Promise.
     */
    #setHandler = handler => {

        this.#handler = isFunction(handler) ? handler : null;

        if (this.#handler) this.#unmountSettings();
        else if (!this.#settingsDom) this.#mountSettings();

    };

    /**
     * Forgets all stored grants. Does not unload a provider that is already playing.
     * Does not require an apiKey, so it remains usable when `secureApi` is on.
     */
    #revoke = () => {

        this.#memoryStore = {};

        if (this.#config.storage !== 'none') {
            try {
                this.#storage().removeItem(this.#config.storageKey);
            } catch {
                // Private mode or quota: store is already empty in memory.
            }
        }

        this.#syncRevokeButton();

    };

    /**
     * Resolves one consent decision for `id` via handler, storage, or overlay.
     * @param   {string}           id  Service id.
     * @returns {Promise<boolean>}     Whether loading is allowed.
     */
    async #resolveRequest(id) {

        const { name } = this.#service(id),
              payload = { id, name };

        if (this.#handler) {
            this.#player.publish('consent/required', payload, this.#apiKey);
            const granted = Boolean(await this.#handler(payload));
            this.#emitResult(payload, granted);
            return granted;
        }

        if (this.#hasGrant(id)) return true;

        this.#player.publish('consent/required', payload, this.#apiKey);

        const granted = await this.#showOverlay(id);
        this.#emitResult(payload, granted);
        if (granted) this.#persistGrant(id);
        return granted;

    }

    /**
     * Returns overlay metadata for `id`, with the id as the name when unregistered.
     * @param   {string}                             id  Service id.
     * @returns {module:src/consent/Consent~service}     Service record.
     */
    #service(id) {

        return this.#services.get(id) ?? { name: id, thirdCountry: '', purposes: [] };

    }

    /**
     * Publishes granted/denied and, on deny, a consent-specific notification.
     * @param {Object}  payload       Event payload.
     * @param {string}  payload.id    Service id.
     * @param {string}  payload.name  Display name.
     * @param {boolean} granted       Whether consent was given.
     */
    #emitResult(payload, granted) {

        this.#player.publish(granted ? 'consent/granted' : 'consent/denied', payload, this.#apiKey);

        if (granted) return;

        this.#player.publish('notification', {
            type: 'error',
            title: this.#player.locale.t('errors.consent.header'),
            message: this.#player.locale.t('errors.consent.denied', { name: payload.name })
        }, this.#apiKey);

    }

    /**
     * Returns true when a non-expired grant for `id` exists in storage.
     * @param   {string}  id  Service id.
     * @returns {boolean}     Whether a valid grant is stored.
     */
    #hasGrant(id) {

        const store = this.#readStore(),
              entry = store[id];

        if (!entry?.granted) return false;

        if (entry.expires && entry.expires <= Date.now()) {
            delete store[id];
            this.#writeStore(store);
            return false;
        }

        return true;

    }

    /**
     * Persists a grant for `id`. Denials are not stored so a retry does not need a storage wipe.
     * @param {string} id  Service id.
     */
    #persistGrant(id) {

        const store = this.#readStore();
        store[id] = {
            granted: true,
            expires: Date.now() + this.#config.expires * 86400000
        };
        this.#writeStore(store);
        this.#syncRevokeButton();

    }

    /**
     * Reads the consent store. Falls back to the runtime map if Web Storage throws.
     * @returns {Object} Parsed store object.
     */
    #readStore() {

        if (this.#config.storage === 'none') return this.#memoryStore;

        try {
            const raw = this.#storage().getItem(this.#config.storageKey);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return this.#memoryStore;
        }

    }

    /**
     * Writes the consent store. Falls back to the runtime map if Web Storage throws.
     * @param {Object} store  Store object to persist.
     */
    #writeStore(store) {

        if (this.#config.storage === 'none') {
            this.#memoryStore = store;
            return;
        }

        try {
            this.#storage().setItem(this.#config.storageKey, JSON.stringify(store));
        } catch {
            this.#memoryStore = store;
        }

    }

    /**
     * Returns the configured Web Storage object.
     * @returns {Storage} `sessionStorage` or `localStorage`.
     */
    #storage() {

        return this.#config.storage === 'session' ? sessionStorage : localStorage;

    }

    /**
     * Returns a safe http(s) href for the overlay privacy link, or an empty string to hide it.
     * @param   {string} id  Service id.
     * @returns {string}     Absolute URL, or `''`.
     */
    #privacyHref(id) {

        const raw = this.#config.privacyUrls?.[id];
        if (!isString(raw) || !raw) return '';

        try {
            const url = raw.startsWith('/') ? new URL(raw, location.href) : new URL(raw);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
            return url.href;
        } catch {
            return '';
        }

    }

    /**
     * Builds the purposes sentence, or an empty string when nothing usable was registered.
     * @param   {string[]} purposes  Purpose tokens.
     * @returns {string}             Translated sentence, or `''`.
     */
    #purposeSentence(purposes) {

        const labels = purposes
            .filter(id => Consent.#purposeIds.includes(id))
            .map(id => this.#player.locale.t(`consent.purpose.${id}`));

        if (!labels.length) return '';

        return this.#player.locale.t('consent.purposes', { purposes: this.#joinList(labels) });

    }

    /**
     * Builds the third-country sentence, or an empty string when no code was registered.
     * @param   {string} code  ISO 3166-1 alpha-2 code.
     * @returns {string}       Translated sentence, or `''`.
     */
    #countrySentence(code) {

        if (!isString(code) || !code) return '';

        const path = `consent.country.${code}`,
              country = this.#player.locale.t(path);

        return this.#player.locale.t('consent.thirdCountry', { country: country === path ? code : country });

    }

    /**
     * Joins translated fragments with a localized separator and final conjunction.
     * @param   {string[]} items  Translated fragments.
     * @returns {string}          Joined list.
     */
    #joinList(items) {

        if (items.length === 1) return items[0];

        const and = this.#player.locale.t('consent.listAnd');

        if (items.length === 2) return `${items[0]}${and}${items[1]}`;

        return `${items.slice(0, -1).join(this.#player.locale.t('consent.listSep'))}${and}${items[items.length - 1]}`;

    }

    /**
     * Builds the overlay body from message, purposes and third-country fragments.
     * @param   {string} id  Service id.
     * @returns {string}     Combined paragraph text.
     */
    #overlayText(id) {

        const { name, purposes, thirdCountry } = this.#service(id);

        return [
            this.#player.locale.t('consent.message', { name }),
            this.#purposeSentence(purposes),
            this.#countrySentence(thirdCountry)
        ].filter(Boolean).join(' ');

    }

    /**
     * Shows the blocking overlay and waits for agree or decline.
     * @param   {string}           id  Service id.
     * @returns {Promise<boolean>}     User decision.
     */
    #showOverlay(id) {

        return new Promise((resolve, reject) => {

            this.#overlayResolver = resolve;
            this.#overlayReject = reject;

            const privacyHref = this.#privacyHref(id),
                  headingId = `vip-consent-heading-${this.#player.getConfig('player.id')}`;

            this.#dom = new DomSmith({
                _ref: 'root',
                className: 'vip-consent',
                'data-sort': 60,
                role: 'dialog',
                ariaModal: 'true',
                ariaLabelledby: headingId,
                tabIndex: -1,
                _nodes: [{
                    className: 'vip-consent-panel',
                    _nodes: [{
                        _tag: 'h2',
                        id: headingId,
                        _nodes: [this.#player.locale.t('consent.heading')]
                    }, {
                        _tag: 'p',
                        _nodes: [this.#overlayText(id)]
                    }, this.#settingsDom && {
                        _tag: 'p',
                        className: 'vip-consent-hint',
                        _nodes: [this.#player.locale.t('consent.revokeHint')]
                    }, {
                        className: 'vip-consent-actions',
                        _nodes: [{
                            _tag: 'button',
                            type: 'button',
                            _nodes: [this.#player.locale.t('consent.decline')],
                            click: () => this.#settleOverlay(false)
                        }, {
                            _tag: 'button',
                            type: 'button',
                            _nodes: [this.#player.locale.t('consent.agree')],
                            click: () => this.#settleOverlay(true)
                        }]
                    }, privacyHref && {
                        className: 'vip-consent-privacy',
                        _nodes: [{
                            _tag: 'a',
                            href: privacyHref,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            _nodes: [this.#player.locale.t('consent.privacy', { name: this.#service(id).name })]
                        }]
                    }]
                }]
            }, this.#player.dom.getElement(this.#apiKey));

            this.#dom.root.focus();

        });

    }

    /**
     * Completes the overlay decision, removes the DOM, and resolves the waiter.
     * @param {boolean} granted  User decision.
     */
    #settleOverlay(granted) {

        const resolve = this.#overlayResolver;
        this.#teardownOverlay();
        resolve?.(granted);

    }

    /**
     * Removes overlay DOM without resolving a pending waiter.
     */
    #teardownOverlay() {

        this.#dom?.destroy();
        this.#dom = this.#overlayResolver = this.#overlayReject = null;

    }

    /**
     * Dismisses a pending overlay without grant or deny. Used when media switches away
     * from the engine that opened it, so the overlay cannot cover the next item.
     * @listens module:src/core/Player#player/engine/set
     */
    #abortOverlay = () => {

        const reject = this.#overlayReject;
        if (!reject) return;

        this.#teardownOverlay();
        reject(new DOMException('Cancelled', 'AbortError'));

    };

    /**
     * Adds a revoke control to the settings popup when that popup exists in this build.
     */
    #mountSettings() {

        const settings = this.#player.getComponent('ui.controller.popupSettings', this.#apiKey);
        if (!settings?.getElement) return;

        this.#settingsDom = new DomSmith({
            _tag: 'label',
            className: 'vip-consent-settings',
            _nodes: [{
                _tag: 'span',
                className: 'form-label-text',
                _nodes: [this.#player.locale.t('consent.settings')]
            }, {
                _ref: 'revoke',
                _tag: 'button',
                type: 'button',
                _nodes: [this.#player.locale.t('consent.revoke')],
                click: this.#revoke
            }]
        }, settings.getElement('wrapper'));

        this.#syncRevokeButton();

    }

    /**
     * Disables the revoke button when no grant is stored.
     */
    #syncRevokeButton() {

        if (!this.#settingsDom?.revoke) return;

        this.#settingsDom.revoke.disabled = !this.#hasStoredGrants();

    }

    /**
     * Returns true when at least one non-expired grant exists in the store.
     * @returns {boolean} Whether a stored grant is present.
     */
    #hasStoredGrants() {

        return Object.values(this.#readStore()).some(entry => entry?.granted && (!entry.expires || entry.expires > Date.now()));

    }

    /**
     * Removes the settings revoke row. Used when an external handler owns consent UI.
     */
    #unmountSettings() {

        this.#settingsDom?.destroy();
        this.#settingsDom = null;

    }

    /**
     * This method removes all API methods and DOM nodes created by this component.
     */
    destroy() {

        this.#abortOverlay();
        this.#unmountSettings();
        this.#player.unsubscribe(this.#subscriptions);
        this.#player.removeApi(['consent.register', 'consent.request', 'consent.setHandler', 'consent.revoke'], this.#apiKey);
        this.#player = this.#apiKey = this.#handler = this.#services = this.#inFlight = this.#memoryStore = this.#settingsDom = this.#subscriptions = null;

    }

}

/**
 * Overlay metadata passed to `register()`.
 * @typedef  {Object}  module:src/consent/Consent~serviceMeta
 * @property {string}   [thirdCountry]  ISO 3166-1 alpha-2 code for a third-country transfer, e.g. `'US'`.
 * @property {string[]} [purposes]      Tokens: `'playback'`, `'cookies'`, `'advertising'`. Unknown values are ignored.
 */

/**
 * Stored service record used by the overlay.
 * @typedef  {Object}  module:src/consent/Consent~service
 * @property {string}   name          Display name.
 * @property {string}   thirdCountry  ISO country code, or `''`.
 * @property {string[]} purposes      Filtered purpose tokens.
 */

/**
 * External handler invoked by `request()` when set. Receives the service id and display name.
 * @callback module:src/consent/Consent~consentHandler
 * @param   {Object}                   service       Service being requested.
 * @param   {string}                   service.id    Service id, e.g. `'youtube'`.
 * @param   {string}                   service.name  Display name.
 * @returns {boolean|Promise<boolean>}               `true` to allow loading, `false` to deny.
 */

/**
 * Fired when consent is about to be requested for a service.
 * @event module:src/consent/Consent#consent/required
 * @param {Object} data       Event payload.
 * @param {string} data.id    Service id.
 * @param {string} data.name  Display name.
 */

/**
 * Fired when consent was granted for a service.
 * @event module:src/consent/Consent#consent/granted
 * @param {Object} data       Event payload.
 * @param {string} data.id    Service id.
 * @param {string} data.name  Display name.
 */

/**
 * Fired when consent was denied for a service.
 * @event module:src/consent/Consent#consent/denied
 * @param {Object} data       Event payload.
 * @param {string} data.id    Service id.
 * @param {string} data.name  Display name.
 */
