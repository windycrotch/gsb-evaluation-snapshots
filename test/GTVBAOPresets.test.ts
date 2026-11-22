import assert from "node:assert/strict";
import { DataTexture, PerspectiveCamera, RedFormat, FloatType } from "three";
import { texture, uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";
import type GTVBAODenoiseNode from "../src/GTVBAODenoiseNode.js";
import { gtvbaoTemporal } from "../src/GTVBAOTemporalNode.js";
import {
  DEFAULT_GTVBAO_PRESET,
  GTVBAO_PRESETS,
  GTVBAO_PRESET_NAMES,
  applyGtvbaoPreset,
} from "../src/GTVBAOPresets.js";

test("GTVBAO balanced preset matches the design default", () => {
  const preset = GTVBAO_PRESETS[DEFAULT_GTVBAO_PRESET];

  assert.equal(DEFAULT_GTVBAO_PRESET, "Balanced");
  assert.equal(preset.resolutionScale, 0.5);
  assert.equal(preset.sliceCount, 2);
  assert.equal(preset.stepCount, 6);
  assert.equal(preset.radius, 3);
  assert.equal(preset.thickness, 0.12);
  assert.equal(preset.aoIntensity, 1);
  assert.equal(preset.expFactor, 2);
  assert.equal(preset.useScreenSpaceSampling, true);
  assert.equal(preset.useLinearThickness, true);
  assert.equal(preset.linearThicknessScale, 100);
  assert.equal(preset.maxThickness, 1);
  assert.equal(preset.temporal, true);
  assert.equal(preset.denoise, false);
  assert.equal(preset.sectorMeasure, "cosine");
  assert.equal(preset.usePerspectiveCorrectSlice, true);
  assert.equal(preset.useDepthMips, true);
});

test("GTVBAO high presets use a thin clamped thickness with the cosine sector measure", () => {
  for (const name of ["High", "No Temporal High"] as const) {
    const preset = GTVBAO_PRESETS[name];

    assert.equal(preset.thickness, 0.08);
    assert.equal(preset.maxThickness, 0.35);
    assert.equal(preset.sectorMeasure, "cosine");
  }
});

test("GTVBAO no-temporal presets use denoise by default", () => {
  for (const name of ["No Temporal Low", "No Temporal High"] as const) {
    const preset = GTVBAO_PRESETS[name];

    assert.equal(preset.temporal, false);
    assert.equal(preset.denoise, true);
  }
});

test("GTVBAO presets mark which ones expect a temporal accumulation pass", () => {
  const accumulating = Object.entries(GTVBAO_PRESETS).filter(([, preset]) => preset.accumulate).map(([name]) => name);

  assert.deepEqual(accumulating, ["Low", "Balanced"]);
  for (const preset of Object.values(GTVBAO_PRESETS)) assert.equal(typeof preset.accumulate, "boolean");
  assert.equal(GTVBAO_PRESETS[DEFAULT_GTVBAO_PRESET].accumulate, true);
});

test("GTVBAO_PRESET_NAMES lists every preset", () => {
  assert.deepEqual(GTVBAO_PRESET_NAMES, Object.keys(GTVBAO_PRESETS));
});

test("applyGtvbaoPreset applies a preset with one variant rebuild", () => {
  const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
  let invalidations = 0;
  node.setVariantChangeCallback(() => {
    invalidations += 1;
  });
  const denoiseNode = {
    radius: { value: 0 },
    useTemporalDenoiseRotation: false,
  } as unknown as GTVBAODenoiseNode;

  const preset = applyGtvbaoPreset(node, "High", denoiseNode);

  assert.equal(preset, GTVBAO_PRESETS.High);
  assert.equal(invalidations, 1);
  assert.equal(node.resolutionScale, 1);
  assert.equal(node.sliceCount.value, 3);
  assert.equal(node.stepCount.value, 12);
  assert.equal(node.thickness.value, 0.08);
  assert.equal(node.maxThickness.value, 0.35);
  assert.equal(node.useTemporalFiltering, true);
  assert.equal(denoiseNode.radius.value, 2);
  assert.equal(denoiseNode.useTemporalDenoiseRotation, false);
  // `accumulate` only tells the caller which texture to feed the lit pass.
  assert.deepEqual(Object.keys(denoiseNode), ["radius", "useTemporalDenoiseRotation"]);
  assert.equal("accumulate" in node, false);

  applyGtvbaoPreset(node, "No Temporal Low", denoiseNode);

  assert.equal(invalidations, 2);
  assert.equal(node.resolutionScale, 0.5);
  assert.equal(node.stepCount.value, 6);
  assert.equal(node.useTemporalFiltering, false);
  assert.equal(denoiseNode.useTemporalDenoiseRotation, false);

  // A custom preset object works the same way; the denoiser is optional.
  applyGtvbaoPreset(node, { ...GTVBAO_PRESETS.Balanced, sliceCount: 4 });

  assert.equal(invalidations, 3);
  assert.equal(node.sliceCount.value, 4);
  assert.equal(node.useTemporalFiltering, true);

  assert.throws(() => applyGtvbaoPreset(node, "Ultra" as never), /Unknown GTVBAO preset/);

  node.dispose();
});

function createPresetTemporalRig() {
  const dataTexture = (w: number, h: number) => new DataTexture(new Float32Array(w * h), w, h, RedFormat, FloatType);
  const aoTexture = dataTexture(8, 4);
  const depthTexture = dataTexture(8, 4);
  const velocityTexture = dataTexture(8, 4);
  const camera = new PerspectiveCamera(55, 2, 0.1, 100);
  const aoNode = new GTVBAONode(texture(depthTexture), null, camera);
  const temporalNode = gtvbaoTemporal(texture(aoTexture), texture(velocityTexture), aoNode);
  const historyValid = () => (temporalNode as unknown as { _historyValid: { value: number } })._historyValid.value;
  return {
    aoNode,
    temporalNode,
    historyValid,
    dispose() {
      temporalNode.dispose();
      aoNode.dispose();
      for (const value of [aoTexture, depthTexture, velocityTexture]) value.dispose();
    },
  };
}

test("applyGtvbaoPreset drops temporal history once per switch, even at unchanged resolution", () => {
  const rig = createPresetTemporalRig();
  try {
    assert.equal(rig.historyValid(), 0);

    // Simulate an accumulated frame.
    (rig.temporalNode as unknown as { _historyValid: { value: number } })._historyValid.value = 1;
    assert.equal(rig.historyValid(), 1);

    // High and Balanced differ in every shader input but the frame is never
    // rendered here, so the AO render target keeps its 1x1 default size: the
    // reset must come from the preset, not from a size change.
    applyGtvbaoPreset(rig.aoNode, "High");
    assert.equal(rig.historyValid(), 0, "the first preset switch invalidates the history");

    rig.temporalNode.reset();
    (rig.temporalNode as unknown as { _historyValid: { value: number } })._historyValid.value = 1;
    applyGtvbaoPreset(rig.aoNode, "Balanced");
    assert.equal(rig.historyValid(), 0, "the next preset switch invalidates again");

    // Applying an identical preset changes no variant value, so nothing is
    // notified and a valid history must survive.
    rig.temporalNode.reset();
    (rig.temporalNode as unknown as { _historyValid: { value: number } })._historyValid.value = 1;
    applyGtvbaoPreset(rig.aoNode, { ...GTVBAO_PRESETS.Balanced });
    assert.equal(rig.historyValid(), 1);
  } finally {
    rig.dispose();
  }
});

test("applyGtvbaoPreset notifies each registered temporal node exactly once through the batched switch", () => {
  const rig = createPresetTemporalRig();
  let resets = 0;
  const originalReset = rig.temporalNode.reset.bind(rig.temporalNode);
  rig.temporalNode.reset = () => {
    resets += 1;
    originalReset();
  };
  try {
    applyGtvbaoPreset(rig.aoNode, "Low");
    assert.equal(resets, 1, "one batched preset switch resets the history once");
    applyGtvbaoPreset(rig.aoNode, "High");
    assert.equal(resets, 2);
  } finally {
    rig.dispose();
  }
});

test("a disposed AO node unregisters temporal nodes and a disposed temporal node stops receiving resets", () => {
  const rig = createPresetTemporalRig();
  const registered = () => (rig.aoNode as unknown as { _temporalNodes: Set<unknown> })._temporalNodes.size;
  try {
    assert.equal(registered(), 1);
    rig.temporalNode.dispose();
    rig.temporalNode.dispose();
    assert.equal(registered(), 0, "repeated temporal dispose() is safe and unregisters once");
    rig.aoNode.dispose();
    rig.aoNode.dispose();
  } finally {
    // Already disposed above; the rig's own cleanup must not throw either.
    assert.doesNotThrow(() => rig.dispose());
  }
});

test("camera reset() only clears temporal history and leaves resolution and preset inputs alone", () => {
  const rig = createPresetTemporalRig();
  try {
    applyGtvbaoPreset(rig.aoNode, "High");
    const internals = rig.aoNode as unknown as {
      _aoRenderTarget: { width: number; height: number };
      _lastSize: { aoWidth: number; aoHeight: number };
      resolutionScale: number;
    };
    rig.aoNode.setSize(64, 32);
    const targetBefore = [internals._aoRenderTarget.width, internals._aoRenderTarget.height];
    const lastBefore = { ...internals._lastSize };
    (rig.temporalNode as unknown as { _historyValid: { value: number } })._historyValid.value = 1;

    rig.temporalNode.reset();

    assert.equal(rig.historyValid(), 0);
    assert.equal(internals.resolutionScale, 1);
    assert.deepEqual(
      [internals._aoRenderTarget.width, internals._aoRenderTarget.height],
      targetBefore
    );
    assert.deepEqual(internals._lastSize, lastBefore);
  } finally {
    rig.dispose();
  }
});
