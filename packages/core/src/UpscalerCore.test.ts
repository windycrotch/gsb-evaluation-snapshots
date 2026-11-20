import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
    // Compute-pass labels per submitted command buffer, in encode order.
    const submits: string[][] = [];
    let pendingLabels: string[] = [];
    const resource = (descriptor: { size?: number; label?: string } = {}) => ({
        label: descriptor.label,
        width: 16,
        height: 16,
        sampleCount: 1,
        format: 'rgba16float',
        getBindGroupLayout: () => ({}),
        createView: () => ({}),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4),
        unmap: () => {},
        destroy: vi.fn(),
    });
    const encoder = {
        beginComputePass: (descriptor: { label?: string } = {}) => {
            pendingLabels.push(descriptor.label ?? '');
            return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(() => {
                submits.push(pendingLabels);
                pendingLabels = [];
            }),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: resource,
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, encoder, submits, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];
// The frame index staged into a constants upload (ConstantsBuffer u32[21]).
const frameIndexOf = (write: Uint32Array) => write[21];

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates the published set through the allocator and returns its handles', async () => {
        const { device } = mockDevice();
        const allocated: CoreTextureDescriptor[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            allocated.push(descriptor);
            return { gpu: device.createTexture() as unknown as GPUTexture, handle: { name: descriptor.label }, destroy: vi.fn() };
        };
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, allocateTexture });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        expect(core.output).toEqual({ name: 'upscale-output' });
        expect(core.guides.dilatedMotion).toEqual({ name: 'upscale-dilated-motion' });
        expect(core.guides.history).toEqual({ name: 'upscale-history-0' });
        const byLabel = new Map(allocated.map((d) => [d.label, d]));
        expect(byLabel.get('upscale-output')).toMatchObject({ width: 64, height: 32, format: 'rgba16float' });
        expect(byLabel.get('upscale-dilated-depth-0')).toMatchObject({ width: 32, height: 16, format: 'r32float' });
        expect(byLabel.get('upscale-masks')).toMatchObject({ format: 'rgba8unorm' });
    });

    it('defaults to raw GPUTexture handles', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.output).toMatchObject({ label: 'upscale-output' });
    });

    it('stages camera facts from plain frame data', async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET))
            .toBe(FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET);

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET)).toBe(0);
    });

    it("reads the projection type from a denoiser-style camera's matrix", async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        const perspective = new Float32Array(16);
        perspective[11] = -1; // w = −z
        const orthographic = new Float32Array(16);
        orthographic[15] = 1;

        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: perspective });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: orthographic });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(0);
        expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100 })).toThrow(/perspective/);
    });

    it('encodes into a host encoder without submitting', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
    });

    it('advances jitter only on the temporal path with jitter on', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        expect(core.beginFrame()).toBe(core.jitter);
        expect(core.jitterPhase).toBe(1);
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.beginFrame()).toBeNull();
    });
});

describe('UpscalerCore split-frame lifecycle', () => {
    const camera = { near: 0.1, far: 100, perspective: true };

    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function configured() {
        const mocks = mockDevice();
        const core = new UpscalerCore({ device: mocks.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const guides = { depth: mocks.gpu('depth'), velocity: mocks.gpu('velocity') };
        const full = { ...guides, color: mocks.gpu('color') };
        return { core, guides, full, ...mocks };
    }

    it('encodes the same passes split as monolithic, across two submits', async () => {
        const monolithic = await configured();
        monolithic.core.dispatch(monolithic.full, camera);
        expect(monolithic.submits).toEqual([[
            'upscale-reconstruct', 'upscale-depth-clip', 'upscale-exposure',
            'upscale-shading-change', 'upscale-accumulate', 'upscale-rcas',
        ]]);

        const split = await configured();
        split.core.dispatchGuides(split.guides, camera);
        split.core.dispatchUpscale({ color: split.gpu('color') }, camera);
        expect(split.submits).toEqual([
            ['upscale-reconstruct', 'upscale-depth-clip'],
            ['upscale-exposure', 'upscale-shading-change', 'upscale-accumulate', 'upscale-rcas'],
        ]);
        // The split frame is the monolithic one, cut at the guides seam.
        expect(split.submits.flat()).toEqual(monolithic.submits.flat());
        // Same staged constants (no color-dependent inputs here, so the
        // guides-stage and late-stage uploads match the monolithic one).
        expect(split.writes.length).toBe(2);
        expect(split.writes[0]).toEqual(monolithic.writes[0]);
        expect(split.writes[1]).toEqual(monolithic.writes[0]);
    });

    it('aborts a split frame: the next frame starts fresh with reset history', async () => {
        const { core, guides, full, writes } = await configured();

        // Commit two frames so history exists and the reset flag has cleared,
        // then start a split frame.
        core.dispatch(full, camera);
        core.dispatch(full, camera);
        expect(lastFlags(writes) & FLAG_RESET).toBe(0);
        core.dispatchGuides(guides, camera);
        expect(core.guidesPending).toBe(true);
        const stagedAborted = writes.length - 1;

        core.abortFrame();
        expect(core.guidesPending).toBe(false);

        // A new split frame starts without throwing, and finishes.
        core.dispatchGuides(guides, camera);
        core.dispatchUpscale({ color: full.color }, camera);
        expect(core.guidesPending).toBe(false);

        // The aborted frame's staged state must not leak into the new frame:
        // history was reset, and its frame index was retired, not reused.
        expect(writes[stagedAborted][20] & FLAG_RESET).toBe(0);
        expect(writes[writes.length - 2][20] & FLAG_RESET).toBe(FLAG_RESET);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
        expect(frameIndexOf(writes[writes.length - 2])).toBe(frameIndexOf(writes[stagedAborted]) + 1);
    });

    it('resets the jitter phase on abort, like resetHistory()', async () => {
        const { core, guides } = await configured();
        core.beginFrame();
        core.beginFrame();
        expect(core.jitterPhase).toBe(2);
        core.dispatchGuides(guides, camera);
        core.abortFrame();
        core.beginFrame();
        expect(core.jitterPhase).toBe(1);
    });

    it('invalidates an in-flight split frame on configure', async () => {
        const { core, guides, gpu } = await configured();
        core.dispatchGuides(guides, camera);
        expect(core.guidesPending).toBe(true);

        core.configure({ displayWidth: 128, displayHeight: 64, customUpscaleRatio: 2 });
        expect(core.guidesPending).toBe(false);

        // The abandoned frame can no longer be finished…
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera)).toThrow(/dispatchGuides\(\) first/);
        // …and a fresh frame runs on the new configuration.
        core.dispatchGuides(guides, camera);
        core.dispatchUpscale({ color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
    });

    it('still rejects a duplicate guides stage and a late stage with no guides', async () => {
        const { core, guides, full, gpu } = await configured();
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera)).toThrow(/dispatchGuides\(\) first/);

        core.dispatchGuides(guides, camera);
        expect(() => core.dispatchGuides(guides, camera)).toThrow(/already ran this frame/);
        expect(() => core.dispatch(full, camera)).toThrow(/split frame is in flight/);

        // After an abort the late stage is rejected again — a new frame must
        // start from the guides stage.
        core.abortFrame();
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera)).toThrow(/dispatchGuides\(\) first/);
    });

    it('is a no-op with no split frame in flight', async () => {
        const { core, full, writes } = await configured();
        expect(() => core.abortFrame()).not.toThrow();
        core.dispatch(full, camera);
        expect(() => core.abortFrame()).not.toThrow();
        // The committed frame's history is untouched by the no-op abort.
        core.dispatch(full, camera);
        expect(lastFlags(writes) & FLAG_RESET).toBe(0);
    });

    it('holds no frame-scoped GPU resources: abort neither frees nor allocates the working set', async () => {
        const mocks = mockDevice();
        const destroyed: string[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => ({
            gpu: mocks.device.createTexture() as unknown as GPUTexture,
            handle: { name: descriptor.label },
            destroy: vi.fn(() => destroyed.push(descriptor.label)),
        });
        const core = new UpscalerCore({
            device: mocks.device as unknown as GPUDevice,
            allocateTexture,
        });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const guides = { depth: mocks.gpu('depth'), velocity: mocks.gpu('velocity') };
        const created = () => (mocks.device.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;

        core.dispatchGuides(guides, camera);
        const beforeAbort = created();
        core.abortFrame();
        // Nothing the guides stage submitted is a per-frame allocation, so
        // there is nothing to release and nothing to re-create: the next
        // frame reuses the same working set.
        expect(created()).toBe(beforeAbort);
        expect(destroyed).toEqual([]);

        core.dispatchGuides(guides, camera);
        core.dispatchUpscale({ color: mocks.gpu('color') }, camera);
        expect(created()).toBe(beforeAbort);
        expect(destroyed).toEqual([]);
    });
});
