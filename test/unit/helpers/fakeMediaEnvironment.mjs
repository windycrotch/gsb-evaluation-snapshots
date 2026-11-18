/**
 * Test doubles for the Media component unit tests.
 * Provides a controllable fake video element and a minimal fake player wired to the real pubsub engine,
 * so the Media component can run under Node without a browser or any third-party test framework.
 * @module test/unit/helpers/fakeMediaEnvironment
 */
import { publish, subscribe, unsubscribe, configure as configurePublisher } from '../../../lib/util/publisher.js';
import { setupGlobals } from './setupGlobals.mjs';

// the pubsub runs synchronously in tests, so every published event is delivered immediately
configurePublisher({ async: false });

const globalsHandles = setupGlobals();

/**
 * A controllable stand-in for an HTMLVideoElement. Only implements the surface the Media component touches.
 */
export class FakeVideoElement {

    constructor() {
        this.listeners = new Map();
        this.src = '';
        this.preload = '';
        this.crossOrigin = null;
        this.className = '';
        this.id = '';
        this.loop = false;
        this.muted = false;
        this.volume = 1;
        this.currentTime = 0;
        this.playbackRate = 1;
        // finite duration, otherwise Media intentionally swallows timeupdate events (mirrors a Chrome guard)
        this.duration = 100;
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.paused = true;
        this.ended = false;
        this.readyState = 0;
        this.networkState = 0;
        this.error = null;
        this.dataset = {};
        this.parentElement = null;
        this.tracks = [];
        this.loadCount = 0;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.get(type)?.delete(handler);
    }

    /**
     * Dispatches a synthetic native event to all registered listeners.
     * @param {string} type    The event type.
     * @param {Object} [extra] Extra properties merged onto the event.
     */
    dispatchEvent(type, extra = {}) {
        const event = { type, target: this, ...extra };
        this.listeners.get(type)?.forEach(handler => handler(event));
    }

    /**
     * Convenience helper: dispatches a native media error event.
     * @param {Object} mediaError  The error exposed via event.error / element.error.
     */
    dispatchError(mediaError) {
        this.error = mediaError;
        this.dispatchEvent('error', { error: mediaError });
    }

    load() { this.loadCount += 1; }

    play() {
        this.paused = false;
        return Promise.resolve();
    }

    pause() {
        this.paused = true;
    }

    remove() {
        this.listeners.clear();
        this.parentElement = null;
    }

    setAttribute() {}

    querySelectorAll() { return this.tracks; }

    appendChild(child) {
        child.parentElement = this;
        return child;
    }
}

/**
 * Minimal fake element used as the players' DOM container.
 */
export class FakeElement {
    constructor() {
        this.children = [];
    }

    appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
    }
}

/**
 * A minimal player double implementing exactly the pub/sub, state and API surface Media relies on.
 */
export class FakePlayer {

    constructor({ config = {}, id = 'fake-player' } = {}) {
        this.id = id;
        this.config = config;
        this.apiKey = Symbol('apiKey');
        this.apiMethods = new Map();
        this.state = {};
        this.dom = { getElement: () => this.container };
        this.container = new FakeElement();
        this.engines = new Map();
    }

    initConfig(key, defaults) {
        if (typeof this.config[key] === 'undefined') this.config[key] = defaults;
        return structuredClone(this.config[key]);
    }

    getConfig() { return structuredClone(this.config); }

    addEngine(engineId, engine) {
        this.engines.set(engineId, { engine });
    }

    removeEngine(engineId) {
        this.engines.delete(engineId);
    }

    setApi(namespace, method) {
        this.apiMethods.set(namespace, method);
    }

    removeApi(namespaces) {
        [].concat(namespaces).forEach(namespace => this.apiMethods.delete(namespace));
    }

    /**
     * Invokes an API method previously registered by the Media component.
     * @param {string} namespace  The full API namespace, e.g. 'default:media.load'.
     * @param {...*}   args       Arguments forwarded to the handler.
     * @returns {*}               The handlers' result.
     */
    callApi(namespace, ...args) {
        const method = this.apiMethods.get(namespace);
        if (!method) throw new Error(`No API method registered for ${namespace}`);
        return method(...args);
    }

    setState(namespace, descriptor) {
        const parts = namespace.split('.');
        parts.reduce((acc, name, index) => {
            if (index === parts.length - 1) {
                Object.defineProperty(acc, name, { ...descriptor, configurable: true, enumerable: true });
            } else if (!acc[name]) {
                acc[name] = {};
            }
            return acc[name];
        }, this.state);
    }

    removeState(namespace) {
        const parts = namespace.split('.'),
              scope = parts.slice(0, -1).reduce((acc, name) => acc?.[name], this.state);
        if (scope) delete scope[parts.at(-1)];
    }

    getState(namespace) {
        if (!namespace) return this.state;
        return namespace.split('.').reduce((acc, name) => acc?.[name] ?? null, this.state);
    }

    subscribe(topic, handler, options) {
        return subscribe(`vip/${this.id}/${topic}`, handler, options);
    }

    unsubscribe(topicOrToken, handler) {
        if (typeof topicOrToken === 'number' || Array.isArray(topicOrToken)) unsubscribe(topicOrToken, true);
        else unsubscribe(`vip/${this.id}/${topicOrToken}`, handler, true);
    }

    publish(topic, data) {
        publish(`vip/${this.id}/${topic}`, data, { async: false });
    }
}

/**
 * Builds fresh metadata, fake player and Media instance for a single test.
 * @param {Object} [options]
 * @param {Object} [options.config]  Media configuration overrides (e.g. stallTimeout).
 * @param {number} [options.timeout] Shortcut for config.stallTimeout, in seconds.
 * @returns {Promise<{player: FakePlayer, media: Media, video: FakeVideoElement, events: Object[], metaData: Function, load: Function, setFetch: Function}>}
 */
export async function createMediaEnvironment({ config = {}, timeout } = {}) {

    const events = [];
    const player = new FakePlayer({
        config: {
            media: {
                ...config,
                ...(typeof timeout === 'number' ? { stallTimeout: timeout } : {})
            }
        }
    });

    const { default: Media } = await import('../../../src/core/Media.js');
    const media = new Media(player, null, { apiKey: player.apiKey });

    // the Media constructor created this element through the document stub
    const video = globalsHandles.lastVideo;

    // wire state getters and native event listeners exactly like the real enable() flow would
    media.enable();

    ['media/stall/begin', 'media/stall/end', 'media/error', 'media/ready', 'media/pause', 'media/timeupdate', 'media/waiting']
        .forEach(topic => player.subscribe(topic, data => events.push({ topic, data })));

    return {
        player,
        media,
        video,
        events,
        setFetch: globalsHandles.setFetch,
        metaData: (src = 'https://example.com/media.mp4') => ({ src, mediaType: 'video', mimeType: 'video/mp4' }),
        load: (metaData, options) => player.callApi('default:media.load', metaData, options)
    };
}

/**
 * Flushes the microtask queue so async/await chains (error classification, load task settlement) run to completion.
 * @param {number} [times=10]  Number of chained microtask ticks to await.
 * @returns {Promise<void>}
 */
export function flushMicrotasks(times = 10) {
    let chain = Promise.resolve();
    for (let i = 0; i < times; i += 1) chain = chain.then(() => {});
    return chain;
}
