import assert from 'node:assert';
import { test } from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

import { WSS } from '../src/wss.ts';

// short in-flight timeout so "fails immediately instead of waiting out 60s" is observable
const TIMEOUT_MS = 300;
const BIND_RETRY_MS = 60;

// resolve once a server is accepting connections on the port
const waitListening = async (port: number) => {
    for (let i = 0; i < 60; i++) {
        const up = await new Promise<boolean>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            ws.on('open', () => { ws.close(); resolve(true); });
            ws.on('error', () => resolve(false));
        });
        if (up) {
            return;
        }
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`server did not start on port ${port}`);
};

// poll until `fn()` returns true
const waitUntil = async (fn: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) {
            return;
        }
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('condition was not met before the timeout');
};

const envelope = (result: CallToolResult) => {
    const item = result.content.find(c => c.type === 'text');
    if (!item || item.type !== 'text') {
        throw new Error('Missing text response');
    }
    return JSON.parse(item.text);
};

type Frame = { id: number; name: string };

type EditorOptions = {
    methods?: string[];
    // per-frame decision: return a payload to answer, or undefined/void to hold the call.
    // default answers every frame with its method name.
    onRequest?: (frame: Frame) => unknown | undefined;
};

// a fake editor: registers on connect and routes each request frame through `onRequest`.
// held calls can later be answered via `answer(id, ...)`.
const fakeEditor = (port: number, options: EditorOptions = {}) => {
    const { methods = ['ping'] } = options;
    const frameQueue: Frame[] = [];
    const frameWaiters: ((frame: Frame) => void)[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
        ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods }));
    });
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === undefined) {
            return;
        }
        const frame = { id: msg.id, name: msg.name };
        const waiter = frameWaiters.shift();
        if (waiter) {
            waiter(frame);
        } else {
            frameQueue.push(frame);
        }
        const reply = options.onRequest ? options.onRequest(frame) : frame.name;
        if (reply !== undefined) {
            ws.send(JSON.stringify({ id: frame.id, res: { data: reply } }));
        }
    });
    const open = new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
    });
    return {
        ws,
        open,
        // resolve with the next request frame in arrival order (uses a queued frame if one is waiting)
        nextFrame: () => new Promise<Frame>((resolve) => {
            const queued = frameQueue.shift();
            if (queued) {
                resolve(queued);
            } else {
                frameWaiters.push(resolve);
            }
        }),
        // answer a held call
        answer: (id: number, data: unknown = 'late') => ws.send(JSON.stringify({ id, res: { data } }))
    };
};

test('normal call resolves through the registered editor', async () => {
    const port = 53100;
    const wss = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);
    const editor = fakeEditor(port);
    await editor.open;
    await wss.waitForEditor(-1, 2000);

    const res = envelope(await wss.call('ping'));
    assert.equal(res.meta.status, 'ok');
    assert.equal(res.data, 'ping');

    editor.ws.close();
    wss.close();
});

test('port handoff fails in-flight calls immediately, then standby retakes the port once the new owner exits', async () => {
    const port = 53101;
    const owner = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);

    // an editor holding every call, with a relayed runtime announced
    const editor = fakeEditor(port, {
        methods: ['ping', 'runtime:capture'],
        onRequest: () => undefined
    });
    await editor.open;
    await owner.waitForEditor(-1, 2000);
    await waitUntil(() => owner.isEditorConnected());
    editor.ws.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
    await waitUntil(() => owner.hasRuntime());

    // concurrent calls in flight when the handoff lands — one edit-time, one relayed runtime
    const editCall = owner.call('ping');
    const runtimeCall = owner.call('runtime:capture');
    await editor.nextFrame();
    await editor.nextFrame();

    // a newer local MCP instance asks the owner to yield
    const yieldWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
        yieldWs.on('open', () => {
            yieldWs.send(JSON.stringify({ yield: true }));
            resolve();
        });
    });

    // acceptance: both in-flight calls end with an explicit handoff error, immediately —
    // well under the 300ms timeout (not by timeout, not from a frame routed to the new owner)
    const start = Date.now();
    const [editRes, runtimeRes] = await Promise.all([editCall, runtimeCall]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < TIMEOUT_MS, `in-flight calls must fail on handoff, not after the timeout (took ${elapsed}ms)`);
    for (const res of [envelope(editRes), envelope(runtimeRes)]) {
        assert.equal(res.meta.status, 'error');
        assert.match(res.meta.message, /handed port .* to a newer MCP server instance/);
    }

    // the owner really released the port: a probe is refused while it stands by.
    // poll tightly and well within the BIND_RETRY_MS rebind window so the standby
    // can't retake the port underneath us before we've observed the free state.
    const portFreed = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + Math.min(500, BIND_RETRY_MS - 10);
        const probe = () => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            ws.on('open', () => {
                ws.close();
                if (Date.now() >= deadline) {
                    resolve(false);
                } else {
                    setTimeout(probe, 15);
                }
            });
            ws.on('error', () => resolve(true));
        };
        probe();
    });
    assert.equal(portFreed, true, 'the old instance must release the port while standing by');

    // a newer instance takes the port, then exits
    const newer = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);
    const genWhileStandby = owner.editorGeneration;
    newer.close();

    // acceptance: the standby owner retakes the port and serves fresh calls again
    await waitListening(port);
    const editor2 = fakeEditor(port);
    await editor2.open;
    await owner.waitForEditor(genWhileStandby, 2000);
    const retaken = envelope(await owner.call('ping'));
    assert.equal(retaken.meta.status, 'ok');
    assert.equal(retaken.data, 'ping', 'the standby instance is fully usable after retaking the port');

    editor2.ws.close();
    yieldWs.close();
    owner.close();
});

test('editor reconnect (generation bump) rejects old in-flight calls and ignores late answers from the old socket', async () => {
    const port = 53102;
    const wss = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);

    const oldEditor = fakeEditor(port, { onRequest: () => undefined });
    await oldEditor.open;
    await wss.waitForEditor(-1, 2000);
    const genBefore = wss.editorGeneration;
    assert.ok(genBefore >= 1);

    const held = wss.call('ping');
    const heldFrame = await oldEditor.nextFrame();

    // reload: a brand-new editor socket registers before the old one closes
    const newEditor = fakeEditor(port);
    await newEditor.open;
    await wss.waitForEditor(genBefore, 2000);
    assert.ok(wss.editorGeneration > genBefore, 'reconnect must bump the generation');

    // acceptance 1: the call riding the old connection fails immediately with a reconnect error
    const start = Date.now();
    const rejected = envelope(await held);
    assert.ok(Date.now() - start < TIMEOUT_MS, 'the stale call must not wait for its timeout');
    assert.equal(rejected.meta.status, 'error');
    assert.match(rejected.meta.message, /editor reconnected/);

    // acceptance 2: a late answer on the OLD socket is ignored...
    oldEditor.answer(heldFrame.id, 'stale-late-answer');
    await new Promise(r => setTimeout(r, 50));

    // ...and can never be mistaken for the result of a NEW request, even though ids collide
    const fresh = envelope(await wss.call('ping'));
    assert.equal(fresh.meta.status, 'ok');
    assert.equal(fresh.data, 'ping', 'the new call is answered by the current editor only');

    oldEditor.ws.close();
    newEditor.ws.close();
    wss.close();
});

test('an answer that arrives after the request timed out is dropped, not paired with a later request', async () => {
    const port = 53103;
    const wss = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);

    // hold ping; answer ping2 immediately
    const editor = fakeEditor(port, {
        methods: ['ping', 'ping2'],
        onRequest: (frame) => frame.name === 'ping2' ? 'ping2' : undefined
    });
    await editor.open;
    await wss.waitForEditor(-1, 2000);

    const slow = wss.call('ping');
    const slowFrame = await editor.nextFrame();
    const timedOut = envelope(await slow);
    assert.equal(timedOut.meta.status, 'error');
    assert.match(timedOut.meta.message, /Timed out after 300ms/);

    // the editor eventually answers the dead call (same id); nothing may resolve from it
    await new Promise(r => setTimeout(r, 50));
    editor.answer(slowFrame.id, 'zombie');
    await new Promise(r => setTimeout(r, 50));

    // a fresh call gets its own answer — no timed-out callback residue
    const fresh = envelope(await wss.call('ping2'));
    assert.equal(fresh.meta.status, 'ok');
    assert.equal(fresh.data, 'ping2');

    editor.ws.close();
    wss.close();
});

test('runtime detach immediately fails in-flight and new runtime calls; re-attach restores them', async () => {
    const port = 53104;
    const wss = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);

    // hold the single relayed call that is in flight when the window closes;
    // all other frames (edit-time and post-reattach calls) answer immediately
    let holdRuntime = true;
    const editor = fakeEditor(port, {
        methods: ['ping', 'runtime:capture'],
        onRequest: (frame) => {
            if (frame.name.startsWith('runtime:') && holdRuntime) {
                return undefined;
            }
            return frame.name;
        }
    });
    await editor.open;
    await wss.waitForEditor(-1, 2000);
    await waitUntil(() => wss.isEditorConnected());
    editor.ws.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
    await waitUntil(() => wss.hasRuntime());

    // an in-flight relayed call when the launch window goes away
    const inFlight = wss.call('runtime:capture');
    await editor.nextFrame();
    holdRuntime = false;
    editor.ws.send(JSON.stringify({ runtime: null }));
    await waitUntil(() => !wss.hasRuntime());

    // acceptance 1: the in-flight runtime call fails at once with the launch_start guidance
    const start = Date.now();
    const failed = envelope(await inFlight);
    assert.ok(Date.now() - start < TIMEOUT_MS, 'detach must end runtime calls immediately, not at timeout');
    assert.equal(failed.meta.status, 'error');
    assert.match(failed.meta.message, /Call launch_start first/);

    // acceptance 2: new runtime calls are refused while detached
    const refused = envelope(await wss.call('runtime:capture'));
    assert.equal(refused.meta.status, 'error');
    assert.match(refused.meta.message, /Call launch_start first/);

    // edit-time traffic keeps working through the same editor socket
    const ping = envelope(await wss.call('ping'));
    assert.equal(ping.data, 'ping');

    // acceptance 3: re-attaching a launch page makes new runtime calls work again
    editor.ws.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
    await waitUntil(() => wss.hasRuntime());
    const resumed = envelope(await wss.call('runtime:capture'));
    assert.equal(resumed.meta.status, 'ok');
    assert.equal(resumed.data, 'runtime:capture');

    editor.ws.close();
    wss.close();
});

test('answers from any socket other than the current editor are ignored, including forged ids', async () => {
    const port = 53105;
    const wss = new WSS(port, { callTimeoutMs: TIMEOUT_MS, bindRetryDelayMs: BIND_RETRY_MS });
    await waitListening(port);

    const editor = fakeEditor(port);
    await editor.open;
    await wss.waitForEditor(-1, 2000);

    // an unrelated page, same allowed origin, never registered as the editor
    const impostor = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://playcanvas.com' });
    await new Promise<void>((resolve, reject) => {
        impostor.on('open', () => resolve());
        impostor.on('error', reject);
    });

    // spam forged answers covering real request ids, including the one about to be issued
    const pending = wss.call('ping');
    for (let id = 0; id < 60; id++) {
        impostor.send(JSON.stringify({ id, res: { data: 'forged' } }));
    }
    const res = envelope(await pending);
    assert.equal(res.meta.status, 'ok');
    assert.equal(res.data, 'ping', 'only the editor socket may resolve a call');

    impostor.close();
    editor.ws.close();
    wss.close();
});
