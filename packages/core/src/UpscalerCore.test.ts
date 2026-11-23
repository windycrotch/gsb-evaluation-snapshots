import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
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
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
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
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: resource,
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, encoder, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];
// The frame index staged into every constants upload (ConstantsBuffer u32[21]).
const frameIndices = (writes: Uint32Array[]) => writes.map((data) => data[21]);

const CAMERA = { near: 0.1, far: 100, perspective: true };
const frameInputs = (gpu: (label: string) => GPUTexture) => ({
    color: gpu('color'),
    depth: gpu('depth'),
    velocity: gpu('velocity'),
});
const guideInputs = (gpu: (label: string) => GPUTexture) => ({
    depth: gpu('depth'),
    velocity: gpu('velocity'),
});

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
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function configured() {
        const mock = mockDevice();
        const core = new UpscalerCore({ device: mock.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        return { core, ...mock };
    }

    it('runs a split frame under one frame index, guides resolving to the written halves', async () => {
        const { core, writes, gpu } = await configured();

        // A completed monolithic frame first, so the split frame's halves are
        // distinguishable from the initial allocation.
        core.dispatch(frameInputs(gpu), CAMERA);
        expect(core.guides.dilatedDepth).toMatchObject({ label: 'upscale-dilated-depth-0' });
        expect(core.guides.history).toMatchObject({ label: 'upscale-history-1' });
        expect(core.guides.exposure).toMatchObject({ label: 'upscale-exposure-1' });

        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);
        // Between the two stages the geometry guide already points at the
        // half this frame wrote; the late products still point at last frame's.
        expect(core.guides.dilatedDepth).toMatchObject({ label: 'upscale-dilated-depth-1' });
        expect(core.guides.previousDepth).toMatchObject({ label: 'upscale-dilated-depth-0' });
        expect(core.guides.history).toMatchObject({ label: 'upscale-history-1' });
        expect(core.guides.exposure).toMatchObject({ label: 'upscale-exposure-1' });

        core.dispatchUpscale(frameInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(false);
        // The frame-end index flips must not move the getters off this frame's writes.
        expect(core.guides.dilatedDepth).toMatchObject({ label: 'upscale-dilated-depth-1' });
        expect(core.guides.history).toMatchObject({ label: 'upscale-history-0' });
        expect(core.guides.exposure).toMatchObject({ label: 'upscale-exposure-0' });

        // One frame index for the whole split frame: 0 (monolithic), then 1 twice.
        expect(frameIndices(writes)).toEqual([0, 1, 1]);
    });

    it('rejects a mixed frame and retires a dropped split frame at the next beginFrame', async () => {
        const { core, writes, gpu } = await configured();
        core.dispatch(frameInputs(gpu), CAMERA);

        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);

        // Mixing the monolithic form (or a second guides stage) into a split
        // frame is rejected, non-destructively: the frame can still be finished.
        expect(() => core.dispatch(frameInputs(gpu), CAMERA)).toThrow(/split frame/);
        expect(() => core.dispatchGuides(guideInputs(gpu), CAMERA)).toThrow(/already ran/);
        expect(core.guidesPending).toBe(true);
        core.dispatchUpscale(frameInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(false);

        // A split frame whose late stage never comes is retired at the next
        // beginFrame instead of leaking its half-frame state into the new frame.
        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);
        core.beginFrame();
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchUpscale(frameInputs(gpu), CAMERA)).toThrow(/dispatchGuides/);

        // The next normal frame recovers, starting from a clean history.
        core.dispatch(frameInputs(gpu), CAMERA);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
        core.dispatch(frameInputs(gpu), CAMERA);
        expect(lastFlags(writes) & FLAG_RESET).toBe(0);

        // The dropped frame never completed, so it never consumed a frame
        // index: 0, 1 (split), 2 (dropped guides), 2 (recovery), 3.
        expect(frameIndices(writes)).toEqual([0, 1, 1, 2, 2, 3]);
    });

    it('discards an in-flight split frame on resetHistory', async () => {
        const { core, writes, gpu } = await configured();
        core.dispatch(frameInputs(gpu), CAMERA);

        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);
        core.resetHistory();
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchUpscale(frameInputs(gpu), CAMERA)).toThrow(/dispatchGuides/);

        core.dispatch(frameInputs(gpu), CAMERA);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
    });

    it('discards an in-flight split frame on configure and restarts clean', async () => {
        const { core, writes, gpu } = await configured();
        core.dispatch(frameInputs(gpu), CAMERA);

        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);
        core.configure({ displayWidth: 128, displayHeight: 64, customUpscaleRatio: 2 });
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchUpscale(frameInputs(gpu), CAMERA)).toThrow(/dispatchGuides/);

        // The next split frame runs against the fresh working set, from a
        // reset history.
        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);
        core.dispatchUpscale(frameInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(false);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
        expect(core.guides.dilatedMotion).toMatchObject({ label: 'upscale-dilated-motion' });
    });

    it('shares frame index, jitter and ping-pong state across monolithic and split frames', async () => {
        const { core, writes, gpu } = await configured();

        core.beginFrame();
        expect(core.jitterPhase).toBe(1);
        core.dispatch(frameInputs(gpu), CAMERA);
        core.beginFrame();
        expect(core.jitterPhase).toBe(2);
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        core.dispatchUpscale(frameInputs(gpu), CAMERA);
        core.beginFrame();
        expect(core.jitterPhase).toBe(3);
        core.dispatch(frameInputs(gpu), CAMERA);

        // Exactly one frame-index step per frame, whichever form submitted it.
        expect(frameIndices(writes)).toEqual([0, 1, 1, 2]);
        // Exactly one ping-pong flip per frame: after an odd number of frames
        // the depth guide is back on the first half.
        expect(core.guides.dilatedDepth).toMatchObject({ label: 'upscale-dilated-depth-0' });
        expect(core.guides.history).toMatchObject({ label: 'upscale-history-1' });
        // Only the first frame after configure carries the reset.
        expect(writes[0][20] & FLAG_RESET).toBe(FLAG_RESET);
        expect(writes[1][20] & FLAG_RESET).toBe(0);
        expect(writes[3][20] & FLAG_RESET).toBe(0);
    });

    it('disposes a pending split frame and readies again on reconfigure', async () => {
        const { core, writes, gpu } = await configured();
        core.beginFrame();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);

        core.dispose();
        expect(core.guidesPending).toBe(false);
        expect(core.isReady).toBe(false);
        expect(() => core.guides).toThrow(/guides/);

        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        expect(core.isReady).toBe(true);
        core.dispatch(frameInputs(gpu), CAMERA);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
        expect(core.guides.dilatedMotion).toMatchObject({ label: 'upscale-dilated-motion' });
    });

    it('cancels in-flight preparation on dispose and recompiles on reconfigure', async () => {
        const { device, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        // Disposed before the queued compiles land; nothing may survive.
        core.dispose();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        expect(core.isReady).toBe(true);
        core.dispatch(frameInputs(gpu), CAMERA);
    });

    it('clears the in-flight split frame and pending work when the device is lost', async () => {
        const { device, gpu } = mockDevice();
        let resolveLost!: (info: GPUDeviceLostInfo) => void;
        device.lost = new Promise<GPUDeviceLostInfo>((resolve) => {
            resolveLost = resolve;
        });
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        core.dispatchGuides(guideInputs(gpu), CAMERA);
        expect(core.guidesPending).toBe(true);

        resolveLost({ reason: 'unknown', message: 'gone' } as GPUDeviceLostInfo);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(core.guidesPending).toBe(false);
        expect(core.isReady).toBe(false);
        await expect(core.prepare()).rejects.toThrow(/device lost/);
        expect(() => core.dispatch(frameInputs(gpu), CAMERA)).toThrow(/device lost/i);
    });
});
