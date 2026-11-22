/**
 * Acceptance tests for engine-switch coordination between {@link module:src/core/Player} (setEngine) and the
 * {@link module:src/controller/Play} control component.
 *
 * Coverage:
 *  1. Normal switch: events fire in order, engine hooks run in order, button reflects real playability.
 *  2. Rapid sequential switches (timing races): requests take effect in initiation order; the slow earlier
 *     switch can never overwrite a later one; each engine event is published exactly once per switch.
 *  3. Switch failure recovery: failure publishes player/engine/switchfailed, the old engine is re-enabled,
 *     the current engine stays the old one, and the play button returns to a state matching the real engine.
 *  4. Destroy cleanup: an in-flight switch never publishes or touches DOM after destroy(); all subscriptions
 *     are torn down.
 *  5. Subscription lifecycle: capability subscriptions are added/removed in pairs, never accumulate when the
 *     same capability state is re-entered, and a single click never triggers multiple play/pause calls.
 *
 * Run with: node --test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDomShim } from './helpers/domShim.js';

installDomShim();

const { createTestPlayer, flushMicrotasks } = await import('./helpers/harness.js');
const { createFakeEngines, FakeBetaEngine } = await import('./helpers/fakeEngines.js');

const CAPABILITY_TOPICS = ['data/ready', 'media/pause', 'media/play', 'data/nomedia', 'media/error', 'media/canplay'];

let harness;

beforeEach(() => {
    harness = null;
});

afterEach(() => {
    harness?.destroy();
});

function countByTopic(events, topic) {
    return events.filter(event => event.topic === topic).length;
}

/**
 * Simulates the production post-switch flow: the Data component publishes data/ready and the media element
 * fires canplay once the new engine is ready. This is what makes the Play button usable in real life.
 * @param {Player} player  Player instance.
 */
function simulateMediaReady(player) {
    player.publish('data/ready', { src: 'fake.mp4' }, { async: false });
    player.publish('media/canplay', null, { async: false });
}

// --------------------------------------------------------------------------------------------------
// 1. Normal switch
// --------------------------------------------------------------------------------------------------

test('normal switch: publishes set then switched once each and runs engine hooks in order', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, events, button } = harness;

    assert.equal(player.getEngine().id, 'alpha');

    await player.setEngine('beta');
    simulateMediaReady(player);

    assert.deepEqual(events.map(e => e.topic), ['player/engine/set', 'player/engine/switched']);
    assert.equal(events[0].data.from.id, 'alpha');
    assert.equal(events[0].data.to.id, 'beta');
    assert.equal(player.getEngine().id, 'beta');

    // lifecycle hooks: old engine disabled first, new engine enabled after
    assert.equal(engines.alpha.calls.disable.length, 1);
    assert.equal(engines.beta.calls.enable.length, 1);

    // both engines are playback-capable: button becomes usable and shows the play icon while paused
    assert.equal(button.disabled, false);
    assert.equal(button.classList.contains('play'), true);
    assert.equal(button.classList.contains('pause'), false);

});

test('normal switch: button icon tracks media/play and media/pause', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button } = harness;

    await player.setEngine('beta');

    player.publish('media/play', null, { async: false });
    assert.equal(button.classList.contains('pause'), true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');

    player.publish('media/pause', null, { async: false });
    assert.equal(button.classList.contains('play'), true);
    assert.equal(button.getAttribute('aria-pressed'), 'false');

});

test('normal switch: target engine without play capability hides and disables the button', async() => {

    const engines = createFakeEngines();
    engines.beta.setCapabilities({ play: false });
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button, liveSubs } = harness;

    await player.setEngine('beta');

    assert.equal(button.style.display, 'none');
    assert.equal(button.disabled, true);

    // capability subscriptions must have been removed again when leaving the play-capable engine
    for (const topic of CAPABILITY_TOPICS) {
        assert.equal(liveSubs.has(topic), false, `subscription for ${topic} should be removed`);
    }

});

// --------------------------------------------------------------------------------------------------
// 2. Rapid sequential switches / timing races
// --------------------------------------------------------------------------------------------------

test('rapid switches: requests become effective in initiation order regardless of settle timing', async() => {

    const engines = createFakeEngines();
    class GammaEngine extends FakeBetaEngine {
        constructor() {
            super({ play: true });
            this.id = 'gamma';
        }
    }
    const gamma = new GammaEngine();
    harness = await createTestPlayer({ engines: { alpha: engines.alpha, beta: engines.beta, gamma }, initial: 'alpha' });
    const { player, events } = harness;

    // Hold every hook so each switch step only settles when the test says so. Queued switches each get
    // their own pending gate, so releases below follow the serialized switch order explicitly.
    engines.alpha.block('disable'); // switch #1: alpha.disable
    engines.beta.block('enable');   // switch #1: beta.enable
    engines.beta.block('disable');  // switch #2: beta.disable
    gamma.block('enable');          // switch #2: gamma.enable
    gamma.block('disable');         // switch #3: gamma.disable
    engines.alpha.block('enable');  // switch #3: alpha.enable

    const p1 = player.setEngine('beta');
    const p2 = player.setEngine('gamma');
    const p3 = player.setEngine('alpha');

    await flushMicrotasks(5);

    // only request #1 has started (its synchronous 'set'); queued requests publish nothing yet
    assert.equal(player.getEngine().id, 'alpha');
    assert.equal(countByTopic(events, 'player/engine/set'), 1);

    // let switch #1 finish: alpha -> beta
    engines.alpha.release('disable');
    engines.beta.release('enable');
    await p1;
    assert.equal(player.getEngine().id, 'beta');
    assert.equal(countByTopic(events, 'player/engine/switched'), 1);

    // let switch #2 finish: beta -> gamma
    engines.beta.release('disable');
    gamma.release('enable');
    await p2;
    assert.equal(player.getEngine().id, 'gamma');

    // let switch #3 finish: gamma -> alpha
    gamma.release('disable');
    engines.alpha.release('enable');
    await p3;
    assert.equal(player.getEngine().id, 'alpha');

    // exactly one set/switched pair per request, in request order
    assert.deepEqual(events.map(e => e.topic), [
        'player/engine/set', 'player/engine/switched',
        'player/engine/set', 'player/engine/switched',
        'player/engine/set', 'player/engine/switched'
    ]);
    assert.deepEqual(events.filter(e => e.topic === 'player/engine/set').map(e => e.data.to.id), ['beta', 'gamma', 'alpha']);

});

test('rapid switches: a slow earlier switch cannot overwrite the latest current engine', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player } = harness;

    // #1 alpha -> beta stalls inside beta.enable
    engines.beta.block('enable');
    const p1 = player.setEngine('beta');

    // #2 beta -> alpha is enqueued while #1 is pending
    const p2 = player.setEngine('alpha');

    engines.beta.release('enable');
    await Promise.all([p1, p2]);
    assert.equal(player.getEngine().id, 'alpha');
    assert.equal(engines.beta.calls.enable.length, 1);
    // alpha is re-enabled once when switch #2 returns onto it
    assert.equal(engines.alpha.calls.enable.length, 1);

});

test('rapid switches: every engine lifecycle event is published exactly once per request', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, events } = harness;

    await Promise.all([
        player.setEngine('beta'),
        player.setEngine('alpha'),
        player.setEngine('beta')
    ]);

    assert.equal(countByTopic(events, 'player/engine/set'), 3);
    assert.equal(countByTopic(events, 'player/engine/switched'), 3);
    assert.equal(countByTopic(events, 'player/engine/switchfailed'), 0);
    assert.equal(player.getEngine().id, 'beta');

});

// --------------------------------------------------------------------------------------------------
// 3. Switch failure recovery
// --------------------------------------------------------------------------------------------------

test('failed enable: publishes switchfailed, re-enables old engine and keeps it current', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, events, button } = harness;

    engines.beta.failNextEnable = true;

    await assert.rejects(() => player.setEngine('beta'), /enable failed/);

    const failures = events.filter(e => e.topic === 'player/engine/switchfailed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].data.from.id, 'alpha');
    assert.equal(failures[0].data.to.id, 'beta');
    assert.ok(failures[0].data.error instanceof Error);

    // no switched event for the failed request
    assert.equal(countByTopic(events, 'player/engine/switched'), 0);

    // current engine is back to alpha, which was re-enabled
    assert.equal(player.getEngine().id, 'alpha');
    assert.equal(engines.alpha.calls.enable.length, 1);
    assert.equal(engines.beta.calls.disable.length, 1); // half-enabled target gets shut down

    // button matches the actual (playable) engine again, not stuck in an intermediate state
    assert.equal(button.style.display, '');
    assert.equal(button.disabled, false);
    assert.equal(button.classList.contains('play'), true);

});

test('failed switch followed by a healthy switch still works (queue survives rejection)', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player } = harness;

    engines.beta.failNextEnable = true;
    await assert.rejects(() => player.setEngine('beta'), /enable failed/);

    // subsequent requests must not be poisoned by the rejected chain
    await player.setEngine('beta');
    assert.equal(player.getEngine().id, 'beta');

});

test('failed switch onto a non-playable engine leaves the button consistent with current engine', async() => {

    const engines = createFakeEngines();
    // alpha starts current and is playable; beta has no play capability and also fails to enable
    engines.beta.setCapabilities({ play: false });
    engines.beta.failNextEnable = true;
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button } = harness;

    await assert.rejects(() => player.setEngine('beta'), /enable failed/);

    assert.equal(player.getEngine().id, 'alpha');
    // rollback onto the playable alpha engine: button usable again
    assert.equal(button.disabled, false);
    assert.equal(button.style.display, '');

});

test('target engine unplayable at runtime: error event disables the button, canplay restores it', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button } = harness;

    await player.setEngine('beta');
    simulateMediaReady(player);
    assert.equal(button.disabled, false);

    player.publish('media/error', { error: new Error('boom') }, { async: false });
    assert.equal(button.disabled, true);

    player.publish('media/canplay', null, { async: false });
    assert.equal(button.disabled, false);

    player.publish('data/nomedia', null, { async: false });
    assert.equal(button.disabled, true);

});

// --------------------------------------------------------------------------------------------------
// 4. Destroy cleanup
// --------------------------------------------------------------------------------------------------

test('destroy during an in-flight switch: no further events are published and DOM is untouched', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, events, button } = harness;

    engines.beta.block('enable');
    const pending = player.setEngine('beta');
    await flushMicrotasks(5); // let the request run up to the blocked beta.enable gate

    // the synchronous start event is out; the switch is now in flight
    assert.equal(countByTopic(events, 'player/engine/set'), 1);

    // destroy while the switch is waiting inside beta.enable
    player.destroy();
    engines.beta.unblock('enable');

    await Promise.allSettled([pending]);
    await flushMicrotasks(5);

    // no switched/switchfailed after destruction
    assert.equal(countByTopic(events, 'player/engine/switched'), 0);
    assert.equal(countByTopic(events, 'player/engine/switchfailed'), 0);

    // late media events must not mutate the detached button (Play is destroyed and ignores them)
    const pauseClassBefore = button.classList.contains('pause');
    assert.doesNotThrow(() => player.publish('media/play', null, { async: false }));
    assert.equal(button.classList.contains('pause'), pauseClassBefore);

    harness = null; // already destroyed; stop afterEach from destroying again

});

test('destroy while requests are still queued: queued requests never start', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, events } = harness;

    engines.alpha.block('disable'); // blocks the first request; the other two stay queued
    const p1 = player.setEngine('beta');
    const p2 = player.setEngine('alpha');
    const p3 = player.setEngine('beta');

    await flushMicrotasks(5); // let request #1 reach its blocked gate and publish the start event

    player.destroy();
    engines.alpha.unblock('disable');

    await Promise.allSettled([p1, p2, p3]);
    await flushMicrotasks(5);

    // only one 'set' ever made it out (the in-flight one); queued requests produced nothing
    assert.equal(countByTopic(events, 'player/engine/set'), 1);
    assert.equal(countByTopic(events, 'player/engine/switched'), 0);
    assert.equal(engines.beta.calls.enable.length, 0);

    harness = null;

});

test('destroy tears down every subscription including capability-bound ones', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, liveSubs } = harness;

    // sanity: capability subscriptions are live while on a playable engine
    for (const topic of CAPABILITY_TOPICS) {
        assert.equal(liveSubs.get(topic), 1);
    }

    player.destroy();
    harness = null;

    // all tracked subscriptions have been unsubscribed
    assert.equal(liveSubs.size, 0);

});

// --------------------------------------------------------------------------------------------------
// 5. Subscription lifecycle / no duplicate handlers
// --------------------------------------------------------------------------------------------------

test('re-entering the same capability state does not accumulate subscriptions', async() => {

    const engines = createFakeEngines();
    class SilentEngine extends FakeBetaEngine {
        constructor() {
            super({ play: false });
            this.id = 'silent';
        }
    }
    const silent = new SilentEngine();
    harness = await createTestPlayer({ engines: { alpha: engines.alpha, beta: engines.beta, silent }, initial: 'alpha' });
    const { player, liveSubs } = harness;

    for (const topic of CAPABILITY_TOPICS) assert.equal(liveSubs.get(topic), 1);

    await player.setEngine('silent'); // playable -> not playable: subs removed
    for (const topic of CAPABILITY_TOPICS) assert.equal(liveSubs.has(topic), false);

    await player.setEngine('beta'); // not playable -> playable: subs added once again
    for (const topic of CAPABILITY_TOPICS) assert.equal(liveSubs.get(topic), 1, `${topic} should have exactly one subscription`);

    await player.setEngine('alpha'); // playable -> playable: no capability boundary crossed
    for (const topic of CAPABILITY_TOPICS) assert.equal(liveSubs.get(topic), 1);

    await player.setEngine('silent');
    await player.setEngine('alpha');
    for (const topic of CAPABILITY_TOPICS) assert.equal(liveSubs.get(topic), 1, 'no subscription may accumulate');

});

test('a single click invokes media.play exactly once even after many engine switches', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button, mediaCalls, mediaState } = harness;

    for (let i = 0; i < 4; i += 1) {
        await player.setEngine('beta');
        await player.setEngine('alpha');
    }

    // production flow: data/ready enables the button once the engine can actually play
    simulateMediaReady(player);
    assert.equal(button.disabled, false);

    mediaState.paused = true;
    button.fire('click');

    assert.equal(mediaCalls.play, 1, 'one click must trigger exactly one media.play call');
    assert.equal(mediaCalls.pause, 0);

    // second click now pauses - again exactly once
    button.fire('click');
    assert.equal(mediaCalls.pause, 1);
    assert.equal(mediaCalls.play, 1);

});

test('media event handlers are single-shot: one media/play changes the icon exactly once', async() => {

    const engines = createFakeEngines();
    harness = await createTestPlayer({ engines, initial: 'alpha' });
    const { player, button } = harness;

    await player.setEngine('beta');
    await player.setEngine('alpha');
    await player.setEngine('beta');

    player.publish('media/play', null, { async: false });

    // with duplicated subscriptions the class would be toggled repeatedly and end up inconsistent;
    // a single handler means exactly one add('pause') and the correct final state
    assert.equal(button.classList.contains('pause'), true);
    assert.equal(button.classList.contains('play'), false);

});
