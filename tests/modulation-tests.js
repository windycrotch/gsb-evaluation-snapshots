/*
 * Modulation chain verification suite.
 *
 * Runs the real App / DSPNode code against a mock AudioContext so the exact
 * values handed to the audio-param callbacks can be asserted deterministically.
 * Shared by the browser page (tests/modulation-tests.html) and the headless
 * Node runner (tests/run-modulation-tests.mjs).
 *
 * Covers:
 *  - no modulation source: effectiveValue === base value
 *  - single source, multiply/add/override modes (incl. right-click cycling)
 *  - multiple sources: add sums, multiply chains, last override wins
 *  - connection mode has priority over the param's own modulationStrategy
 *  - save/load round trip preserves connection modes + param strategies
 *  - preset-style load: connection without mode falls back to param strategy
 */

import { AudioUtils } from '../js/utils/audio-utils.js';

/* ---------- Mock Web Audio ---------- */

/**
 * Universal stand-in for any unknown member of an audio node: callable
 * (setPeriodicWave, start, ...) while also behaving like an AudioParam
 * (gain, frequency, offset, delayTime, ...).
 */
function makeUniversalMember() {
    const fn = function () { };
    fn.value = 0;
    fn.setTargetAtTime = (v) => { fn.value = v; };
    fn.setValueAtTime = (v) => { fn.value = v; };
    fn.linearRampToValueAtTime = (v) => { fn.value = v; };
    fn.exponentialRampToValueAtTime = (v) => { fn.value = v; };
    fn.cancelScheduledValues = () => { };
    return fn;
}

function makeAudioNode() {
    const target = {
        connect(dest) { return dest; },
        disconnect() { },
        start() { },
        stop() { }
    };
    return new Proxy(target, {
        get(t, k) {
            if (k in t) return t[k];
            const member = makeUniversalMember();
            t[k] = member;
            return member;
        },
        set(t, k, v) { t[k] = v; return true; }
    });
}

export function createMockAudioContext() {
    const ctx = {
        currentTime: 0,
        sampleRate: 44100,
        state: 'running',
        baseLatency: 0,
        outputLatency: 0,
        destination: makeAudioNode(),
        createBuffer: (channels, length, sampleRate) => ({
            numberOfChannels: channels,
            length,
            sampleRate,
            getChannelData: () => new Float32Array(length)
        }),
        resume: async () => { }
    };
    return new Proxy(ctx, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'string' && k.startsWith('create')) {
                return () => makeAudioNode();
            }
            return undefined;
        }
    });
}

/**
 * Point the app at the mock context and neutralise real AudioContext creation
 * so loadGraphFromData()/addNode() run without a user gesture.
 */
export function installMockAudio(app, mockCtx) {
    app.audioCtx = mockCtx;
    app.audioStarted = true;
    AudioUtils.init(mockCtx);
    app.startAudio = async () => { };
}

/* ---------- Assertions ---------- */

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function approx(a, b, eps = 1e-9) {
    return Math.abs(a - b) <= eps;
}

function assertApprox(actual, expected, msg) {
    assert(approx(actual, expected), `${msg} (expected ${expected}, got ${actual})`);
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (typeof a !== 'object') return Object.is(a, b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
}

/* ---------- Helpers ---------- */

function paramConnections(app, node, paramIndex) {
    return app.connections.filter(c =>
        c.kind === 'param' &&
        c.toNode === node &&
        (paramIndex === undefined || c.paramIndex === paramIndex)
    );
}

/** Every param connection's mode must match its modList entry (line colour == computed mode). */
function assertModeConsistency(app) {
    for (const c of app.connections) {
        if (c.kind !== 'param') continue;
        const entry = (c.toNode.paramModulators[c.paramIndex] || [])
            .find(e => e.node === c.fromNode);
        assert(entry, `missing modList entry for connection ${c.fromNode.type} -> ${c.toNode.type}[${c.paramIndex}]`);
        assert(entry.mode === c.mode,
            `connection mode "${c.mode}" != modList entry mode "${entry.mode}" (${c.fromNode.type} -> ${c.toNode.type}[${c.paramIndex}])`);
    }
}

function addValueNode(app, v) {
    const n = app.addNode('value', 300, 300);
    n.params[0].value = v;
    n.updateParam(0);
    return n;
}

/* ---------- Suite ---------- */

export async function runModulationTests(app) {
    const results = [];
    const test = async (name, fn) => {
        try {
            await fn();
            results.push({ name, pass: true });
        } catch (e) {
            results.push({ name, pass: false, error: (e && e.message) || String(e) });
        }
    };

    /* 1. No modulation source: effectiveValue equals the base value */
    await test('no modulation: effectiveValue equals base value', () => {
        app.reset();
        const gain = app.addNode('gain', 100, 100);
        gain.params[0].value = 0.7;
        gain.updateParam(0);
        assertApprox(gain.params[0].effectiveValue, 0.7, 'effectiveValue');
        // The value actually sent to the audio param:
        assertApprox(gain.outputNode.gain.value, 0.7, 'audio param value');
    });

    /* 2. Single source, all three modes, switched via the right-click path */
    await test('single source: multiply/add/override via cycleParamConnectionMode', () => {
        app.reset();
        const gain = app.addNode('gain', 100, 100);
        const val = addValueNode(app, 0.5);
        gain.params[0].value = 1.0;
        gain.updateParam(0);

        app.connect(val, 0, gain, 0, 'param', 'multiply');
        assertApprox(gain.params[0].effectiveValue, 0.5, 'multiply effectiveValue'); // 1.0 * 0.5
        assertApprox(gain.outputNode.gain.value, 0.5, 'multiply audio value');

        const conn = paramConnections(app, gain, 0)[0];
        assert(conn, 'param connection exists');

        app.cycleParamConnectionMode(conn); // multiply -> add
        assert(conn.mode === 'add', `expected mode "add", got "${conn.mode}"`);
        assertApprox(gain.params[0].effectiveValue, 1.5, 'add effectiveValue'); // 1.0 + 0.5
        assertApprox(gain.outputNode.gain.value, 1.5, 'add audio value');

        app.cycleParamConnectionMode(conn); // add -> override
        assert(conn.mode === 'override', `expected mode "override", got "${conn.mode}"`);
        assertApprox(gain.params[0].effectiveValue, 0.5, 'override effectiveValue');
        assertApprox(gain.outputNode.gain.value, 0.5, 'override audio value');

        app.cycleParamConnectionMode(conn); // override -> multiply
        assert(conn.mode === 'multiply', `expected mode "multiply", got "${conn.mode}"`);
        assertApprox(gain.params[0].effectiveValue, 0.5, 'multiply again effectiveValue');

        assertModeConsistency(app);
    });

    /* 3. Multiple sources on one param: add sums, multiply chains, last override wins */
    await test('multi-source: add accumulates, multiply chains, last override wins', () => {
        app.reset();
        const gain = app.addNode('gain', 100, 100);
        gain.params[0].value = 1.0;
        gain.updateParam(0);

        const vMul = addValueNode(app, 2);
        const vAdd = addValueNode(app, 0.5);
        const vOvr1 = addValueNode(app, 9);
        const vOvr2 = addValueNode(app, 3);

        app.connect(vMul, 0, gain, 0, 'param', 'multiply');
        app.connect(vAdd, 0, gain, 0, 'param', 'add');
        app.connect(vOvr1, 0, gain, 0, 'param', 'override');
        app.connect(vOvr2, 0, gain, 0, 'param', 'override'); // connected last -> wins

        assertApprox(gain.params[0].effectiveValue, 3, 'last override wins');
        assertApprox(gain.outputNode.gain.value, 3, 'audio value follows override');

        // Drop both overrides -> base * multiply + add = 1*2 + 0.5
        for (const vn of [vOvr1, vOvr2]) {
            const conn = paramConnections(app, gain, 0).find(c => c.fromNode === vn);
            app.disconnect(conn);
            app.connections.splice(app.connections.indexOf(conn), 1);
        }
        assertApprox(gain.params[0].effectiveValue, 2.5, 'mul+add mix');
        assertApprox(gain.outputNode.gain.value, 2.5, 'audio value follows mix');

        assertModeConsistency(app);
    });

    /* 4. Connection mode has priority over the param's own modulationStrategy */
    await test('connection mode has priority over param modulationStrategy', () => {
        app.reset();
        const gain = app.addNode('gain', 100, 100);
        gain.params[0].value = 1.0;
        gain.params[0].modulationStrategy = 'add'; // param-level strategy
        const val = addValueNode(app, 0.5);

        // No explicit mode -> falls back to the param strategy
        app.connect(val, 0, gain, 0, 'param');
        const conn = paramConnections(app, gain, 0)[0];
        assert(conn.mode === 'add', `fallback mode should be "add", got "${conn.mode}"`);
        assertApprox(gain.params[0].effectiveValue, 1.5, 'param strategy applied');

        // Explicit connection mode wins over the param strategy
        app.cycleParamConnectionMode(conn); // add -> override
        assertApprox(gain.params[0].effectiveValue, 0.5, 'connection mode beats param strategy');
        assert(gain.params[0].modulationStrategy === 'add', 'param strategy itself is untouched');

        assertModeConsistency(app);
    });

    /* 5. Save/load round trip: modes + strategies survive, behaviour unchanged */
    await test('save/load round trip preserves connection modes and param strategies', async () => {
        app.reset();
        const gain = app.addNode('gain', 100, 100);
        gain.params[0].value = 1.0;
        gain.params[0].modulationStrategy = 'add'; // non-default param strategy
        const val = addValueNode(app, 0.5);
        const lfo = app.addNode('lfo', 300, 500);

        app.connect(val, 0, gain, 0, 'param', 'override');
        app.connect(lfo, 0, gain, 0, 'param'); // falls back to param strategy 'add'
        gain.updateParam(0);
        const effectiveBefore = gain.params[0].effectiveValue;

        const data1 = JSON.parse(JSON.stringify(app.buildGraphData()));
        await app.loadGraphFromData(data1);

        const gain2 = app.nodes.find(n => n.type === 'gain');
        assert(gain2, 'gain node restored');
        assert(gain2.params[0].modulationStrategy === 'add',
            `param strategy not restored (got "${gain2.params[0].modulationStrategy}")`);

        const modes = paramConnections(app, gain2, 0).map(c => c.mode).sort();
        assert(deepEqual(modes, ['add', 'override']),
            `connection modes not restored (got ${JSON.stringify(modes)})`);

        gain2.updateParam(0);
        assertApprox(gain2.params[0].effectiveValue, effectiveBefore,
            'effectiveValue differs after reload');

        // Re-serialising must produce identical data (stable round trip)
        const data2 = JSON.parse(JSON.stringify(app.buildGraphData()));
        assert(deepEqual(data2, data1), 're-serialised graph differs from loaded data');

        assertModeConsistency(app);
    });

    /* 6. Preset-style load: connection without mode falls back to restored param strategy */
    await test('preset load: missing connection mode falls back to param strategy, explicit mode wins', async () => {
        app.reset();
        const data = {
            nodes: [
                { id: 'g1', type: 'gain', x: 100, y: 100, params: [1.0], extra: { paramStrategies: [{ index: 0, strategy: 'add' }] } },
                { id: 'v1', type: 'value', x: 300, y: 100, params: [0.5] },
                { id: 'v2', type: 'value', x: 300, y: 300, params: [2] }
            ],
            connections: [
                // legacy connection without mode -> should adopt the restored 'add' strategy
                { fromNodeId: 'v1', fromPort: 0, toNodeId: 'g1', toPort: 0, kind: 'param', paramIndex: 0 },
                // explicit mode -> wins over everything
                { fromNodeId: 'v2', fromPort: 0, toNodeId: 'g1', toPort: 0, kind: 'param', paramIndex: 0, mode: 'override' }
            ]
        };
        await app.loadGraphFromData(JSON.parse(JSON.stringify(data)));

        const gain = app.nodes.find(n => n.id === 'g1');
        assert(gain, 'gain node loaded');
        assert(gain.params[0].modulationStrategy === 'add', 'param strategy restored from extra');

        const conns = paramConnections(app, gain, 0);
        const legacy = conns.find(c => c.fromNode.id === 'v1');
        const explicit = conns.find(c => c.fromNode.id === 'v2');
        assert(legacy && legacy.mode === 'add',
            `legacy connection should materialise mode "add", got "${legacy && legacy.mode}"`);
        assert(explicit && explicit.mode === 'override', 'explicit override mode preserved');

        // override (connected last) wins
        assertApprox(gain.params[0].effectiveValue, 2, 'override wins after preset load');
        assertApprox(gain.outputNode.gain.value, 2, 'audio value after preset load');

        // Remove the override -> the 'add' strategy connection remains: 1.0 + 0.5
        app.disconnect(explicit);
        app.connections.splice(app.connections.indexOf(explicit), 1);
        assertApprox(gain.params[0].effectiveValue, 1.5, 'add strategy applies once override removed');

        assertModeConsistency(app);
    });

    /* 7. Corrupt patch data: invalid modes/strategies normalise to multiply */
    await test('corrupt patch: invalid mode and strategy normalise to multiply', async () => {
        app.reset();
        const data = {
            nodes: [
                { id: 'g1', type: 'gain', x: 100, y: 100, params: [1.0], extra: { paramStrategies: [{ index: 0, strategy: 'bogus' }] } },
                { id: 'v1', type: 'value', x: 300, y: 100, params: [0.5] }
            ],
            connections: [
                { fromNodeId: 'v1', fromPort: 0, toNodeId: 'g1', toPort: 0, kind: 'param', paramIndex: 0, mode: 'garbage' }
            ]
        };
        await app.loadGraphFromData(JSON.parse(JSON.stringify(data)));

        const gain = app.nodes.find(n => n.id === 'g1');
        assert(gain, 'gain node loaded');
        assert(gain.params[0].modulationStrategy === 'multiply',
            `invalid strategy should normalise to "multiply", got "${gain.params[0].modulationStrategy}"`);
        const conn = paramConnections(app, gain, 0)[0];
        assert(conn && conn.mode === 'multiply',
            `invalid connection mode should normalise to "multiply", got "${conn && conn.mode}"`);
        assertApprox(gain.params[0].effectiveValue, 0.5, 'multiply applied'); // 1.0 * 0.5
        assertModeConsistency(app);
    });

    return results;
}
