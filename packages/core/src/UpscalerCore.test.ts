import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice(options: { pipeline?: () => Promise<GPUComputePipeline> } = {}) {
    const writes: Uint32Array[] = [];
    let loseDevice!: (info: GPUDeviceLostInfo) => void;
    const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
        loseDevice = resolve;
    });
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
        lost,
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: options.pipeline ?? (async () => resource()),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: resource,
        createCommandEncoder: vi.fn(() => encoder),
    };
    return {
        device,
        writes,
        encoder,
        lost,
        lose: () => loseDevice({} as GPUDeviceLostInfo),
        gpu: (label: string) => resource({ label }) as unknown as GPUTexture,
    };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];

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

describe('UpscalerCore split-frame guard rails', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function temporal() {
        const mock = mockDevice();
        const core = new UpscalerCore({ device: mock.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };
        const depth = mock.gpu('depth');
        const velocity = mock.gpu('velocity');
        const color = mock.gpu('color');
        return { ...mock, core, camera, depth, velocity, color, guides: { depth, velocity } };
    }

    it('rejects a second guides stage once the frame is split', async () => {
        const { core, camera, guides, color } = await temporal();

        core.dispatchGuides(guides, camera);
        expect(core.guidesPending).toBe(true);
        expect(() => core.dispatchGuides(guides, camera)).toThrow(/@pmndrs\/upscaler/);
        expect(() => core.dispatchGuides(guides, camera)).toThrow(/already ran the guides stage for this frame/);
        expect(() => core.dispatchGuides(guides, camera)).toThrow(/dispatchUpscale/);

        core.dispatchUpscale({ color }, camera);
        // The next frame's guides stage is allowed again.
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchGuides(guides, camera)).not.toThrow();
    });

    it('rejects a second encodeGuides and the cross-mixed dispatchGuides', async () => {
        const { core, encoder, camera, guides } = await temporal();

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, guides, camera);
        expect(() => core.encodeGuides(encoder as unknown as GPUCommandEncoder, guides, camera))
            .toThrow(/already ran the guides stage for this frame/);
        expect(() => core.dispatchGuides(guides, camera)).toThrow(/already ran the guides stage for this frame/);
    });

    it('rejects the late stage before the guides stage ran', async () => {
        const { core, encoder, camera, color } = await temporal();

        expect(() => core.dispatchUpscale({ color }, camera))
            .toThrow(/call dispatchGuides\(\) \(or encodeGuides\(\)\) before dispatchUpscale\(\)/);
        expect(() => core.dispatchUpscale({ color }, camera)).toThrow(/@pmndrs\/upscaler/);
        expect(() => core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color }, camera))
            .toThrow(/call dispatchGuides\(\) \(or encodeGuides\(\)\) before dispatchUpscale\(\)/);
        // The failed calls left the frame unstarted, not half-open.
        expect(core.guidesPending).toBe(false);
    });

    it('rejects the monolithic dispatch while a split frame is in flight', async () => {
        const { core, encoder, camera, guides, color, depth, velocity, device } = await temporal();

        core.dispatchGuides(guides, camera);
        expect(() => core.dispatch({ color, depth, velocity }, camera))
            .toThrow(/a split frame is in flight/);
        expect(() => core.dispatch({ color, depth, velocity }, camera))
            .toThrow(/dispatchGuides\(\) already ran the guides stage this frame/);
        expect(() => core.encode(encoder as unknown as GPUCommandEncoder, { color, depth, velocity }, camera))
            .toThrow(/a split frame is in flight/);
        expect(device.queue.submit).toHaveBeenCalledTimes(1);

        // Finishing the split frame is still the way out.
        core.dispatchUpscale({ color }, camera);
        expect(core.guidesPending).toBe(false);
    });

    it('keeps the normal split and monolithic paths unchanged', async () => {
        const { core, camera, guides, color, depth, velocity, device, writes } = await temporal();

        // Normal split frame: guides → late, two submits, one frame's bookkeeping.
        expect(() => core.dispatchGuides(guides, camera)).not.toThrow();
        expect(core.guidesPending).toBe(true);
        expect(lastFlags(writes) & FLAG_RESET).toBe(FLAG_RESET);
        expect(() => core.dispatchUpscale({ color }, camera)).not.toThrow();
        expect(core.guidesPending).toBe(false);
        expect(device.queue.submit).toHaveBeenCalledTimes(2);

        // The next frame no longer carries the pending reset.
        core.dispatchGuides(guides, camera);
        expect(lastFlags(writes) & FLAG_RESET).toBe(0);
        core.dispatchUpscale({ color }, camera);

        // Monolithic dispatch after a finished split frame.
        expect(() => core.dispatch({ color, depth, velocity }, camera)).not.toThrow();
        expect(core.guidesPending).toBe(false);
        expect(device.queue.submit).toHaveBeenCalledTimes(5);

        // The split frame advances each ping-pong exactly once: depth flips at
        // the guides stage (resolve through `_latestDepthWrite`), history at
        // the late stage.
        const historyBefore = core.guides.history;
        const depthBefore = core.guides.dilatedDepth;
        core.dispatchGuides(guides, camera);
        expect(core.guides.dilatedDepth).not.toBe(depthBefore);
        expect(core.guides.previousDepth).toBe(depthBefore);
        expect(core.guides.history).toBe(historyBefore);
        core.dispatchUpscale({ color }, camera);
        expect(core.guides.history).not.toBe(historyBefore);
        expect(core.guides.dilatedDepth).not.toBe(depthBefore);
    });

    it('rejects prepare() and any dispatch after device loss', async () => {
        const { core, camera, color, depth, velocity, device, lose } = await temporal();

        lose();
        await Promise.resolve();
        await expect(core.prepare()).rejects.toThrow('@pmndrs/upscaler: GPU device lost.');
        expect(core.isReady).toBe(false);
        expect(() => core.dispatch({ color, depth, velocity }, camera)).toThrow(/GPU device lost/);
        // No command was encoded against the dead device.
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
    });

    it('settles a queued pipeline compile instead of hanging when the device is lost', async () => {
        // Never settle the compile: the loss handler alone must reject it.
        const mock = mockDevice({ pipeline: () => new Promise<GPUComputePipeline>(() => {}) });
        const core = new UpscalerCore({ device: mock.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'bilinear' });
        const preparation = core.prepare();

        mock.lose();
        await expect(preparation).rejects.toThrow('@pmndrs/upscaler: GPU device lost.');
        await expect(core.prepare()).rejects.toThrow('@pmndrs/upscaler: GPU device lost.');
    });

    it('clears a split frame on device loss so guidesPending cannot strand a frame', async () => {
        const { core, camera, guides, color, lose } = await temporal();

        core.dispatchGuides(guides, camera);
        expect(core.guidesPending).toBe(true);
        lose();
        await Promise.resolve();
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchUpscale({ color }, camera)).toThrow(/GPU device lost/);
    });
});
