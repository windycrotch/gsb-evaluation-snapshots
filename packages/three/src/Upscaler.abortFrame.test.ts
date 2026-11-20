import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler';

//* Mock Renderer — the jitter-test shape plus the encoder/bind-group surface
// dispatchGuides/dispatchUpscale need, so a split frame runs end to end
// without a GPU.

function mockRenderer() {
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
        destroy: () => {},
    });
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: resource,
        createBindGroup: resource,
        createCommandEncoder: () => encoder,
    };
    const backing = new WeakMap<object, object>();
    const renderer = {
        backend: {
            device,
            get: (texture: object) => {
                if (!backing.has(texture)) backing.set(texture, { texture: resource() });
                return backing.get(texture);
            },
        },
        initTexture: () => {},
    } as unknown as WebGPURenderer;
    return { renderer };
}

const camera = () => {
    const c = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    c.updateMatrixWorld();
    return c;
};

describe('Upscaler.abortFrame', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function configured() {
        const { renderer } = mockRenderer();
        const upscaler = new Upscaler({ renderer });
        upscaler.configure({ displayWidth: 1280, displayHeight: 720, customUpscaleRatio: 2 });
        await upscaler.init();
        return { upscaler };
    }

    const guides = { depth: {} as never, velocity: {} as never };

    it('clears the pending split frame and restores the camera view', async () => {
        const { upscaler } = await configured();
        const cam = camera();

        upscaler.beginFrame(cam);
        expect(cam.view).not.toBeNull();
        upscaler.dispatchGuides(guides, cam);
        expect(upscaler.guidesPending).toBe(true);

        // The color render failed — abandon the frame. The jitter comes off
        // the camera as endFrame would, and the split state is gone.
        upscaler.abortFrame();
        expect(upscaler.guidesPending).toBe(false);
        expect(cam.view).toBeNull();

        // The next frame starts cleanly: guides again, then the late stage.
        upscaler.beginFrame(cam);
        upscaler.dispatchGuides(guides, cam);
        upscaler.dispatchUpscale({ color: {} as never }, cam);
        expect(upscaler.guidesPending).toBe(false);
        upscaler.endFrame(cam);
    });

    it('is a no-op when no split frame is in flight', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        expect(() => upscaler.abortFrame()).not.toThrow();
        upscaler.beginFrame(cam);
        upscaler.endFrame(cam);
        expect(() => upscaler.abortFrame()).not.toThrow();
    });

    it('invalidates the split frame on configure', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        upscaler.beginFrame(cam);
        upscaler.dispatchGuides(guides, cam);
        expect(upscaler.guidesPending).toBe(true);

        upscaler.configure({ displayWidth: 1920, displayHeight: 1080, customUpscaleRatio: 2 });
        expect(upscaler.guidesPending).toBe(false);
        expect(() => upscaler.dispatchUpscale({ color: {} as never }, cam)).toThrow(/dispatchGuides/);
        upscaler.endFrame(cam);
    });
});
