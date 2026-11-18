import { describe, expect, it } from 'vitest';

import { MAX_SUPPORTED_EYE_Z, screenHalfExtents } from '../off-axis';
import {
  maxBackgroundSeparationPx,
  eyeDrawStates,
  planOrbitEyes,
  planWindowEyes,
  type StereoMode,
} from '../stereo-plan';

const orbitBase = {
  baseline: 0.12,
  zeroParallaxDistance: 2.5,
  fovYDeg: 50,
  canvasWidthPx: 1920,
  canvasHeightPx: 1080,
  near: 0.05,
  far: 500,
} as const;

const windowBase = {
  eye: { x: 0, y: 0, z: 2.5 },
  baseline: 0.12,
  windowHalfHeight: 0.9,
  canvasWidthPx: 1920,
  canvasHeightPx: 1080,
  near: 0.05,
  far: 500,
} as const;

describe('the orbit pair, as the renderer sees it', () => {
  const left = planOrbitEyes({ ...orbitBase, mode: 'sbs' }).eyes[0];
  const right = planOrbitEyes({ ...orbitBase, mode: 'sbs' }).eyes[1];

  it('has equal vertical extents in both eyes', () => {
    // Vertical disparity is what makes a pair unfusable, and it is absent here
    // by construction rather than by approximation.
    expect(left.frustum.top).toBe(right.frustum.top);
    expect(left.frustum.bottom).toBe(right.frustum.bottom);
    expect(left.frustum.near).toBe(right.frustum.near);
    expect(left.frustum.far).toBe(right.frustum.far);
  });

  it('displaces the eyes only along x, and never rotates them', () => {
    // Each eye is a translation within the rig. Nothing in the placement can
    // express a rotation, which is what rules toe-in out by construction.
    expect(left.position.y).toBe(right.position.y);
    expect(left.position.z).toBe(right.position.z);
    expect(right.position.x - left.position.x).toBeCloseTo(orbitBase.baseline, 12);
  });

  it('gives the eyes the opposite halves of the canvas', () => {
    expect(left.viewport).toEqual({ x: 0, width: 0.5 });
    expect(right.viewport).toEqual({ x: 0.5, width: 0.5 });
  });

  it('exchanges the halves rather than the eyes when asked to swap', () => {
    // Swapping the eye positions would flip the sign of every off-axis shift
    // and put the scene behind the screen. Only the destination changes.
    const swapped = planOrbitEyes({ ...orbitBase, mode: 'sbs', swapLR: true });
    expect(swapped.eyes[0].viewport.x).toBe(0.5);
    expect(swapped.eyes[1].viewport.x).toBe(0);
    expect(swapped.eyes[0].position.x).toBe(left.position.x);
    expect(swapped.eyes[1].position.x).toBe(right.position.x);
  });
});

describe('the zero-parallax plane', () => {
  // A projection matching the frustum: x_ndc = (2 n x)/(r - l) / (r - l) style,
  // written out here so the test measures the same numbers the GPU would.
  function project(
    position: { x: number; y: number; z: number },
    frustum: { left: number; right: number; bottom: number; top: number; near: number },
    point: { x: number; y: number; z: number },
  ) {
    // The eye looks along -z, with the plane of no parallax at `z`.
    const x = point.x - position.x;
    const y = point.y - position.y;
    const z = point.z - position.z;
    const w = -z;
    const { left, right, bottom, top, near } = frustum;
    return {
      x: ((2 * near * x) / (right - left) + ((right + left) / (right - left)) * z) / w,
      y: ((2 * near * y) / (top - bottom) + ((top + bottom) / (top - bottom)) * z) / w,
    };
  }

  it('puts a point on the glass in the same place in both eyes', () => {
    const plan = planOrbitEyes({ ...orbitBase, mode: 'sbs' });
    const [left, right] = plan.eyes;
    // A point on the screen plane: `zeroParallaxDistance` in front of the rig,
    // which after the placement is at z = 0 for the eye.
    const onScreen = { x: 0.4, y: 0.3, z: -orbitBase.zeroParallaxDistance };
    const l = project(left.position, left.frustum, onScreen);
    const r = project(right.position, right.frustum, onScreen);
    expect(r.x - l.x).toBeCloseTo(0, 12);
    expect(r.y - l.y).toBe(0);
  });
});

describe('the two limits under the orbit planner', () => {
  it('lets the smaller of compression and pixel cap win', () => {
    // Pick a cap that binds first, then ask for a compression that binds
    // harder; the result must follow the compression, not the cap.
    const capped = planOrbitEyes({ ...orbitBase, mode: 'sbs', clampPx: 10 });
    const both = planOrbitEyes({ ...orbitBase, mode: 'sbs', clampPx: 10, compression: 0.1 });
    expect(both.effectiveBaseline).toBeLessThan(capped.effectiveBaseline);
    expect(both.limit).toBe('compression');
    // And with the compression released, the cap is the one in charge.
    expect(capped.limit).toBe('clamp');
  });

  it('reports the background separation the pixel cap bounds', () => {
    const plan = planOrbitEyes({ ...orbitBase, mode: 'sbs', clampPx: 12 });
    expect(plan.limit).toBe('clamp');
    // The cap was built to bound the far field, so the reported number lands
    // on it rather than merely under it.
    expect(plan.backgroundSeparationPx).toBeCloseTo(12, 6);
  });

  it('leaves the baseline alone when neither limit binds', () => {
    const plan = planOrbitEyes({ ...orbitBase, mode: 'sbs' });
    expect(plan.limit).toBeNull();
    expect(plan.effectiveBaseline).toBeCloseTo(orbitBase.baseline, 12);
  });

  it('measures the background separation from the same half-width the eyes use', () => {
    const plan = planOrbitEyes({ ...orbitBase, mode: 'sbs' });
    const eyeWidthPx = orbitBase.canvasWidthPx / 2;
    const { halfWidth } = screenHalfExtents(
      orbitBase.zeroParallaxDistance, orbitBase.fovYDeg, eyeWidthPx / orbitBase.canvasHeightPx);
    expect(plan.backgroundSeparationPx).toBeCloseTo(
      maxBackgroundSeparationPx(orbitBase.baseline, halfWidth, eyeWidthPx), 12);
  });
});

describe('mode switches leave nothing of the other eye behind', () => {
  const drawFor = (mode: StereoMode) => eyeDrawStates(planOrbitEyes({ ...orbitBase, mode }));

  it('draws one eye into the whole canvas in mono', () => {
    const [first, second] = drawFor('mono');
    expect(first.eye).not.toBeNull();
    expect(first.viewport).toEqual({ x: 0, width: 1 });
    // The second eye is switched off with no frustum of its own, rather than
    // keeping the half-width viewport and skewed volume it had in stereo.
    expect(second.eye).toBeNull();
    expect(second.frustum).toBeNull();
    expect(second.viewport).toEqual({ x: 0, width: 1 });
  });

  it('returns the second eye to a full-canvas view after a stereo frame', () => {
    // The sequence that used to leave a stale frustum: draw stereo, then draw
    // mono. The second eye's state has to describe mono, not stereo.
    const stereo = drawFor('sbs');
    const mono = drawFor('mono');
    expect(stereo[1].eye).not.toBeNull();
    expect(stereo[1].viewport.width).toBe(0.5);
    expect(mono[1].eye).toBeNull();
    expect(mono[1].frustum).toBeNull();
    expect(mono[1].viewport.width).toBe(1);
  });

  it('gives a mono eye the symmetric frustum a single viewer expects', () => {
    const [first] = drawFor('mono');
    expect(first.frustum!.left).toBeCloseTo(-first.frustum!.right, 12);
    expect(first.frustum!.bottom).toBeCloseTo(-first.frustum!.top, 12);
  });
});

describe('the head-tracked window pair', () => {
  it('separates the eyes about the head and shares the vertical extent', () => {
    const plan = planWindowEyes({ ...windowBase, mode: 'sbs' });
    const [left, right] = plan.eyes as [typeof plan.eyes[0], typeof plan.eyes[0]];
    expect(right.position.x - left.position.x).toBeCloseTo(windowBase.baseline, 12);
    expect(left.position.y).toBe(right.position.y);
    expect(left.position.z).toBe(right.position.z);
    expect(left.frustum.top).toBe(right.frustum.top);
    expect(left.frustum.bottom).toBe(right.frustum.bottom);
    // The head's own position is preserved as the midpoint of the pair.
    expect((left.position.x + right.position.x) / 2).toBeCloseTo(windowBase.eye.x, 12);
  });

  it('shares the vertical extent even with the head off-axis and above the centre', () => {
    // The vertical bounds depend on the eye's height, so an off-centre head
    // makes them asymmetric -- but they must still be the SAME asymmetry in
    // both eyes, which is what rules out vertical disparity.
    const plan = planWindowEyes({
      ...windowBase, mode: 'sbs', eye: { x: 0.6, y: -0.35, z: 2.1 },
    });
    const [left, right] = plan.eyes;
    expect(left.frustum.top).toBe(right.frustum.top);
    expect(left.frustum.bottom).toBe(right.frustum.bottom);
    expect(left.frustum.top).not.toBeCloseTo(-left.frustum.bottom, 6);
  });

  it('puts a point on the glass in the same place in both eyes', () => {
    const plan = planWindowEyes({ ...windowBase, mode: 'sbs' });
    const [left, right] = plan.eyes;
    // The window is at the origin. A point in its plane therefore shows no
    // horizontal disparity, however far off-axis the head is.
    const onGlass = { x: 0.2, y: 0.1, z: 0 };
    const l = projectThrough(left, onGlass);
    const r = projectThrough(right, onGlass);
    expect(r.x - l.x).toBeCloseTo(0, 12);
    expect(r.y - l.y).toBeCloseTo(0, 12);
  });

  it('carries the pixel cap from the window that is actually on screen', () => {
    const plan = planWindowEyes({ ...windowBase, mode: 'sbs', clampPx: 8 });
    expect(plan.limit).toBe('clamp');
    expect(plan.backgroundSeparationPx).toBeCloseTo(8, 6);
  });
});

// A minimal frustum projection in the eye's own frame, matching what the
// renderer will do with `setFrustum`.
function projectThrough(
  eye: { position: { x: number; y: number; z: number }; frustum: { left: number; right: number; bottom: number; top: number; near: number } },
  point: { x: number; y: number; z: number },
) {
  const { left, right, bottom, top, near } = eye.frustum;
  const x = point.x - eye.position.x;
  const y = point.y - eye.position.y;
  const z = point.z - eye.position.z;
  const w = -z;
  return {
    x: ((2 * near * x) / (right - left) + ((right + left) / (right - left)) * z) / w,
    y: ((2 * near * y) / (top - bottom) + ((top + bottom) / (top - bottom)) * z) / w,
  };
}

describe('illegal eye positions are refused or clamped', () => {
  const plan = (eye: { x?: number; y?: number; z?: number } | null) =>
    planWindowEyes({ ...windowBase, mode: 'sbs', eye });

  it('refuses an eye on the glass or behind it', () => {
    // sanitizeEye throws for zero and negative depth; the planner must not
    // pass that on as a degenerate frustum.
    const atZero = plan({ x: 0, y: 0, z: 0 });
    const behind = plan({ x: 0, y: 0, z: -1 });
    expect(atZero.eyeRejected).toBe(true);
    expect(behind.eyeRejected).toBe(true);
  });

  it('refuses an eye that is not a number at all', () => {
    expect(plan({ x: 0, y: 0, z: Number.NaN }).eyeRejected).toBe(true);
    expect(plan(null).eyeRejected).toBe(true);
  });

  it('keeps the last good placement when the tracker loses the head', () => {
    const previous = { x: 0.3, y: -0.1, z: 2.2 };
    const rejected = planWindowEyes({
      ...windowBase, mode: 'sbs', eye: { x: 0, y: 0, z: -2 }, previousEye: previous,
    });
    expect(rejected.eyeRejected).toBe(true);
    expect(rejected.centreEye).toEqual(previous);
    // Both eyes are still built, still parallel, and still share a vertical
    // extent -- the picture holds where it was rather than collapsing.
    expect(rejected.eyes).toHaveLength(2);
    expect(rejected.eyes[0].frustum.top).toBe(rejected.eyes[1].frustum.top);
    expect(rejected.eyes[0].frustum.bottom).toBe(rejected.eyes[1].frustum.bottom);
  });

  it('clamps an implausibly distant eye to the supported maximum', () => {
    const clamped = plan({ x: 0, y: 0, z: MAX_SUPPORTED_EYE_Z * 10 });
    expect(clamped.eyeRejected).toBe(false);
    expect(clamped.centreEye.z).toBe(MAX_SUPPORTED_EYE_Z);
    // A clamped eye still produces a usable, non-degenerate pair.
    expect(clamped.eyes[0].frustum.right).toBeGreaterThan(clamped.eyes[0].frustum.left);
    expect(clamped.eyes[0].frustum.top).toBeGreaterThan(clamped.eyes[0].frustum.bottom);
  });

  it('never produces a degenerate frustum for any accepted eye', () => {
    for (const z of [0.2, 1, 2.5, MAX_SUPPORTED_EYE_Z]) {
      const built = plan({ x: 0.7, y: -0.4, z });
      for (const eye of built.eyes) {
        expect(eye.frustum.right).toBeGreaterThan(eye.frustum.left);
        expect(eye.frustum.top).toBeGreaterThan(eye.frustum.bottom);
        expect(Number.isFinite(eye.frustum.left)).toBe(true);
        expect(Number.isFinite(eye.frustum.right)).toBe(true);
      }
    }
  });
});

describe('the draw state handed to the renderer', () => {
  it('gives each eye its own frustum that differs only horizontally', () => {
    // This is what the component copies onto two cameras. The two projections
    // must agree on every vertical quantity, or the pair cannot be fused.
    const [left, right] = eyeDrawStates(planOrbitEyes({ ...orbitBase, mode: 'sbs' }));
    expect(left.frustum).not.toBeNull();
    expect(right.frustum).not.toBeNull();
    const l = left.frustum!;
    const r = right.frustum!;
    expect(l.top).toBe(r.top);
    expect(l.bottom).toBe(r.bottom);
    expect(l.near).toBe(r.near);
    expect(l.far).toBe(r.far);
    expect(l.left).not.toBe(r.left);
    expect(l.right).not.toBe(r.right);
  });

  it('moves the eyes apart in opposite directions', () => {
    const plan = planOrbitEyes({ ...orbitBase, mode: 'sbs' });
    expect(plan.eyes[0].position.x).toBeLessThan(0);
    expect(plan.eyes[1].position.x).toBeGreaterThan(0);
  });
});

describe('a baseline that cannot be used', () => {
  // A hand-edited parameter file or a typed value can carry a negative or NaN
  // separation. `computeStereoEye` throws for a negative one, so the planner
  // clamps it: no depth is a better failure than no picture.
  it('treats a negative or unusable separation as zero', () => {
    const negative = planOrbitEyes({ ...orbitBase, mode: 'sbs', baseline: -0.2 });
    expect(negative.effectiveBaseline).toBe(0);
    expect(negative.eyes[0].frustum.right).toBeGreaterThan(negative.eyes[0].frustum.left);

    const nan = planOrbitEyes({ ...orbitBase, mode: 'sbs', baseline: Number.NaN });
    expect(nan.effectiveBaseline).toBe(0);
  });
});
