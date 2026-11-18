/**
 * Unit tests for the stall detection logic of the Media component.
 * Run with: node --test test/unit/media.stall.test.js
 * @module test/unit/media.stall.test
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaEnvironment } from './helpers/fakeMediaEnvironment.mjs';

const topics = list => list.map(entry => entry.topic);

describe('Media stall detection', () => {

    let env;

    afterEach(() => {
        if (env) {
            env.media.disable();
            env = null;
        }
    });

    it('fires begin once while the playhead is stuck and end once after it advances', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        // playback starts and a waiting event arrives while the playhead stays at 0
        env.video.paused = false;
        env.video.dispatchEvent('waiting');

        assert.equal(env.player.getState('media.stalled'), false);

        await new Promise(resolve => setTimeout(resolve, 140));

        assert.deepEqual(topics(env.events).filter(t => t === 'media/stall/begin'), ['media/stall/begin']);
        assert.equal(env.player.getState('media.stalled'), true);

        // repeated waiting events while already stalled must not trigger another begin
        env.video.dispatchEvent('waiting');
        env.video.dispatchEvent('play');
        await new Promise(resolve => setTimeout(resolve, 140));
        assert.equal(topics(env.events).filter(t => t === 'media/stall/begin').length, 1);

        // playback recovers: playhead moves more than 0.2s and timeupdate fires
        env.video.currentTime = 1;
        env.video.dispatchEvent('timeupdate');

        assert.deepEqual(topics(env.events).filter(t => t === 'media/stall/end'), ['media/stall/end']);
        assert.equal(env.player.getState('media.stalled'), false);

        // further timeupdates must not publish end again
        env.video.currentTime = 2;
        env.video.dispatchEvent('timeupdate');
        assert.equal(topics(env.events).filter(t => t === 'media/stall/end').length, 1);
    });

    it('does not flag a stall when the playhead advances more than 0.2 seconds within the window', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        env.video.paused = false;
        env.video.dispatchEvent('waiting');

        // recovery happens before the timeout elapses
        env.video.currentTime = 0.5;
        env.video.dispatchEvent('timeupdate');

        await new Promise(resolve => setTimeout(resolve, 140));

        assert.equal(topics(env.events).includes('media/stall/begin'), false);
        assert.equal(env.player.getState('media.stalled'), false);
    });

    it('ends an active stall exactly once when playback is paused', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        env.video.paused = false;
        env.video.dispatchEvent('waiting');
        await new Promise(resolve => setTimeout(resolve, 140));
        assert.equal(topics(env.events).includes('media/stall/begin'), true);

        // user pauses while still stuck at the same position
        env.video.paused = true;
        env.video.dispatchEvent('pause');

        assert.deepEqual(topics(env.events).filter(t => t === 'media/stall/end'), ['media/stall/end']);

        // repeated pause events must not re-publish end
        env.video.dispatchEvent('pause');
        assert.equal(topics(env.events).filter(t => t === 'media/stall/end').length, 1);
    });

    it('never starts stall checks when stallTimeout is 0', async() => {

        env = await createMediaEnvironment({ timeout: 0 });

        env.video.paused = false;
        env.video.dispatchEvent('waiting');
        env.video.dispatchEvent('play');
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.equal(topics(env.events).includes('media/stall/begin'), false);
        assert.equal(topics(env.events).includes('media/stall/end'), false);
        assert.equal(env.player.getState('media.stalled'), false);
    });

    it('does not begin a stall while paused', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        env.video.paused = true;
        env.video.dispatchEvent('waiting');
        await new Promise(resolve => setTimeout(resolve, 140));

        assert.equal(topics(env.events).includes('media/stall/begin'), false);
    });

    it('does not begin a stall during AirPlay casting', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });
        env.player.setState('media.airPlayActive', { get: () => true, enumerable: true, configurable: true });

        env.video.paused = false;
        env.video.dispatchEvent('waiting');
        await new Promise(resolve => setTimeout(resolve, 140));

        assert.equal(topics(env.events).includes('media/stall/begin'), false);
    });

    it('clears an in-flight stall check when a new source is loaded', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        env.video.paused = false;
        const firstLoad = env.load(env.metaData('https://example.com/a.mp4'));
        firstLoad.catch(() => {}); // switching source cancels the former load
        env.video.dispatchEvent('waiting');

        // switch source before the stall timeout elapses
        const secondLoad = env.load(env.metaData('https://example.com/b.mp4'));
        await new Promise(resolve => setTimeout(resolve, 140));

        assert.equal(topics(env.events).includes('media/stall/begin'), false);
        assert.equal(env.player.getState('media.stalled'), false);

        env.video.dispatchEvent('loadedmetadata');
        await secondLoad;
    });

    it('resets stall state on recovery and can detect a subsequent stall again', async() => {

        env = await createMediaEnvironment({ timeout: 0.1 });

        env.video.paused = false;
        env.video.dispatchEvent('waiting');
        await new Promise(resolve => setTimeout(resolve, 140));
        assert.equal(topics(env.events).filter(t => t === 'media/stall/begin').length, 1);

        env.video.currentTime = 1;
        env.video.dispatchEvent('timeupdate');
        assert.equal(topics(env.events).filter(t => t === 'media/stall/end').length, 1);

        // second stall cycle after recovery
        env.video.dispatchEvent('waiting');
        await new Promise(resolve => setTimeout(resolve, 140));
        assert.equal(topics(env.events).filter(t => t === 'media/stall/begin').length, 2);
        assert.equal(topics(env.events).filter(t => t === 'media/stall/end').length, 1);
    });
});
