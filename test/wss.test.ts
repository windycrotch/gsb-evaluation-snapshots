import assert from 'node:assert';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

import { WSS } from '../src/wss.ts';

const PORT = 52999;

process.env.MCP_ALLOWED_ORIGINS = 'https://extra.example.com, https://another.example.com:8443';

const wss = new WSS(PORT);

after(() => wss.close());

// attempt a connection with the given Origin header; true = accepted
const attempt = (origin?: string) => {
    return new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin ? { origin } : {});
        ws.on('open', () => {
            ws.close();
            resolve(true);
        });
        ws.on('error', () => resolve(false));
    });
};

const ready = async () => {
    for (let i = 0; i < 40; i++) {
        if (await attempt()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`server did not start on port ${PORT}`);
};

test('origin validation on websocket upgrade', async () => {
    await ready();

    // allowed: non-browser local clients (no Origin, e.g. the yield handshake)
    assert.equal(await attempt(), true, 'no Origin should be allowed');

    // allowed: the editor
    assert.equal(await attempt('https://playcanvas.com'), true, 'playcanvas.com should be allowed');

    // rejected: other subdomains, which serve project code (the editor relays for launch pages)
    assert.equal(await attempt('https://launch.playcanvas.com'), false, 'launch.playcanvas.com must be rejected');
    assert.equal(await attempt('https://sub.launch.playcanvas.com'), false, 'nested subdomains must be rejected');
    assert.equal(await attempt('http://playcanvas.com'), false, 'plain http editor origin must be rejected');
    assert.equal(await attempt('null'), false, 'opaque origin must be rejected');

    // allowed: local editor dev builds
    assert.equal(await attempt('http://localhost:3000'), true, 'localhost dev origin should be allowed');
    assert.equal(await attempt('http://127.0.0.1:8080'), true, '127.0.0.1 dev origin should be allowed');

    // allowed: extra origins from MCP_ALLOWED_ORIGINS (exact match)
    assert.equal(await attempt('https://extra.example.com'), true, 'MCP_ALLOWED_ORIGINS origin should be allowed');
    assert.equal(await attempt('https://another.example.com:8443'), true, 'MCP_ALLOWED_ORIGINS origin with port should be allowed');
    assert.equal(await attempt('https://sub.extra.example.com'), false, 'extra origins are exact match, not wildcards');

    // rejected: any other webpage (browsers do not apply CORS to websockets)
    assert.equal(await attempt('https://evil.com'), false, 'unknown origin must be rejected');
    assert.equal(await attempt('https://playcanvas.com.evil.com'), false, 'suffix-spoofed origin must be rejected');
    assert.equal(await attempt('https://evilplaycanvas.com'), false, 'lookalike origin must be rejected');
    assert.equal(await attempt('http://192.168.1.10:3000'), false, 'LAN origin must be rejected');
});

const PORT2 = 52998;

const connectEditor = (port: number) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
        ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping'] }));
        resolve(ws);
    });
    ws.on('message', (data) => {
        const { id } = JSON.parse(data.toString());
        ws.send(JSON.stringify({ id, res: { data: 'pong' } }));
    });
});

const envelope = (result: CallToolResult) => {
    const item = result.content.find(item => item.type === 'text');
    if (!item || item.type !== 'text') {
        throw new Error('Missing text response');
    }
    return JSON.parse(item.text);
};

test('waitForEditor tracks editor connection generation', async () => {
    const wss2 = new WSS(PORT2);

    // wait for the server to listen
    for (let i = 0; i < 40; i++) {
        const up = await new Promise<boolean>((r) => {
            const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
            ws.on('open', () => { ws.close(); r(true); });
            ws.on('error', () => r(false));
        });
        if (up) break;
        await new Promise(r => setTimeout(r, 50));
    }

    const gen0 = wss2.editorGeneration;
    const ed = await connectEditor(PORT2);
    const back = await wss2.waitForEditor(gen0, 2000);
    assert.equal(back, true, 'a freshly connected editor bumps the generation');

    const pong = envelope(await wss2.call('ping'));
    assert.equal(pong.meta.status, 'ok');
    assert.equal(pong.data, 'pong');

    const missing = envelope(await wss2.call('missing'));
    assert.equal(missing.meta.status, 'error');
    assert.match(missing.meta.message, /does not support 'missing'/);

    const gen1 = wss2.editorGeneration;
    const none = await wss2.waitForEditor(gen1, 300);
    assert.equal(none, false, 'no new editor within the timeout resolves false');

    const legacy = await new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ register: 'editor' }));
            resolve(ws);
        });
        ws.on('message', (data) => {
            const { id } = JSON.parse(data.toString());
            ws.send(JSON.stringify({ id, res: { data: 'legacy pong' } }));
        });
    });
    await wss2.waitForEditor(gen1, 2000);
    const legacyPong = envelope(await wss2.call('ping'));
    assert.equal(legacyPong.meta.status, 'ok');
    assert.equal(legacyPong.data, 'legacy pong');

    const gen2 = wss2.editorGeneration;
    const incompatibleEditor = await new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ register: 'editor', protocolVersion: 2, methods: ['ping'] }));
            resolve(ws);
        });
    });
    await wss2.waitForEditor(gen2, 2000);
    const incompatible = envelope(await wss2.call('ping'));
    assert.equal(incompatible.meta.status, 'error');
    assert.match(incompatible.meta.message, /advertises incompatible protocol 2/);

    ed.close();
    legacy.close();
    incompatibleEditor.close();
    wss2.close();
});

const PORT3 = 52997;

test('runtime calls relay through the editor socket', async () => {
    const wss3 = new WSS(PORT3);

    // an editor peer that relays for the launch page: it answers every frame, echoing the
    // method name back so we can prove which socket the call travelled on
    const editor = await new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT3}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping', 'launch:start'] }));
            resolve(ws);
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            ws.send(JSON.stringify({ id: msg.id, res: { data: msg.name } }));
        });
    });

    await wss3.waitForEditor(-1, 2000);
    assert.equal(wss3.hasRuntime(), false, 'no runtime until the editor announces one');

    editor.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
    assert.equal(await wss3.waitForRuntime(2000), true, 'announcing a relayed launch page makes the runtime available');

    const capture = envelope(await wss3.call('runtime:capture'));
    assert.equal(capture.meta.status, 'ok');
    assert.equal(capture.data, 'runtime:capture', 'runtime frames ride the editor socket unchanged');

    const unsupported = envelope(await wss3.call('runtime:nope'));
    assert.equal(unsupported.meta.status, 'error');
    assert.match(unsupported.meta.message, /Runtime does not support 'runtime:nope'/);

    // the launch window closed: the relay is withdrawn and runtime tools say so
    editor.send(JSON.stringify({ runtime: null }));
    for (let i = 0; i < 40 && wss3.hasRuntime(); i++) {
        await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(wss3.hasRuntime(), false, 'withdrawing the relay clears the runtime');
    const gone = envelope(await wss3.call('runtime:capture'));
    assert.equal(gone.meta.status, 'error');
    assert.match(gone.meta.message, /Call launch_start first; the editor relays to the launched page/);
    assert.doesNotMatch(gone.meta.message, /Apps on device/, 'relay mode must not blame the launch origin permission');

    // edit-time calls are unaffected
    const ping = envelope(await wss3.call('ping'));
    assert.equal(ping.data, 'ping');

    editor.close();
    wss3.close();
});

const PORT4 = 52992;

// open a socket that answers every frame with `data`, optionally registering as the editor
const peer = (port: number, data: string, origin?: string, register = true) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    ws.on('open', () => {
        if (register) {
            ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping'] }));
        }
        resolve(ws);
    });
    ws.on('message', (raw) => {
        const { id } = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ id, res: { data } }));
    });
});

const listening = async (port: number) => {
    for (let i = 0; i < 40; i++) {
        const up = await new Promise<boolean>((r) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            ws.on('open', () => { ws.close(); r(true); });
            ws.on('error', () => r(false));
        });
        if (up) return;
        await new Promise(r => setTimeout(r, 50));
    }
};

// an editor plus a second, unregistered page socket, both from the editor origin
const pair = async (t: TestContext, port: number) => {
    const wss = new WSS(port);
    await listening(port);
    const gen = wss.editorGeneration;
    const editor = await peer(port, 'editor', 'https://playcanvas.com');
    await wss.waitForEditor(gen, 2000);
    const other = await peer(port, 'forged', 'https://playcanvas.com', false);
    t.after(() => {
        editor.close();
        other.close();
        wss.close();
    });
    return { wss, other };
};

test('only the socket a request went to can answer it', async (t) => {
    const { wss, other } = await pair(t, PORT4);

    // the other socket races forged answers for the next request ids
    const pending = wss.call('ping');
    for (let id = 0; id < 50; id++) {
        other.send(JSON.stringify({ id, res: { data: 'forged' } }));
    }
    assert.equal(envelope(await pending).data, 'editor', 'answers from another socket are ignored');
});

test('a page cannot ask the server to give up its port', async (t) => {
    const { wss, other } = await pair(t, PORT4 - 1);
    other.send(JSON.stringify({ yield: true }));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(envelope(await wss.call('ping')).data, 'editor', 'yield from a page with an Origin is ignored');
});

const PORT5 = 52996;

// an editor that registers but never answers any request
const silentEditor = (port: number, methods: string[] = ['ping'], received?: { id: number; name: string }[]) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
        ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods }));
        resolve(ws);
    });
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.name && received) {
            received.push({ id: msg.id, name: msg.name });
        }
    });
});

test('pending requests fail fast when the editor connection is replaced', async (t) => {
    const wss = new WSS(PORT5);
    await listening(PORT5);
    t.after(() => wss.close());

    const silent = await silentEditor(PORT5);
    await wss.waitForEditor(0, 2000);
    t.after(() => silent.close());

    // several concurrent requests pile up on the old connection
    const started = Date.now();
    const pending = [wss.call('ping'), wss.call('ping'), wss.call('ping')];

    // a reloaded editor page connects and registers, taking the slot
    const gen = wss.editorGeneration;
    const reloaded = await peer(PORT5, 'reloaded');
    await wss.waitForEditor(gen, 2000);
    t.after(() => reloaded.close());

    for (const p of pending) {
        const res = envelope(await p);
        assert.equal(res.meta.status, 'error');
        assert.match(res.meta.message, /connection was replaced/);
    }
    assert.ok(Date.now() - started < 5000, 'replaced requests must not run into the 60s default timeout');

    // the new connection serves requests normally
    assert.equal(envelope(await wss.call('ping')).data, 'reloaded');
});

test('a closed editor socket fails its pending requests immediately', async (t) => {
    const wss = new WSS(PORT5 - 1);
    await listening(PORT5 - 1);
    t.after(() => wss.close());

    const silent = await silentEditor(PORT5 - 1);
    await wss.waitForEditor(0, 2000);

    const started = Date.now();
    const pending = wss.call('ping');
    silent.close();
    const res = envelope(await pending);
    assert.equal(res.meta.status, 'error');
    assert.match(res.meta.message, /connection was replaced/);
    assert.ok(Date.now() - started < 5000, 'a closed socket must fail its requests now, not at the 60s timeout');

    // and the next call reports the missing editor instead of hanging
    const res2 = envelope(await wss.call('ping'));
    assert.match(res2.meta.message, /Editor not connected/);
});

test('answers on a new connection never claim requests from the old one', async (t) => {
    const wss = new WSS(PORT5 - 2);
    await listening(PORT5 - 2);
    t.after(() => wss.close());

    const received: { id: number; name: string }[] = [];
    const silent = await silentEditor(PORT5 - 2, ['ping', 'scene:load'], received);
    await wss.waitForEditor(0, 2000);
    t.after(() => silent.close());

    const pending = wss.call('scene:load', 7);
    for (let i = 0; i < 40 && !received.some(m => m.name === 'scene:load'); i++) {
        await new Promise(r => setTimeout(r, 25));
    }
    const oldId = received.find(m => m.name === 'scene:load')!.id;

    // the editor reloads: a new connection takes the slot and the old request fails
    const gen = wss.editorGeneration;
    const reloaded = await peer(PORT5 - 2, 'new');
    await wss.waitForEditor(gen, 2000);
    t.after(() => reloaded.close());

    // the new connection forges an answer carrying the OLD request id
    reloaded.send(JSON.stringify({ id: oldId, res: { data: 'forged' } }));

    const res = envelope(await pending);
    assert.equal(res.meta.status, 'error');
    assert.match(res.meta.message, /connection was replaced/);
    assert.notEqual(res.data, 'forged', 'a same-id answer on the new connection must not claim the old request');

    // fresh requests on the new connection are unaffected
    assert.equal(envelope(await wss.call('ping')).data, 'new');
});

test('detaching the runtime fails in-flight runtime calls immediately', async (t) => {
    const wss = new WSS(PORT5 - 3);
    await listening(PORT5 - 3);
    t.after(() => wss.close());

    // an editor that relays for a launch page; answers edit-time pings, never runtime frames
    const editor = await new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT5 - 3}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping'] }));
            ws.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
            resolve(ws);
        });
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.name === 'ping') {
                ws.send(JSON.stringify({ id: msg.id, res: { data: 'pong' } }));
            }
        });
    });
    t.after(() => editor.close());
    assert.equal(await wss.waitForRuntime(2000), true);

    const started = Date.now();
    const pending = wss.call('runtime:capture');

    // the launch window closes: the relay is withdrawn mid-flight
    editor.send(JSON.stringify({ runtime: null }));
    const res = envelope(await pending);
    assert.equal(res.meta.status, 'error');
    assert.match(res.meta.message, /Call launch_start first/);
    assert.doesNotMatch(res.meta.message, /Apps on device/, 'a detached runtime must not blame browser permissions');
    assert.ok(Date.now() - started < 5000, 'an in-flight runtime call must fail at detach, not at the 60s timeout');

    // later runtime calls say the same, and edit-time calls still work
    assert.match(envelope(await wss.call('runtime:capture')).meta.message, /Call launch_start first/);
    assert.equal(envelope(await wss.call('ping')).data, 'pong');
});

test('editor disconnect clears the runtime and editor capabilities', async (t) => {
    const wss = new WSS(PORT5 - 6);
    await listening(PORT5 - 6);
    t.after(() => wss.close());

    const editor = await new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT5 - 6}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping'] }));
            ws.send(JSON.stringify({ runtime: { protocolVersion: 1, methods: ['runtime:capture'] } }));
            resolve(ws);
        });
    });
    assert.equal(await wss.waitForRuntime(2000), true);

    editor.close();
    for (let i = 0; i < 40 && wss.hasRuntime(); i++) {
        await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(wss.hasRuntime(), false, 'editor disconnect must clear the relayed runtime');

    const runtime = envelope(await wss.call('runtime:capture'));
    assert.match(runtime.meta.message, /Call launch_start first/);
    assert.doesNotMatch(runtime.meta.message, /Apps on device/);

    const ping = envelope(await wss.call('ping'));
    assert.match(ping.meta.message, /Editor not connected/);
});

test('a local process without an Origin can claim the port', async (t) => {
    const wss = new WSS(PORT5 - 7);
    await listening(PORT5 - 7);
    const editor = await peer(PORT5 - 7, 'editor', 'https://playcanvas.com');
    await wss.waitForEditor(0, 2000);
    t.after(() => {
        editor.close();
        wss.close();
    });

    const dropped = new Promise<void>((resolve) => editor.on('close', () => resolve()));

    // the takeover handshake: a no-Origin local process asks us to yield
    const handshake = new WebSocket(`ws://127.0.0.1:${PORT5 - 7}`);
    handshake.on('open', () => handshake.send(JSON.stringify({ yield: true })));
    await dropped;

    const res = envelope(await wss.call('ping'));
    assert.equal(res.meta.status, 'error');
    assert.match(res.meta.message, /standby/, 'after yielding, the instance stands by instead of serving calls');
});
