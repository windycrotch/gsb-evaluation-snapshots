import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

// The gsaf player is not part of the shipped entries, so these tests build it from source:
// the TypeScript is transpiled and its imports of playcanvas and the decoder worker are
// redirected to the stubs below, which record everything the player does — every frame
// uploaded to the container, every decode asked of the worker, every destroy.

const PLAYCANVAS_STUB = `
export const WORKBUFFER_UPDATE_ONCE = 1;

export class Vec3 {
    constructor(v) {
        this.v = v;
    }
}

export class Quat {
    constructor(x, y, z, w) {
        Object.assign(this, { x, y, z, w });
    }
}

export class GSplatFormat {
    static createDefaultFormat() {
        return {};
    }
}

// A container standing in for the GPU one: it records every frame uploaded to it.
export class GSplatContainer {
    static instances = [];

    constructor(device, maxSplats, format) {
        this.device = device;
        this.maxSplats = maxSplats;
        this.aabb = { setMinMax: () => {} };
        this.textures = new Map();
        this.centers = { set: () => {} };
        this.uploads = [];
        this.destroyed = false;
        GSplatContainer.instances.push(this);
    }

    getTexture(name) {
        let texture = this.textures.get(name);
        if (!texture) {
            texture = { width: 8, height: 8, lock: () => ({ set: () => {} }), unlock: () => {} };
            this.textures.set(name, texture);
        }
        return texture;
    }

    update(count) {
        this.uploads.push(count);
    }

    destroy() {
        this.destroyed = true;
    }
}

export class Entity {
    constructor(name, app) {
        this.name = name;
        this.app = app;
        this.handlers = new Map();
    }

    once(event, fn) {
        const list = this.handlers.get(event) ?? [];
        list.push(fn);
        this.handlers.set(event, list);
    }

    setLocalRotation() {}

    setLocalPosition() {}

    setLocalEulerAngles() {}

    addComponent(name, data) {
        this[name] = { ...data };
    }

    destroy() {
        for (const fn of this.handlers.get('destroy') ?? []) fn();
    }
}
`;

const WORKER_STUB = `
// Every decoder created through the module under test, oldest first.
export const instances = [];

// A decoder the test drives by hand: open and decode queue a request the test settles.
export class GsafDecoder {
    constructor() {
        this.opens = [];
        this.decodes = [];
        this.destroyed = false;
        instances.push(this);
    }

    open(bytes, wasm) {
        return new Promise((resolve, reject) => this.opens.push({ resolve, reject }));
    }

    decode(index, buffers) {
        return new Promise((resolve, reject) => this.decodes.push({ index, buffers, resolve, reject }));
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const request of this.opens.splice(0)) request.reject(new Error('gsaf: the decoder was stopped'));
        for (const request of this.decodes.splice(0)) request.reject(new Error('gsaf: the decoder was stopped'));
    }
}

export const compileGsafDecoder = () => Promise.resolve('compiled-decoder');
`;

const dir = mkdtempSync(join(tmpdir(), 'gsaf-player-'));
const source = readFileSync(new URL('../../src/gsaf/gsaf-player.ts', import.meta.url), 'utf8');
const transpiled = ts
    .transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    })
    .outputText.replace(/from ["']playcanvas["']/, "from './playcanvas-stub.mjs'")
    .replace(/from ["']\.\/gsaf-worker["']/, "from './gsaf-worker-stub.mjs'");
writeFileSync(join(dir, 'gsaf-player.mjs'), transpiled);
writeFileSync(join(dir, 'playcanvas-stub.mjs'), PLAYCANVAS_STUB);
writeFileSync(join(dir, 'gsaf-worker-stub.mjs'), WORKER_STUB);

const moduleUrl = (name) => pathToFileURL(join(dir, name)).href;
const { GsafPlayer, loadGsaf } = await import(moduleUrl('gsaf-player.mjs'));
const { Entity, GSplatContainer } = await import(moduleUrl('playcanvas-stub.mjs'));
const { GsafDecoder, instances: decoders } = await import(moduleUrl('gsaf-worker-stub.mjs'));

// flushes the microtask queue, letting a settled decode reach the player
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeApp = () => {
    const updates = new Set();
    return {
        renderNextFrame: false,
        graphicsDevice: { isWebGPU: true },
        root: { addChild: () => undefined },
        on: (event, fn) => updates.add(fn),
        off: (event, fn) => updates.delete(fn),
        update: (dt) => {
            for (const fn of [...updates]) fn(dt);
        }
    };
};

// a player over a fake container, 10 frames at 10 fps, so the time names the frame: 0.4 is frame 4
const makePlayer = (animated = true) => {
    const app = makeApp();
    const container = new GSplatContainer(app.graphicsDevice, 16, {});
    const entity = new Entity('gsplat', app);
    entity.gsplat = { resource: container, workBufferUpdate: null };
    const decoder = new GsafDecoder();
    const first = {
        center: new Float32Array(4),
        color: new Uint16Array(4),
        scale: new Uint16Array(4),
        rotation: new Uint16Array(4),
        centers: new Float32Array(3),
        index: 0,
        count: 1
    };
    const player = new GsafPlayer(app, entity, decoder, 10, 10, first, animated);
    return { app, container, entity, decoder, player };
};

// settles the oldest decode in flight with a frame whose count names its index (frame n → n + 1)
const completeDecode = (decoder) => {
    const request = decoder.decodes.shift();
    assert.ok(request, 'a decode is in flight');
    request.resolve({ ...request.buffers, index: request.index, count: request.index + 1 });
};

// silences the player's error report while a test makes a decode fail on purpose
const muteConsoleError = () => {
    const original = console.error;
    console.error = () => undefined;
    return () => {
        console.error = original;
    };
};

describe('GsafPlayer', () => {
    it('lands the last of a burst of seeks, never showing the frames they overtook', async () => {
        const { player, decoder, container } = makePlayer();
        // three seeks land while the first one's frame is still decoding
        const first = player.seek(0.1);
        const second = player.seek(0.5);
        const third = player.seek(0.9);
        assert.equal(decoder.decodes.length, 1);
        assert.equal(decoder.decodes[0].index, 1);

        completeDecode(decoder); // frame 1, overtaken by the later seeks
        await tick();
        assert.deepEqual(container.uploads, []); // the stale frame is not shown
        assert.equal(decoder.decodes.length, 1);
        assert.equal(decoder.decodes[0].index, 9); // the last seek's frame decodes next

        completeDecode(decoder);
        await Promise.all([first, second, third]); // every seek settles once the last one lands
        assert.deepEqual(container.uploads, [10]); // only frame 9 (count 10) reached the container
        assert.equal(player.time, 0.9);
    });

    it('lands a seek made while paused and plays on from that frame', async () => {
        const { app, player, decoder, container } = makePlayer();
        const landed = player.seek(0.3);
        completeDecode(decoder);
        await landed; // resolves though the player is paused
        assert.deepEqual(container.uploads, [4]);

        player.paused = false;
        app.update(0.2); // the clock resumes at the seek's frame: 0.5 is frame 5
        assert.equal(decoder.decodes.length, 1);
        assert.equal(decoder.decodes[0].index, 5);
        completeDecode(decoder);
        await tick();
        assert.deepEqual(container.uploads, [4, 6]);
    });

    it('shows frames as they decode while playing, skipping the ones a slow decode misses', async () => {
        const { app, player, decoder, container } = makePlayer();
        player.paused = false;
        app.update(0.1); // frame 1 falls due
        assert.equal(decoder.decodes[0].index, 1);
        app.update(0.1); // the playhead moves on while it decodes, but no seek happened
        completeDecode(decoder); // frame 1 still lands: it is the freshest decode there is
        await tick();
        assert.deepEqual(container.uploads, [2]);
        assert.equal(decoder.decodes[0].index, 2); // and the frame now due decodes next
    });

    it('keeps the last frame after a decode fails and rejects every later seek', async () => {
        const restore = muteConsoleError();
        try {
            const { player, decoder, container } = makePlayer();
            const landed = player.seek(0.4);
            decoder.decodes.shift().reject(new Error('gsaf: decode broke'));
            await assert.rejects(landed, /decode broke/);

            await assert.rejects(player.seek(0.6), /decode broke/); // rejects, does not hang
            await assert.rejects(player.seek(0.1), /decode broke/);
            assert.equal(decoder.decodes.length, 0); // no decode is attempted for them
            assert.deepEqual(container.uploads, []); // the last shown frame stays up
        } finally {
            restore();
        }
    });

    it('releases pending seeks on destroy and never uploads a frame that lands after it', async () => {
        const { entity, player, decoder, container } = makePlayer();
        const landed = player.seek(0.4);
        entity.destroy();
        await landed; // the destroy settles the wait instead of hanging it
        await player.seek(0.7); // a seek after destroy resolves at once

        completeDecode(decoder); // the decode in flight at destroy finishes late
        await tick();
        assert.deepEqual(container.uploads, []); // nothing reaches the GPU
        assert.equal(decoder.decodes.length, 0); // and nothing more is decoded
    });

    it('resolves a seek at once when the sequence is not animated', async () => {
        const { player, decoder } = makePlayer(false);
        await player.seek(0.5);
        assert.equal(decoder.decodes.length, 0);
    });
});

describe('loadGsaf', () => {
    const HEADER = { frameCount: 10, maxSplats: 4, fps: 10, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] };

    // a response whose body the test releases when it chooses
    const makeResponse = () => {
        let release;
        const body = new Promise((resolve) => {
            release = () => resolve(new ArrayBuffer(8));
        });
        const response = Promise.resolve({
            ok: true,
            headers: { get: () => '8' },
            body: null,
            arrayBuffer: () => body
        });
        return { response, release };
    };

    // a load driven through open and the first decode, returning the live player
    const makeLoadedPlayer = async () => {
        const app = makeApp();
        const { response, release } = makeResponse();
        const controller = new AbortController();
        const load = loadGsaf(app, response, undefined, () => undefined, controller.signal);
        release();
        await tick();
        const decoder = decoders.at(-1);
        decoder.opens.shift().resolve(HEADER);
        await tick();
        const firstDecode = decoder.decodes.shift();
        firstDecode.resolve({ ...firstDecode.buffers, index: 0, count: 1 });
        const player = await load;
        const container = GSplatContainer.instances.at(-1);
        return { app, player, decoder, container, controller };
    };

    it('rejects without creating a worker when aborted during the download', async () => {
        const { response, release } = makeResponse();
        const controller = new AbortController();
        const before = decoders.length;
        const load = loadGsaf(makeApp(), response, undefined, () => undefined, controller.signal);
        controller.abort();
        release();
        await assert.rejects(load, /destroyed while loading/);
        assert.equal(decoders.length, before);
    });

    it('stops the worker when aborted while the file opens', async () => {
        const { response, release } = makeResponse();
        const controller = new AbortController();
        const load = loadGsaf(makeApp(), response, undefined, () => undefined, controller.signal);
        release();
        await tick();
        const decoder = decoders.at(-1);
        assert.equal(decoder.opens.length, 1);
        controller.abort();
        await assert.rejects(load, /destroyed while loading/);
        assert.ok(decoder.destroyed);
    });

    it('releases the worker and the container when aborted during the first decode', async () => {
        const { response, release } = makeResponse();
        const controller = new AbortController();
        const load = loadGsaf(makeApp(), response, undefined, () => undefined, controller.signal);
        release();
        await tick();
        const decoder = decoders.at(-1);
        decoder.opens[0].resolve(HEADER);
        await tick();
        assert.equal(decoder.decodes.length, 1);
        const container = GSplatContainer.instances.at(-1);
        controller.abort();
        await assert.rejects(load, /destroyed while loading/);
        assert.ok(decoder.destroyed);
        assert.ok(container.destroyed);
    });

    it('shows the first frame, then releases the worker and container with the entity', async () => {
        const { player, decoder, container } = await makeLoadedPlayer();
        assert.equal(player.animated, true);
        assert.equal(player.duration, 1);
        assert.deepEqual(container.uploads, [1]); // the first frame is up
        player.entity.destroy();
        assert.ok(decoder.destroyed);
        assert.ok(container.destroyed);
    });

    it('lets two players on one page decode and die independently', async () => {
        const restore = muteConsoleError();
        try {
            const one = await makeLoadedPlayer();
            const two = await makeLoadedPlayer();

            // a decode failure in one player does not touch the other
            const failed = one.player.seek(0.4);
            one.decoder.decodes.shift().reject(new Error('gsaf: boom'));
            await assert.rejects(failed, /boom/);
            await assert.rejects(one.player.seek(0.2), /boom/);

            const landed = two.player.seek(0.4);
            completeDecode(two.decoder);
            await landed;
            assert.deepEqual(two.container.uploads, [1, 5]);

            // destroying one leaves the other decoding
            one.player.entity.destroy();
            assert.ok(one.decoder.destroyed);
            assert.ok(!two.decoder.destroyed);
            const again = two.player.seek(0.6);
            completeDecode(two.decoder);
            await again;
            assert.deepEqual(two.container.uploads, [1, 5, 7]);
        } finally {
            restore();
        }
    });
});
