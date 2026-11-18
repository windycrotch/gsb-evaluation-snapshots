/**
 * Unit tests for the Media components' source loading task handling:
 * cancellation of a still-loading former source and reuse of pending promises.
 * Run with: node --test test/unit/media.load.test.js
 * @module test/unit/media.load.test
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaEnvironment, flushMicrotasks } from './helpers/fakeMediaEnvironment.mjs';

describe('Media source loading', () => {

    let env;

    afterEach(() => {
        if (env) {
            env.media.disable();
            env = null;
        }
    });

    it('reuses the pending promise when the same src is requested twice', async() => {

        env = await createMediaEnvironment();

        const metaData = env.metaData('https://example.com/same.mp4'),
              first = env.load(metaData),
              second = env.load(metaData);

        // the native element only ever received a single load instruction (no concurrent double load)
        assert.equal(env.video.loadCount, 1);
        assert.equal(env.video.src, 'https://example.com/same.mp4');

        // settling the shared underlying task fulfils both requests with the same result
        env.video.dispatchEvent('loadedmetadata');
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.deepEqual(secondResult, firstResult);
        assert.equal(env.video.loadCount, 1);
    });

    it('cancels the still-pending task of the former source before loading a new one', async() => {

        env = await createMediaEnvironment();

        const first = env.load(env.metaData('https://example.com/old.mp4'));
        let rejectionName;
        first.catch(error => { rejectionName = error.name; });

        assert.equal(env.video.loadCount, 1);

        const next = env.load(env.metaData('https://example.com/new.mp4'));
        await flushMicrotasks();

        // the former load was rejected with an AbortError ...
        assert.equal(rejectionName, 'AbortError');
        // ... and the new source was actually assigned and loaded
        assert.equal(env.video.src, 'https://example.com/new.mp4');
        assert.equal(env.video.loadCount, 2);

        env.video.dispatchEvent('loadedmetadata');
        await assert.doesNotReject(next);
    });

    it('does not reuse a promise that already settled for the same src', async() => {

        env = await createMediaEnvironment();

        const first = env.load(env.metaData('https://example.com/once.mp4'));
        env.video.dispatchEvent('loadedmetadata');
        await first;

        // a second, later request for the same src starts a fresh task instead of reusing the settled one
        const again = env.load(env.metaData('https://example.com/once.mp4'));
        assert.notEqual(again, first);
        assert.equal(env.video.loadCount, 2);

        env.video.dispatchEvent('loadedmetadata');
        await assert.doesNotReject(again);
    });

    it('rejects the load promise when the media element reports an error', async() => {

        env = await createMediaEnvironment();
        env.setFetch(() => Promise.resolve({ status: 200 }));

        const load = env.load(env.metaData('https://example.com/broken.mp4'));

        env.video.dispatchError({ code: 4, message: 'DEMUXER_ERROR_NO_SUPPORT', MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });

        await assert.rejects(load, error => error.code === 4);
    });
});
