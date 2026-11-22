import assert from "node:assert/strict";
import { Color, type EventDispatcher, PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAODenoiseNode, {
  type GTVBAODenoiseOptions,
  type SampleableTextureNode,
} from "../src/GTVBAODenoiseNode.js";

test("GTVBAODenoiseNode keeps a fixed denoise kernel by default", () => {
  const node = createDenoiseNode();
  const renderer = createFakeRenderer();
  node.index.value = 2;

  updateDenoiseNode(node, { frameId: 7, renderer });
  assert.equal(node.index.value, 2);
  assert.equal(renderer.renderCount, 1);

  node.dispose();
});

test("GTVBAODenoiseNode rotates its denoise kernel when enabled", () => {
  const node = createDenoiseNode({ useTemporalDenoiseRotation: true });
  const renderer = createFakeRenderer();

  updateDenoiseNode(node, { frameId: 7, renderer });
  assert.equal(node.index.value, 3);
  updateDenoiseNode(node, { frameId: 8, renderer });
  assert.equal(node.index.value, 0);
  assert.equal(renderer.renderCount, 2);

  node.dispose();
});

test("GTVBAODenoiseNode stores the normal encoding option", () => {
  const node = createDenoiseNode({ normalEncoding: "directionToColor" });

  assert.equal(node.normalEncoding, "directionToColor");

  node.dispose();
});

test("GTVBAODenoiseNode rebuilds its fragment when the AO depth-mips variant changes", () => {
  const linearDepthNode = createTextureNode();
  const linearDepthSource = {
    useDepthMips: { value: true },
    getDepthMipNodes: () => [linearDepthNode],
  };
  const node = createDenoiseNode({
    linearDepthSource: linearDepthSource as never,
  });
  const material = (node as unknown as { _material: { version: number } })._material;
  const renderer = createFakeRenderer();
  const builder = {
    getSharedContext: () => ({}),
    renderer: { logarithmicDepthBuffer: false },
  };

  node.setup(builder as never);
  const builtVersion = material.version;

  updateDenoiseNode(node, { frameId: 1, renderer });
  assert.equal(material.version, builtVersion);

  linearDepthSource.useDepthMips.value = false;
  updateDenoiseNode(node, { frameId: 2, renderer });
  assert.equal(material.version, builtVersion + 1);

  updateDenoiseNode(node, { frameId: 3, renderer });
  assert.equal(material.version, builtVersion + 1);

  linearDepthSource.useDepthMips.value = true;
  updateDenoiseNode(node, { frameId: 4, renderer });
  assert.equal(material.version, builtVersion + 2);

  // Replacing one enabled source with another must update the bound depth.
  const replacementDepthNode = createTextureNode();
  node.linearDepthSource = {
    useDepthMips: { value: true },
    getDepthMipNodes: () => [replacementDepthNode],
  } as never;
  updateDenoiseNode(node, { frameId: 5, renderer });
  assert.equal(material.version, builtVersion + 3);

  updateDenoiseNode(node, { frameId: 6, renderer });
  assert.equal(material.version, builtVersion + 3);

  node.dispose();
});

test("GTVBAODenoiseNode keeps its material when setup repeats with unchanged inputs", () => {
  const node = createDenoiseNode();
  const material = (node as unknown as { _material: { version: number } })._material;
  const setupWith = (context: object) =>
    node.setup({ getSharedContext: () => context, renderer: { logarithmicDepthBuffer: false } } as never);

  setupWith({ flag: 1, closure: () => 1, nested: {} });
  const builtVersion = material.version;

  // Each consumer build calls setup with a fresh context holding new closures and nodes.
  setupWith({ flag: 1, closure: () => 2, nested: {} });
  assert.equal(material.version, builtVersion);

  setupWith({ flag: 2, closure: () => 2, nested: {} });
  assert.equal(material.version, builtVersion + 1);

  node.noiseNode = createTextureNode() as never;
  setupWith({ flag: 2 });
  assert.equal(material.version, builtVersion + 2);

  setupWith({ flag: 2 });
  assert.equal(material.version, builtVersion + 2);

  node.dispose();
});

test("GTVBAODenoiseNode does not dispose a user-supplied noise texture", () => {
  const node = createDenoiseNode();
  const userNoise = createTextureNode();
  let userDisposeCount = 0;
  userNoise.value.dispose = () => {
    userDisposeCount += 1;
  };
  node.noiseNode = userNoise;
  node.setup(createFakeBuilder() as never);

  node.dispose();

  assert.equal(node.noiseNode, userNoise);
  assert.equal(userDisposeCount, 0);
});

test("GTVBAODenoiseNode disposes the default noise texture it generated", () => {
  const node = createDenoiseNode();
  assert.equal(node.noiseNode, null);
  node.setup(createFakeBuilder() as never);

  // Re-read through a function so the earlier null assertion does not narrow the type.
  const generated = ((): SampleableTextureNode | null => node.noiseNode)();
  assert.notEqual(generated, null);
  let disposeEvents = 0;
  (generated!.value as unknown as EventDispatcher<{ dispose: object }>).addEventListener("dispose", () => {
    disposeEvents += 1;
  });

  node.dispose();

  assert.equal(disposeEvents, 1);
});

test("GTVBAODenoiseNode rebuilds its fragment after the AO source changes size", () => {
  const source = createTextureNode();
  const node = createDenoiseNodeFrom(source);
  const material = (node as unknown as {
    _material: { version: number };
    _denoiseRenderTarget: { width: number; height: number };
  })._material;
  const target = (node as unknown as { _denoiseRenderTarget: { width: number; height: number } })._denoiseRenderTarget;
  const renderer = createFakeRenderer();
  const builder = {
    getSharedContext: () => ({}),
    renderer: { logarithmicDepthBuffer: false },
  };

  node.setup(builder as never);
  const builtVersion = material.version;

  // First observation (1x1 source) only sizes the target; the fragment was
  // already built for it in setup().
  updateDenoiseNode(node, { frameId: 1, renderer });
  assert.equal(material.version, builtVersion);
  assert.deepEqual([target.width, target.height], [1, 1]);

  // A real resize rebuilds the fragment and resizes the target once.
  setSourceSize(source, 20, 12);
  updateDenoiseNode(node, { frameId: 2, renderer });
  assert.equal(material.version, builtVersion + 1);
  assert.deepEqual([target.width, target.height], [20, 12]);

  // The same size must neither reallocate nor rebuild.
  updateDenoiseNode(node, { frameId: 3, renderer });
  assert.equal(material.version, builtVersion + 1);
  assert.deepEqual([target.width, target.height], [20, 12]);

  node.dispose();
});

test("GTVBAODenoiseNode keeps the first fragment when the source is sized before setup", () => {
  const source = createTextureNode();
  setSourceSize(source, 16, 8);
  const node = createDenoiseNodeFrom(source);
  const material = (node as unknown as { _material: { version: number } })._material;
  const target = (node as unknown as { _denoiseRenderTarget: { width: number; height: number } })._denoiseRenderTarget;
  const renderer = createFakeRenderer();
  const builder = {
    getSharedContext: () => ({}),
    renderer: { logarithmicDepthBuffer: false },
  };

  node.setup(builder as never);
  const builtVersion = material.version;

  updateDenoiseNode(node, { frameId: 1, renderer });
  assert.equal(material.version, builtVersion, "the initial sizing must not force a rebuild");
  assert.deepEqual([target.width, target.height], [16, 8]);

  node.dispose();
});

test("GTVBAODenoiseNode.dispose is idempotent and keeps the noise texture owned by the caller", () => {
  const node = createDenoiseNode();
  node.setup(createFakeBuilder() as never);
  const userNoise = createTextureNode();
  let userDisposeCount = 0;
  userNoise.value.dispose = () => {
    userDisposeCount += 1;
  };
  node.noiseNode = userNoise;

  assert.doesNotThrow(() => {
    node.dispose();
    node.dispose();
  });
  assert.equal(node.noiseNode, userNoise);
  assert.equal(userDisposeCount, 0);
});

function setSourceSize(source: SampleableTextureNode, width: number, height: number) {
  const image = (source as unknown as { value: { image: { width: number; height: number } } }).value.image;
  image.width = width;
  image.height = height;
}

function createDenoiseNodeFrom(source: ReturnType<typeof createTextureNode>) {
  return new GTVBAODenoiseNode(
    source,
    uniform(1) as never,
    null,
    new PerspectiveCamera()
  );
}

function createFakeBuilder() {
  return {
    getSharedContext: () => ({}),
    renderer: { logarithmicDepthBuffer: false },
  };
}

function createDenoiseNode(options: GTVBAODenoiseOptions = {}) {
  return new GTVBAODenoiseNode(
    createTextureNode(),
    uniform(1) as never,
    null,
    new PerspectiveCamera(),
    options
  );
}

function createTextureNode(): SampleableTextureNode {
  return {
    value: {
      image: { width: 1, height: 1 },
      dispose() {},
    },
    sample: () => uniform(1) as never,
  } as unknown as SampleableTextureNode;
}

function updateDenoiseNode(node: GTVBAODenoiseNode, frame: unknown) {
  (node as unknown as { updateBefore(frame: unknown): void }).updateBefore(frame);
}

function createFakeRenderer() {
  let renderTarget: unknown = null;
  return {
    autoClear: true,
    outputColorSpace: "",
    renderCount: 0,
    toneMapping: 0,
    toneMappingExposure: 1,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => renderTarget,
    getScissorTest: () => false,
    render() {
      this.renderCount += 1;
    },
    setClearColor: () => {},
    setMRT: () => {},
    setPixelRatio: () => {},
    setRenderObjectFunction: () => {},
    setRenderTarget: (target: unknown) => {
      renderTarget = target;
    },
    setScissorTest: () => {},
  };
}
