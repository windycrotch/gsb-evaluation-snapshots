/**
 * Browser-demo data builders for the loader lifecycle page.
 * Mirrors test/mockFetch.ts but produces real blob URLs so the production
 * loaders fetch exactly as they would over the network.
 */

/** Build a raw .splat file: 32 bytes per splat, xyz as the first 3 float32. */
export function buildSplatFile(count: number, opts: { xStep?: number; yStep?: number; zStep?: number } = {}): Uint8Array {
    const xStep = opts.xStep ?? 1;
    const yStep = opts.yStep ?? 10;
    const zStep = opts.zStep ?? 100;
    const data = new Uint8Array(count * 32);
    const f32 = new Float32Array(data.buffer);
    for (let i = 0; i < count; i++) {
        f32[i * 8 + 0] = i * xStep;
        f32[i * 8 + 1] = i * yStep;
        f32[i * 8 + 2] = i * zStep;
    }
    return data;
}

/** Split bytes into chunks so the fetch stream delivers several read() slices. */
export function chunkBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < data.byteLength; off += chunkSize) {
        chunks.push(data.subarray(off, Math.min(off + chunkSize, data.byteLength)).slice());
    }
    return chunks;
}

/** Build a binary little-endian 3DGS .ply (17 float32 props, 68 byte rows). */
export function buildPlyFile(count: number, opts: { xStep?: number; yStep?: number; zStep?: number } = {}): Uint8Array {
    const xStep = opts.xStep ?? 1;
    const yStep = opts.yStep ?? 10;
    const zStep = opts.zStep ?? 100;

    const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const headerLines = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...props.map(p => `property float ${p}`), 'end_header', ''];
    const header = new TextEncoder().encode(headerLines.join('\n'));

    const rowLength = props.length * 4;
    const body = new Uint8Array(count * rowLength);
    const f32 = new Float32Array(body.buffer);
    for (let i = 0; i < count; i++) {
        const b = (i * rowLength) / 4;
        f32[b + props.indexOf('x')] = i * xStep;
        f32[b + props.indexOf('y')] = i * yStep;
        f32[b + props.indexOf('z')] = i * zStep;
        f32[b + props.indexOf('rot_0')] = 1;
    }

    const out = new Uint8Array(header.byteLength + body.byteLength);
    out.set(header, 0);
    out.set(body, header.byteLength);
    return out;
}

/**
 * A fetch wrapper that serves registered bytes in fixed-size chunks and can be
 * switched to a failing URL, while still creating a genuine network-like
 * ReadableStream the production reader consumes.
 */
export class DemoFetchServer {
    private routes = new Map<string, { chunks: Uint8Array[]; failStatus?: number }>();
    private originalFetch: typeof fetch;

    install() {
        this.originalFetch = globalThis.fetch;
        globalThis.fetch = (input: any, init?: RequestInit) => this.handle(input, init);
    }

    restore() {
        globalThis.fetch = this.originalFetch;
        this.routes.clear();
    }

    register(url: string, bytes: Uint8Array, chunkSize: number, failStatus?: number) {
        this.routes.set(url, { chunks: chunkBytes(bytes, chunkSize), failStatus });
    }

    private async handle(input: any, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : input.url;
        const route = this.routes.get(url);
        if (!route) return this.originalFetch(input, init);
        if (route.failStatus) return new Response(null, { status: route.failStatus });

        const signal = init?.signal;
        const chunks = route.chunks;
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                return new Promise<void>(resolve => {
                    setTimeout(() => {
                        if (signal?.aborted) {
                            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                            resolve();
                            return;
                        }
                        if (index >= chunks.length) {
                            controller.close();
                            resolve();
                            return;
                        }
                        controller.enqueue(chunks[index++]);
                        resolve();
                    }, 30); // slow enough to click "cancel" mid-flight
                });
            },
        });
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        return new Response(stream, { status: 200, headers: { 'content-length': String(total) } });
    }
}
