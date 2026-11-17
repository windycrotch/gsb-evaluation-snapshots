/**
 * Headless tests for hot-updatable `resolutionScale` handling in `GodraysPass`.
 *
 * These tests never touch WebGL: they instantiate the pass and assert on the
 * sizes of its render targets and the compositor's recorded `godraysResolution`.
 * The internal fields are reached via a typed structural cast so the tests keep
 * compiling when private members are renamed.
 *
 * Run via `npm test` (bundled with esbuild, then executed with the Node.js
 * built-in test runner).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KernelSize } from 'postprocessing';
import * as THREE from 'three';

import { GODRAYS_BLUR_RESOLUTION_SCALE, type BilateralFilterPass } from '../src/bilateralFilter';
import { GodraysPass, type GodraysPassParams } from '../src/index';

interface PassInternals {
  godraysRenderTarget: THREE.WebGLRenderTarget;
  blurPass: BilateralFilterPass | null;
  blurRenderTarget: THREE.WebGLRenderTarget | null;
  compositorPass: {
    fullscreenMaterial: {
      uniforms: {
        godraysResolution: { value: THREE.Vector2 };
        resolution: { value: THREE.Vector2 };
      };
    };
  };
  illumPass: {
    material: { uniforms: { resolution: { value: THREE.Vector2 } } };
  };
  lastParams: GodraysPassParams;
  maybeInitBlur: (input: THREE.Texture) => void;
}

const internals = (pass: GodraysPass): PassInternals => pass as unknown as PassInternals;

const expectedGodrays = (width: number, height: number, scale: number) => ({
  width: Math.ceil(width * scale),
  height: Math.ceil(height * scale),
});

const expectedBlur = (width: number, height: number, scale: number) => {
  const g = expectedGodrays(width, height, scale);
  return {
    width: Math.ceil(g.width * GODRAYS_BLUR_RESOLUTION_SCALE),
    height: Math.ceil(g.height * GODRAYS_BLUR_RESOLUTION_SCALE),
  };
};

/**
 * Asserts that every existing target in the pipeline agrees on the dimensions
 * implied by the given viewport size and resolution scale. Targets that are
 * lazily created (blur pass / blur render target) are only checked once they
 * exist.
 */
const assertTargetSizes = (
  pass: GodraysPass,
  viewport: { width: number; height: number },
  scale: number,
  expectBlur: boolean
): void => {
  const p = internals(pass);
  const g = expectedGodrays(viewport.width, viewport.height, scale);
  const b = expectedBlur(viewport.width, viewport.height, scale);

  assert.equal(p.godraysRenderTarget.width, g.width, 'godrays RT width');
  assert.equal(p.godraysRenderTarget.height, g.height, 'godrays RT height');
  // The backing texture must track the render target size.
  assert.equal((p.godraysRenderTarget.texture.image as { width: number }).width, g.width);
  assert.equal((p.godraysRenderTarget.texture.image as { height: number }).height, g.height);

  assert.deepEqual(
    {
      width: p.illumPass.material.uniforms.resolution.value.x,
      height: p.illumPass.material.uniforms.resolution.value.y,
    },
    g,
    'illum pass resolution uniform'
  );

  // The compositor must record exactly the same low-resolution size as the
  // illumination target so upsampling samples line up.
  assert.deepEqual(
    {
      width: p.compositorPass.fullscreenMaterial.uniforms.godraysResolution.value.x,
      height: p.compositorPass.fullscreenMaterial.uniforms.godraysResolution.value.y,
    },
    g,
    'compositor godraysResolution'
  );
  assert.deepEqual(
    {
      width: p.compositorPass.fullscreenMaterial.uniforms.resolution.value.x,
      height: p.compositorPass.fullscreenMaterial.uniforms.resolution.value.y,
    },
    viewport,
    'compositor full-resolution uniform'
  );

  if (expectBlur) {
    assert.ok(p.blurPass, 'blur pass should have been created');
    assert.ok(p.blurRenderTarget, 'blur render target should have been created');
    assert.deepEqual(
      { width: p.blurRenderTarget!.width, height: p.blurRenderTarget!.height },
      b,
      'blur render target size (including blur scale factor)'
    );
    assert.deepEqual(
      {
        width: p.blurPass!.material.uniforms.resolution.value.x,
        height: p.blurPass!.material.uniforms.resolution.value.y,
      },
      g,
      'blur pass resolution uniform'
    );
  }
};

const createPass = (resolutionScale: number): GodraysPass => {
  const light = new THREE.PointLight();
  const camera = new THREE.PerspectiveCamera();
  return new GodraysPass(light, camera, { resolutionScale });
};

describe('GodraysPass resolutionScale hot updates', () => {
  it('resizes the illumination target and compositor resolution when the scale changes via setParams', () => {
    const pass = createPass(0.5);
    const viewport = { width: 800, height: 600 };
    pass.setSize(viewport.width, viewport.height);
    assertTargetSizes(pass, viewport, 0.5, false);

    for (const scale of [0.25, 1.0, 0.5, 0.25, 1.0]) {
      pass.setParams({ resolutionScale: scale });
      assert.equal(internals(pass).lastParams.resolutionScale, scale);
      assertTargetSizes(pass, viewport, scale, false);
    }
  });

  it('produces ceil(w*scale) x ceil(h*scale) for scales 0.25, 0.5 and 1.0, including odd viewports', () => {
    const pass = createPass(0.5);
    // Odd viewport so rounding actually matters.
    const viewport = { width: 801, height: 599 };
    for (const scale of [0.25, 0.5, 1.0]) {
      pass.setSize(viewport.width, viewport.height);
      pass.setParams({ resolutionScale: scale });
      assertTargetSizes(pass, viewport, scale, false);
    }
  });

  it('creates the blur pass at the current size on first use and keeps it in sync across scale changes', () => {
    const pass = createPass(0.5);
    const viewport = { width: 800, height: 600 };
    pass.setSize(viewport.width, viewport.height);

    // Blur resources are lazily created only when rendering needs them.
    const p = internals(pass);
    assert.equal(p.blurPass, null);
    assert.equal(p.blurRenderTarget, null);

    // Switch scale *before* the blur pass exists: it must be initialized at the
    // new 0.25 size rather than the old 0.5 size.
    pass.setParams({ resolutionScale: 0.25 });
    p.maybeInitBlur(p.godraysRenderTarget.texture);
    assertTargetSizes(pass, viewport, 0.25, true);

    for (const scale of [0.5, 1.0, 0.25]) {
      pass.setParams({ resolutionScale: scale });
      assertTargetSizes(pass, viewport, scale, true);
    }
  });

  it('re-sizes the blur render target through its scale factor on viewport changes', () => {
    const pass = createPass(0.5);
    pass.setSize(1024, 768);
    const p = internals(pass);
    p.maybeInitBlur(p.godraysRenderTarget.texture);
    assertTargetSizes(pass, { width: 1024, height: 768 }, 0.5, true);

    pass.setSize(640, 480);
    assertTargetSizes(pass, { width: 640, height: 480 }, 0.5, true);

    pass.setParams({ resolutionScale: 1.0 });
    assertTargetSizes(pass, { width: 640, height: 480 }, 1.0, true);
  });

  it('stays consistent for every interleaving of setSize and setParams', () => {
    const viewportA = { width: 800, height: 600 };
    const viewportB = { width: 1280, height: 720 };

    // setParams first, then setSize.
    {
      const pass = createPass(0.5);
      pass.setParams({ resolutionScale: 0.25 });
      pass.setSize(viewportA.width, viewportA.height);
      assertTargetSizes(pass, viewportA, 0.25, false);
    }

    // setSize first, then setParams.
    {
      const pass = createPass(0.5);
      pass.setSize(viewportA.width, viewportA.height);
      pass.setParams({ resolutionScale: 1.0 });
      assertTargetSizes(pass, viewportA, 1.0, false);
    }

    // Alternating calls with both scale and viewport changing.
    {
      const pass = createPass(0.5);
      pass.setSize(viewportA.width, viewportA.height);
      pass.setParams({ resolutionScale: 0.25 });
      pass.setSize(viewportB.width, viewportB.height);
      pass.setParams({ resolutionScale: 1.0 });
      pass.setSize(viewportA.width, viewportA.height);
      pass.setParams({ resolutionScale: 0.5 });
      assertTargetSizes(pass, viewportA, 0.5, false);
    }

    // Same interleaving but with the blur pass already initialized.
    {
      const pass = createPass(0.5);
      pass.setSize(viewportA.width, viewportA.height);
      const p = internals(pass);
      p.maybeInitBlur(p.godraysRenderTarget.texture);
      pass.setParams({ resolutionScale: 0.25 });
      pass.setSize(viewportB.width, viewportB.height);
      pass.setParams({ resolutionScale: 1.0 });
      assertTargetSizes(pass, viewportB, 1.0, true);
    }

    // Two setSize calls in a row and two setParams calls in a row.
    {
      const pass = createPass(0.5);
      pass.setSize(viewportA.width, viewportA.height);
      pass.setSize(viewportB.width, viewportB.height);
      pass.setParams({ resolutionScale: 0.25 });
      pass.setParams({ resolutionScale: 0.25 });
      assertTargetSizes(pass, viewportB, 0.25, false);
    }
  });

  it('rejects parameters containing both raymarchSteps and adaptiveSteps without mutating any state', () => {
    const pass = createPass(0.5);
    const viewport = { width: 800, height: 600 };
    pass.setSize(viewport.width, viewport.height);
    const p = internals(pass);

    // Snapshot the valid state before the invalid call.
    const snapshot = {
      scale: p.lastParams.resolutionScale,
      raymarchSteps: p.lastParams.raymarchSteps,
      rtWidth: p.godraysRenderTarget.width,
      rtHeight: p.godraysRenderTarget.height,
      compositorWidth: p.compositorPass.fullscreenMaterial.uniforms.godraysResolution.value.x,
    };

    assert.throws(
      () =>
        pass.setParams({
          raymarchSteps: 42,
          adaptiveSteps: { stepSize: 2.0 },
        }),
      /Cannot specify both raymarchSteps and adaptiveSteps/
    );

    // Nothing changed: params and every target keep the previous valid state.
    assert.equal(p.lastParams.resolutionScale, snapshot.scale);
    assert.equal(p.lastParams.raymarchSteps, snapshot.raymarchSteps);
    assert.equal(p.godraysRenderTarget.width, snapshot.rtWidth);
    assert.equal(p.godraysRenderTarget.height, snapshot.rtHeight);
    assert.equal(
      p.compositorPass.fullscreenMaterial.uniforms.godraysResolution.value.x,
      snapshot.compositorWidth
    );
    assertTargetSizes(pass, viewport, snapshot.scale, false);

    // A failed update must not poison subsequent valid updates.
    pass.setParams({ resolutionScale: 0.25 });
    assertTargetSizes(pass, viewport, 0.25, false);

    // And rejection still applies once the blur pass exists, with blur targets
    // also left untouched.
    p.maybeInitBlur(p.godraysRenderTarget.texture);
    const blurWidthBefore = p.blurRenderTarget!.width;
    assert.throws(
      () =>
        pass.setParams({
          raymarchSteps: 7,
          adaptiveSteps: { stepSize: 1.0 },
          resolutionScale: 1.0,
        }),
      /Cannot specify both raymarchSteps and adaptiveSteps/
    );
    assert.equal(p.lastParams.resolutionScale, 0.25);
    assert.equal(p.blurRenderTarget!.width, blurWidthBefore);
    assertTargetSizes(pass, viewport, 0.25, true);
  });

  it('continues to support kernel-size changes while hot-updating the scale', () => {
    const pass = createPass(0.5);
    const viewport = { width: 800, height: 600 };
    pass.setSize(viewport.width, viewport.height);
    const p = internals(pass);
    p.maybeInitBlur(p.godraysRenderTarget.texture);

    pass.setParams({
      resolutionScale: 0.25,
      blur: { variance: 0.2, kernelSize: KernelSize.MEDIUM },
    });
    assertTargetSizes(pass, viewport, 0.25, true);
    assert.equal(p.blurPass!.material.defines.KSIZE_ENUM, KernelSize.MEDIUM);

    pass.setParams({
      resolutionScale: 1.0,
      blur: { variance: 0.2, kernelSize: KernelSize.LARGE },
    });
    assertTargetSizes(pass, viewport, 1.0, true);
    assert.equal(p.blurPass!.material.defines.KSIZE_ENUM, KernelSize.LARGE);
  });
});
