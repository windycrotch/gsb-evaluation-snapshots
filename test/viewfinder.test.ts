// View-finder loading and caching, exercised with OffscreenCanvas + a fake
// fetch: no DOM and no real network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Blend-mode support is a property of the 2d context, so the fake toggles it
// for every context at once (a per-canvas flag would not survive the clone
// vintagejs makes of the source).
let blendModesSupported = true;

class FakeBitmap {
  constructor(
    public width: number,
    public height: number,
    public data: Uint8ClampedArray,
  ) {}
}

class FakeContext {
  fillStyle: unknown = null;
  private compositeOperation = 'source-over';
  constructor(private canvas: FakeOffscreenCanvas) {}

  // A browser without blend-mode support keeps `globalCompositeOperation` at
  // its previous value, which is what `supportsBlendModes` detects.
  get globalCompositeOperation() {
    return this.compositeOperation;
  }
  set globalCompositeOperation(value: string) {
    if (blendModesSupported) this.compositeOperation = value;
  }

  drawImage(src: FakeBitmap | FakeOffscreenCanvas) {
    const { data } = this.canvas;
    if (this.compositeOperation === 'multiply') {
      for (let i = 0; i < data.length; i++) data[i] = (data[i] * src.data[i]) / 255;
    } else {
      data.set(src.data);
    }
  }
  getImageData() {
    return { data: new Uint8ClampedArray(this.canvas.data) };
  }
  putImageData(imageData: { data: Uint8ClampedArray }) {
    this.canvas.data.set(imageData.data);
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  fillRect() {}
}

class FakeOffscreenCanvas {
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext(type: string) {
    return type === '2d' ? new FakeContext(this) : null;
  }
}

const pixels = (...rgba: number[]) => new Uint8ClampedArray(rgba);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let vintagejs: typeof import('../src/index').default;

beforeEach(async () => {
  vi.resetModules();
  blendModesSupported = true;
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('Image', undefined);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('ImageBitmap', FakeBitmap);
  vintagejs = (await import('../src/index')).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubViewfinderLoad = (bitmap: FakeBitmap) => {
  const blob = { kind: 'viewfinder-blob' };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(blob),
  });
  const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  return { fetchMock, createImageBitmapMock };
};

const bitmap = (...rgba: number[]) => new FakeBitmap(1, 1, pixels(...rgba));

const render = (source: FakeBitmap, effect: object) =>
  vintagejs<OffscreenCanvas>(source as unknown as ImageBitmap, effect);

describe('viewfinder loading and caching', () => {
  it('reports the viewfinder URL and successful compositing on the result', async () => {
    stubViewfinderLoad(bitmap(0, 255, 0, 255));

    const res = await render(bitmap(200, 200, 200, 255), {
      viewfinder: '/film-1.jpg',
    });

    expect(res.viewfinder).toEqual({ url: '/film-1.jpg', applied: true });
  });

  it('reports no viewfinder when the effect does not use one', async () => {
    const res = await render(bitmap(10, 20, 30, 255), {});

    expect(res.viewfinder).toBe(false);
  });

  it('loads a viewfinder once and reuses it for later renders', async () => {
    const { fetchMock, createImageBitmapMock } = stubViewfinderLoad(
      bitmap(128, 128, 128, 255),
    );

    await render(bitmap(100, 100, 100, 255), { viewfinder: '/film-1.jpg' });
    await render(bitmap(100, 100, 100, 255), { viewfinder: '/film-1.jpg' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/film-1.jpg');
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with the URL and the underlying reason, then retries the load', async () => {
    const failingFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', failingFetch);
    vi.stubGlobal('createImageBitmap', vi.fn());

    const failure = render(bitmap(1, 2, 3, 255), {
      viewfinder: '/missing.jpg',
    });
    await expect(failure).rejects.toThrow('/missing.jpg');
    await expect(failure).rejects.toThrow('HTTP 404');

    // The failed entry was evicted from the cache: the next render reloads it.
    const { fetchMock } = stubViewfinderLoad(bitmap(255, 255, 255, 255));
    const res = await render(bitmap(1, 2, 3, 255), {
      viewfinder: '/missing.jpg',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/missing.jpg');
    expect(res.viewfinder).toEqual({ url: '/missing.jpg', applied: true });
  });

  it('starts one load for concurrent renders and shares the result', async () => {
    const blob = { kind: 'viewfinder-blob' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    });
    const bitmapDeferred = deferred<FakeBitmap>();
    const createImageBitmapMock = vi
      .fn()
      .mockReturnValue(bitmapDeferred.promise);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const first = render(bitmap(200, 200, 200, 255), {
      viewfinder: '/film-1.jpg',
    });
    const second = render(bitmap(200, 200, 200, 255), {
      viewfinder: '/film-1.jpg',
    });

    // Both renders are waiting on one not-yet-completed underlying load.
    await vi.waitFor(() => expect(createImageBitmapMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);

    bitmapDeferred.resolve(bitmap(255, 0, 255, 255));
    const [res1, res2] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(res1.viewfinder).toEqual({ url: '/film-1.jpg', applied: true });
    expect(res2.viewfinder).toEqual({ url: '/film-1.jpg', applied: true });
  });

  it('rejects every concurrent render when the shared load fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    vi.stubGlobal('createImageBitmap', vi.fn());

    const first = render(bitmap(1, 2, 3, 255), { viewfinder: '/broken.jpg' });
    const second = render(bitmap(1, 2, 3, 255), { viewfinder: '/broken.jpg' });

    await expect(first).rejects.toThrow('/broken.jpg');
    await expect(first).rejects.toThrow('HTTP 500');
    await expect(second).rejects.toThrow('/broken.jpg');
    await expect(second).rejects.toThrow('HTTP 500');
  });
});

describe('viewfinder compositing', () => {
  it('multiplies the texture into the pixels when blend modes are supported', async () => {
    stubViewfinderLoad(bitmap(128, 255, 0, 255));

    const res = await render(bitmap(200, 200, 200, 255), {
      viewfinder: '/film-1.jpg',
    });
    const canvas = res.getCanvas() as unknown as FakeOffscreenCanvas;

    // 200 * 128 / 255 ≈ 100, 200 * 255 / 255 = 200, 200 * 0 = 0
    expect(Array.from(canvas.data)).toEqual([100, 200, 0, 255]);
  });

  it('multiplies pixel by pixel when blend modes are unsupported', async () => {
    blendModesSupported = false;
    stubViewfinderLoad(bitmap(128, 255, 0, 255));

    const res = await render(bitmap(200, 200, 200, 255), {
      viewfinder: '/film-1.jpg',
    });
    const canvas = res.getCanvas() as unknown as FakeOffscreenCanvas;

    expect(Array.from(canvas.data)).toEqual([100, 200, 0, 255]);
    expect(res.viewfinder).toEqual({ url: '/film-1.jpg', applied: true });
  });

  it('leaves pixels untouched when no viewfinder is configured', async () => {
    const res = await render(bitmap(200, 200, 200, 255), {});
    const canvas = res.getCanvas() as unknown as FakeOffscreenCanvas;

    expect(Array.from(canvas.data)).toEqual([200, 200, 200, 255]);
  });
});
