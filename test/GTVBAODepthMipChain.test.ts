import assert from "node:assert/strict";
import { OrthographicCamera, PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

type MipTexture = { image: { width: number; height: number }; addEventListener(type: "dispose", listener: () => void): void };
type MipNode = { value: MipTexture };

const PLACEHOLDER_SIZE = 1;

function createNode(options: { resolutionScale?: number; useDepthMips?: boolean } = {}) {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera(), options);
}

function mipNodes(node: GTVBAONode) {
  return node.getDepthMipNodes() as unknown as MipNode[];
}

function mipSizes(node: GTVBAONode) {
  return mipNodes(node).map(({ value }) => [value.image.width, value.image.height]);
}

function mipTextures(node: GTVBAONode) {
  return mipNodes(node).map(({ value }) => value);
}

function isPlaceholders(node: GTVBAONode) {
  return mipSizes(node).every(([width, height]) => width === PLACEHOLDER_SIZE && height === PLACEHOLDER_SIZE);
}

test("depth MIP chain level sizes track the drawing buffer size", () => {
  const node = createNode({ resolutionScale: 0.5 });
  node.setSize(640, 360);
  assert.deepEqual(mipSizes(node), [[320, 180], [160, 90], [80, 45], [40, 23], [20, 12]]);

  node.setSize(800, 600);
  assert.deepEqual(mipSizes(node), [[400, 300], [200, 150], [100, 75], [50, 38], [25, 19]]);

  node.dispose();
});

test("depth MIP chain reallocates when resolutionScale changes and points at new textures", () => {
  const node = createNode();
  node.resolutionScale = 0.5;
  node.setSize(640, 360);
  const halfTextures = mipTextures(node);
  assert.deepEqual(mipSizes(node)[0], [320, 180]);

  node.resolutionScale = 0.25;
  node.setSize(640, 360);
  const quarterTextures = mipTextures(node);
  assert.deepEqual(mipSizes(node)[0], [160, 90]);
  // Every level must reference the newly allocated texture, never the old one.
  assert.equal(quarterTextures.length, halfTextures.length);
  for (const oldTexture of halfTextures) {
    assert.equal(quarterTextures.includes(oldTexture), false, "old level texture is still referenced after a scale change");
  }

  node.dispose();
});

test("depth MIP chain reallocates on a projection-only change at a fixed drawing buffer size", () => {
  const node = createNode({ resolutionScale: 0.5 });
  const camera = (node as unknown as { _camera: PerspectiveCamera })._camera;
  node.setSize(640, 360);
  const before = mipTextures(node);
  const beforeSizes = mipSizes(node);

  // Same dimensions, changed projection (zoom): the AO render target keeps its
  // size, but the encoded depth the chain holds changes, so it must rebuild.
  camera.zoom = 2;
  camera.updateProjectionMatrix();
  node.setSize(640, 360);
  const after = mipTextures(node);

  assert.deepEqual(mipSizes(node), beforeSizes, "level dimensions stay the same at a fixed size");
  for (const oldTexture of before) {
    assert.equal(after.includes(oldTexture), false, "old level texture survives a projection change");
  }

  // Repeating the same size with an unchanged projection reuses the chain.
  node.setSize(640, 360);
  assert.deepEqual(mipTextures(node), after);

  node.dispose();
});

test("depth MIP chain rebuilds and the orthographic flag flips when switching cameras", () => {
  const node = createNode({ resolutionScale: 0.5 });
  node.setSize(640, 360);
  const perspectiveTextures = mipTextures(node);
  const prefilter = (node as unknown as {
    _depthPrefilter: { _isOrthographicCamera: boolean };
  })._depthPrefilter;
  assert.equal(prefilter._isOrthographicCamera, false);

  const orthographic = new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
  orthographic.updateProjectionMatrix();
  node.setCamera(orthographic);
  assert.equal(prefilter._isOrthographicCamera, true);
  assert.equal((node as unknown as { _isOrthographicCamera: boolean })._isOrthographicCamera, true);

  // setCamera marks the chain stale; the next setSize rebuilds it even though
  // the drawing buffer (and thus every level size) is unchanged.
  node.setSize(640, 360);
  const orthographicTextures = mipTextures(node);
  for (const oldTexture of perspectiveTextures) {
    assert.equal(orthographicTextures.includes(oldTexture), false, "perspective-era texture survives the camera switch");
  }

  // And back to perspective.
  const perspective = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  perspective.updateProjectionMatrix();
  node.setCamera(perspective);
  node.setSize(640, 360);
  assert.equal(prefilter._isOrthographicCamera, false);
  for (const oldTexture of orthographicTextures) {
    assert.equal(mipTextures(node).includes(oldTexture), false, "orthographic-era texture survives the camera switch");
  }

  node.dispose();
});

test("setCamera rebinds the near/far reference nodes and inverse projection to the new camera", () => {
  const node = createNode();
  const internals = node as unknown as {
    _camera: PerspectiveCamera;
    _cameraNear: { object: unknown };
    _cameraFar: { object: unknown };
    _cameraProjectionMatrixInverse: { value: unknown };
  };
  const orthographic = new OrthographicCamera(-2, 2, 2, -2, 0.5, 50);
  orthographic.updateProjectionMatrix();
  node.setCamera(orthographic);

  assert.equal(internals._camera, orthographic);
  assert.equal(internals._cameraNear.object, orthographic);
  assert.equal(internals._cameraFar.object, orthographic);
  assert.equal(internals._cameraProjectionMatrixInverse.value, orthographic.projectionMatrixInverse);

  node.dispose();
});

test("turning useDepthMips off releases the chain and on rebuilds it at the current size", () => {
  const node = createNode({ resolutionScale: 0.5 });
  node.setSize(640, 360);
  assert.equal(isPlaceholders(node), false);
  const onTextures = mipTextures(node);
  const disposed = new Set<MipTexture>();
  for (const texture of onTextures) texture.addEventListener("dispose", () => disposed.add(texture));

  node.useDepthMips.value = false;
  node.setSize(640, 360);
  assert.equal(isPlaceholders(node), true, "texture nodes fall back to placeholders while MIPs are off");
  assert.equal(disposed.size, onTextures.length, "all chain textures are released");

  // Re-enabling rebuilds the chain for the current AO resolution with new textures.
  node.useDepthMips.value = true;
  node.setSize(640, 360);
  assert.equal(isPlaceholders(node), false);
  assert.deepEqual(mipSizes(node)[0], [320, 180]);
  const rebuilt = mipTextures(node);
  for (const oldTexture of onTextures) {
    assert.equal(rebuilt.includes(oldTexture), false, "rebuilt chain reuses a released texture");
  }

  node.dispose();
});
