/**
 * Unit tests for the Media components' load error classification:
 * network errors (HTTP status / CORS) are distinguished from unsupported formats,
 * errors are published via 'media/error' and reject the load promise.
 * Run with: node --test test/unit/media.error.test.js
 * @module test/unit/media.error.test
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaEnvironment, flushMicrotasks } from './helpers/fakeMediaEnvironment.mjs';
import ExtendedMediaError from '../../src/util/ExtendedMediaError.js';

const UNSUPPORTED = 4;
const NETWORK = 2;

describe('Media load error classification', () => {

    let env;

    afterEach(() => {
        if (env) {
            env.media.disable();
            env = null;
        }
    });

    it('classifies an HTTP status >= 300 behind an unsupported-format error as a network error with status', async() => {

        env = await createMediaEnvironment();
        const requests = [];
        env.setFetch((url, options) => {
            requests.push({ url, options });
            return Promise.resolve({ status: 404 });
        });

        const load = env.load(env.metaData('https://example.com/missing.mp4'));

        // browser reports MEDIA_ERR_SRC_NOT_SUPPORTED, which triggers the HEAD probe first
        env.video.dispatchError({ code: UNSUPPORTED, message: 'src not supported' });
        await flushMicrotasks();

        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.method, 'HEAD');

        const published = env.events.find(entry => entry.topic === 'media/error');
        assert.ok(published, 'media/error must be published');
        assert.equal(published.data.error.code, NETWORK);
        assert.equal(published.data.error.status, 404);
        assert.match(published.data.error.message, /404/);
        assert.ok(published.data.error instanceof ExtendedMediaError);

        await assert.rejects(load, error => error.code === NETWORK && error.status === 404);
    });

    it('classifies a failed HEAD probe (e.g. CORS) as a network error carrying the reason', async() => {

        env = await createMediaEnvironment();
        const corsError = new TypeError('Failed to fetch: CORS policy blocked the request');
        env.setFetch(() => Promise.reject(corsError));

        const load = env.load(env.metaData('https://cdn.example.com/blocked.mp4'));
        env.video.dispatchError({ code: UNSUPPORTED, message: 'src not supported' });
        await flushMicrotasks();

        const published = env.events.find(entry => entry.topic === 'media/error');
        assert.ok(published);
        assert.equal(published.data.error.code, NETWORK);
        assert.match(published.data.error.message, /CORS/);
        assert.equal(published.data.error.cause, corsError);

        await assert.rejects(load, error => error.code === NETWORK && /CORS/.test(error.message));
    });

    it('keeps an unsupported-format error when the HEAD probe proves the resource is reachable', async() => {

        env = await createMediaEnvironment();
        env.setFetch(() => Promise.resolve({ status: 200 }));

        const load = env.load(env.metaData('https://example.com/weird.xyz'));
        env.video.dispatchError({ code: UNSUPPORTED, message: 'src not supported' });
        await flushMicrotasks();

        const published = env.events.find(entry => entry.topic === 'media/error');
        assert.ok(published);
        assert.equal(published.data.error.code, UNSUPPORTED);

        await assert.rejects(load, error => error.code === UNSUPPORTED);
    });

    it('does not probe blob: URLs and reports the format error directly', async() => {

        env = await createMediaEnvironment();
        let fetchCalled = false;
        env.setFetch(() => { fetchCalled = true; return Promise.resolve({ status: 200 }); });

        const load = env.load(env.metaData('blob:https://example.com/1234-5678'));
        env.video.dispatchError({ code: UNSUPPORTED, message: 'src not supported' });
        await flushMicrotasks();

        assert.equal(fetchCalled, false);
        const published = env.events.find(entry => entry.topic === 'media/error');
        assert.equal(published.data.error.code, UNSUPPORTED);

        await assert.rejects(load, error => error.code === UNSUPPORTED);
    });

    it('treats a native network error as a network error even without a probe', async() => {

        env = await createMediaEnvironment();
        let fetchCalled = false;
        env.setFetch(() => { fetchCalled = true; return Promise.resolve({ status: 200 }); });

        const load = env.load(env.metaData('https://example.com/stream.mp4'));
        env.video.dispatchError({ code: NETWORK, message: 'NETWORK_ERR' });
        await flushMicrotasks();

        assert.equal(fetchCalled, false, 'native network errors must not trigger a HEAD probe');
        const published = env.events.find(entry => entry.topic === 'media/error');
        assert.equal(published.data.error.code, NETWORK);

        await assert.rejects(load, error => error.code === NETWORK);
    });

    it('publishes a pause event alongside the error and only one error event', async() => {

        env = await createMediaEnvironment();
        env.setFetch(() => Promise.resolve({ status: 500 }));

        const load = env.load(env.metaData('https://example.com/failing.mp4'));
        env.video.dispatchError({ code: UNSUPPORTED, message: 'src not supported' });
        await flushMicrotasks();

        assert.equal(env.events.filter(entry => entry.topic === 'media/error').length, 1);
        assert.ok(env.events.some(entry => entry.topic === 'media/pause'));

        await assert.rejects(load);
    });
});
