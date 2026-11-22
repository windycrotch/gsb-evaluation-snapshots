/**
 * Test harness: builds a real {@link module:src/core/Player} with the production {@link module:src/controller/Play}
 * component, but replaces the heavyweight Dom / Data components with lightweight stubs so the engine
 * switching machinery can be exercised deterministically under Node with the DOM shim.
 * @module test/helpers/harness
 */
import Player from '../../src/core/Player.js';
import Play from '../../src/controller/Play.js';
import { ShimElement } from './domShim.js';

/**
 * Minimal Dom stand-in: provides the root element and the private mount API the Player constructor expects.
 */
class StubDom {

    constructor(player) {

        this.root = new ShimElement('vision-player');
        document.body.appendChild(this.root);

        player.setApi('refreshDom', () => {}, true);
        player.setApi('mountDom', () => {}, true);
        player.setApi('dom.getElement', () => this.root);

    }

    destroy() {
        this.root.remove();
    }

}

/**
 * Controller stand-in exposing the 'left' button container Play attaches to.
 */
class StubController {

    constructor(player) {

        this.left = new ShimElement('div');
        this.left.setAttribute('class', 'vip-controller-buttons-left');
        player.dom.getElement().appendChild(this.left);

    }

    getElement(area) {
        return area === 'left' ? this.left : this.left;
    }

    destroy() {}

}

/**
 * Optional Data stand-in. The real Data component is not needed for engine switch tests; registering a
 * placeholder keeps the component tree small and predictable.
 */
class StubData {

    constructor(player) {
        player.setApi('data.getMediaData', () => ({ media: [], currentMediaIndex: 0 }));
        player.setApi('data.getPreferredMetaData', () => ({}));
        player.setApi('data.setMediaData', () => Promise.resolve());
    }

    destroy() {}

}

/**
 * Locale stand-in providing just the translate API Play uses for labels and tooltips.
 */
class StubLocale {

    constructor(player) {
        player.setApi('locale.t', key => key);
        player.setApi('locale.getLocalizedTime', value => value);
        player.setApi('locale.getNativeLang', lang => lang);
    }

    destroy() {}

}

/**
 * Flushes the microtask queue `times` times, letting awaited promise chains settle.
 * @param {number} [times=10]  Number of microtask flushes.
 * @returns {Promise<void>}
 */
export function flushMicrotasks(times = 10) {
    let chain = Promise.resolve();
    for (let i = 0; i < times; i += 1) {
        chain = chain.then(() => {});
    }
    return chain;
}

/**
 * Instrumentation record for a created test player.
 * @typedef {Object} PlayerHarness
 * @property {Player}              player     The real player instance.
 * @property {Object}              play       The live Play component instance.
 * @property {ShimElement}         button     The play button DOM element.
 * @property {Map<string, number>} liveSubs   Topic -> number of currently active subscriptions on this player.
 * @property {Object[]}            events     Chronological list of published engine events.
 * @property {Object}              mediaCalls Counts of media.play / media.pause invocations.
 * @property {Function}            destroy    Tears the harness down.
 */

let harnessId = 0;

/**
 * Creates a fully wired test player with the production Play component and the given engines.
 * @param {Object}   [options]
 * @param {Object}   [options.engines]  Engine id -> engine object (must expose `capabilities`).
 * @param {string}   [options.initial]  Id of the engine to mark as current before the test starts.
 * @returns {Promise<PlayerHarness>}
 */
export async function createTestPlayer({ engines = {}, initial = '' } = {}) {

    // fresh registry per player: remove anything previous harnesses registered (the static
    // removeComponent throws when a path is missing, so tolerate that here)
    ['dom', 'locale', 'data', 'controller', 'controller.play'].forEach(path => {
        try {
            Player.removeComponent(path);
        } catch {
            /* not registered yet */
        }
    });

    Player.addComponent('dom', StubDom);
    Player.addComponent('locale', StubLocale);
    Player.addComponent('data', StubData);
    Player.addComponent('controller', StubController);
    Player.addComponent('controller.play', Play);

    const target = document.createElement('div');
    target.setAttribute('id', 'test-target');
    document.body.appendChild(target);

    harnessId += 1;
    const player = new Player(target, null, {
        player: { id: `test-${harnessId}` },
        media: { autoPlay: false }
    });

    // media state + API surface touched by Play
    const mediaState = { paused: true };
    player.setState('media.paused', {
        configurable: true,
        enumerable: true,
        get: () => mediaState.paused
    });

    const mediaCalls = { play: 0, pause: 0 };
    player.setApi('media.play', () => {
        mediaCalls.play += 1;
        mediaState.paused = false;
    });
    player.setApi('media.pause', () => {
        mediaCalls.pause += 1;
        mediaState.paused = true;
    });
    player.setApi('media.getElement', () => ({}));

    // register the fake engines
    for (const [id, engine] of Object.entries(engines)) {
        player.addEngine(id, engine, { capabilities: engine.capabilities });
    }

    // ---- instrumentation: track live subscriptions per topic ----
    const liveSubs = new Map();
    const tokenTopic = new Map();
    const originalSubscribe = player.subscribe.bind(player),
          originalUnsubscribe = player.unsubscribe.bind(player);

    const bump = (topic, delta) => {
        const next = (liveSubs.get(topic) ?? 0) + delta;
        if (next <= 0) liveSubs.delete(topic);
        else liveSubs.set(topic, next);
    };

    player.subscribe = (topic, handler, opts) => {
        const token = originalSubscribe(topic, handler, opts);
        tokenTopic.set(token, topic);
        bump(topic, 1);
        return token;
    };

    player.unsubscribe = (topicOrToken, handler) => {
        if (Array.isArray(topicOrToken)) {
            topicOrToken.forEach(token => {
                const topic = tokenTopic.get(token);
                if (topic) bump(topic, -1);
            });
        } else if (typeof topicOrToken === 'number') {
            const topic = tokenTopic.get(topicOrToken);
            if (topic) bump(topic, -1);
        } else {
            bump(topicOrToken, -1);
        }
        return originalUnsubscribe(topicOrToken, handler);
    };

    // Seed the initial engine without consuming any enable/disable hooks, then synthesize the same
    // 'engine/set' event the production bootstrap would produce so Play initializes its subscriptions.
    if (initial) {
        const initialEntry = engines[initial];
        player.seedEngine(initial);
        player.publish('player/engine/set', {
            from: { id: '', capabilities: {} },
            to: { id: initial, capabilities: initialEntry.capabilities },
            options: {}
        }, { async: false });
    }

    // ---- instrumentation: record engine lifecycle events ----
    const events = [];
    ['player/engine/set', 'player/engine/switched', 'player/engine/switchfailed'].forEach(topic => {
        originalSubscribe(topic, data => events.push({ topic, data }));
    });

    const play = player.getComponent('controller.play'),
          root = player.dom.getElement(),
          button = root.childNodes[0].childNodes[0]; // root -> controller div -> left div -> button

    return {
        player,
        play,
        button,
        liveSubs,
        events,
        mediaCalls,
        mediaState,
        destroy() {
            target.remove();
            try {
                player.destroy();
            } catch {
                // already destroyed
            }
        }
    };

}
