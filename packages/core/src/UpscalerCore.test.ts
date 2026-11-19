import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { UpscalerNotReadyError } from './initializationError';
import { SplitFrameError } from './splitFrameError';
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

//* Split-frame lifecycle: the dispatchGuides → dispatchUpscale contract and
// every way a driver can break it. The mock never runs GPU work, so the
// assertions are purely about the core's bookkeeping and failure modes.
describe('UpscalerCore split-frame lifecycle', () => {
    // Private frame counters, read via an untyped view so tests can prove an
    // ordering error left them exactly where they were.
    interface CoreInternals {
        _frameIndex: number;
        _historyIndex: number;
        _depthIndex: number;
        _pendingReset: boolean;
        _pendingGuides: unknown;
        _stagedGuides: unknown;
        _initialized: boolean;
    }
    const internals = (core: UpscalerCore): CoreInternals =>
        core as unknown as CoreInternals;

    const camera = (overrides: Partial<{ near: number; far: number; perspective: boolean; reversedDepth: boolean }> = {}) => ({
        near: 0.1,
        far: 100,
        perspective: true,
        ...overrides,
    });

    async function configuredCore(path: 'temporal' | 'guides' = 'temporal') {
        const mocks = mockDevice();
        const core = new UpscalerCore({ device: mocks.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, path });
        await core.prepare();
        return { core, ...mocks };
    }

    // Copies the frame counters into a detached object: internals() returns
    // the live instance, so a plain reference would read post-call values.
    function snapshotState(core: UpscalerCore): Readonly<CoreInternals> {
        const live = internals(core);
        return { ...live };
    }

    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('runs a complete split frame: pending between stages, clear and indices flipped after', async () => {
        const { core, device, gpu } = await configuredCore();
        const cam = camera();
        const before = snapshotState(core);

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        const mid = snapshotState(core);
        expect(core.guidesPending).toBe(true);
        // The early stage alone must not end the frame.
        expect(mid._frameIndex).toBe(before._frameIndex);
        expect(mid._historyIndex).toBe(before._historyIndex);
        expect(mid._stagedGuides).toBeNull();
        expect(mid._pendingGuides).not.toBeNull();

        core.dispatchUpscale({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        const after = snapshotState(core);
        expect(core.guidesPending).toBe(false);
        expect(after._frameIndex).toBe(before._frameIndex + 1);
        expect(after._historyIndex).toBe(1 - before._historyIndex);
        expect(after._depthIndex).toBe(1 - before._depthIndex);
        expect(after._pendingGuides).toBeNull();
        expect(after._pendingReset).toBe(false);
        // Two stages, two submits.
        expect(device.queue.submit).toHaveBeenCalledTimes(2);
    });

    it('keeps the guides-only path pending-free: dispatchGuides ends the whole frame', async () => {
        const { core, device, gpu } = await configuredCore('guides');
        const before = snapshotState(core);

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        const after = snapshotState(core);
        expect(core.guidesPending).toBe(false);
        expect(after._frameIndex).toBe(before._frameIndex + 1);
        expect(after._depthIndex).toBe(1 - before._depthIndex);
        expect(after._pendingGuides).toBeNull();
        expect(after._stagedGuides).toBeNull();
        expect(device.queue.submit).toHaveBeenCalledTimes(1);
        // No late stage exists on this path — the path guard explains why.
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera())).toThrow(/temporal path/);
    });

    it('rejects a second dispatchGuides with an identifiable error and no state change', async () => {
        const { core, device, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        const snapshot = snapshotState(core);
        const uploadsAfterFirst = device.queue.writeBuffer.mock.calls.length;

        let error: unknown;
        try {
            core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(SplitFrameError);
        expect((error as SplitFrameError).code).toBe('UPSCALER_SPLIT_FRAME');
        expect((error as SplitFrameError).reason).toBe('guides-already-pending');
        // Nothing encoded, nothing uploaded, counters frozen, still pending.
        expect(device.queue.writeBuffer).toHaveBeenCalledTimes(uploadsAfterFirst);
        expect(device.createCommandEncoder).toHaveBeenCalledTimes(1);
        const after = snapshotState(core);
        expect(after._frameIndex).toBe(snapshot._frameIndex);
        expect(after._historyIndex).toBe(snapshot._historyIndex);
        expect(after._depthIndex).toBe(snapshot._depthIndex);
        expect(core.guidesPending).toBe(true);

        // The frame is still finishable through the correct call.
        core.dispatchUpscale({ color: gpu('color') }, camera());
        expect(core.guidesPending).toBe(false);
    });

    it('rejects dispatchUpscale without a preceding dispatchGuides without touching state', async () => {
        const { core, device, gpu } = await configuredCore();
        const before = snapshotState(core);
        const uploads = device.queue.writeBuffer.mock.calls.length;

        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera())).toThrowError(
            expect.objectContaining({ name: 'SplitFrameError', reason: 'upscale-without-guides' }),
        );
        expect(device.queue.writeBuffer).toHaveBeenCalledTimes(uploads);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        const after = snapshotState(core);
        expect(after._frameIndex).toBe(before._frameIndex);
        expect(after._historyIndex).toBe(before._historyIndex);
        expect(core.guidesPending).toBe(false);

        // A normal frame can start immediately afterwards.
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        expect(core.guidesPending).toBe(true);
    });

    it('rejects the monolithic dispatch mid-split with an identifiable error and keeps the half frame', async () => {
        const { core, device, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        const snapshot = snapshotState(core);
        const uploads = device.queue.writeBuffer.mock.calls.length;

        let error: unknown;
        try {
            core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(SplitFrameError);
        expect((error as SplitFrameError).reason).toBe('dispatch-while-pending');
        // The guard runs before readiness bookkeeping and the constants rewrite.
        expect(device.queue.writeBuffer).toHaveBeenCalledTimes(uploads);
        expect(device.createCommandEncoder).toHaveBeenCalledTimes(1);
        expect(internals(core)._frameIndex).toBe(snapshot._frameIndex);
        expect(core.guidesPending).toBe(true);

        // The pending frame still completes normally.
        core.dispatchUpscale({ color: gpu('color') }, camera());
        expect(core.guidesPending).toBe(false);
    });

    it('rejects a camera mismatch between the stages before rewriting the constants buffer', async () => {
        const { core, device, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera({ far: 100 }));
        const snapshot = snapshotState(core);
        const uploads = device.queue.writeBuffer.mock.calls.length;

        let error: unknown;
        try {
            core.dispatchUpscale({ color: gpu('color') }, camera({ far: 250 }));
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(SplitFrameError);
        expect((error as SplitFrameError).reason).toBe('camera-mismatch');
        // No second constants upload, no encoder, no bookkeeping change.
        expect(device.queue.writeBuffer).toHaveBeenCalledTimes(uploads);
        expect(device.createCommandEncoder).toHaveBeenCalledTimes(1);
        const after = snapshotState(core);
        expect(after._frameIndex).toBe(snapshot._frameIndex);
        expect(after._historyIndex).toBe(snapshot._historyIndex);
        expect(after._depthIndex).toBe(snapshot._depthIndex);
        expect(core.guidesPending).toBe(true);

        // Repeating with the original camera succeeds.
        core.dispatchUpscale({ color: gpu('color') }, camera({ far: 100 }));
        expect(core.guidesPending).toBe(false);
    });

    it.each([
        ['near', { near: 0.5 }],
        ['perspective', { perspective: false }],
        ['reversedDepth', { reversedDepth: true }],
    ] as const)('treats a differing %s as a camera mismatch without state change', async (_field, override) => {
        const { core, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        const snapshot = snapshotState(core);

        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera(override))).toThrowError(
            expect.objectContaining({ name: 'SplitFrameError', reason: 'camera-mismatch' }),
        );
        expect(core.guidesPending).toBe(true);
        expect(internals(core)._frameIndex).toBe(snapshot._frameIndex);
    });

    it('rejects a reset flag introduced only at the late stage without resetting history', async () => {
        const { core, device, gpu } = await configuredCore();
        const cam = camera();
        // A completed first frame clears the configure-time reset, so the
        // pending frame below starts with _pendingReset === false.
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        core.dispatchUpscale({ color: gpu('color') }, cam);
        expect(internals(core)._pendingReset).toBe(false);

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        const snapshot = snapshotState(core);
        const uploads = device.queue.writeBuffer.mock.calls.length;

        let error: unknown;
        try {
            core.dispatchUpscale({ color: gpu('color'), reset: true }, cam);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(SplitFrameError);
        expect((error as SplitFrameError).reason).toBe('reset-mismatch');
        expect(device.queue.writeBuffer).toHaveBeenCalledTimes(uploads);
        const after = snapshotState(core);
        // _pendingReset was not flipped by the rejected call.
        expect(after._pendingReset).toBe(snapshot._pendingReset);
        expect(after._frameIndex).toBe(snapshot._frameIndex);
        expect(core.guidesPending).toBe(true);

        // The same late call without the stray reset finishes the frame.
        core.dispatchUpscale({ color: gpu('color') }, cam);
        expect(core.guidesPending).toBe(false);
    });

    it('accepts an identical reset flag on both stages and clears it at frame end', async () => {
        const { core, gpu } = await configuredCore();
        const cam = camera();
        // First frame consumes the configure-time reset.
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        core.dispatchUpscale({ color: gpu('color') }, cam);

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity'), reset: true }, cam);
        expect(internals(core)._pendingReset).toBe(true);
        core.dispatchUpscale({ color: gpu('color'), reset: true }, cam);
        const after = snapshotState(core);
        expect(after._pendingReset).toBe(false);
        expect(core.guidesPending).toBe(false);
    });

    it('clears the pending split when configure() runs mid-frame so no half frame lingers', async () => {
        const { core, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        expect(core.guidesPending).toBe(true);
        const before = snapshotState(core);

        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const after = snapshotState(core);
        expect(core.guidesPending).toBe(false);
        expect(after._pendingGuides).toBeNull();
        expect(after._stagedGuides).toBeNull();
        // configure() restarts history; the abandoned frame never flipped indices.
        expect(after._historyIndex).toBe(before._historyIndex);
        expect(after._pendingReset).toBe(true);

        // A fresh, clean frame pair works against the new generation.
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        expect(core.guidesPending).toBe(true);
        core.dispatchUpscale({ color: gpu('color') }, camera());
        expect(core.guidesPending).toBe(false);
    });

    it('clears the pending split on dispose() and reports not-initialized on later dispatch', async () => {
        const { core, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        expect(core.guidesPending).toBe(true);

        core.dispose();
        expect(core.guidesPending).toBe(false);
        expect(internals(core)._initialized).toBe(false);
        expect(internals(core)._pendingGuides).toBeNull();

        // Every imperative entry point reports the standard not-ready error
        // rather than touching the released constants buffer/textures.
        expect(() => core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera()))
            .toThrow(UpscalerNotReadyError);
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera()))
            .toThrow(UpscalerNotReadyError);
        expect(() => core.dispatch({ color: gpu('color') }, camera()))
            .toThrow(UpscalerNotReadyError);
        expect(core.guidesPending).toBe(false);
    });

    it('can be reconfigured and driven again after dispose()', async () => {
        const { core, gpu } = await configuredCore();
        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        core.dispose();

        core.configure({ displayWidth: 48, displayHeight: 24, customUpscaleRatio: 2 });
        await core.prepare();
        expect(core.guidesPending).toBe(false);
        expect(() => core.dispatchUpscale({ color: gpu('color') }, camera())).toThrow(SplitFrameError);

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, camera());
        expect(core.guidesPending).toBe(true);
        core.dispatchUpscale({ color: gpu('color') }, camera());
        expect(core.guidesPending).toBe(false);
    });

    it('enforces the same contract through the encode* forms without submitting', async () => {
        const { core, device, encoder, gpu } = await configuredCore();
        const cam = camera();

        // Encode a valid split frame into the host encoder.
        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, cam);
        expect(core.guidesPending).toBe(true);
        const snapshot = snapshotState(core);

        expect(() =>
            core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, cam),
        ).toThrowError(expect.objectContaining({ name: 'SplitFrameError', reason: 'guides-already-pending' }));
        expect(() =>
            core.encode(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, cam),
        ).toThrowError(expect.objectContaining({ name: 'SplitFrameError', reason: 'dispatch-while-pending' }));
        expect(() =>
            core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera({ far: 250 })),
        ).toThrowError(expect.objectContaining({ name: 'SplitFrameError', reason: 'camera-mismatch' }));
        expect(internals(core)._frameIndex).toBe(snapshot._frameIndex);
        expect(core.guidesPending).toBe(true);
        expect(device.queue.submit).not.toHaveBeenCalled();

        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, cam);
        expect(core.guidesPending).toBe(false);
        expect(internals(core)._frameIndex).toBe(snapshot._frameIndex + 1);
        expect(device.queue.submit).not.toHaveBeenCalled();
    });
});
