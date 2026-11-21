/**
 * Utility module for loading external scripts with deduplication and cancellation support.
 * Provides a centralized way to load external JavaScript libraries while avoiding duplicate requests.
 * @module lib/util/scriptLoader
 * @author Frank Kudermann - alphanull
 * @version 1.0.0
 * @license MIT
 */
export default {
    request
};

/**
 * Module-local registry for managing callbacks per script URL.
 * Cross-bundle deduplication is handled via DOM dataset attributes instead of global state.
 * @private
 * @type {Map<string, Set<{resolve: Function, reject: Function}>>}
 */
const callbackRegistry = new Map();

/* eslint-disable jsdoc/require-jsdoc */
class CancelablePromise {

    #promise;

    #cancel;

    #cancelled = false;

    constructor(executor) {
        this.#promise = new Promise((resolve, reject) => {
            this.#cancel = () => {
                if (!this.#cancelled) {
                    this.#cancelled = true;
                    reject(new DOMException('Cancelled', 'AbortError'));
                }
            };
            executor(
                value => { if (!this.#cancelled) resolve(value); },
                error => { if (!this.#cancelled) reject(error); }
            );
        });
    }

    cancel() {
        this.#cancel();
        return this.#promise;
    }

    then(onFulfilled, onRejected) { return this.#promise.then(onFulfilled, onRejected); }

    catch(onRejected) { return this.#promise.catch(onRejected); }

    finally(onFinally) { return this.#promise.finally(onFinally); }
}

/**
 * Attaches load/error event listeners to a script element.
 * Handles success/error callbacks for all pending requests.
 * @private
 * @param {string}            url        Script URL for callback registry lookup.
 * @param {HTMLScriptElement} script     Script element to attach listeners to.
 * @param {Function}          getResult  Callback that retrieves the global result object.
 */
function attachScriptListeners(url, script, getResult) {

    script.addEventListener('load', () => {
        script.dataset.scriptLoaderStatus = 'loaded';
        const callbacks = callbackRegistry.get(url);
        if (callbacks) {
            callbacks.forEach(callback => callback.resolve(getResult()));
            callbackRegistry.delete(url);
        }
    }, { once: true });

    script.addEventListener('error', error => {
        script.dataset.scriptLoaderStatus = 'error';
        const callbacks = callbackRegistry.get(url);
        if (callbacks) {
            callbacks.forEach(callback => callback.reject(new Error(`[VisionPlayer] Failed to load script: ${url}`, { cause: error })));
            callbackRegistry.delete(url);
        }
    }, { once: true });

}

/**
 * Attaches to an existing script that is currently loading (data-loaded="0").
 * @private
 * @param   {string}            url        URL of the script being loaded.
 * @param   {HTMLScriptElement} script     Script element to attach listeners to.
 * @param   {Function}          getResult  Callback that retrieves the global result object.
 * @returns {CancelablePromise}            Cancelable promise resolving on script load completion.
 */
function attachToLoadingScript(url, script, getResult) {

    return new CancelablePromise((resolve, reject) => {
        const callbacks = { resolve, reject };

        // Get or create callback set for this URL
        let callbackSet = callbackRegistry.get(url);
        if (!callbackSet) {
            callbackSet = new Set();
            callbackRegistry.set(url, callbackSet);
            // Only attach listeners if this is the first callback (listeners not yet registered)
            attachScriptListeners(url, script, getResult);
        }
        callbackSet.add(callbacks);
    });

}

/**
 * Creates and injects a new script element.
 * @private
 * @param   {string}            url        URL of the script to create and load.
 * @param   {Object}            options    Configuration for script attributes (async, defer, etc.).
 * @param   {Function}          getResult  Callback that retrieves the global result object.
 * @returns {CancelablePromise}            Cancelable promise resolving on script load completion.
 */
function createNewScript(url, options, getResult) {

    return new CancelablePromise((resolve, reject) => {
        const callbacks = { resolve, reject };

        // Create callback set for this URL
        const callbackSet = new Set([callbacks]);
        callbackRegistry.set(url, callbackSet);

        // Create script element
        const script = document.createElement('script');
        script.src = url;
        script.async = options.async;
        script.defer = options.defer;
        script.crossOrigin = options.crossOrigin;
        script.integrity = options.integrity ?? '';
        script.referrerPolicy = options.referrerPolicy;
        script.dataset.scriptLoaderStatus = 'loading';

        attachScriptListeners(url, script, getResult);
        document.head.appendChild(script);
    });

}

/**
 * Requests loading of an external script. Returns a cancelable promise.
 * Multiple requests for the same URL will share the same underlying script element.
 * @param   {string}            url                       The URL of the script to load.
 * @param   {Object}            [options]                 Optional configuration for script element.
 * @param   {string}            [options.global]          Global variable name (e.g. 'dashjs'). If set, promise resolves with window[global].
 * @param   {Function}          [options.checkAvailable]  Custom availability checker. Defaults to () => window[global] != null.
 * @param   {boolean}           [options.async=true]      Whether to load the script asynchronously.
 * @param   {boolean}           [options.defer=false]     Whether to defer script execution.
 * @param   {string}            [options.crossOrigin]     CORS setting ('anonymous' or 'use-credentials').
 * @param   {string}            [options.integrity]       Subresource integrity hash.
 * @param   {string}            [options.referrerPolicy]  Referrer policy for the script request.
 * @returns {CancelablePromise}                           A cancelable promise that resolves when the script loads.
 * @example
 * import scriptLoader from '/lib/util/scriptLoader.js';
 * const dashjs = await scriptLoader.request('https://cdn.dashjs.org/latest/dash.all.min.js', {
 *     global: 'dashjs'
 * });
 * // dashjs is now window.dashjs
 * @example
 * // With cancellation
 * const promise = scriptLoader.request(url);
 * // Later, if no longer needed:
 * promise.cancel().catch(() => {}); // Suppress AbortError
 * @example
 * // With custom availability check
 * const Hls = await scriptLoader.request(url, {
 *     global: 'Hls',
 *     checkAvailable: () => window.Hls?.isSupported?.()
 * });
 * @example
 * // With CORS and integrity
 * scriptLoader.request(url, {
 *     crossOrigin: 'anonymous',
 *     integrity: 'sha384-...'
 * });
 */
export function request(url, options = {}) {

    // Helper to get result value (returns global object or nothing)
    const getResult = () => window[options.global];

    // Setup availability checker if global is specified
    const checker = options.global
        ? options.checkAvailable || (() => {
            const globalVar = window[options.global];
            return globalVar !== null && typeof globalVar !== 'undefined';
        })
        : null;

    // Check if library is already available globally
    if (checker && checker()) return new CancelablePromise(resolve => resolve(getResult()));

    // Check if script already exists in DOM (compare .src to avoid CSS selector escaping issues)
    const scripts = document.querySelectorAll('script[src]'),
          existing = Array.from(scripts).find(script => script.src === url);

    if (!existing) return createNewScript(url, options, getResult); // No script exists - create new one

    switch (existing.dataset.scriptLoaderStatus) {
        case 'loaded': // Already loaded (by any scriptLoader instance)
            return new CancelablePromise(resolve => resolve(getResult()));

        case 'loading': // Currently loading (by another scriptLoader instance)
            return attachToLoadingScript(url, existing, getResult);

        case 'error': // Previous load failed, reject immediately
            return new CancelablePromise((resolve, reject) => {
                reject(new Error(`[VisionPlayer] Script previously failed to load: ${url}`));
            });

        default: { // No status (Externally inserted script)
            // Check via Performance API if script was already downloaded
            const perfEntry = performance?.getEntriesByName?.(url, 'resource')?.[0];
            if (perfEntry?.responseEnd > 0) {
                // Script downloaded - check if executed (consider defer scripts)
                if (document.readyState !== 'loading') {
                    // DOM is interactive or complete - script is executed
                    existing.dataset.scriptLoaderStatus = 'loaded';
                    return new CancelablePromise(resolve => resolve(getResult()));
                }
            }

            // External script exists but status unknown - mark as loading and attach listeners
            existing.dataset.scriptLoaderStatus = 'loading';
            return attachToLoadingScript(url, existing, getResult);
        }
    }
}
