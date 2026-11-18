import assert from 'node:assert';
import net from 'node:net';
import { test } from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';

import { requestHandoff, waitForPortRelease } from '../src/handoff.ts';
import { isAllowedOrigin, WSS } from '../src/wss.ts';

// every test allocates its own loopback port, so files can run in parallel and the
// ports never collide with a host's reserved ranges (Windows excludes whole blocks).
process.env.MCP_ALLOWED_ORIGINS = 'https://extra.example.com, https://another.example.com:8443';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// an unused loopback port: bind an ephemeral one, note its number, release it again.
const freePort = () => new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
    });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 4000, label = 'condition') => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await sleep(25);
    }
    throw new Error(`timed out waiting for ${label}`);
};

// resolve true when the server accepts a connection with the given Origin
const attempt = (port: number, origin?: string) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    ws.on('open', () => {
        ws.close();
        resolve(true);
    });
    ws.on('error', () => resolve(false));
});

const waitForListening = async (port: number) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        if (await attempt(port)) {
            return;
        }
        await sleep(50);
    }
    throw new Error(`server did not start on port ${port}`);
};

const envelope = (result: CallToolResult) => {
    const item = result.content.find(item => item.type === 'text');
    if (!item || item.type !== 'text') {
        throw new Error('Missing text response');
    }
    return JSON.parse(item.text) as { data: unknown; meta: Record<string, unknown> };
};

// a fake editor page. `answer` decides the response payload; it runs after the frame
// is observed, so tests can interleave a forgery before the real answer is sent.
const connectEditor = (port: number, methods: string[], answer: (name: string, id: number) => void, origin = 'https://playcanvas.com', project?: number | null) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    ws.on('open', () => {
        ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods, project }));
        resolve(ws);
    });
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (typeof msg.name === 'string') {
            answer(msg.name, msg.id);
        }
    });
});

test('origin allowlist accepts only the editor, loopback dev origins and exact extras', () => {
    // allowed
    assert.equal(isAllowedOrigin('https://playcanvas.com'), true);
    assert.equal(isAllowedOrigin('https://playcanvas.com:443'), true, 'an explicit port on the editor host is allowed');
    assert.equal(isAllowedOrigin('http://localhost'), true);
    assert.equal(isAllowedOrigin('http://localhost:3000'), true);
    assert.equal(isAllowedOrigin('https://localhost:8443'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:8080'), true);
    assert.equal(isAllowedOrigin('https://extra.example.com'), true, 'MCP_ALLOWED_ORIGINS is exact');
    assert.equal(isAllowedOrigin('https://another.example.com:8443'), true);

    // rejected: subdomains, lookalikes, http editor origin, opaque origin, LAN/other pages
    for (const origin of [
        'https://launch.playcanvas.com',
        'https://sub.launch.playcanvas.com',
        'http://playcanvas.com',
        'https://playcanvas.com.evil.com',
        'https://evilplaycanvas.com',
        'https://sub.extra.example.com',
        'null',
        'http://192.168.1.10:3000',
        'http://10.0.0.5',
        'https://evil.com',
        'http://foo.localhost:3000'
    ]) {
        assert.equal(isAllowedOrigin(origin), false, `${origin} must be rejected`);
    }
});

test('origin validation at the websocket upgrade, observed in stats', async (t) => {
    const PORT_ORIGIN = await freePort();
    const wss = new WSS(PORT_ORIGIN);
    t.after(() => wss.close());
    await waitForListening(PORT_ORIGIN);

    // no Origin: local processes (e.g. the handoff probe) may connect
    assert.equal(await attempt(PORT_ORIGIN), true);

    // the editor and local dev builds
    assert.equal(await attempt(PORT_ORIGIN, 'https://playcanvas.com'), true);
    assert.equal(await attempt(PORT_ORIGIN, 'http://localhost:3000'), true);
    assert.equal(await attempt(PORT_ORIGIN, 'http://127.0.0.1:8080'), true);

    // rejected pages
    assert.equal(await attempt(PORT_ORIGIN, 'https://launch.playcanvas.com'), false);
    assert.equal(await attempt(PORT_ORIGIN, 'http://playcanvas.com'), false);
    assert.equal(await attempt(PORT_ORIGIN, 'https://playcanvas.com.evil.com'), false);
    assert.equal(await attempt(PORT_ORIGIN, 'null'), false);
    assert.equal(await attempt(PORT_ORIGIN, 'http://192.168.1.10:3000'), false);

    assert.equal(wss.stats.rejectedOrigins, 5, 'every rejected upgrade is counted');
    assert.equal(wss.isOwner, true);
});

test('a standby instance keeps retrying and takes over when the owner exits', async (t) => {
    const PORT_TAKEOVER = await freePort();
    const owner = new WSS(PORT_TAKEOVER, { bindRetryDelay: 100 });
    t.after(() => owner.close());
    await waitForListening(PORT_TAKEOVER);
    assert.equal(owner.isOwner, true);

    // the second instance cannot bind: it must stand by, not exit or kill the owner
    const standby = new WSS(PORT_TAKEOVER, { bindRetryDelay: 100 });
    t.after(() => standby.close());
    await waitFor(() => standby.stats.bindAttempts >= 2, 2000, 'standby bind retries');
    assert.equal(standby.isOwner, false);
    assert.equal(standby.isStandby, true);
    assert.equal(owner.isOwner, true, 'the owner is untouched');

    // the owner goes away (MCP client closed): the standby picks the port up itself
    owner.close();
    await waitFor(() => standby.isOwner, 3000, 'standby takeover');
    assert.equal(standby.stats.becameOwner, 1);

    // and it is a working editor bridge, not just a bound port
    const editor = await connectEditor(PORT_TAKEOVER, ['ping'], (name, id) => {
        if (name === 'ping') {
            const ws = editor as WebSocket;
            ws.send(JSON.stringify({ id, res: { data: 'pong' } }));
        }
    });
    t.after(() => editor.close());
    await waitFor(() => standby.editorConnected, 2000, 'editor registration');
    const pong = envelope(await standby.call('ping'));
    assert.equal(pong.meta.status, 'ok');
    assert.equal(pong.data, 'pong');
});

test('a yield request releases the port, disconnects the editor and re-enters standby', async (t) => {
    const PORT_YIELD = await freePort();
    const owner = new WSS(PORT_YIELD, { bindRetryDelay: 100, handoffRetryDelay: 300 });
    t.after(() => owner.close());
    await waitForListening(PORT_YIELD);

    const editor = new WebSocket(`ws://127.0.0.1:${PORT_YIELD}`, { origin: 'https://playcanvas.com' });
    let editorClosed = false;
    const editorReady = new Promise<void>((resolve) => {
        editor.on('open', () => {
            editor.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping'] }));
            resolve();
        });
        editor.on('close', () => {
            editorClosed = true;
        });
        editor.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.name === 'ping') {
                editor.send(JSON.stringify({ id: msg.id, res: { data: 'pong' } }));
            }
        });
    });
    await editorReady;
    await waitFor(() => owner.editorConnected, 2000, 'editor registration');
    t.after(() => editor.terminate());

    // a second instance is waiting for the port
    const standby = new WSS(PORT_YIELD, { bindRetryDelay: 100 });
    t.after(() => standby.close());
    await waitFor(() => standby.stats.bindAttempts >= 2, 2000, 'standby start');

    // a local process (no Origin) asks the owner to yield
    const requester = new WebSocket(`ws://127.0.0.1:${PORT_YIELD}`);
    await new Promise<void>(resolve => requester.on('open', () => resolve()));
    t.after(() => requester.terminate());
    requester.send(JSON.stringify({ yield: true }));

    await waitFor(() => !owner.isOwner, 2000, 'owner release');
    assert.equal(owner.stats.released, 1);
    assert.equal(owner.isStandby, true, 'the old owner waits to take the port back');
    await waitFor(() => editorClosed, 2000, 'editor disconnect');
    assert.equal(owner.editorConnected, false);

    // the waiting instance now owns the port
    await waitFor(() => standby.isOwner, 3000, 'standby takeover after handoff');
    assert.equal(standby.stats.becameOwner, 1);
});

test('a yield frame from a page with an Origin cannot make the owner give up the port', async (t) => {
    const PORT_PAGE_YIELD = await freePort();
    const wss = new WSS(PORT_PAGE_YIELD, { bindRetryDelay: 100 });
    t.after(() => wss.close());
    await waitForListening(PORT_PAGE_YIELD);

    const forged = new WebSocket(`ws://127.0.0.1:${PORT_PAGE_YIELD}`, { origin: 'https://playcanvas.com' });
    await new Promise<void>(resolve => forged.on('open', () => resolve()));
    t.after(() => forged.terminate());
    forged.send(JSON.stringify({ yield: true }));

    await waitFor(() => wss.stats.ignoredYields >= 1, 2000, 'ignored yield counter');
    await sleep(100);
    assert.equal(wss.isOwner, true, 'the port is still owned');
    assert.equal(wss.stats.released, 0);
});

test('only the socket a request was sent to may answer it', async (t) => {
    const PORT_FORGERY = await freePort();
    const wss = new WSS(PORT_FORGERY, { bindRetryDelay: 100 });
    t.after(() => wss.close());
    await waitForListening(PORT_FORGERY);

    const forgery: { send?: (id: number) => void } = {};
    const editor = await connectEditor(
        PORT_FORGERY,
        ['ping', 'probe'],
        (name, id) => {
            if (name === 'probe') {
                forgery.send?.(id);
                setTimeout(() => {
                    editor.send(JSON.stringify({ id, res: { data: 'editor' } }));
                }, 50);
            } else if (name === 'ping') {
                editor.send(JSON.stringify({ id, res: { data: 'pong' } }));
            }
        }
    );
    t.after(() => editor.close());
    await waitFor(() => wss.editorConnected, 2000, 'editor registration');

    // a second page races forged answers for whatever request id it can guess
    const intruder = new WebSocket(`ws://127.0.0.1:${PORT_FORGERY}`, { origin: 'https://playcanvas.com' });
    await new Promise<void>(resolve => intruder.on('open', () => resolve()));
    t.after(() => intruder.terminate());
    forgery.send = (id: number) => {
        intruder.send(JSON.stringify({ id, res: { data: 'forged' } }));
        // also spam neighbouring ids, as a hostile page cannot know the counter
        for (let other = id; other < id + 25; other++) {
            intruder.send(JSON.stringify({ id: other, res: { data: 'forged' } }));
        }
    };

    const result = envelope(await wss.call('probe'));
    assert.equal(result.meta.status, 'ok');
    assert.equal(result.data, 'editor', 'the answer from a different socket was dropped');
    assert.ok(wss.stats.ignoredResponses >= 1, 'dropped responses are counted');
});

test('responses use the unified envelope for success and failure', async (t) => {
    const PORT_ERRORS = await freePort();
    const wss = new WSS(PORT_ERRORS, { bindRetryDelay: 100 });
    t.after(() => wss.close());
    await waitForListening(PORT_ERRORS);

    // no editor connected: actionable error, data null, no top-level error
    const disconnected = envelope(await wss.call('ping'));
    assert.equal(disconnected.meta.status, 'error');
    assert.equal(disconnected.data, null);
    assert.match(String(disconnected.meta.message), /Editor not connected.*CONNECT/);
    assert.deepEqual(Object.keys(disconnected).sort(), ['data', 'meta']);
    assert.equal('error' in disconnected, false);

    const editor = await connectEditor(PORT_ERRORS, ['ping'], (name, id) => {
        if (name === 'ping') {
            editor.send(JSON.stringify({ id, res: { data: 'pong' } }));
        }
    }, 'https://playcanvas.com', 1);
    t.after(() => editor.close());
    await waitFor(() => wss.editorConnected, 2000, 'editor registration');

    // success: data has a value, meta.status ok
    const success = envelope(await wss.call('ping'));
    assert.equal(success.meta.status, 'ok');
    assert.equal(success.data, 'pong');
    assert.equal(success.meta.tool, 'ping');
    assert.deepEqual(Object.keys(success).sort(), ['data', 'meta']);

    // unsupported method: names the method and the recovery step
    const unsupported = envelope(await wss.call('not:a:method'));
    assert.equal(unsupported.meta.status, 'error');
    assert.equal(unsupported.data, null);
    assert.match(String(unsupported.meta.message), /does not support 'not:a:method'/);
    assert.equal('error' in unsupported, false);

    // a successful method with no payload still carries data (never null on ok)
    const noPayload = envelope(wss.ok('editor:noop', undefined));
    assert.equal(noPayload.meta.status, 'ok');
    assert.deepEqual(noPayload.data, {}, 'success without a payload is an empty object, not null');
});

test('image responses keep the envelope invariants too', async (t) => {
    const PORT_ERRORS = await freePort();
    const wss = new WSS(PORT_ERRORS, { bindRetryDelay: 100 });
    t.after(() => wss.close());
    await waitForListening(PORT_ERRORS);

    // no editor: the image tool fails through the same envelope
    const missing = await wss.callImage('viewport:capture');
    assert.equal(missing.isError, true);
    assert.equal(envelope(missing).data, null);
    assert.equal(envelope(missing).meta.status, 'error');

    const editor = await connectEditor(PORT_ERRORS, ['ping', 'viewport:capture'], (name, id) => {
        if (name === 'viewport:capture') {
            editor.send(JSON.stringify({ id, res: { data: 'aW1hZ2U=', meta: { mimeType: 'image/webp', width: 4 } } }));
        } else if (name === 'ping') {
            editor.send(JSON.stringify({ id, res: { data: 'pong' } }));
        }
    }, 'https://playcanvas.com', 1);
    t.after(() => editor.close());
    await waitFor(() => wss.editorConnected, 2000, 'editor registration');

    const captured = await wss.callImage('viewport:capture');
    assert.equal(captured.isError, undefined);
    const image = captured.content.find(item => item.type === 'image');
    assert.ok(image && image.type === 'image' && image.data === 'aW1hZ2U=');
    const text = envelope(captured);
    assert.equal(text.meta.status, 'ok');
    assert.notEqual(text.data, null, 'a successful response carries data');
    assert.equal(text.meta.mimeType, 'image/webp');
});

test('an editor disconnecting mid-request fails the call instead of hanging', async (t) => {
    const PORT_DISCONNECT = await freePort();
    const wss = new WSS(PORT_DISCONNECT, { bindRetryDelay: 100 });
    t.after(() => wss.close());
    await waitForListening(PORT_DISCONNECT);

    const editor = await connectEditor(PORT_DISCONNECT, ['ping', 'stall'], () => {
        // never answer; the test drops the socket instead
    });
    t.after(() => editor.close());
    await waitFor(() => wss.editorConnected, 2000, 'editor registration');

    const pending = wss.call('stall');
    await sleep(100);
    editor.close();
    const result = envelope(await pending);
    assert.equal(result.meta.status, 'error');
    assert.equal(result.data, null);
    assert.match(String(result.meta.message), /disconnected before answering 'stall'/);
});

test('requestHandoff asks a real owner to yield and sees it release the port', async (t) => {
    const PORT_HANDOFF = await freePort();
    const owner = new WSS(PORT_HANDOFF, { bindRetryDelay: 100 });
    t.after(() => owner.close());
    await waitForListening(PORT_HANDOFF);

    const role = await requestHandoff(PORT_HANDOFF, 1000);
    assert.equal(role, 'owner');
    await waitFor(() => !owner.isOwner, 2000, 'owner release');
    assert.equal(owner.stats.released, 1);
});

test('requestHandoff reports a missing listener and a silent one distinctly', async (t) => {
    const PORT_HANDOFF_NONE = await freePort();
    const PORT_HANDOFF_SILENT = await freePort();
    const PORT_HANDOFF_OLD = await freePort();

    // nothing listening
    assert.equal(await requestHandoff(PORT_HANDOFF_NONE, 300), 'none');

    // something listening that is not an MCP bridge: never killed, just reported
    const silent = new WebSocketServer({ port: PORT_HANDOFF_SILENT, host: '127.0.0.1' });
    t.after(() => silent.close());
    await new Promise<void>(resolve => silent.on('listening', () => resolve()));
    assert.equal(await requestHandoff(PORT_HANDOFF_SILENT, 300), 'unanswered');

    // an old build ignores `hello` (no role answer) but understands `yield` and releases
    const oldBuild = new WebSocketServer({ port: PORT_HANDOFF_OLD, host: '127.0.0.1' });
    t.after(() => oldBuild.close());
    await new Promise<void>(resolve => oldBuild.on('listening', () => resolve()));
    oldBuild.on('connection', (ws) => {
        ws.on('message', (data) => {
            if (JSON.parse(data.toString()).yield === true) {
                ws.close();
            }
        });
    });
    assert.equal(await requestHandoff(PORT_HANDOFF_OLD, 1000), 'yielded');
});

test('waitForPortRelease resolves once the listening socket is gone', async (t) => {
    const PORT_RELEASE = await freePort();
    const server = new WebSocketServer({ port: PORT_RELEASE, host: '127.0.0.1' });
    t.after(() => server.close());
    await new Promise<void>(resolve => server.on('listening', () => resolve()));

    // a busy port is not reported as released before the deadline
    assert.equal(await waitForPortRelease(PORT_RELEASE, 200), false);

    const released = waitForPortRelease(PORT_RELEASE, 2000);
    server.close();
    assert.equal(await released, true, 'the wait resolves once the owner closes');
});

