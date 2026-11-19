import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';

// The gsaf player's seek, decode-failure, destroy and pause/resume races, driven by a fake
// decoder (decodes complete when the test says so) and a fake app (updates fire when the test
// says so). Tests run against the built artifact, so they exercise exactly what the package
// ships. Run `npm run build` first (`npm test` does both).
import { GsafDecoder, GsafPlayer, loadGsaf } from '../dist/viewer.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// polls until a condition holds, since a load in flight crosses several task boundaries
const until = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i++) await flush();
    assert.ok(condition());
};

// tracks a promise's settlement, for asserting about what has not happened yet
const track = (promise) => {
    const state = { settled: null };
    promise.then(
        () => {
            state.settled = 'resolved';
        },
        () => {
            state.settled = 'rejected';
        }
    );
    return state;
};

const makeBuffers = () => ({
    center: new Float32Array(4),
    color: new Uint16Array(4),
    scale: new Uint16Array(4),
    rotation: new Uint16Array(4),
    centers: new Float32Array(3)
});

const makeApp = () => {
    const updates = new Set();
    return {
        renderNextFrame: false,
        on(name, fn) {
            if (name === 'update') updates.add(fn);
        },
        off(name, fn) {
            updates.delete(fn);
        },
        update(dt) {
            for (const fn of [...updates]) fn(dt);
        }
    };
};

const makeContainer = () => {
    const container = {
        uploads: 0,
        destroyed: false,
        getTexture: () => ({
            lock: () => ({
                set() {
                    // the frame's texels land here
                }
            }),
            unlock() {
                // the texture would upload here
            }
        }),
        centers: {
            set() {
                // the sorter's centers land here
            }
        },
        update() {
            container.uploads++;
        },
        destroy() {
            container.destroyed = true;
        }
    };
    return container;
};

const makeEntity = (container) => {
    const destroyers = [];
    return {
        gsplat: { resource: container, workBufferUpdate: 0 },
        once(name, fn) {
            if (name === 'destroy') destroyers.push(fn);
        },
        destroy() {
            for (const fn of destroyers.splice(0)) fn();
        }
    };
};

// a decoder whose decodes complete only when the test completes them
const makeDecoder = () => {
    const decoder = {
        requests: [],
        destroyed: false,
        decode(index, buffers) {
            return new Promise((resolve, reject) => {
                decoder.requests.push({ index, buffers, resolve, reject });
            });
        },
        destroy() {
            decoder.destroyed = true;
        },
        // resolves the oldest request, its frame carrying the buffers it was given back
        complete(count = 1) {
            const request = decoder.requests.shift();
            assert.ok(request, 'no decode in flight');
            request.resolve({ ...request.buffers, index: request.index, count });
        },
        fail(err) {
            const request = decoder.requests.shift();
            assert.ok(request, 'no decode in flight');
            request.reject(err);
        }
    };
    return decoder;
};

// a player over a 10-frame, 10fps sequence: one second long, frame n due at n / 10 seconds
const makePlayer = () => {
    const app = makeApp();
    const container = makeContainer();
    const entity = makeEntity(container);
    const decoder = makeDecoder();
    const first = { ...makeBuffers(), index: 0, count: 1 };
    const player = new GsafPlayer(app, entity, decoder, 10, 10, first, true);
    return { app, container, entity, decoder, player };
};

describe('GsafPlayer.seek', () => {
    it('resolves a superseded seek instead of landing it on the wrong frame', async () => {
        const { decoder, player } = makePlayer();

        const first = track(player.seek(0.5));
        assert.equal(decoder.requests.length, 1);
        assert.equal(decoder.requests[0].index, 5);

        // a newer seek supersedes the one still waiting for frame 5
        const second = track(player.seek(0.8));
        await flush();
        assert.equal(first.settled, 'resolved');
        assert.equal(second.settled, null);
        assert.equal(decoder.requests.length, 1);

        // frame 5 lands, but it is already stale: the seek for frame 8 keeps waiting
        decoder.complete();
        await flush();
        assert.equal(second.settled, null);
        assert.equal(decoder.requests.length, 1);
        assert.equal(decoder.requests[0].index, 8);

        // frame 8 lands: the latest seek's frame is on screen, so it resolves
        decoder.complete();
        await flush();
        assert.equal(second.settled, 'resolved');
        assert.equal(player.time, 0.8);
    });

    it('resolves at once when the frame is already on screen', async () => {
        const { decoder, player } = makePlayer();
        await player.seek(0);
        assert.equal(decoder.requests.length, 0);
    });

    it('wraps negative and overflowing times into the sequence', async () => {
        const { decoder, player } = makePlayer();
        const landed = player.seek(-0.2);
        assert.equal(player.time, 0.8);
        assert.equal(decoder.requests[0].index, 8);
        decoder.complete();
        await landed;
    });

    it('resolves immediately when the sequence is not animated', async () => {
        const app = makeApp();
        const entity = makeEntity(makeContainer());
        const decoder = makeDecoder();
        const first = { ...makeBuffers(), index: 0, count: 1 };
        const player = new GsafPlayer(app, entity, decoder, 10, 10, first, false);
        await player.seek(0.5);
        assert.equal(decoder.requests.length, 0);
    });

    it('rejects the pending and every later seek with the decode failure', async () => {
        const { decoder, player } = makePlayer();
        const landed = track(player.seek(0.5));
        const failure = new Error('decode failed');
        decoder.fail(failure);
        await flush();
        assert.equal(landed.settled, 'rejected');
        await assert.rejects(player.seek(0.2), (err) => err === failure);
        await assert.rejects(player.seek(0.9), (err) => err === failure);
        // the failure is terminal: no decode is attempted again
        assert.equal(decoder.requests.length, 0);
    });

    it('resolves a pending seek on destroy and never uploads or renders again', async () => {
        const { app, container, entity, decoder, player } = makePlayer();
        const landed = track(player.seek(0.5));
        assert.equal(decoder.requests.length, 1);

        entity.destroy();
        await flush();
        assert.equal(landed.settled, 'resolved');

        // a decode that outlives the player is dropped: no upload, no render
        decoder.complete();
        await flush();
        assert.equal(container.uploads, 0);
        assert.equal(app.renderNextFrame, false);

        // the update listener is gone and seeks resolve without decoding
        app.update(0.2);
        assert.equal(decoder.requests.length, 0);
        await player.seek(0.3);
        assert.equal(decoder.requests.length, 0);
    });

    it('uploads the decoded frame and asks for a render', async () => {
        const { app, container, entity, decoder, player } = makePlayer();
        const landed = player.seek(0.5);
        decoder.complete(7);
        await landed;
        assert.equal(container.uploads, 1);
        assert.equal(app.renderNextFrame, true);
        assert.equal(entity.gsplat.workBufferUpdate, 1);
    });
});

describe('GsafPlayer playback clock', () => {
    it('does not advance while paused and resumes from the same time', async () => {
        const { app, decoder, player } = makePlayer();
        assert.equal(player.paused, true);
        app.update(0.3);
        assert.equal(player.time, 0);
        assert.equal(decoder.requests.length, 0);

        player.paused = false;
        app.update(0.3);
        assert.ok(Math.abs(player.time - 0.3) < 1e-9);
        decoder.complete();
        await flush();

        player.paused = true;
        app.update(0.3);
        assert.ok(Math.abs(player.time - 0.3) < 1e-9);

        player.paused = false;
        app.update(0.1);
        assert.ok(Math.abs(player.time - 0.4) < 1e-9);
    });

    it('wraps the clock at the duration', () => {
        const { app, player } = makePlayer();
        player.paused = false;
        app.update(1.2);
        assert.ok(Math.abs(player.time - 0.2) < 1e-9);
    });
});

// GsafDecoder starts its worker from a blob url; a fake Worker captures it and speaks for it
class FakeWorker {
    static instances = [];

    static reset() {
        FakeWorker.instances = [];
    }

    constructor(url) {
        this.url = url;
        this.messages = [];
        this.terminates = 0;
        this.onmessage = null;
        this.onerror = null;
        FakeWorker.instances.push(this);
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminates++;
    }

    // a message from the worker, as its onmessage would deliver it
    respond(data) {
        this.onmessage({ data });
    }
}

const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

describe('GsafDecoder', () => {
    before(() => {
        globalThis.Worker = FakeWorker;
    });

    after(() => {
        delete globalThis.Worker;
    });

    beforeEach(() => {
        FakeWorker.reset();
    });

    it("settles requests with the worker's messages", async () => {
        const decoder = new GsafDecoder();
        const worker = FakeWorker.instances[0];
        const wasm = await WebAssembly.compile(EMPTY_WASM);

        const opened = decoder.open(new ArrayBuffer(8), wasm);
        assert.equal(worker.messages[0].type, 'open');
        worker.respond({ type: 'open', header: { frameCount: 3 } });
        assert.deepEqual(await opened, { frameCount: 3 });

        const decoded = decoder.decode(2, makeBuffers());
        assert.equal(worker.messages[1].type, 'decode');
        worker.respond({ type: 'decode', frame: { ...makeBuffers(), index: 2, count: 5 } });
        assert.equal((await decoded).index, 2);

        const failed = decoder.decode(3, makeBuffers());
        worker.respond({ type: 'error', message: 'bad frame' });
        await assert.rejects(failed, /bad frame/);
    });

    it('rejects a request in flight when destroyed, and every request after', async () => {
        const decoder = new GsafDecoder();
        const worker = FakeWorker.instances[0];
        const wasm = await WebAssembly.compile(EMPTY_WASM);
        const open = decoder.open(new ArrayBuffer(8), wasm);
        assert.equal(worker.messages.length, 1);

        decoder.destroy();
        await assert.rejects(open, /decoder was stopped/);
        assert.equal(worker.terminates, 1);

        // a destroyed decoder sends nothing more
        await assert.rejects(decoder.decode(0, makeBuffers()), /decoder was stopped/);
        assert.equal(worker.messages.length, 1);

        // a reply that arrives too late is ignored
        worker.respond({ type: 'open', header: {} });
        await flush();
    });

    it('is idempotent to destroy', () => {
        const decoder = new GsafDecoder();
        const worker = FakeWorker.instances[0];
        decoder.destroy();
        decoder.destroy();
        assert.equal(worker.terminates, 1);
    });
});

describe('loadGsaf', () => {
    before(() => {
        globalThis.Worker = FakeWorker;
    });

    after(() => {
        delete globalThis.Worker;
    });

    beforeEach(() => {
        FakeWorker.reset();
    });

    const WASM_DATA_URL = `data:application/wasm;base64,${Buffer.from(EMPTY_WASM).toString('base64')}`;

    const fakeResponse = () =>
        Promise.resolve({
            ok: true,
            url: 'https://example.com/scene.gsaf',
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(8)
        });

    const noProgress = () => {
        // progress is not under test
    };

    const makeLoadApp = () => ({
        graphicsDevice: {},
        renderNextFrame: false,
        root: {
            children: [],
            addChild(entity) {
                this.children.push(entity);
            }
        },
        on() {
            // the load only listens on a real app
        },
        off() {
            // the load only listens on a real app
        }
    });

    it('rejects when aborted before the file arrives, creating no decoder', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            loadGsaf(makeLoadApp(), fakeResponse(), WASM_DATA_URL, noProgress, controller.signal),
            /destroyed while loading/
        );
        assert.equal(FakeWorker.instances.length, 0);
    });

    it('rejects when aborted mid-open, stopping the worker and creating nothing', async () => {
        const controller = new AbortController();
        const app = makeLoadApp();
        const load = loadGsaf(app, fakeResponse(), WASM_DATA_URL, noProgress, controller.signal);

        // wait until the decoder's worker holds the open request
        await until(() => FakeWorker.instances[0]?.messages.length === 1);
        const worker = FakeWorker.instances[0];
        assert.equal(worker.messages[0].type, 'open');

        controller.abort();
        await assert.rejects(load, /destroyed while loading/);

        // the worker is stopped, nothing more was sent, and no container was created or
        // uploaded: no entity, no render
        assert.equal(worker.terminates, 1);
        assert.deepEqual(
            worker.messages.map((m) => m.type),
            ['open']
        );
        assert.equal(app.root.children.length, 0);
        assert.equal(app.renderNextFrame, false);

        // a reply that arrives after the abort changes nothing
        worker.respond({ type: 'open', header: {} });
        await flush();
        assert.equal(worker.messages.length, 1);
        assert.equal(app.root.children.length, 0);
    });
});
