/**
 * Two locally crafted fake media engines used to exercise Player.setEngine and the Play control without
 * pulling in any real streaming library or media element.
 *
 * Both engines record every lifecycle call and expose controllable blocking / failure flags so tests can
 * deterministically create timing races and failure scenarios.
 * @module test/helpers/fakeEngines
 */

/**
 * Base implementation shared by both fake engines.
 */
class FakeEngineBase {

    /**
     * @param {string} id            Engine id under which it is registered.
     * @param {Object} capabilities  Capability descriptor handed to player.addEngine.
     */
    constructor(id, capabilities) {
        this.id = id;
        this.capabilities = capabilities;

        /**
         * Hook names currently held open. While a hook name is in this set, every invocation of that hook
         * stays pending until the test calls `release(hook)` or `unblock(hook)`.
         * @type {Set<string>}
         */
        this.holding = new Set();

        /**
         * Per-hook FIFO queues of pending deferred invocations created while the hook is held.
         * @type {Object<string, Array<{promise: Promise, resolve: Function, reject: Function}>>}
         */
        this.holdingGates = { enable: [], disable: [] };

        this.calls = {
            enable: [],
            disable: []
        };

        /** When true, the next enable() rejects instead of resolving. */
        this.failNextEnable = false;
        this.enableError = null;
    }

    /**
     * Runs one lifecycle hook: records the call, then either waits on a test-controlled holding gate or
     * resolves on the next microtask (the default, keeping behavior asynchronous like a real engine).
     * @param {string} hook     Which lifecycle hook is running.
     * @param {Object} options  Options forwarded by Player.setEngine.
     * @returns {Promise<void>}
     */
    #run(hook, options) {

        this.calls[hook].push(options);

        if (this.holding.has(hook)) {
            const gate = createGate();
            this.holdingGates[hook].push(gate);
            if (hook === 'enable' && this.failNextEnable) {
                this.failNextEnable = false;
                gate.reject(this.enableError || new Error(`[fake-engine:${this.id}] enable failed`));
            }
            return gate.promise;
        }

        return Promise.resolve().then(() => {
            if (hook === 'enable' && this.failNextEnable) {
                this.failNextEnable = false;
                throw this.enableError || new Error(`[fake-engine:${this.id}] enable failed`);
            }
        });

    }

    enable(options) {
        return this.#run('enable', options);
    }

    disable(options) {
        return this.#run('disable', options);
    }

    canPlay() {
        return 'probably';
    }

    /**
     * Holds the given hook open: invocations stay pending until {@link FakeEngineBase#release} (or
     * {@link FakeEngineBase#unblock}) is called. Safe to call before the switch starts and idempotent when
     * called more than once for the same hook (the pending queue is preserved).
     * @param {string} hook  'enable' or 'disable'.
     */
    block(hook) {
        this.holding.add(hook);
        if (!this.holdingGates[hook]) this.holdingGates[hook] = [];
    }

    /**
     * Settles the oldest pending invocation of a blocked hook (FIFO), matching the serialized switch order.
     * If the invocation has not been reached yet (the switch is still queued behind an earlier step), waits
     * until it arrives and then settles it.
     * @param {string} hook  'enable' or 'disable'.
     * @returns {Promise<void>}
     */
    async release(hook) {
        if (!this.holding.has(hook)) throw new Error(`[fake-engine:${this.id}] ${hook} is not blocked`);
        // wait until the serialized switch actually reaches this hook
        while (this.holdingGates[hook].length === 0) {
            await Promise.resolve();
        }
        const gate = this.holdingGates[hook].shift();
        if (hook === 'enable' && this.failNextEnable) {
            this.failNextEnable = false;
            gate.reject(this.enableError || new Error(`[fake-engine:${this.id}] enable failed`));
        } else {
            gate.resolve();
        }
    }

    /**
     * Stops holding the hook and resolves any invocations still waiting on it.
     * @param {string} hook  'enable' or 'disable'.
     */
    unblock(hook) {
        this.holding.delete(hook);
        const queue = this.holdingGates[hook];
        if (queue) {
            queue.forEach(gate => gate.resolve());
            queue.length = 0;
        }
    }

}

/**
 * Creates a deferred gate (promise with its settle functions exposed).
 * @returns {{promise: Promise, resolve: Function, reject: Function}}
 */
function createGate() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Engine "alpha": a playback-capable engine (mirrors the native engine role).
 */
export class FakeAlphaEngine extends FakeEngineBase {

    constructor() {
        super('alpha', {
            play: true,
            seek: true,
            volume: true,
            loop: true,
            playbackRate: true
        });
    }

}

/**
 * Engine "beta": initially playback-capable as well, but its capabilities can be reconfigured per test
 * (e.g. to emulate an embedded engine without play controls) and its enable() can be forced to fail.
 */
export class FakeBetaEngine extends FakeEngineBase {

    constructor(capabilities = { play: true, seek: true, volume: true }) {
        super('beta', capabilities);
    }

    /**
     * Replaces the capability descriptor at runtime (before the next switch).
     * @param {Object} capabilities  New capabilities.
     */
    setCapabilities(capabilities) {
        this.capabilities = capabilities;
    }

}

/**
 * Builds the standard pair of fake engines used by the acceptance tests.
 * @returns {{alpha: FakeAlphaEngine, beta: FakeBetaEngine}}
 */
export function createFakeEngines() {
    return {
        alpha: new FakeAlphaEngine(),
        beta: new FakeBetaEngine()
    };
}
