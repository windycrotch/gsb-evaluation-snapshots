/**
 * Controllable in-memory fetch mock for loader lifecycle tests.
 *
 * - Servers are registered per URL with a chunk list, so test code decides how
 *   many bytes each reader.read() returns (forces multi-slice parsing).
 * - The response body is a REAL ReadableStream, so Node's Response keeps it
 *   intact and reader.read() yields the exact chunks registered.
 * - Aborting the request aborts the underlying stream and makes the pending /
 *   next read reject with an AbortError, exactly like the browser.
 * - A failing URL returns HTTP 500.
 */

export interface MockServer {
    url: string;
    chunks: Uint8Array[];
    failStatus?: number;
    /** Resolved once the loader has started reading this body */
    whenStarted(): Promise<void>;
    /** Resolved after n read() calls have been delivered */
    whenReads(n: number): Promise<void>;
    /** Number of read() calls delivered so far */
    reads(): number;
}

interface InternalServer extends MockServer {
    _reads: number;
    _startedResolvers: Function[];
    _readResolvers: Map<number, Function>;
}

export function installFetchMock(): Map<string, MockServer> {
    const servers = new Map<string, MockServer>();
    (globalThis as any).fetch = (url: string, init: RequestInit) => mockFetch(servers, url, init);
    return servers;
}

function mockFetch(servers: Map<string, any>, url: string, init: RequestInit): Promise<Response> {
    const server: InternalServer = servers.get(url);
    if (!server) throw new Error(`unmocked fetch url: ${url}`);
    if (server.failStatus) {
        return Promise.resolve(new Response(null, { status: server.failStatus }));
    }

    const signal: AbortSignal | undefined = init?.signal;
    const chunks: Uint8Array[] = server.chunks.map(c => c.slice());
    server._reads = 0;
    server._startedResolvers = [];
    server._readResolvers = new Map();
    server.whenStarted = () => new Promise<void>(r => server._startedResolvers.push(r));
    server.whenReads = (n: number) =>
        new Promise<void>(r => {
            if (server._reads >= n) return r();
            const tick = () => (server._reads >= n ? r() : setTimeout(tick, 2));
            tick();
        });
    server.reads = () => server._reads;

    let inFlight: { reject: (e: any) => void } | null = null;

    const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const onAbort = () => {
                try {
                    controller.error(abortError());
                } catch {
                    /* already closed/errored */
                }
                // Reject a read() already waiting on the next network chunk.
                inFlight?.reject(abortError());
                inFlight = null;
            };
            if (signal?.aborted) {
                queueMicrotask(onAbort);
            } else {
                signal?.addEventListener('abort', onAbort, { once: true });
            }
        },
        pull(controller) {
            if (signal?.aborted) {
                controller.error(abortError());
                return;
            }
            // Macrotask delivery mimics a real network: an abort scheduled
            // between reads is observed before the next chunk is enqueued.
            return new Promise<void>((resolve, reject) => {
                inFlight = { reject };
                setTimeout(() => {
                    inFlight = null;
                    if (signal?.aborted) {
                        controller.error(abortError());
                        resolve();
                        return;
                    }
                    if (server._reads === 0) {
                        server._startedResolvers.forEach(r => r());
                    }
                    if (server._reads >= chunks.length) {
                        controller.close();
                        resolve();
                        return;
                    }
                    const idx = server._reads++;
                    controller.enqueue(chunks[idx]);
                    server._readResolvers.get(idx)?.();
                    resolve();
                }, 0);
            });
        },
    });

    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
    return Promise.resolve(
        new Response(stream, {
            status: 200,
            headers: { 'content-length': String(totalBytes) },
        }),
    );
}

/* ------------------------------------------------------------------ */
/* Data builders                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a raw .splat file: 32 bytes per splat, xyz as the first 3 float32.
 * Coordinates are spread so each splat gets a distinct, predictable position.
 */
export function buildSplatFile(count: number, opts: { xStep?: number; yStep?: number; zStep?: number } = {}): Uint8Array {
    const xStep = opts.xStep ?? 1;
    const yStep = opts.yStep ?? 10;
    const zStep = opts.zStep ?? 100;
    const data = new Uint8Array(count * 32);
    const f32 = new Float32Array(data.buffer);
    for (let i = 0; i < count; i++) {
        f32[i * 8 + 0] = i * xStep; // x
        f32[i * 8 + 1] = i * yStep; // y
        f32[i * 8 + 2] = i * zStep; // z
    }
    return data;
}

/**
 * Split a byte array into fixed-size chunks (the last one may be shorter).
 * Deliberately allows non-32-byte-aligned chunks to exercise the
 * "less than one splat, buffer and continue" branch of the loaders.
 */
export function chunkBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < data.byteLength; off += chunkSize) {
        chunks.push(data.subarray(off, Math.min(off + chunkSize, data.byteLength)).slice());
    }
    return chunks;
}

/**
 * Build a binary little-endian 3DGS .ply file (shDegree 0: the base props).
 * 17 float32 properties per vertex -> 68 byte rows.
 */
export function buildPlyFile(count: number, opts: { xStep?: number; yStep?: number; zStep?: number } = {}): Uint8Array {
    const xStep = opts.xStep ?? 1;
    const yStep = opts.yStep ?? 10;
    const zStep = opts.zStep ?? 100;

    const props = [
        'x',
        'y',
        'z',
        'nx',
        'ny',
        'nz',
        'f_dc_0',
        'f_dc_1',
        'f_dc_2',
        'opacity',
        'scale_0',
        'scale_1',
        'scale_2',
        'rot_0',
        'rot_1',
        'rot_2',
        'rot_3',
    ];
    const headerLines = [
        'ply',
        'format binary_little_endian 1.0',
        `element vertex ${count}`,
        ...props.map(p => `property float ${p}`),
        'end_header',
        '',
    ];
    const header = new TextEncoder().encode(headerLines.join('\n'));

    const rowLength = props.length * 4;
    const body = new Uint8Array(count * rowLength);
    const f32 = new Float32Array(body.buffer);
    for (let i = 0; i < count; i++) {
        const b = (i * rowLength) / 4;
        f32[b + props.indexOf('x')] = i * xStep;
        f32[b + props.indexOf('y')] = i * yStep;
        f32[b + props.indexOf('z')] = i * zStep;
        f32[b + props.indexOf('rot_0')] = 1; // unit quaternion (1,0,0,0)
        f32[b + props.indexOf('rot_1')] = 0;
        f32[b + props.indexOf('rot_2')] = 0;
        f32[b + props.indexOf('rot_3')] = 0;
    }

    const out = new Uint8Array(header.byteLength + body.byteLength);
    out.set(header, 0);
    out.set(body, header.byteLength);
    return out;
}
