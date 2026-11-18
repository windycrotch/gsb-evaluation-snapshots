/**
 * Readback-path tests driven by a scripted `GPUDevice` stand-in instead of a real GPU, so texture
 * recreation, format validation, row-padding stripping and buffer cleanup are each asserted
 * independently — and stay verifiable on machines where Dawn cannot start.
 */
import { expect, it, vi } from 'vitest';
import { createCanvas } from './canvas.ts';

type FakeTexture = { width: number; height: number; destroy: ReturnType<typeof vi.fn> };

type FakeBuffer = {
  mapAsync: ReturnType<typeof vi.fn>;
  getMappedRange: ReturnType<typeof vi.fn>;
  unmap: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

/** A `GPUDevice` stand-in that records every texture and buffer it creates and never touches a GPU. */
const makeDevice = (behaviour: { mappedBytes?: Uint8Array; mapError?: Error } = {}) => {
  const textures: FakeTexture[] = [];
  const buffers: FakeBuffer[] = [];
  const encoder = { copyTextureToBuffer: vi.fn(), finish: vi.fn(() => ({})) };
  const createTexture = vi.fn((descriptor: { size: Iterable<number> }) => {
    const [width = 0, height = 0] = descriptor.size;
    const texture: FakeTexture = { width, height, destroy: vi.fn() };
    textures.push(texture);
    return texture;
  });
  const createBuffer = vi.fn((_descriptor: { size: number; usage: number }) => {
    const buffer: FakeBuffer = {
      mapAsync: behaviour.mapError
        ? vi.fn().mockRejectedValue(behaviour.mapError)
        : vi.fn().mockResolvedValue(undefined),
      getMappedRange: vi.fn(() => {
        if (!behaviour.mappedBytes) throw new Error('test did not provide mapped bytes');
        return behaviour.mappedBytes.buffer;
      }),
      unmap: vi.fn(),
      destroy: vi.fn(),
    };
    buffers.push(buffer);
    return buffer;
  });
  const submit = vi.fn();
  const device = {
    createTexture,
    createBuffer,
    createCommandEncoder: vi.fn(() => encoder),
    queue: { submit },
  } as unknown as GPUDevice;
  return { device, encoder, textures, buffers, createTexture, createBuffer, submit };
};

it('throws on getCurrentTexture() and readPixels() before configure()', async () => {
  const context = createCanvas(4, 4).getContext('webgpu');
  expect(context.getConfiguration()).toBeNull();
  expect(() => context.getCurrentTexture()).toThrow('getCurrentTexture() called before configure()');
  await expect(context.readPixels()).rejects.toThrow('readPixels() called before configure()');
});

it('destroys the stale texture and rebuilds it at the new size when the canvas is resized', () => {
  const { device, textures, createTexture } = makeDevice();
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('webgpu');
  context.configure({ device, format: 'rgba8unorm' });

  const first = context.getCurrentTexture();
  expect(context.getCurrentTexture()).toBe(first); // stable while the canvas size is
  expect(createTexture).toHaveBeenCalledOnce();

  canvas.width = 8;
  canvas.height = 6;
  const second = context.getCurrentTexture();
  expect(second).not.toBe(first);
  expect(textures[0]!.destroy).toHaveBeenCalledOnce();
  expect(createTexture).toHaveBeenCalledTimes(2);
  expect(createTexture).toHaveBeenLastCalledWith(expect.objectContaining({ size: [8, 6] }));
  expect(textures[1]).toMatchObject({ width: 8, height: 6 });
});

it('drops the current texture on configure() and unconfigure()', () => {
  const { device, textures } = makeDevice();
  const context = createCanvas(4, 4).getContext('webgpu');
  context.configure({ device, format: 'rgba8unorm' });
  context.getCurrentTexture();

  context.configure({ device, format: 'bgra8unorm' });
  expect(textures[0]!.destroy).toHaveBeenCalledOnce();

  context.getCurrentTexture();
  context.unconfigure();
  expect(textures[1]!.destroy).toHaveBeenCalledOnce();
  expect(context.getConfiguration()).toBeNull();
  expect(() => context.getCurrentTexture()).toThrow('getCurrentTexture() called before configure()');
});

it('rejects readPixels() on an unreadable format, naming the format and the supported list', async () => {
  const { device, createTexture, createBuffer } = makeDevice();
  const context = createCanvas(2, 2).getContext('webgpu');
  context.configure({ device, format: 'rgba16float' });

  await expect(context.readPixels()).rejects.toThrow(
    'readPixels() does not support canvas format "rgba16float"; supported formats are rgba8unorm, rgba8unorm-srgb, bgra8unorm, and bgra8unorm-srgb',
  );
  // The rejection happens before any GPU work is scheduled.
  expect(createTexture).not.toHaveBeenCalled();
  expect(createBuffer).not.toHaveBeenCalled();
});

it('strips 256-byte row padding and returns rows top-to-bottom (65x3, rgba8unorm)', async () => {
  const width = 65;
  const height = 3;
  const bytesPerRow = 512; // 65 * 4 = 260 pixel bytes per row, padded up to the 256-byte alignment
  const padded = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) padded[y * bytesPerRow + x] = (y * width * 4 + x) % 0xee;
    padded.fill(0xee, y * bytesPerRow + width * 4, (y + 1) * bytesPerRow); // sentinel padding bytes
  }
  const { device, encoder, createBuffer } = makeDevice({ mappedBytes: padded });
  const canvas = createCanvas(width, height);
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm' });

  const image = await canvas.readPixels();

  expect(image).toMatchObject({ width, height });
  expect(image.data.length).toBe(width * height * 4);
  for (let y = 0; y < height; y++)
    expect(image.data.subarray(y * width * 4, (y + 1) * width * 4)).toEqual(
      padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4),
    );
  expect(image.data.includes(0xee)).toBe(false); // no padding byte leaks into the image
  expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: bytesPerRow * height }));
  expect(encoder.copyTextureToBuffer).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ bytesPerRow }),
    [width, height],
  );
});

it('swizzles bgra8unorm readbacks back to RGBA order', async () => {
  const padded = new Uint8Array(256); // one 256-aligned row holding two BGRA pixels
  padded.set([10, 20, 30, 40, 50, 60, 70, 80]);
  const { device } = makeDevice({ mappedBytes: padded });
  const canvas = createCanvas(2, 1);
  canvas.getContext('webgpu').configure({ device, format: 'bgra8unorm' });

  const image = await canvas.readPixels();

  expect(image).toMatchObject({ width: 2, height: 1 });
  expect(Array.from(image.data)).toEqual([30, 20, 10, 40, 70, 60, 50, 80]);
});

it('unmaps and then destroys the staging buffer after a successful read', async () => {
  const { device, buffers } = makeDevice({ mappedBytes: new Uint8Array(256) });
  const canvas = createCanvas(1, 1);
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm' });

  await canvas.readPixels();

  const buffer = buffers[0]!;
  expect(buffer.unmap).toHaveBeenCalledOnce();
  expect(buffer.destroy).toHaveBeenCalledOnce();
  expect(buffer.unmap.mock.invocationCallOrder[0]!).toBeLessThan(buffer.destroy.mock.invocationCallOrder[0]!);
});

it('destroys the staging buffer and rethrows when mapAsync fails', async () => {
  const { device, buffers, submit } = makeDevice({ mapError: new Error('map failed') });
  const canvas = createCanvas(1, 1);
  canvas.getContext('webgpu').configure({ device, format: 'rgba8unorm' });

  await expect(canvas.readPixels()).rejects.toThrow('map failed');

  const buffer = buffers[0]!;
  expect(submit).toHaveBeenCalledOnce(); // the copy was already on its way when mapping failed
  expect(buffer.unmap).not.toHaveBeenCalled(); // the buffer was never mapped
  expect(buffer.destroy).toHaveBeenCalledOnce();
});
