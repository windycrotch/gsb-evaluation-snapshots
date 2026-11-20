import assert from "node:assert/strict";
import { Color, PerspectiveCamera } from "three";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";
import GTVBAODenoiseNode from "../src/GTVBAODenoiseNode.js";
import GTVBAOTemporalNode from "../src/GTVBAOTemporalNode.js";
import { getGtvbaoFragmentVariantKey } from "../src/GTVBAOFragmentNode.js";
import { GTVBAO_PRESETS, applyGtvbaoPreset } from "../src/GTVBAOPresets.js";

// These tests drive preset switches as convergent sessions against a fake
// renderer: every preset application must leave the AO node, the depth-MIP
// prefilter, the denoiser and the textures the lit pass reads on the same
// configuration in a single frame, re-switches must resolve to the last
// request, unknown presets must keep the previous working state, and nothing
// may touch released resources after disposal.

const VIEWPORT = { width: 320, height: 180 };
const TEMPORAL_ROTATIONS = [60, 300, 180, 240, 120, 0];

type Preset = (typeof GTVBAO_PRESETS)["Balanced"];

interface AoInternals {
  _aoRenderTarget: { width: number; height: number };
  _debugRenderTarget: { width: number; height: number };
  _depthPrefilter: { _textures: unknown[]; compute(renderer: unknown): void };
  _fragmentContext: object | null;
  _material: object;
  _materials: Map<string, object>;
  _refreshMaterialFragmentNode(): void;
  _temporalDirection: { value: number };
  _temporalOffset: { value: number };
  _upsampleEnabled: { value: number };
  _upsampleJitter: { value: number };
}

interface DenoiseInternals {
  _fragmentLinearDepthNode: unknown;
}

function aoInternals(node: GTVBAONode) {
  return node as unknown as AoInternals;
}

function createRig() {
  const camera = new PerspectiveCamera();
  const aoNode = new GTVBAONode(uniform(1) as never, null, camera);
  const denoiseNode = new GTVBAODenoiseNode(aoNode.getTextureNode(), uniform(1) as never, null, camera, {
    linearDepthSource: aoNode,
  });
  const temporalNode = new GTVBAOTemporalNode(aoNode.getTextureNode(), uniform(1) as never, aoNode);
  // Simulate a built pipeline so variant switches select compiled materials and
  // the denoiser tracks the depth-MIP binding.
  const ao = aoInternals(aoNode);
  ao._fragmentContext = {};
  ao._refreshMaterialFragmentNode();
  denoiseNode.setup({ getSharedContext: () => ({}), renderer: { logarithmicDepthBuffer: false } } as never);
  let invalidations = 0;
  aoNode.setVariantChangeCallback(() => {
    invalidations += 1;
  });
  return {
    aoNode,
    denoiseNode,
    temporalNode,
    get invalidations() {
      return invalidations;
    },
  };
}

function createFakeRenderer(width = VIEWPORT.width, height = VIEWPORT.height) {
  const state = {
    computes: 0,
    copies: 0,
    renderTarget: null as unknown,
    renders: [] as { material: unknown; name: string }[],
  };
  const renderer = {
    autoClear: true,
    outputColorSpace: "",
    toneMapping: 0,
    toneMappingExposure: 1,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) => target.set(width, height),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => state.renderTarget,
    getScissorTest: () => false,
    compute: () => {
      state.computes += 1;
    },
    copyTextureToTexture: () => {
      state.copies += 1;
    },
    initRenderTarget: () => {},
    render(quad: { material: unknown; name: string }) {
      state.renders.push({ material: quad.material, name: quad.name });
    },
    setClearColor: () => {},
    setMRT: () => {},
    setPixelRatio: () => {},
    setRenderObjectFunction: () => {},
    setRenderTarget: (target: unknown) => {
      state.renderTarget = target;
    },
    setScissorTest: () => {},
  };
  return { renderer, state };
}

function renderFrame(rig: ReturnType<typeof createRig>, renderer: unknown, frameId: number) {
  const frame = { frameId, renderer };
  (rig.aoNode as unknown as { updateBefore(f: unknown): void }).updateBefore(frame);
  (rig.temporalNode as unknown as { updateBefore(f: unknown): void }).updateBefore(frame);
  (rig.denoiseNode as unknown as { updateBefore(f: unknown): void }).updateBefore(frame);
}

// Asserts that one frame after a preset application every stage reads the new
// tier's configuration: AO resolution, depth MIPs, upsample and jitter gates,
// temporal phase, denoiser settings and the selected AO material.
function expectConvergedToPreset(
  rig: ReturnType<typeof createRig>,
  rendererState: ReturnType<typeof createFakeRenderer>["state"],
  preset: Preset,
  frameId: number
) {
  const { aoNode, denoiseNode } = rig;
  const ao = aoInternals(aoNode);
  const aoWidth = Math.max(1, Math.round(VIEWPORT.width * preset.resolutionScale));
  const aoHeight = Math.max(1, Math.round(VIEWPORT.height * preset.resolutionScale));

  // The AO pass rendered this frame, into the new tier's target.
  const aoRender = rendererState.renders.find((render) => render.name === "GTVBAO");
  assert.ok(aoRender, "AO pass did not render");
  assert.equal(aoRender.material, ao._material);
  assert.equal(ao._materials.get(getGtvbaoFragmentVariantKey(aoNode, false)), ao._material);
  assert.equal(ao._aoRenderTarget.width, aoWidth);
  assert.equal(ao._aoRenderTarget.height, aoHeight);
  assert.equal(aoNode.getTextureNode().value, (aoNode as never as { _aoRenderTarget: { texture: unknown } })._aoRenderTarget.texture);

  // The linear-depth MIP chain matches the new tier, or is fully released.
  const mipZero = aoNode.getDepthMipNodes()[0] as unknown as { value: { image: { width: number; height: number } } };
  if (preset.useDepthMips) {
    assert.equal(mipZero.value.image.width, aoWidth);
    assert.equal(mipZero.value.image.height, aoHeight);
  } else {
    assert.equal(mipZero.value.image.width, 1);
    assert.equal(mipZero.value.image.height, 1);
  }

  // Depth-aware upsample and jitter gates reflect the new tier this frame.
  const upsampleActive = aoNode.isDepthAwareUpsampleActive();
  assert.equal(upsampleActive, preset.resolutionScale < 1 && preset.useDepthMips);
  assert.equal(ao._upsampleEnabled.value, upsampleActive ? 1 : 0);
  assert.equal(ao._upsampleJitter.value, preset.temporal && upsampleActive ? aoNode.upsampleJitter : 0);
  assert.equal(ao._temporalDirection.value, preset.temporal ? TEMPORAL_ROTATIONS[frameId % 6] / 360 : 1);
  assert.equal(ao._temporalOffset.value, preset.temporal ? [0, 0.5, 0.25, 0.75][frameId % 4] : 1);

  // The denoiser settled on the new tier: radius, rotation and whether it
  // samples the depth MIPs (never a released texture).
  const denoise = denoiseNode as unknown as DenoiseInternals;
  assert.equal(denoiseNode.radius.value, preset.denoiseRadius);
  assert.equal(denoiseNode.useTemporalDenoiseRotation, preset.temporal && preset.denoise);
  assert.equal(denoise._fragmentLinearDepthNode, preset.useDepthMips ? aoNode.getDepthMipNodes()[0] : null);
}

test("GTVBAO preset sequence converges each tier in a single frame", () => {
  const rig = createRig();
  const { renderer, state } = createFakeRenderer();
  const sequence: (string | Preset)[] = [
    "Balanced",
    "High",
    "No Temporal High",
    "No Temporal Low",
    // No Temporal -> temporal: the tier that used to show hard shadow edges.
    "Low",
    // Releasing and reallocating the depth MIPs mid-sequence.
    { ...GTVBAO_PRESETS.Balanced, useDepthMips: false },
    "Balanced",
  ];

  let frameId = 0;
  for (const preset of sequence) {
    const resolved = applyGtvbaoPreset(rig.aoNode, preset as never, rig.denoiseNode);
    assert.equal(rig.invalidations, frameId + 1);
    state.renders.length = 0;
    renderFrame(rig, renderer, frameId);
    expectConvergedToPreset(rig, state, resolved, frameId);
    frameId += 1;
  }

  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();
});

test("GTVBAO re-switches before a frame settles resolve to the last request", () => {
  const rig = createRig();
  const { renderer, state } = createFakeRenderer();

  applyGtvbaoPreset(rig.aoNode, "High", rig.denoiseNode);
  applyGtvbaoPreset(rig.aoNode, "No Temporal Low", rig.denoiseNode);
  applyGtvbaoPreset(rig.aoNode, "Balanced", rig.denoiseNode);
  assert.equal(rig.invalidations, 3);

  // No frame ran between the switches: the first frame must already be the
  // last requested tier, with no trace of the intermediate ones.
  renderFrame(rig, renderer, 0);
  expectConvergedToPreset(rig, state, GTVBAO_PRESETS.Balanced, 0);

  // Switching away and back within one frame is equally final.
  applyGtvbaoPreset(rig.aoNode, "No Temporal High", rig.denoiseNode);
  applyGtvbaoPreset(rig.aoNode, "Low", rig.denoiseNode);
  assert.equal(rig.invalidations, 5);
  state.renders.length = 0;
  renderFrame(rig, renderer, 1);
  expectConvergedToPreset(rig, state, GTVBAO_PRESETS.Low, 1);

  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();
});

test("GTVBAO temporal-only and scale-only preset changes still notify once", () => {
  const rig = createRig();

  applyGtvbaoPreset(rig.aoNode, "Balanced", rig.denoiseNode);
  assert.equal(rig.invalidations, 1);

  // Identical shader variant, different pipeline toggles: consumers still get
  // exactly one reset signal per session, so temporal history does not go stale.
  applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.Balanced, temporal: false }, rig.denoiseNode);
  assert.equal(rig.invalidations, 2);
  assert.equal(rig.aoNode.useTemporalFiltering, false);

  applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.Balanced, resolutionScale: 1 }, rig.denoiseNode);
  assert.equal(rig.invalidations, 3);
  assert.equal(rig.aoNode.resolutionScale, 1);

  // Re-applying the current configuration is a no-op.
  applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.Balanced, resolutionScale: 1 }, rig.denoiseNode);
  assert.equal(rig.invalidations, 3);

  // The session properties notify directly as well, without a shader rebuild.
  const version = rig.aoNode.version;
  rig.aoNode.useTemporalFiltering = false;
  assert.equal(rig.invalidations, 4);
  rig.aoNode.useTemporalFiltering = false;
  assert.equal(rig.invalidations, 4);
  rig.aoNode.resolutionScale = 0.25;
  assert.equal(rig.invalidations, 5);
  assert.equal(rig.aoNode.version, version);

  // Invalid scales are rejected and keep the previous value.
  for (const bad of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    rig.aoNode.resolutionScale = bad;
  }
  assert.equal(rig.aoNode.resolutionScale, 0.25);
  assert.equal(rig.invalidations, 5);

  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();
});

test("GTVBAO unknown or malformed presets keep the previous working state", () => {
  const rig = createRig();
  const { renderer, state } = createFakeRenderer();

  applyGtvbaoPreset(rig.aoNode, "Low", rig.denoiseNode);
  renderFrame(rig, renderer, 0);
  assert.equal(rig.invalidations, 1);
  const snapshot = {
    resolutionScale: rig.aoNode.resolutionScale,
    sliceCount: rig.aoNode.sliceCount.value,
    stepCount: rig.aoNode.stepCount.value,
    radius: rig.aoNode.radius.value,
    thickness: rig.aoNode.thickness.value,
    maxThickness: rig.aoNode.maxThickness.value,
    useTemporalFiltering: rig.aoNode.useTemporalFiltering,
    useDepthMips: rig.aoNode.useDepthMips.value,
    denoiseRadius: rig.denoiseNode.radius.value,
    denoiseRotation: rig.denoiseNode.useTemporalDenoiseRotation,
  };

  assert.throws(() => applyGtvbaoPreset(rig.aoNode, "Ultra" as never, rig.denoiseNode), /Unknown GTVBAO preset/);
  assert.throws(() => applyGtvbaoPreset(rig.aoNode, null as never, rig.denoiseNode), /Unknown GTVBAO preset/);
  assert.throws(
    () => applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.High, stepCount: Number.NaN }, rig.denoiseNode),
    /Invalid GTVBAO preset/
  );
  assert.throws(
    () => applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.High, temporal: "yes" } as never, rig.denoiseNode),
    /Invalid GTVBAO preset/
  );
  assert.throws(
    () => applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.High, resolutionScale: 0 }, rig.denoiseNode),
    /Invalid GTVBAO preset/
  );
  const { useDepthMips: _dropped, ...incomplete } = GTVBAO_PRESETS.High;
  assert.throws(() => applyGtvbaoPreset(rig.aoNode, incomplete as never, rig.denoiseNode), /Invalid GTVBAO preset/);

  // No session started: no notification, no field moved, the node still renders.
  assert.equal(rig.invalidations, 1);
  assert.deepEqual(
    {
      resolutionScale: rig.aoNode.resolutionScale,
      sliceCount: rig.aoNode.sliceCount.value,
      stepCount: rig.aoNode.stepCount.value,
      radius: rig.aoNode.radius.value,
      thickness: rig.aoNode.thickness.value,
      maxThickness: rig.aoNode.maxThickness.value,
      useTemporalFiltering: rig.aoNode.useTemporalFiltering,
      useDepthMips: rig.aoNode.useDepthMips.value,
      denoiseRadius: rig.denoiseNode.radius.value,
      denoiseRotation: rig.denoiseNode.useTemporalDenoiseRotation,
    },
    snapshot
  );
  state.renders.length = 0;
  renderFrame(rig, renderer, 1);
  expectConvergedToPreset(rig, state, GTVBAO_PRESETS.Low, 1);

  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();
});

test("GTVBAO disposal releases prefilter, denoiser and materials and blocks later access", () => {
  const rig = createRig();
  const { renderer, state } = createFakeRenderer();

  applyGtvbaoPreset(rig.aoNode, "Balanced", rig.denoiseNode);
  renderFrame(rig, renderer, 0);
  applyGtvbaoPreset(rig.aoNode, "High", rig.denoiseNode);
  renderFrame(rig, renderer, 1);
  const invalidationsBeforeDispose = rig.invalidations;

  const ao = aoInternals(rig.aoNode);
  const disposedObjects = new Set<object>();
  const track = (object: { addEventListener?: (type: string, listener: () => void) => void }) => {
    object.addEventListener?.("dispose", function (this: object) {
      disposedObjects.add(this);
    });
    return object;
  };
  const materials = [...ao._materials.values(), ao._material].map((material) =>
    track(material as { addEventListener: (type: string, listener: () => void) => void })
  );
  const mipTextures = rig.aoNode
    .getDepthMipNodes()
    .map((mipNode) => track((mipNode as never as { value: object }).value as { addEventListener: (t: string, l: () => void) => void }));
  const prefilter = ao._depthPrefilter;

  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();

  assert.equal(rig.aoNode.isDisposed, true);
  assert.equal(rig.denoiseNode.isDisposed, true);
  assert.equal(rig.temporalNode.isDisposed, true);
  for (const material of materials) assert.ok(disposedObjects.has(material), "material not disposed");
  for (const texture of mipTextures) assert.ok(disposedObjects.has(texture), "depth MIP texture not disposed");
  assert.equal(prefilter._textures.length, 0);
  assert.equal(ao._materials.size, 0);

  // Later frames and edits must not touch the released objects.
  const renders = state.renders.length;
  const computes = state.computes;
  renderFrame(rig, renderer, 2);
  prefilter.compute(renderer);
  assert.equal(state.renders.length, renders);
  assert.equal(state.computes, computes);

  rig.aoNode.setSize(640, 360);
  assert.equal(ao._aoRenderTarget.width, 320);
  rig.aoNode.stepCount.value = 4;
  rig.aoNode.resolutionScale = 1;
  rig.aoNode.useTemporalFiltering = false;
  assert.equal(rig.invalidations, invalidationsBeforeDispose);
  assert.equal(ao._materials.size, 0);
  assert.throws(() => applyGtvbaoPreset(rig.aoNode, "Low", rig.denoiseNode), /disposed/);

  // Disposal is idempotent.
  rig.aoNode.dispose();
  rig.denoiseNode.dispose();
  rig.temporalNode.dispose();
});
