import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListPromptsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import pkg from '../package.json' with { type: 'json' };

import { requestHandoff, waitForPortRelease } from './handoff.ts';
import { register as registerAnimation } from './tools/animation.ts';
import { register as registerAnimStateGraph } from './tools/animstategraph.ts';
import { register as registerAsset } from './tools/asset.ts';
import { register as registerAssetMaterial } from './tools/assets/material.ts';
import { register as registerAssetScript } from './tools/assets/script.ts';
import { register as registerBuild } from './tools/build.ts';
import { register as registerEditor } from './tools/editor.ts';
import { register as registerEntity } from './tools/entity.ts';
import { register as registerProcessing } from './tools/processing.ts';
import { register as registerProject } from './tools/project.ts';
import { register as registerProjects } from './tools/projects.ts';
import { register as registerRuntime } from './tools/runtime.ts';
import { register as registerScene } from './tools/scene.ts';
import { register as registerStore } from './tools/store.ts';
import { register as registerVcs } from './tools/vcs.ts';
import { register as registerViewport } from './tools/viewport.ts';
import { WSS } from './wss.ts';

const PORT = parseInt(process.env.PORT || '52000', 10);

// Ask whoever currently owns the port to gracefully hand it off, so the *newest*
// (active) client ends up controlling the editor. The owner releases the port
// without exiting, so its MCP client doesn't restart it — no kill/restart storm.
// Nothing is ever killed and no PID table is consulted (netstat/lsof output is
// localized and unreliable): the port is probed over the same websocket the
// editor uses. If nobody usable answers, WSS stands by and retries binding.
const handoff = await requestHandoff(PORT, 1500);
if (handoff === 'owner' || handoff === 'yielded') {
    // let the previous owner finish closing its listening socket before binding, so
    // the takeover does not start with a string of EADDRINUSE stand-by retries.
    const released = await waitForPortRelease(PORT, 2000);
    console.error(
        released
            ? `[process] Port ${PORT} released by the previous owner; taking over.`
            : `[process] Port ${PORT} was asked to hand off but is still listening; standing by and retrying.`
    );
} else if (handoff === 'none') {
    console.error('[process] Nothing to hand off on port', PORT, '— starting as owner.');
} else {
    console.error('[process] The listener on port', PORT, 'did not answer the handoff request; leaving it alone and standing by.');
}

// Create a WebSocket server
const wss = new WSS(PORT);

// Create an MCP server
const mcp = new McpServer({
    name: 'PlayCanvas',
    version: pkg.version
}, {
    capabilities: {
        tools: {},
        resources: {},
        prompts: {}
    }
});
mcp.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
mcp.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));

// Tools
registerEntity(mcp, wss);
registerAsset(mcp, wss);
registerAssetMaterial(mcp, wss);
registerAssetScript(mcp, wss);
registerAnimation(mcp, wss);
registerAnimStateGraph(mcp, wss);
registerProcessing(mcp, wss);
registerBuild(mcp, wss);
registerScene(mcp, wss);
registerProject(mcp, wss);
registerProjects(mcp, wss);
registerStore(mcp, wss);
registerViewport(mcp, wss);
registerRuntime(mcp, wss);
registerEditor(mcp, wss);
registerVcs(mcp, wss);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
mcp.connect(transport).then(() => {
    console.error('[MCP] Listening');
}).catch((e) => {
    console.error('[MCP] Error', e);
    process.exit(1);
});

const close = () => {
    mcp.close().finally(() => {
        console.error('[MCP] Closed');
        wss.close();
        process.exit(0);
    });
};

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
    console.error('[process] Uncaught exception', err);
    console.error('[process] Stack:', err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[process] Unhandled rejection at:', promise);
    console.error('[process] Reason:', reason);
});
process.on('exit', (code) => {
    console.error('[process] Exit with code:', code);
});

// Clean up on exit
process.stdin.on('close', () => {
    console.error('[process] stdin closed');
    close();
});
process.stdin.on('end', () => {
    console.error('[process] stdin ended');
    close();
});

// If our parent process dies we get reparented to init (ppid 1). That means our
// MCP client/launcher is gone but we were left running — the main way stale
// servers pile up and keep hogging the port. Detect it and exit so the port is
// released for the active client instead of lingering as an orphan.
if (process.platform !== 'win32') {
    const parentWatch = setInterval(() => {
        if (process.ppid === 1) {
            console.error('[process] Parent gone (reparented to init); exiting to release the port');
            clearInterval(parentWatch);
            close();
        }
    }, 2000);
    parentWatch.unref();
}
process.on('SIGINT', () => {
    console.error('[process] SIGINT');
    close();
});
process.on('SIGTERM', () => {
    console.error('[process] SIGTERM');
    close();
});
process.on('SIGQUIT', () => {
    console.error('[process] SIGQUIT');
    close();
});
