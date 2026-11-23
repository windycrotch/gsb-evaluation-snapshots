import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    installBrowserGlobals,
    makePresetFetch,
    loadPresetData,
    FakeAudioContext,
    alerts
} from './helpers/browser-env.js';

installBrowserGlobals();

// Keep the app's verbose debug logging out of the test output.
console.log = () => { };

const { App } = await import('../js/app.js');

let app;

beforeEach(() => {
    installBrowserGlobals();
    globalThis.fetch = makePresetFetch();
    app = new App();
});

/* ---------- helpers ---------- */

function sortedIds(nodes) {
    return nodes.map(n => n.id).sort();
}

function connectionTuples(appInstance) {
    return appInstance.connections.map(c =>
        [
            c.kind,
            `${c.fromNode.id}:${c.fromPort}`,
            `${c.toNode.id}:${c.toPort}`,
            c.kind === 'param' ? c.paramIndex : '',
            c.kind === 'param' ? (c.mode || 'multiply') : ''
        ].join('|')
    ).sort();
}

function expectedConnectionTuples(data) {
    return (data.connections || []).map(c => {
        const kind = c.kind || 'audio';
        return [
            kind,
            `${c.fromNodeId}:${c.fromPort}`,
            `${c.toNodeId}:${c.toPort}`,
            kind === 'param' ? (c.paramIndex ?? c.toPort) : '',
            kind === 'param' ? (c.mode || 'multiply') : ''
        ].join('|');
    }).sort();
}

// No live node may reference a node that is no longer on the canvas, neither
// in a parameter's modulator list nor in a modulator's subscriber list.
function assertNoStaleModulators(appInstance) {
    const live = new Set(appInstance.nodes);
    for (const n of appInstance.nodes) {
        (n.paramModulators || []).forEach((list, idx) => {
            (list || []).forEach(entry => {
                assert.ok(
                    live.has(entry.node),
                    `stale modulator registration on ${n.type}[${idx}]`
                );
            });
        });
        if (Array.isArray(n.subscribers)) {
            n.subscribers.forEach(s => {
                assert.ok(live.has(s.node), `stale subscriber on ${n.type}`);
            });
        }
    }
}

function assertGraphMatchesData(appInstance, data) {
    assert.deepEqual(sortedIds(appInstance.nodes), sortedIds(data.nodes));
    assert.deepEqual(connectionTuples(appInstance), expectedConnectionTuples(data));
    // Every param connection must be registered on its target node.
    for (const c of appInstance.connections.filter(c => c.kind === 'param')) {
        const list = c.toNode.paramModulators[c.paramIndex] || [];
        assert.ok(
            list.some(entry => entry.node === c.fromNode),
            `param modulator ${c.fromNode.id} missing on ${c.toNode.id}[${c.paramIndex}]`
        );
    }
    assertNoStaleModulators(appInstance);
}

/* ---------- preset loading: concurrency ---------- */

test('concurrent preset loads: a slow earlier load must not overwrite a later one', async () => {
    let releaseFlanger;
    const flangerGate = new Promise(resolve => { releaseFlanger = resolve; });
    globalThis.fetch = makePresetFetch({ gates: { flanger: flangerGate } });

    const flangerPromise = app.loadPreset('flanger'); // requested first, resolves last
    const phaserPromise = app.loadPreset('phaser');

    assert.equal(await phaserPromise, true);
    releaseFlanger();
    assert.equal(await flangerPromise, false); // stale result discarded

    const phaser = await loadPresetData('phaser');
    assertGraphMatchesData(app, phaser);
    assert.equal(FakeAudioContext.instances.length, 1, 'single AudioContext');
});

test('simultaneous preset loads settle on the most recent request', async () => {
    const [flangerResult, phaserResult] = await Promise.all([
        app.loadPreset('flanger'),
        app.loadPreset('phaser')
    ]);
    assert.equal(flangerResult, false);
    assert.equal(phaserResult, true);

    const phaser = await loadPresetData('phaser');
    assertGraphMatchesData(app, phaser);
    assert.equal(FakeAudioContext.instances.length, 1, 'single AudioContext');
});

/* ---------- preset loading: failure rollback ---------- */

test('missing preset keeps the current graph and later loads still work', async () => {
    assert.equal(await app.loadPreset('flanger'), true);
    const flanger = await loadPresetData('flanger');
    assertGraphMatchesData(app, flanger);

    const nodesBefore = [...app.nodes];
    const connsBefore = connectionTuples(app);

    assert.equal(await app.loadPreset('does-not-exist'), false);
    assert.equal(alerts.length, 1, 'user is notified about the failure');
    assert.ok(app.nodes.every((n, i) => n === nodesBefore[i]), 'graph objects untouched');
    assert.deepEqual(connectionTuples(app), connsBefore);

    assert.equal(await app.loadPreset('phaser'), true, 'loading still works after the failure');
    assertGraphMatchesData(app, await loadPresetData('phaser'));
});

test('unparseable or malformed preset rolls back to the previous graph', async () => {
    assert.equal(await app.loadPreset('flanger'), true);
    const idsBefore = sortedIds(app.nodes);
    const connsBefore = connectionTuples(app);

    globalThis.fetch = makePresetFetch({
        overrides: {
            'broken-json': () => ({
                ok: true,
                status: 200,
                json: async () => { throw new SyntaxError('Unexpected token'); }
            }),
            'bad-shape': () => ({
                ok: true,
                status: 200,
                json: async () => ({ hello: 'world' })
            })
        }
    });

    assert.equal(await app.loadPreset('broken-json'), false);
    assert.deepEqual(sortedIds(app.nodes), idsBefore);
    assert.deepEqual(connectionTuples(app), connsBefore);

    assert.equal(await app.loadPreset('bad-shape'), false);
    assert.deepEqual(sortedIds(app.nodes), idsBefore);
    assert.deepEqual(connectionTuples(app), connsBefore);
    assertNoStaleModulators(app);

    assert.equal(await app.loadPreset('phaser'), true, 'loading still works after the failures');
    assertGraphMatchesData(app, await loadPresetData('phaser'));
});

test('a failure while applying a preset restores the previous graph', async () => {
    assert.equal(await app.loadPreset('flanger'), true);
    const idsBefore = sortedIds(app.nodes);
    const connsBefore = connectionTuples(app);

    const phaser = await loadPresetData('phaser');
    const original = app.createNodeInstance.bind(app);
    let created = 0;
    app.createNodeInstance = (...args) => {
        created += 1;
        if (created === 3) throw new Error('simulated build failure');
        return original(...args);
    };
    await assert.rejects(() => app.loadGraphFromData(phaser));
    app.createNodeInstance = original;

    assert.deepEqual(sortedIds(app.nodes), idsBefore, 'previous nodes restored');
    assert.deepEqual(connectionTuples(app), connsBefore, 'previous connections restored');
    assertNoStaleModulators(app);

    assert.equal(await app.loadPreset('phaser'), true, 'loading still works after rollback');
    assertGraphMatchesData(app, phaser);
});

/* ---------- audio startup: singleton ---------- */

test('concurrent startAudio calls create exactly one AudioContext', async () => {
    await Promise.all([
        app.startAudio(),
        app.startAudio(),
        app.startAudio(),
        app.startAudio()
    ]);
    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(app.audioCtx, FakeAudioContext.instances[0]);

    await app.startAudio();
    assert.equal(FakeAudioContext.instances.length, 1, 'repeat calls reuse the context');
});

/* ---------- node deletion: modulation cleanup ---------- */

test('reset clears the graph and restores the default nodes', async () => {
    assert.equal(await app.loadPreset('flanger'), true);
    app.reset();
    assert.deepEqual(app.nodes.map(n => n.type), ['output', 'audio-source']);
    assert.equal(app.connections.length, 0);
    assert.equal(app.dynamicNodes.size, 0);
    assertNoStaleModulators(app);

    assert.equal(await app.loadPreset('phaser'), true, 'loading works after reset');
    assertGraphMatchesData(app, await loadPresetData('phaser'));
});

test('deleting a modulator node removes it from parameter evaluation', async () => {
    await app.startAudio();
    const value = app.addNode('value', 100, 100);
    const gain = app.addNode('gain', 400, 100);
    app.setNodeParam(gain, 0, 0.5);
    app.setNodeParam(value, 0, 2);
    app.connect(value, 0, gain, 0, 'param', 'override');

    assert.equal(gain.paramModulators[0].length, 1);
    assert.equal(gain.params[0].effectiveValue, 2, 'modulator drives the parameter');

    app.deleteNode(value);

    assert.equal(gain.paramModulators[0].length, 0, 'modulator registration cleared');
    assert.equal(gain.params[0].effectiveValue, 0.5, 'parameter re-evaluated without the deleted node');
    assertNoStaleModulators(app);
});

test('deleting a modulated node removes its subscription from the modulator', async () => {
    await app.startAudio();
    const lfo = app.addNode('lfo', 100, 100);
    const gain = app.addNode('gain', 400, 100);
    app.connect(lfo, 0, gain, 0, 'param');
    assert.equal(lfo.subscribers.length, 1);

    app.deleteNode(gain);

    assert.equal(lfo.subscribers.length, 0, 'deleted node unsubscribed');
    lfo.notifySubscribers(); // must not touch the deleted node
    assertNoStaleModulators(app);
});

test('deleteNode sweeps stale modulation registrations not backed by a connection', async () => {
    await app.startAudio();
    const ghost = app.addNode('value', 100, 100);
    const gain = app.addNode('gain', 400, 100);
    // Simulate a registration whose connection bookkeeping was lost.
    gain.paramModulators[0].push({ node: ghost, mode: 'multiply' });

    app.deleteNode(ghost);

    assert.equal(gain.paramModulators[0].length, 0, 'stale registration swept');
    assertNoStaleModulators(app);
});

test('deleting a preset modulator then reloading presets restores a consistent graph', async () => {
    assert.equal(await app.loadPreset('flanger'), true);
    const flanger = await loadPresetData('flanger');
    assertGraphMatchesData(app, flanger);

    const lfo = app.nodes.find(n => n.type === 'lfo');
    const paramConns = app.connections.filter(c => c.kind === 'param' && c.fromNode === lfo);
    assert.ok(paramConns.length > 0, 'flanger preset has LFO modulation');
    const target = paramConns[0].toNode;
    const paramIndex = paramConns[0].paramIndex;

    app.deleteNode(lfo);
    assert.ok(app.connections.every(c => c.fromNode !== lfo && c.toNode !== lfo));
    assert.ok((target.paramModulators[paramIndex] || []).every(e => e.node !== lfo));
    assertNoStaleModulators(app);

    assert.equal(await app.loadPreset('phaser'), true);
    assertGraphMatchesData(app, await loadPresetData('phaser'));

    assert.equal(await app.loadPreset('flanger'), true, 'reloading the original preset recovers');
    assertGraphMatchesData(app, flanger);
});
