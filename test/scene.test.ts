import assert from 'node:assert';
import { test } from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebSocket } from 'ws';

import { register } from '../src/tools/scene.ts';
import { WSS } from '../src/wss.ts';

const PORT = 52991;

type ToolResult = { content: { text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

const makeServer = () => {
    const tools: Record<string, ToolHandler> = {};
    return {
        tools,
        registerTool(name: string, _cfg: unknown, handler: ToolHandler) {
            tools[name] = handler;
        }
    };
};

test('load_scene preserves immediate loading and optionally waits for readiness', async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    let generation = 0;
    const wss = {
        get editorGeneration() {
            return generation;
        },
        call: async (name: string, ...args: unknown[]) => {
            calls.push({ name, args });
            return { content: [{ text: JSON.stringify({ name, data: { uniqueId: args[0] } }) }] };
        },
        raw: async (name: string, ...args: unknown[]) => {
            calls.push({ name, args });
            return { data: { uniqueId: args[0] } };
        },
        waitForEditor: async (gen: number, _waitMs: number) => gen < ++generation,
        ok: (name: string, data: unknown) => ({ content: [{ text: JSON.stringify({ name, data }) }] }),
        fail: (name: string, message: string) => ({ content: [{ text: JSON.stringify({ name, message }) }], isError: true })
    };
    const server = makeServer();
    register(server as unknown as McpServer, wss as unknown as WSS);

    const result = await server.tools.load_scene({ uniqueId: 'scene-2' });
    await server.tools.load_scene({ uniqueId: 'scene-3', wait: true });
    await server.tools.rename_scene({ name: 'Gameplay' });

    assert.deepEqual(calls, [
        { name: 'scene:load', args: ['scene-2'] },
        { name: 'scene:load', args: ['scene-3', { wait: true }] },
        { name: 'scene:name:set', args: ['Gameplay'] }
    ]);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: 'scene:load', data: { uniqueId: 'scene-2' } });
});

test('load_scene wait=true fails explicitly when the editor never reconnects', async () => {
    const wss = {
        editorGeneration: 3,
        raw: async () => ({ data: { uniqueId: 'scene-9' } }),
        waitForEditor: async () => false,
        ok: (name: string, data: unknown) => ({ content: [{ text: JSON.stringify({ name, data }) }] }),
        fail: (name: string, message: string) => ({ content: [{ text: JSON.stringify({ name, status: 'error', message }) }], isError: true })
    };
    const server = makeServer();
    register(server as unknown as McpServer, wss as unknown as WSS);

    const result = await server.tools.load_scene({ uniqueId: 'scene-9', wait: true, waitMs: 50 });
    assert.equal(result.isError, true, 'a reconnect timeout must be an error, not a success');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'error');
    assert.match(body.message, /did not reconnect in time/);
});

// a fake editor that answers scene:load, then (optionally) drops the connection
// the way the real editor page does when loading a scene reloads it
const connectEditor = (port: number, methods: string[], onLoad?: (ws: WebSocket) => void) => new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
        ws.send(JSON.stringify({ register: 'editor', protocolVersion: 1, methods: ['ping', ...methods] }));
        resolve(ws);
    });
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (!msg.name || msg.name === 'ping') {
            return;
        }
        ws.send(JSON.stringify({ id: msg.id, res: { data: { uniqueId: msg.args[0] } } }));
        if (msg.name === 'scene:load') {
            onLoad?.(ws);
        }
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
    throw new Error(`server did not start on port ${port}`);
};

test('load_scene wait=true follows the editor reload across connections', async (t) => {
    const wss = new WSS(PORT);
    await listening(PORT);
    t.after(() => wss.close());

    const server = makeServer();
    register(server as unknown as McpServer, wss);

    // first editor generation: answers the load, then its page reloads (socket closes)
    const first = await connectEditor(PORT, ['scene:load'], (ws) => {
        setTimeout(() => ws.close(), 50);
    });
    await wss.waitForEditor(0, 2000);

    // the reloaded page reconnects as a NEW generation shortly after
    let second: WebSocket | undefined;
    setTimeout(async () => {
        second = await connectEditor(PORT, ['scene:load']);
    }, 200);
    t.after(() => second?.close());

    const loaded = await server.tools.load_scene({ uniqueId: 'scene-7', wait: true, waitMs: 5000 });
    assert.equal(loaded.isError, undefined, JSON.stringify(loaded));
    const body = JSON.parse(loaded.content[0].text);
    assert.equal(body.meta.status, 'ok');
    assert.deepEqual(body.data, { uniqueId: 'scene-7' });
    assert.ok(wss.editorGeneration >= 2, 'a newer editor generation connected');

    first.close();
});

test('load_scene wait=true times out when the reloaded editor never returns', async (t) => {
    const wss = new WSS(PORT + 1);
    await listening(PORT + 1);
    t.after(() => wss.close());

    const server = makeServer();
    register(server as unknown as McpServer, wss);

    // the editor answers the load and reloads, but no new connection ever arrives
    const first = await connectEditor(PORT + 1, ['scene:load'], (ws) => {
        setTimeout(() => ws.close(), 50);
    });
    await wss.waitForEditor(0, 2000);
    t.after(() => first.close());

    const result = await server.tools.load_scene({ uniqueId: 'scene-8', wait: true, waitMs: 400 });
    assert.equal(result.isError, true, 'no reconnect within waitMs must be an error, not a success');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.meta.status, 'error');
    assert.match(body.meta.message, /did not reconnect in time/);
});
