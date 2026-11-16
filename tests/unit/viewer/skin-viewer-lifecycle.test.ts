/**
 * SkinViewer resource lifecycle regression tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkinViewer } from "@/viewer/SkinViewer";
import { use } from "@/core/renderer/registry";
import { BufferUsage } from "@/core/renderer/types";
import type {
  DrawParams,
  IBuffer,
  IPipeline,
  IRenderer,
  ITexture,
  PipelineConfig,
  RendererOptions,
  TextureOptions,
} from "@/core/renderer/types";
import type { BackgroundRenderer } from "@/core/plugins/types";
import type { TextureSource } from "@/texture";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createReadyImage(width = 64, height = 64): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { value: true },
    width: { value: width },
    height: { value: height },
  });
  return image;
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createMockBitmap(label: string): ImageBitmap {
  return {
    width: 64,
    height: 64,
    close: vi.fn(),
    __label: label,
  } as unknown as ImageBitmap;
}

class MockBuffer implements IBuffer {
  readonly id: number;
  readonly size: number;
  readonly usage: BufferUsage;
  readonly dispose = vi.fn();
  readonly update = vi.fn();

  constructor(id: number, usage: BufferUsage, data: ArrayBufferView) {
    this.id = id;
    this.usage = usage;
    this.size = data.byteLength;
  }
}

class MockPipeline implements IPipeline {
  readonly dispose = vi.fn();

  constructor(readonly id: number) {}
}

class MockTexture implements ITexture {
  readonly width = 64;
  readonly height = 64;
  readonly update = vi.fn();
  readonly dispose = vi.fn();

  constructor(
    readonly id: number,
    readonly source: TexImageSource,
  ) {}
}

class MockRenderer implements IRenderer {
  readonly backend = "webgl" as const;
  readonly pixelRatio = 1;
  width = 300;
  height = 150;
  readonly createTextureCalls: TexImageSource[] = [];
  readonly createdTextures: MockTexture[] = [];
  readonly drawCalls: DrawParams[] = [];
  readonly dispose = vi.fn();
  readonly beginFrame = vi.fn();
  readonly clear = vi.fn();
  readonly endFrame = vi.fn();

  private nextResourceId = 1;
  private textureResults: (Deferred<ITexture> | Error)[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {}

  queueTextureResult(result: Deferred<ITexture> | Error): void {
    this.textureResults.push(result);
  }

  createBuffer(usage: BufferUsage, data: ArrayBufferView): IBuffer {
    return new MockBuffer(this.nextResourceId++, usage, data);
  }

  async createTexture(source: TexImageSource, _options?: TextureOptions): Promise<ITexture> {
    this.createTextureCalls.push(source);
    const result = this.textureResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result) {
      return result.promise;
    }
    const texture = new MockTexture(this.nextResourceId++, source);
    this.createdTextures.push(texture);
    return texture;
  }

  createPipeline(_config: PipelineConfig): IPipeline {
    return new MockPipeline(this.nextResourceId++);
  }

  draw(params: DrawParams): void {
    this.drawCalls.push(params);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
}

let lastRenderer: MockRenderer | null = null;

function registerMockRenderer(): void {
  use({
    type: "renderer",
    backend: "webgl",
    createRenderer: (options: RendererOptions) => {
      lastRenderer = new MockRenderer(options.canvas);
      return lastRenderer;
    },
    shaders: {
      vertex: "void main() {}",
      fragment: "void main() {}",
    },
  });
}

function getLastRenderer(): MockRenderer {
  if (!lastRenderer) {
    throw new Error("Mock renderer was not created");
  }
  return lastRenderer;
}

beforeEach(() => {
  lastRenderer = null;
  registerMockRenderer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkinViewer resource lifecycle", () => {
  it("keeps the current skin texture when a later setSkin load fails", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    const initialTexture = renderer.createTextureCalls[0];

    renderer.queueTextureResult(new Error("gpu texture allocation failed"));

    await expect(viewer.setSkin(createReadyImage())).rejects.toThrow(
      "gpu texture allocation failed",
    );
    viewer.render();

    const skinDraw = renderer.drawCalls.find((call) => "u_skinTexture" in call.bindGroup.textures);
    const renderedTexture = skinDraw?.bindGroup.textures.u_skinTexture as MockTexture | undefined;
    expect(renderedTexture?.source).toBe(initialTexture);

    viewer.dispose();
  });

  it("lets the latest setSkin request win and disposes stale textures", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const first = deferred<ITexture>();
    const second = deferred<ITexture>();
    renderer.queueTextureResult(first);
    renderer.queueTextureResult(second);

    const firstUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    const secondUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 3);
    const firstTexture = new MockTexture(1001, createMockBitmap("first"));
    const secondTexture = new MockTexture(1002, createMockBitmap("second"));

    second.resolve(secondTexture);
    await secondUpdate;

    first.resolve(firstTexture);
    await firstUpdate;

    viewer.render();
    const skinDraw = renderer.drawCalls
      .filter((call) => "u_skinTexture" in call.bindGroup.textures)
      .at(-1);
    expect(skinDraw?.bindGroup.textures.u_skinTexture).toBe(secondTexture);
    expect(firstTexture.dispose).toHaveBeenCalledTimes(1);
    expect(secondTexture.dispose).not.toHaveBeenCalled();

    viewer.dispose();
  });

  it("rolls back allocated resources when initial texture creation fails", async () => {
    const rendererBuffers: MockBuffer[] = [];
    const rendererPipelines: MockPipeline[] = [];

    use({
      type: "renderer",
      backend: "webgl",
      createRenderer: (options: RendererOptions) => {
        const renderer = new MockRenderer(options.canvas);
        lastRenderer = renderer;
        renderer.queueTextureResult(new Error("initial texture failed"));

        const createBuffer = renderer.createBuffer.bind(renderer);
        renderer.createBuffer = (usage, data) => {
          const buffer = createBuffer(usage, data) as MockBuffer;
          rendererBuffers.push(buffer);
          return buffer;
        };

        const createPipeline = renderer.createPipeline.bind(renderer);
        renderer.createPipeline = (config) => {
          const pipeline = createPipeline(config) as MockPipeline;
          rendererPipelines.push(pipeline);
          return pipeline;
        };

        return renderer;
      },
      shaders: {
        vertex: "void main() {}",
        fragment: "void main() {}",
      },
    });

    await expect(
      createSkinViewer({
        canvas: document.createElement("canvas"),
        preferredBackend: "webgl",
      }),
    ).rejects.toThrow("initial texture failed");

    const renderer = getLastRenderer();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(rendererBuffers.length).toBeGreaterThan(0);
    expect(rendererBuffers.every((buffer) => buffer.dispose.mock.calls.length === 1)).toBe(true);
    expect(rendererPipelines.length).toBe(3);
    expect(rendererPipelines.every((pipeline) => pipeline.dispose.mock.calls.length === 1)).toBe(
      true,
    );
  });
});

describe("SkinViewer panorama lifecycle", () => {
  it("keeps the latest panorama request when an earlier request resolves later", async () => {
    const sources: TextureSource[] = [];
    const createdRenderers: {
      renderer: BackgroundRenderer;
      render: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }[] = [];
    const first = deferred<void>();
    const second = deferred<void>();

    use({
      type: "background",
      name: "panorama",
      createRenderer: () => {
        const load = createdRenderers.length === 0 ? first : second;
        const render = vi.fn();
        const dispose = vi.fn();
        const renderer: BackgroundRenderer = {
          setSource: vi.fn(async (source) => {
            sources.push(source);
            await load.promise;
          }),
          render,
          dispose,
        };
        createdRenderers.push({ renderer, render, dispose });
        return renderer;
      },
    });

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    const firstUpdate = viewer.setPanorama(createReadyImage());
    const secondUpdate = viewer.setPanorama(createReadyImage());

    second.resolve();
    await secondUpdate;
    first.resolve();
    await firstUpdate;

    viewer.render();

    expect(sources).toHaveLength(2);
    const firstRenderer = createdRenderers[0]!;
    const secondRenderer = createdRenderers[1]!;
    expect(firstRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(firstRenderer.render).not.toHaveBeenCalled();
    expect(secondRenderer.dispose).not.toHaveBeenCalled();
    expect(secondRenderer.render).toHaveBeenCalledTimes(1);

    viewer.dispose();
  });
});

describe("SkinViewer setSkin async semantics", () => {
  it("clears the skin immediately on setSkin(null) and releases late in-flight textures", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    const initialTexture = renderer.createdTextures[0]!;

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    await viewer.setSkin(null);

    // Explicit clear takes effect immediately: old texture disposed, nothing drawn.
    expect(initialTexture.dispose).toHaveBeenCalledTimes(1);
    viewer.render();
    expect(renderer.drawCalls).toHaveLength(0);

    // The superseded load must release its texture when it finally arrives.
    const lateTexture = new MockTexture(2001, createMockBitmap("late"));
    inFlight.resolve(lateTexture);
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(lateTexture.dispose).toHaveBeenCalledTimes(1);

    viewer.render();
    expect(renderer.drawCalls).toHaveLength(0);

    viewer.dispose();
  });

  it("does not throw when a superseded setSkin request fails", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const first = deferred<ITexture>();
    const second = deferred<ITexture>();
    renderer.queueTextureResult(first);
    renderer.queueTextureResult(second);

    const firstUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    const secondUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 3);

    // The stale request fails: swallowed, must not affect the newer request.
    first.reject(new Error("stale load failed"));
    await expect(firstUpdate).resolves.toBeUndefined();

    const secondTexture = new MockTexture(2002, createMockBitmap("second"));
    second.resolve(secondTexture);
    await secondUpdate;

    viewer.render();
    const skinDraw = renderer.drawCalls
      .filter((call) => "u_skinTexture" in call.bindGroup.textures)
      .at(-1);
    expect(skinDraw?.bindGroup.textures.u_skinTexture).toBe(secondTexture);
    expect(secondTexture.dispose).not.toHaveBeenCalled();

    viewer.dispose();
  });

  it("releases skin textures that arrive after dispose without throwing", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    viewer.dispose();

    const lateTexture = new MockTexture(2003, createMockBitmap("late"));
    inFlight.resolve(lateTexture);
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(lateTexture.dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows setSkin failures that arrive after dispose", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setSkin(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    viewer.dispose();

    inFlight.reject(new Error("gpu is gone"));
    await expect(pendingUpdate).resolves.toBeUndefined();
  });

  it("keeps the current skin when the new image fails to load", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    const initialTexture = renderer.createdTextures[0]!;

    const brokenImage = document.createElement("img");
    Object.defineProperties(brokenImage, {
      complete: { value: false },
      width: { value: 64 },
      height: { value: 64 },
    });

    const update = viewer.setSkin(brokenImage);
    const errorEvent = new Event("error");
    const expectation = expect(update).rejects.toBe(errorEvent);
    brokenImage.dispatchEvent(errorEvent);
    await expectation;

    // Failure must preserve the previously visible skin.
    expect(initialTexture.dispose).not.toHaveBeenCalled();
    viewer.render();
    const skinDraw = renderer.drawCalls.find((call) => "u_skinTexture" in call.bindGroup.textures);
    expect(skinDraw?.bindGroup.textures.u_skinTexture).toBe(initialTexture);

    viewer.dispose();
  });
});

describe("SkinViewer setCape async semantics", () => {
  it("auto-switches backEquipment to cape after a successful setCape", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    expect(viewer.backEquipment).toBe("none");

    const pending = deferred<ITexture>();
    renderer.queueTextureResult(pending);
    const update = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    const capeTexture = new MockTexture(3001, createMockBitmap("cape"));
    pending.resolve(capeTexture);
    await update;

    expect(viewer.backEquipment).toBe("cape");

    viewer.render();
    const capeDraw = renderer.drawCalls.find(
      (call) => call.bindGroup.textures.u_skinTexture === capeTexture,
    );
    expect(capeDraw).toBeDefined();

    viewer.dispose();
  });

  it("keeps an explicit backEquipment selection after a successful setCape", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    viewer.setBackEquipment("elytra");

    const pending = deferred<ITexture>();
    renderer.queueTextureResult(pending);
    const update = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    pending.resolve(new MockTexture(3002, createMockBitmap("cape")));
    await update;

    expect(viewer.backEquipment).toBe("elytra");

    viewer.dispose();
  });

  it("keeps the current cape texture and backEquipment when a later setCape fails", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const first = deferred<ITexture>();
    renderer.queueTextureResult(first);
    const firstUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    const capeTexture = new MockTexture(3003, createMockBitmap("cape-v1"));
    first.resolve(capeTexture);
    await firstUpdate;
    expect(viewer.backEquipment).toBe("cape");

    renderer.queueTextureResult(new Error("cape upload failed"));
    await expect(viewer.setCape(createReadyImage())).rejects.toThrow("cape upload failed");

    // Failure must not touch the visible cape texture or the equipment state.
    expect(viewer.backEquipment).toBe("cape");
    expect(capeTexture.dispose).not.toHaveBeenCalled();

    viewer.render();
    const capeDraw = renderer.drawCalls
      .filter((call) => call.bindGroup.textures.u_skinTexture === capeTexture)
      .at(-1);
    expect(capeDraw).toBeDefined();

    viewer.dispose();
  });

  it("does not auto-switch backEquipment when setCape fails", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    const initialSkinTexture = renderer.createdTextures[0]!;

    renderer.queueTextureResult(new Error("cape upload failed"));
    await expect(viewer.setCape(createReadyImage())).rejects.toThrow("cape upload failed");

    expect(viewer.backEquipment).toBe("none");

    // Only skin draws may happen; no cape draw with a leftover texture.
    viewer.render();
    expect(renderer.drawCalls.length).toBeGreaterThan(0);
    expect(
      renderer.drawCalls.every(
        (call) => call.bindGroup.textures.u_skinTexture === initialSkinTexture,
      ),
    ).toBe(true);

    viewer.dispose();
  });

  it("clears the cape and backEquipment on setCape(null) and releases late in-flight textures", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();
    const initialSkinTexture = renderer.createdTextures[0]!;

    const first = deferred<ITexture>();
    renderer.queueTextureResult(first);
    const firstUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    const capeTexture = new MockTexture(3004, createMockBitmap("cape-v1"));
    first.resolve(capeTexture);
    await firstUpdate;
    expect(viewer.backEquipment).toBe("cape");

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 3);

    await viewer.setCape(null);

    // Explicit clear is immediate: texture disposed, equipment reset to none.
    expect(viewer.backEquipment).toBe("none");
    expect(capeTexture.dispose).toHaveBeenCalledTimes(1);

    viewer.render();
    expect(renderer.drawCalls.length).toBeGreaterThan(0);
    expect(
      renderer.drawCalls.every(
        (call) => call.bindGroup.textures.u_skinTexture === initialSkinTexture,
      ),
    ).toBe(true);

    // The superseded load must release its texture when it finally arrives.
    const lateTexture = new MockTexture(3005, createMockBitmap("late"));
    inFlight.resolve(lateTexture);
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(lateTexture.dispose).toHaveBeenCalledTimes(1);
    expect(viewer.backEquipment).toBe("none");

    viewer.dispose();
  });

  it("lets the latest setCape request win and disposes stale cape textures", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const first = deferred<ITexture>();
    const second = deferred<ITexture>();
    renderer.queueTextureResult(first);
    renderer.queueTextureResult(second);

    const firstUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);
    const secondUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 3);

    const firstTexture = new MockTexture(3006, createMockBitmap("cape-first"));
    const secondTexture = new MockTexture(3007, createMockBitmap("cape-second"));

    second.resolve(secondTexture);
    await secondUpdate;
    expect(viewer.backEquipment).toBe("cape");

    first.resolve(firstTexture);
    await firstUpdate;

    expect(firstTexture.dispose).toHaveBeenCalledTimes(1);
    expect(secondTexture.dispose).not.toHaveBeenCalled();

    viewer.render();
    const capeDraw = renderer.drawCalls
      .filter((call) => call.bindGroup.textures.u_skinTexture === secondTexture)
      .at(-1);
    expect(capeDraw).toBeDefined();

    viewer.dispose();
  });

  it("releases cape textures that arrive after dispose without throwing", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    viewer.dispose();

    const lateTexture = new MockTexture(3008, createMockBitmap("late"));
    inFlight.resolve(lateTexture);
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(lateTexture.dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows setCape failures that arrive after dispose", async () => {
    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });
    const renderer = getLastRenderer();

    const inFlight = deferred<ITexture>();
    renderer.queueTextureResult(inFlight);
    const pendingUpdate = viewer.setCape(createReadyImage());
    await waitForCondition(() => renderer.createTextureCalls.length === 2);

    viewer.dispose();

    inFlight.reject(new Error("gpu is gone"));
    await expect(pendingUpdate).resolves.toBeUndefined();
  });
});

interface MockBackgroundRenderer {
  renderer: BackgroundRenderer;
  setSource: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/**
 * Register a mock panorama plugin whose renderers run the queued setSource
 * behaviors (one per created renderer, defaulting to immediate success).
 */
function useMockPanoramaPlugin(
  setSourceBehaviors: Array<() => Promise<void>>,
): MockBackgroundRenderer[] {
  const created: MockBackgroundRenderer[] = [];
  use({
    type: "background",
    name: "panorama",
    createRenderer: () => {
      const behavior = setSourceBehaviors.shift() ?? (async () => {});
      const background: MockBackgroundRenderer = {
        setSource: vi.fn(behavior),
        render: vi.fn(),
        dispose: vi.fn(),
        renderer: null as unknown as BackgroundRenderer,
      };
      background.renderer = {
        setSource: background.setSource as unknown as (source: TextureSource) => Promise<void>,
        render: background.render as unknown as () => void,
        dispose: background.dispose as unknown as () => void,
      };
      created.push(background);
      return background.renderer;
    },
  });
  return created;
}

describe("SkinViewer setPanorama async semantics", () => {
  it("keeps the current background when a later setPanorama fails", async () => {
    const created = useMockPanoramaPlugin([
      async () => {},
      async () => {
        throw new Error("panorama load failed");
      },
    ]);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    await viewer.setPanorama(createReadyImage());
    viewer.render();
    expect(created).toHaveLength(1);
    expect(created[0]!.render).toHaveBeenCalledTimes(1);

    await expect(viewer.setPanorama(createReadyImage())).rejects.toThrow("panorama load failed");

    // The failed renderer is released; the previous background stays visible.
    expect(created).toHaveLength(2);
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(created[0]!.dispose).not.toHaveBeenCalled();

    viewer.render();
    expect(created[0]!.render).toHaveBeenCalledTimes(2);
    expect(created[1]!.render).not.toHaveBeenCalled();

    viewer.dispose();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("clears the background immediately on setPanorama(null) and releases late in-flight renderers", async () => {
    const inFlight = deferred<void>();
    const created = useMockPanoramaPlugin([async () => {}, () => inFlight.promise]);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    await viewer.setPanorama(createReadyImage());
    viewer.render();
    expect(created[0]!.render).toHaveBeenCalledTimes(1);

    const pendingUpdate = viewer.setPanorama(createReadyImage());
    await waitForCondition(() => created.length === 2);

    await viewer.setPanorama(null);

    // Explicit clear is immediate: previous background disposed and not rendered.
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
    viewer.render();
    expect(created[0]!.render).toHaveBeenCalledTimes(1);

    // The superseded renderer must be released when its load finally completes.
    inFlight.resolve();
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);

    viewer.render();
    expect(created[1]!.render).not.toHaveBeenCalled();

    viewer.dispose();
  });

  it("does not throw when a superseded setPanorama request fails", async () => {
    const stale = deferred<void>();
    const created = useMockPanoramaPlugin([
      async () => {
        await stale.promise;
        throw new Error("stale panorama failed");
      },
      async () => {},
    ]);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    const firstUpdate = viewer.setPanorama(createReadyImage());
    await waitForCondition(() => created.length === 1);
    const secondUpdate = viewer.setPanorama(createReadyImage());
    await waitForCondition(() => created.length === 2);
    await secondUpdate;

    stale.resolve();
    await expect(firstUpdate).resolves.toBeUndefined();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);

    viewer.render();
    expect(created[1]!.render).toHaveBeenCalledTimes(1);
    expect(created[0]!.render).not.toHaveBeenCalled();

    viewer.dispose();
  });

  it("releases background renderers that complete after dispose without throwing", async () => {
    const inFlight = deferred<void>();
    const created = useMockPanoramaPlugin([() => inFlight.promise]);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    const pendingUpdate = viewer.setPanorama(createReadyImage());
    await waitForCondition(() => created.length === 1);

    viewer.dispose();

    inFlight.resolve();
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows setPanorama failures that arrive after dispose", async () => {
    const inFlight = deferred<void>();
    const created = useMockPanoramaPlugin([
      async () => {
        await inFlight.promise;
        throw new Error("late panorama failure");
      },
    ]);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    const pendingUpdate = viewer.setPanorama(createReadyImage());
    await waitForCondition(() => created.length === 1);

    viewer.dispose();

    inFlight.resolve();
    await expect(pendingUpdate).resolves.toBeUndefined();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
  });
});
