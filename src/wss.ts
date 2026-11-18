import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';

const PING_DELAY = 1000;

const DEFAULT_TIMEOUT = 60_000;
const PROTOCOL_VERSION = 1;

// how often a standby instance retries binding. each MCP client runs its own server, but
// only one can own the port; the rest stand by and take over when the owner exits.
const BIND_RETRY_DELAY = 3_000;

// after yielding, wait longer than a regular retry before trying to take the port back,
// so the instance that asked for the handoff has time to bind first.
const HANDOFF_RETRY_DELAY = 5_000;

// browsers don't apply CORS to websockets, so any open webpage can hit ws://localhost:<port>
// (MCP spec DNS-rebinding warning). only the editor origin and local dev builds may connect;
// other playcanvas.com subdomains (e.g. launch pages running project code) may not. no-Origin
// clients (non-browser local processes, e.g. the yield handshake) are allowed too.
// add exact extra origins via MCP_ALLOWED_ORIGINS (comma-separated).
// scheme, host and optional port must match exactly; paths, subdomains, lookalikes and the
// http editor origin all fail.
const DEFAULT_ALLOWED_ORIGINS = /^https:\/\/playcanvas\.com(?::\d{1,5})?$|^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

// Chromium gates public→loopback behind a per-origin permission (Chrome 142+, websockets
// from 147). a blocked socket looks like "nothing is listening", so failures must name it.
const LNA_EDITOR_HINT = 'If it stays on "Connecting", the browser may be blocking its connection to 127.0.0.1: allow local access for the editor origin in site settings ("Apps on device" in Chrome).';

// launch page has no socket of its own, so a runtime failure is only ever a blocked popup
const LAUNCH_HINT = 'If it never connects, allow popups for the editor origin so the launch window can open; the editor relays to it, so no extra browser permission is involved.';

// the blank /editor page only handles project tools
const NO_PROJECT_HINT = 'No project is open in the Editor. Call list_projects or create_project, then open_project, and retry.';

/**
 * Whether a browser Origin may open a websocket to the editor bridge. Only the
 * production editor origin, loopback dev builds, and exact extras are allowed;
 * everything else (subdomains, lookalikes, http(s) editor variants, opaque
 * `null`, LAN addresses) is rejected. An absent Origin (local process) is
 * handled by the caller, not here.
 *
 * @param origin - The `Origin` request header value.
 * @param extraOrigins - Additional exact origins (e.g. tests); merged with `MCP_ALLOWED_ORIGINS`.
 * @returns True when the origin is allowed to connect.
 */
const isAllowedOrigin = (origin: string, extraOrigins: readonly string[] = []): boolean => {
    if (DEFAULT_ALLOWED_ORIGINS.test(origin)) {
        return true;
    }
    const configured = [...extraOrigins, ...(process.env.MCP_ALLOWED_ORIGINS || '').split(',')]
        .map(s => s.trim())
        .filter(Boolean);
    return configured.includes(origin);
};

/**
 * Metadata attached to every tool response. `status`/`message` describe the
 * outcome; the pagination fields describe a list slice. Everything lives under
 * `meta` so it never collides with business data in `data`.
 */
export type Meta = {
    tool: string;
    status: 'ok' | 'error';
    message?: string;
    total?: number;
    count?: number;
    hasMore?: boolean;
    nextCursor?: string | null;
    [key: string]: unknown;
};

/**
 * The unified response envelope shared by every tool. Agents pattern-match on
 * the *shape* of a response, so keeping this identical across all tools removes
 * a major source of hallucinated field access.
 *
 * - `data` is always present; an empty result set is `[]`, never an error.
 * - errors live in `meta.status`/`meta.message` (never a top-level `error`).
 */
export type Envelope<T = unknown> = {
    data: T | null;
    meta: Meta;
};

/**
 * Observable counters for the bridge. They make port ownership changes, origin
 * rejections, and response-routing drops inspectable (and testable) instead of
 * only visible in log lines.
 */
export type WSSStats = {
    /** Bind attempts, including standby retries. */
    bindAttempts: number;
    /** Times this instance successfully took the port. */
    becameOwner: number;
    /** Times this instance released the port for another instance. */
    released: number;
    /** Connections rejected by the Origin allowlist. */
    rejectedOrigins: number;
    /** Responses ignored because they arrived on a socket the request was not sent to. */
    ignoredResponses: number;
    /** Yield frames ignored because they came from a page with an Origin. */
    ignoredYields: number;
};

export type WSSOptions = {
    /** Delay between standby bind attempts (default 3000ms). */
    bindRetryDelay?: number;
    /** Delay before retrying the port after a graceful handoff (default 5000ms). */
    handoffRetryDelay?: number;
    /** Extra exact origins, in addition to `MCP_ALLOWED_ORIGINS`. */
    allowedOrigins?: readonly string[];
};

/**
 * The raw payload returned by an editor method over the websocket.
 */
type RawResult = {
    data?: unknown;
    error?: string;
    meta?: Record<string, unknown>;
};

// project is null when the editor is on the blank /editor page (no project open)
type Capabilities = { protocolVersion?: number; methods?: Set<string>; project?: number | null };

type Pending = {
    socket: WebSocket;
    name: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (res: RawResult) => void;
    reject: (err: Error) => void;
};

class WSS {
    private _server: WebSocketServer | undefined;

    // the one registered editor socket; launch:*/ping and relayed runtime:* all ride it
    private _editor: WebSocket | undefined;

    private _editorCaps: Capabilities | undefined;

    // the launch page the editor relays for; set by its announce frame, null when it detaches
    private _runtime: Capabilities | undefined;

    // keyed by request id; only the socket the request went to may answer it
    private _callbacks = new Map<number, Pending>();

    private _id = 0;

    private _editorGeneration = 0;

    private _pingInterval: ReturnType<typeof setInterval> | null = null;

    private _port: number;

    private _listening = false;

    // true once a bind attempt found the port owned elsewhere (EADDRINUSE) or after a
    // handoff; false again the moment this instance becomes the owner.
    private _standby = false;

    private _closed = false;

    private _bindTimer: ReturnType<typeof setTimeout> | null = null;

    private _bindRetryDelay: number;

    private _handoffRetryDelay: number;

    private _extraOrigins: readonly string[];

    private _stats: WSSStats = {
        bindAttempts: 0,
        becameOwner: 0,
        released: 0,
        rejectedOrigins: 0,
        ignoredResponses: 0,
        ignoredYields: 0
    };

    constructor(port: number, options: WSSOptions = {}) {
        this._port = port;
        this._bindRetryDelay = options.bindRetryDelay ?? BIND_RETRY_DELAY;
        this._handoffRetryDelay = options.handoffRetryDelay ?? HANDOFF_RETRY_DELAY;
        this._extraOrigins = options.allowedOrigins ?? [];
        this._bind();
    }

    /**
     * Try to own the port. If another MCP server instance already owns it
     * (EADDRINUSE), don't kill it and don't give up — stand by and retry, so
     * whoever currently owns the editor connection stays stable and we take
     * over automatically once they exit. This is what keeps multiple concurrent
     * agent MCP clients from fighting over the port.
     */
    private _bind() {
        if (this._closed) {
            return;
        }
        this._bindTimer = null;
        this._stats.bindAttempts++;
        const server = new WebSocketServer({
            port: this._port,

            // loopback only — never expose the editor bridge to the LAN
            host: '127.0.0.1',
            verifyClient: ({ origin }: { origin?: string }) => {
                if (!origin || isAllowedOrigin(origin, this._extraOrigins)) {
                    return true;
                }
                this._stats.rejectedOrigins++;
                console.error(`[WSS] Rejected connection from disallowed origin "${origin}" (allowed: https://playcanvas.com, localhost, 127.0.0.1, plus MCP_ALLOWED_ORIGINS)`);
                return false;
            }
        });
        this._server = server;
        server.on('listening', () => {
            if (this._closed || this._server !== server) {
                return;
            }
            this._listening = true;
            this._standby = false;
            this._stats.becameOwner++;
            console.error(`[WSS] Listening on 127.0.0.1:${this._port} (port owner)`);
        });
        server.on('error', (err: Error & { code?: string }) => {
            if (this._closed || this._server !== server) {
                return;
            }

            // an error after a successful listen is not a bind conflict; keep the
            // existing listener rather than closing client sockets underneath it.
            if (this._listening && err.code !== 'EADDRINUSE') {
                console.error('[WSS] Server error', err);
                return;
            }
            this._listening = false;
            this._server = undefined;
            if (err.code === 'EADDRINUSE') {
                this._standby = true;
                console.error(`[WSS] Standby: port ${this._port} is owned by another MCP server instance; retrying in ${this._bindRetryDelay}ms (only one instance controls the editor at a time).`);
            } else {
                console.error(`[WSS] Failed to bind 127.0.0.1:${this._port}; retrying in ${this._bindRetryDelay}ms`, err);
            }
            try {
                server.close();
            } catch { /* already closing */ }
            this._scheduleBind(this._bindRetryDelay);
        });
        this._attachConnectionHandler(server);
    }

    private _scheduleBind(delay: number) {
        if (this._closed) {
            return;
        }
        if (this._bindTimer) {
            clearTimeout(this._bindTimer);
        }
        this._bindTimer = setTimeout(() => this._bind(), delay);
    }

    private _attachConnectionHandler(server: WebSocketServer) {

        // attached once per server instance and kept for its life; re-adding it per
        // disconnect would leak listeners and double-handle messages.
        server.on('connection', (ws, req) => {

            // browsers always send an Origin, so only local processes arrive without
            // one. an Origin-bearing page is never trusted for the yield handshake.
            const local = !req.headers.origin;
            console.error(`[WSS] Peer connected (${local ? 'local process' : `origin ${req.headers.origin}`})`);

            // backwards compatibility: an older editor build may never send a register
            // frame, so the first *page* takes the editor slot provisionally. local
            // processes (the handoff probe, port checks) never claim it, and a later
            // register from any socket makes the registration authoritative.
            if (!local && !this._editor) {
                this._editor = ws;
                this._editorGeneration++;
                this._startPing();
            }
            ws.on('message', (data) => {
                try {
                    this._onMessage(ws, local, data.toString());
                } catch (e) {
                    console.error('[WSS] Failed to handle frame', e);
                }
            });
            ws.on('close', () => {
                if (this._editor === ws) {
                    this._editor = undefined;
                    this._editorCaps = undefined;

                    // the relay lives in the editor page; a reloaded editor re-announces
                    this._runtime = undefined;
                    console.error('[WSS] Disconnected editor');
                    if (this._pingInterval) {
                        clearInterval(this._pingInterval);
                        this._pingInterval = null;
                    }
                    this._failPending(ws, name => `The editor disconnected before answering '${name}'. Reconnect it (MCP button → CONNECT) and retry.`);
                }
            });

            // a socket 'error' with no listener is re-thrown by `ws` as an uncaught
            // exception; handle it and let the 'close' that follows free the slot.
            ws.on('error', (err: Error) => {
                console.error('[WSS] Socket error', err?.message ?? err);
                try {
                    ws.close();
                } catch { /* already closing */ }
            });
        });
    }

    private _onMessage(ws: WebSocket, local: boolean, text: string) {
        let msg: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.error('[WSS] Ignored frame: expected a JSON object');
                return;
            }
            msg = parsed as Record<string, unknown>;
        } catch {
            console.error('[WSS] Ignored frame: invalid JSON');
            return;
        }

        // a local process may ask who owns this bridge before requesting a handoff.
        if (msg.hello === true) {
            if (!local) {
                console.error('[WSS] Ignored identification request from a page with an Origin');
                return;
            }
            this._sendFrame(ws, {
                hello: true,
                name: 'playcanvas-editor-mcp',
                protocolVersion: PROTOCOL_VERSION,
                port: this._port,
                role: this._listening ? 'owner' : 'standby'
            });
            return;
        }

        // a newer instance asks us to hand off the port so the active client
        // controls the editor. we release it (without exiting, so our client
        // doesn't restart us) and stand by to retake it if that instance exits —
        // "latest wins" without a kill/restart storm. only local processes (no
        // Origin) may do this; an Origin-bearing page must never evict the owner.
        if (msg.yield === true) {
            if (!local) {
                this._stats.ignoredYields++;
                console.error('[WSS] Ignored yield request from a page with an Origin; only local processes may request a handoff');
                return;
            }
            this._yield();
            return;
        }

        if (msg.register === 'editor') {
            this._registerEditor(ws, msg);
            return;
        }

        // the launch page the editor relays for, or null once its window is gone
        if ('runtime' in msg) {
            if (this._editor !== ws) {
                console.error('[WSS] Ignored runtime announce from a socket that is not the editor');
                return;
            }
            const runtime = msg.runtime as { protocolVersion?: unknown; methods?: unknown } | null | undefined;
            this._runtime = runtime ? {
                protocolVersion: Number.isInteger(runtime.protocolVersion) ? runtime.protocolVersion as number : undefined,
                methods: Array.isArray(runtime.methods) ? new Set(runtime.methods.filter((name): name is string => typeof name === 'string')) : undefined
            } : undefined;
            console.error(`[WSS] Runtime relay ${runtime ? 'attached' : 'detached'}`);
            return;
        }

        // anything with an id is a response candidate. it must arrive on the exact
        // socket the request was sent to; responses from any other connected page
        // (including one replaying a guessed id) are dropped.
        const id = msg.id;
        if (!Number.isInteger(id)) {
            return;
        }
        const pending = this._callbacks.get(id as number);
        if (!pending) {
            return;
        }
        if (pending.socket !== ws) {
            this._stats.ignoredResponses++;
            console.error(`[WSS] Ignored response for request ${id} from a socket the request was not sent to`);
            return;
        }
        const res = msg.res;
        if (!res || typeof res !== 'object' || Array.isArray(res)) {
            this._settle(id as number, undefined, new Error(`The editor returned an invalid response for '${pending.name}'. Reload the editor page and retry.`));
            return;
        }
        this._settle(id as number, res as RawResult);
    }

    private _sendFrame(ws: WebSocket, frame: Record<string, unknown>) {
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            ws.send(JSON.stringify(frame));
        } catch (err) {
            console.error('[WSS] Failed to send frame', err);
        }
    }

    private _registerEditor(ws: WebSocket, msg: Record<string, unknown>) {
        const previous = this._editor;
        if (previous && previous !== ws) {
            console.error('[WSS] Replacing the editor connection with a newly registered one');
            this._failPending(previous, name => `The editor reconnected before answering '${name}'. Retry against the new connection.`);
            try {
                previous.close(1000, 'REPLACED');
            } catch { /* already closing */ }
            this._runtime = undefined;
        }
        this._editor = ws;
        this._editorCaps = {
            protocolVersion: Number.isInteger(msg.protocolVersion) ? msg.protocolVersion as number : undefined,
            methods: Array.isArray(msg.methods) ? new Set(msg.methods.filter((name): name is string => typeof name === 'string')) : undefined,
            project: Number.isInteger(msg.project) || msg.project === null ? msg.project as number | null : undefined
        };
        this._editorGeneration++;
        this._startPing();
        console.error('[WSS] Registered editor');
    }

    /**
     * Release the port to a newer instance and disconnect the editor so it
     * reconnects to the new owner. The process keeps running and retries binding
     * in the background, so it can take the port back if the new owner exits.
     */
    private _yield() {
        console.error('[WSS] Yield requested by a local process; releasing the port, disconnecting the editor and standing by');
        this._relinquish();
    }

    private _relinquish() {
        this._listening = false;
        this._standby = true;
        this._stats.released++;
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._editor = undefined;
        this._editorCaps = undefined;
        this._runtime = undefined;

        // requests cannot be answered once the editor is gone; fail them now instead
        // of leaving callers waiting for the request timeout.
        this._failAllPending(name => `The MCP server handed the editor bridge to another instance before '${name}' was answered. Retry once that instance has connected to the editor.`);

        const server = this._server;
        this._server = undefined;
        if (server) {
            // drop every open page too: they belong to this listener and would
            // otherwise stay connected to a server that no longer accepts anyone.
            for (const client of server.clients) {
                try {
                    client.close(1001, 'HANDOFF');
                } catch { /* already closing */ }
            }
            try {
                server.close();
            } catch { /* already closing */ }
        }

        // give the requesting instance ample time to bind before we retry.
        this._scheduleBind(this._handoffRetryDelay);
    }

    private _startPing() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._pingInterval = setInterval(() => {
            const editor = this._editor;

            // self-heal: with no live editor, stop the loop instead of pinging into the
            // void every second — a fresh editor connection restarts it.
            if (!editor || editor.readyState !== WebSocket.OPEN) {
                if (this._pingInterval) {
                    clearInterval(this._pingInterval);
                    this._pingInterval = null;
                }
                return;
            }
            this._send('ping').catch(() => { /* ping failures are non-fatal */ });
        }, PING_DELAY);
    }

    private _settle(id: number, res?: RawResult, err?: Error) {
        const pending = this._callbacks.get(id);
        if (!pending) {
            return;
        }
        this._callbacks.delete(id);
        clearTimeout(pending.timer);
        if (err) {
            pending.reject(err);
        } else {
            pending.resolve(res as RawResult);
        }
    }

    private _failPending(socket: WebSocket, message: (name: string) => string) {
        for (const [id, pending] of this._callbacks) {
            if (pending.socket === socket) {
                this._callbacks.delete(id);
                clearTimeout(pending.timer);
                pending.reject(new Error(message(pending.name)));
            }
        }
    }

    private _failAllPending(message: (name: string) => string) {
        for (const [id, pending] of this._callbacks) {
            this._callbacks.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new Error(message(pending.name)));
        }
    }

    /**
     * Whether a relayed launch page is currently attached.
     *
     * @returns True if the editor has announced a runtime peer and its socket is open.
     */
    hasRuntime(): boolean {
        return !!this._runtime && this._editor?.readyState === WebSocket.OPEN;
    }

    /**
     * Wait for a runtime (launch) peer to connect, up to a timeout.
     *
     * @param timeoutMs - Maximum time to wait in milliseconds.
     * @returns Resolves true once the runtime is connected, false on timeout.
     */
    waitForRuntime(timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        return new Promise((resolve) => {
            const check = () => {
                if (this.hasRuntime()) {
                    resolve(true);
                    return;
                }
                if (Date.now() - start >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(check, 250);
            };
            check();
        });
    }

    /**
     * The current editor-connection generation. Increments each time an editor
     * peer takes the editor slot, so callers can detect a reload → reconnect
     * (not merely "a socket is present").
     */
    get editorGeneration() {
        return this._editorGeneration;
    }

    /**
     * Wait until a NEWER editor generation than `sinceGen` is connected, up to a
     * timeout. Used by branch-changing VCS tools: capture the generation, fire
     * the op that reloads the editor, then await the reloaded page reconnecting.
     *
     * @param sinceGen - The generation captured before triggering the reload.
     * @param timeoutMs - Maximum time to wait in milliseconds.
     * @returns Resolves true once a newer editor generation is connected, false on timeout.
     */
    waitForEditor(sinceGen: number, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        return new Promise((resolve) => {
            const check = () => {
                if (this._editorGeneration > sinceGen && this._editor?.readyState === WebSocket.OPEN) {
                    resolve(true);
                    return;
                }
                if (Date.now() - start >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(check, 250);
            };
            check();
        });
    }

    /**
     * Whether this instance currently owns the editor port.
     */
    get isOwner(): boolean {
        return this._listening && !this._closed;
    }

    /**
     * Whether this instance is standing by because another instance owns the port.
     */
    get isStandby(): boolean {
        return !this._closed && this._standby;
    }

    /**
     * Whether a registered editor socket is currently connected.
     */
    get editorConnected(): boolean {
        return this._editor?.readyState === WebSocket.OPEN;
    }

    /**
     * The port this instance controls (or is trying to control).
     */
    get port(): number {
        return this._port;
    }

    /**
     * A snapshot of the bridge's observable counters.
     */
    get stats(): Readonly<WSSStats> {
        return { ...this._stats };
    }

    private _send(name: string, ...args: unknown[]) {

        // runtime:* is relayed to the launch page, everything else the editor handles; one socket
        const isRuntime = name.startsWith('runtime:');
        const socket = this._editor;
        return new Promise<RawResult>((resolve, reject) => {
            const id = this._id++;
            if (isRuntime && !this.hasRuntime()) {
                reject(new Error(`No running instance connected. Call launch_start first; the editor relays to the launched page automatically. ${LAUNCH_HINT}`));
                return;
            }
            if (!socket) {
                if (this._standby) {
                    reject(new Error(`This MCP server is on standby because another instance owns port ${this._port} (only one instance can control the editor at a time). Close the other MCP client/instance, or restart this one to request a fresh handoff, then retry.`));
                } else if (this._listening) {
                    reject(new Error(`Editor not connected. Open the PlayCanvas Editor, click the MCP button at the bottom of the toolbar and press CONNECT, then retry. ${LNA_EDITOR_HINT}`));
                } else {
                    reject(new Error(`This MCP server is not listening on port ${this._port} yet (it may be starting or shutting down). Retry in a moment; a server on standby takes over automatically once the port frees.`));
                }
                return;
            }
            if (socket.readyState !== WebSocket.OPEN) {
                reject(new Error('Editor socket not open. Reconnect (or re-run launch_start) and retry.'));
                return;
            }
            const peer = isRuntime ? 'Runtime' : 'Editor';
            const capabilities = isRuntime ? this._runtime : this._editorCaps;
            if (
                capabilities?.protocolVersion !== undefined &&
                capabilities.protocolVersion !== PROTOCOL_VERSION
            ) {
                reject(new Error(`${peer} advertises incompatible protocol ${capabilities.protocolVersion}; expected ${PROTOCOL_VERSION}. Reload it with a compatible build and reconnect.`));
                return;
            }
            if (capabilities?.methods && !capabilities.methods.has(name)) {
                if (!isRuntime && capabilities.project === null) {
                    reject(new Error(NO_PROJECT_HINT));
                    return;
                }
                reject(new Error(`${peer} does not support '${name}'. Reload it with a compatible build and reconnect.`));
                return;
            }
            const timer = setTimeout(() => {
                this._callbacks.delete(id);
                reject(new Error(`Timed out after ${DEFAULT_TIMEOUT}ms waiting for the ${isRuntime ? 'runtime' : 'editor'} to handle '${name}'. It may be busy or disconnected; verify the connection and retry, or split the request into smaller calls.`));
            }, DEFAULT_TIMEOUT);
            this._callbacks.set(id, {
                socket,
                name,
                timer,
                resolve,
                reject
            });
            try {
                socket.send(JSON.stringify({ id, name, args }));
            } catch (err) {
                clearTimeout(timer);
                this._callbacks.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    /**
     * Wrap a business payload (or error) in the unified envelope and produce an
     * MCP text response.
     *
     * @param name - The websocket method name surfaced in `meta.tool`.
     * @param raw - The raw payload from the editor, or null on transport error.
     * @param errorMessage - An overriding error message (e.g. a transport failure).
     * @returns The MCP tool response.
     */
    private _wrap(name: string, raw: RawResult | null, errorMessage?: string): CallToolResult {
        const rawError = typeof raw?.error === 'string' ? raw.error : raw?.error ? JSON.stringify(raw.error) : '';
        const message = (errorMessage || rawError).trim();
        const isError = !!message;
        const meta: Meta = {
            tool: name,
            status: isError ? 'error' : 'ok'
        };

        // the envelope invariants (tool/status/message) are owned by the server; an
        // editor-supplied meta may add fields but must not rewrite the outcome.
        if (raw?.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
            for (const [key, value] of Object.entries(raw.meta)) {
                if (key === 'tool' || key === 'status' || (key === 'message' && isError)) {
                    continue;
                }
                meta[key] = value;
            }
        }
        if (isError) {
            meta.message = message || `The editor reported an unspecified error for '${name}'. Check the editor console, reload the page and retry.`;
        }
        const envelope: Envelope = {
            // a successful response always carries data; a method with no payload
            // resolves to an empty object rather than null so "ok" never looks empty.
            data: isError ? null : (raw?.data ?? {}),
            meta
        };
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(envelope)
            }],
            ...(isError ? { isError: true } : {})
        };
    }

    /**
     * Send a raw method to a peer and return its unwrapped payload. Useful when
     * a tool needs to post-process the result before wrapping it.
     *
     * @param name - The method name (routed by prefix).
     * @param args - The method arguments.
     * @returns The raw payload from the peer.
     */
    raw(name: string, ...args: unknown[]): Promise<RawResult> {
        return this._send(name, ...args);
    }

    /**
     * Build a success MCP response in the unified envelope.
     *
     * @param name - The websocket method name surfaced in `meta.tool`.
     * @param data - The business payload.
     * @param meta - Optional extra meta fields.
     * @returns The MCP tool response.
     */
    ok(name: string, data: unknown, meta?: Record<string, unknown>): CallToolResult {
        return this._wrap(name, { data, meta });
    }

    /**
     * Build an error MCP response in the unified envelope.
     *
     * @param name - The websocket method name surfaced in `meta.tool`.
     * @param message - The actionable error message.
     * @returns The MCP tool response.
     */
    fail(name: string, message: string): CallToolResult {
        return this._wrap(name, null, message);
    }

    async call(name: string, ...args: unknown[]): Promise<CallToolResult> {
        try {
            const raw = await this._send(name, ...args);
            return this._wrap(name, raw);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return this._wrap(name, null, message);
        }
    }

    async callImage(name: string, ...args: unknown[]): Promise<CallToolResult> {
        try {
            const raw = await this._send(name, ...args);
            if (raw.error) {
                return this._wrap(name, raw);
            }
            if (!raw.data || typeof raw.data !== 'string') {
                return this._wrap(name, null, 'No image data received. Ensure a scene is loaded and the viewport has rendered at least one frame, then retry.');
            }
            const mimeType = (raw.meta?.mimeType as string) || 'image/webp';

            // image tools return the image block plus a parallel text block with the same
            // meta, so "all metadata lives in meta" holds for every tool (issue #11). the
            // text companion still obeys the envelope: a successful response carries data,
            // and the editor cannot rewrite the server-owned tool/status/message fields.
            const meta: Meta = { tool: name, status: 'ok' };
            for (const [key, value] of Object.entries(raw.meta || {})) {
                if (key === 'tool' || key === 'status' || key === 'message') {
                    continue;
                }
                meta[key] = value;
            }
            return {
                content: [
                    {
                        type: 'image',
                        data: raw.data,
                        mimeType
                    },
                    {
                        type: 'text',
                        text: JSON.stringify({ data: { mimeType }, meta })
                    }
                ]
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return this._wrap(name, null, message);
        }
    }

    close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._listening = false;
        this._standby = false;
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        if (this._bindTimer) {
            clearTimeout(this._bindTimer);
            this._bindTimer = null;
        }
        this._failAllPending(name => `The MCP server shut down before '${name}' was answered. Restart the MCP client and retry.`);
        this._editor = undefined;
        this._editorCaps = undefined;
        this._runtime = undefined;
        const server = this._server;
        this._server = undefined;
        if (server) {
            // terminate instead of close: waiting for peers to acknowledge would leave
            // the listening socket (and the test process) alive indefinitely.
            for (const client of server.clients) {
                try {
                    client.terminate();
                } catch { /* already closed */ }
            }
            try {
                server.close();
            } catch { /* already closing */ }
        }
        console.error('[WSS] Closed');
    }
}

export { WSS, LAUNCH_HINT, isAllowedOrigin };
