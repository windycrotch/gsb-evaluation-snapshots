import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The player bundled from its shipped source (rollup.test.config.mjs), with the engine stubbed:
// the tests inject every collaborator through the public constructor and drive it only through
// the public api (seek, time, failed, paused, entity.destroy). Run `npm test`, which builds it.
import { GsafPlayer } from '../../test-build/gsaf-player.js';

const FRAMES = 10;
const FPS = 30;
const DURATION = FRAMES / FPS;
const SPLATS = 4;

// A controllable decoder standing in for the worker: each decode holds until the test resolves
// or rejects it, so the main thread never blocks and failures are a test decision.
class FakeDecoder {
    calls = [];

    #pending = [];

    decode(index) {
        this.calls.push(index);
        return new Promise((resolve, reject) => {
            this.#pending.push({ index, resolve, reject });
        });
    }

    // resolves the oldest in-flight decode with a frame in the worker's own shape
    resolve(index = this.#pending[0]?.index ?? 0) {
        const item = this.#pending.shift();
        assert.ok(item, 'no decode in flight to resolve');
        item.resolve({ ...buffers(), index, count: SPLATS });
    }

    failNext(err = new Error('gsaf: decode failed')) {
        const item = this.#pending.shift();
        assert.ok(item, 'no decode in flight to fail');
        item.reject(err);
        return err;
    }

    destroy() {
        this.#pending.length = 0;
    }
}

// minimal AppBase: the update events the player pumps on, and the render flag uploads set
class FakeApp {
    #handlers = new Map();

    renderNextFrame = false;

    on(name, handler) {
        this.#handlers.set(name, handler);
    }

    off(name, handler) {
        if (this.#handlers.get(name) === handler) this.#handlers.delete(name);
    }

    // fires the engine's per-frame update with the given delta seconds
    update(dt) {
        this.#handlers.get('update')?.(dt);
    }
}

// one locked texture per stream, recording that the frame's data was written into it
class FakeTexture {
    locked = false;

    data = null;

    // the player writes through the storage lock() hands back, then unlocks the texture
    lock() {
        this.locked = true;
        return { set: (data) => this.#write(data) };
    }

    #write(data) {
        this.data = data;
    }

    unlock() {
        this.locked = false;
    }
}

class FakeContainer {
    textures = new Map();

    // the engine's separate xyz centers buffer the sorter reads
    centers = new Float32Array(SPLATS * 3);

    updates = [];

    constructor() {
        for (const name of ['dataCenter', 'dataColor', 'dataScale', 'dataRotation']) {
            this.textures.set(name, new FakeTexture());
        }
    }

    getTexture(name) {
        return this.textures.get(name);
    }

    update(count) {
        this.updates.push(count);
    }
}

class FakeEntity {
    #destroyHandler = null;

    gsplat;

    resource;

    constructor() {
        this.resource = new FakeContainer();
        // mirrors the engine's gsplat component: a writable workBufferUpdate flag the player
        // sets once per uploaded frame, plus a counter the test reads
        let workBufferUpdate = 0;
        this.gsplat = {
            resource: this.resource,
            workBufferUpdates: 0,
            get workBufferUpdate() {
                return workBufferUpdate;
            },
            set workBufferUpdate(value) {
                workBufferUpdate = value;
                this.workBufferUpdates++;
            }
        };
    }

    once(name, handler) {
        assert.equal(name, 'destroy');
        this.#destroyHandler = handler;
    }

    // the public teardown the embedding host reaches through the entity
    destroy() {
        const handler = this.#destroyHandler;
        this.#destroyHandler = null;
        handler?.();
    }
}

const buffers = () => ({
    center: new Float32Array(SPLATS * 4),
    color: new Uint16Array(SPLATS * 4),
    scale: new Uint16Array(SPLATS * 4),
    rotation: new Uint16Array(SPLATS * 4),
    centers: new Float32Array(SPLATS * 3)
});

const makePlayer = (animated = true) => {
    const app = new FakeApp();
    const entity = new FakeEntity();
    const decoder = new FakeDecoder();
    const first = { ...buffers(), index: 0, count: SPLATS };
    const player = new GsafPlayer(app, entity, decoder, FRAMES, FPS, first, animated);
    return { app, entity, decoder, player };
};

// flushes the microtasks a settled promise's continuations run in
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GsafPlayer seek contract', () => {
    it('resolves after seeking to a middle frame, once it is uploaded, with the right time', async () => {
        const { app, entity, decoder, player } = makePlayer();

        assert.equal(player.time, 0);
        const landed = player.seek(0.1); // 0.1s * 30fps = frame 3

        // the decode is in flight in the worker and nothing has landed yet
        assert.deepEqual(decoder.calls, [3]);
        assert.equal(entity.resource.updates.length, 0);

        let settled = false;
        landed.then(() => (settled = true));
        await flush();
        assert.equal(settled, false);

        decoder.resolve(3);
        await landed;

        assert.equal(player.time, 0.1);
        // every stream was written, unlocked, and the container updated with the frame's count
        for (const texture of entity.resource.textures.values()) {
            assert.notEqual(texture.data, null);
            assert.equal(texture.locked, false);
        }
        assert.deepEqual(entity.resource.updates, [SPLATS]);
        // one upload asks for exactly one work buffer copy, and a render
        assert.equal(entity.gsplat.workBufferUpdate, 1);
        assert.equal(entity.gsplat.workBufferUpdates, 1);
        assert.equal(app.renderNextFrame, true);
    });

    it('resolves at once when seeking to the frame already on screen, with no decode', async () => {
        const { decoder, player } = makePlayer();

        let settled = false;
        player.seek(0).then(() => (settled = true));
        await flush();

        assert.equal(settled, true);
        assert.deepEqual(decoder.calls, []);

        // and again after a real frame has landed
        const middle = player.seek(0.1);
        decoder.resolve(3);
        await middle;
        decoder.calls.length = 0;

        settled = false;
        player.seek(0.1).then(() => (settled = true));
        await flush();
        assert.equal(settled, true);
        assert.deepEqual(decoder.calls, []);
    });

    it('wraps negative and over-duration times back into [0, duration)', async () => {
        const { decoder, player } = makePlayer();

        // times sit exactly on frame starts (frame / fps); the frame index is exact, while the
        // playhead carries a sub-ulp residue from floating-point modulo and is compared within
        // tolerance. Each targets a frame not yet shown, so a decode is always requested
        const epsilon = 1e-9;
        const t = (frame) => frame / FPS;
        const cases = [
            // [input time, expected playhead time, expected frame]
            [DURATION + t(2), t(2), 2], // one whole duration past frame 2
            [2 * DURATION + t(3), t(3), 3], // two durations past frame 3
            [-t(2), DURATION - t(2), FRAMES - 2], // negative lands two frames before the end
            [-DURATION + t(1), t(1), 1], // one duration back, then frame 1
            [-2 * DURATION - t(1), DURATION - t(1), FRAMES - 1] // two durations back and one frame
        ];

        for (const [input, expectedTime, expectedFrame] of cases) {
            const callsBefore = decoder.calls.length;
            const landed = player.seek(input);

            assert.ok(player.time >= 0 && player.time < DURATION, `time ${player.time} in range`);
            assert.ok(Math.abs(player.time - expectedTime) < epsilon);
            // a new frame is requested from the worker for the wrapped target
            assert.equal(decoder.calls.length, callsBefore + 1);
            assert.equal(decoder.calls.at(-1), expectedFrame);

            decoder.resolve(expectedFrame);
            await landed;
            assert.ok(Math.abs(player.time - expectedTime) < epsilon);
        }

        // a whole number of durations wraps back to the start (frame 0). Floating-point modulo
        // leaves a sub-ulp residue instead of exact zero, so it lands on frame 0 and decodes it;
        // only an input that yields an exact in-range zero takes the already-shown shortcut
        const zeroCalls = decoder.calls.length;
        const atEnd = player.seek(DURATION);
        assert.ok(player.time >= 0 && player.time < epsilon);
        assert.equal(decoder.calls.length, zeroCalls + 1);
        assert.equal(decoder.calls.at(-1), 0);
        decoder.resolve(0);
        await atEnd;

        // now frame 0 is on screen again: seeking the wrapped zero resolves at once, no decode
        const shownCalls = decoder.calls.length;
        const wrappedZero = player.seek(0);
        assert.equal(player.time, 0);
        assert.equal(decoder.calls.length, shownCalls);
        await wrappedZero;
    });

    it('rejects seeks with the original decode error after a failure, and reports failed', async (t) => {
        t.mock.method(console, 'error');
        const { app, decoder, player } = makePlayer();

        assert.equal(player.failed, false);
        const err = new Error('gsaf: worker exploded');
        const first = player.seek(0.1);
        decoder.failNext(err);

        await assert.rejects(first, (caught) => caught === err);
        assert.equal(player.failed, true);

        // failed is read-only: assigning in strict mode throws, the getter stays true
        assert.throws(() => {
            player.failed = false;
        }, TypeError);
        assert.equal(player.failed, true);

        // a later seek rejects with the same error, starts no decode, and the clock is frozen
        const callsBefore = decoder.calls.length;
        await assert.rejects(player.seek(0.2), (caught) => caught === err);
        assert.equal(decoder.calls.length, callsBefore);

        const timeBefore = player.time;
        player.paused = false;
        app.update(0.1);
        assert.equal(player.time, timeBefore);
    });

    it('resolves seeks still pending when the entity is destroyed, and new seeks after', async () => {
        const { entity, decoder, player } = makePlayer();

        const pending = player.seek(0.1);
        assert.deepEqual(decoder.calls, [3]);
        let settled = false;
        pending.then(() => (settled = true));

        entity.destroy();
        await pending;
        assert.equal(settled, true);

        // a seek after destruction resolves at once and never reaches the decoder
        const callsBefore = decoder.calls.length;
        const after = player.seek(0.2);
        let afterSettled = false;
        after.then(() => (afterSettled = true));
        await flush();
        assert.equal(afterSettled, true);
        assert.equal(decoder.calls.length, callsBefore);

        // the in-flight decode settling later never rejects or disturbs the settled seek
        decoder.resolve(3);
        await flush();
        assert.equal(settled, true);
    });

    it('resolves immediately on a non-animated player without starting a decode', async () => {
        const { app, decoder, player } = makePlayer(false);

        assert.equal(player.animated, false);
        let settled = false;
        player.seek(0.1).then(() => (settled = true));
        await flush();

        assert.equal(settled, true);
        assert.deepEqual(decoder.calls, []);
        // the worker is never pumped: an update changes nothing and starts nothing
        player.paused = false;
        app.update(0.1);
        assert.equal(player.time, 0);
        assert.deepEqual(decoder.calls, []);
    });

    it('decodes and uploads a seek while paused, without advancing the clock', async () => {
        const { app, entity, decoder, player } = makePlayer();

        assert.equal(player.paused, true);
        const landed = player.seek(0.1);
        decoder.resolve(3);
        await landed;

        assert.equal(player.time, 0.1);
        assert.deepEqual(entity.resource.updates, [SPLATS]);

        // playback updates while paused leave the playhead where the seek put it
        app.update(0.1);
        app.update(0.05);
        assert.equal(player.time, 0.1);

        // unpausing advances it again, proving the pause was all that held the clock
        player.paused = false;
        app.update(0.1);
        assert.ok(player.time > 0.1);
    });

    it('coalesces concurrent seeks, resolving both when the latest requested frame lands', async () => {
        const { decoder, player } = makePlayer();

        const first = player.seek(0.1);
        const second = player.seek(0.2); // frame 6; only one decode is ever in flight
        assert.deepEqual(decoder.calls, [3]);

        decoder.resolve(6);
        await Promise.all([first, second]);
        assert.equal(player.time, 0.2);
    });
});
