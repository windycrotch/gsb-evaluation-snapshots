// Turning stereo settings and a viewpoint into the cameras that draw them.
//
// `off-axis.ts` has the geometry: an asymmetric view volume, a pair of eye
// views, and the effective baseline the compression and pixel-limit controls
// agree on. This module applies that geometry to the two things the viewer has
// to draw -- an orbiting camera and a head-tracked window -- and reduces both
// to the same description: one or two eye placements, each displaced sideways
// and never rotated, each with the frustum that makes the zero-parallax plane
// land in the same place for both.
//
// It is deliberately separate from the PlayCanvas component. The property that
// makes a stereo pair fusable -- identical vertical extents, horizontal motion
// only -- is a property of these numbers, and can be tested without a graphics
// device. The component's job is only to copy a placement onto an eye entity.

import {
  computeOffAxisFrustum,
  computeStereoEye,
  effectiveBaseline,
  sanitizeEye,
  screenHalfExtents,
  type Eye,
  type Frustum,
} from './off-axis';

export type StereoMode = 'mono' | 'sbs';

/** Which control made the baseline shorter than the one asked for. */
export type BaselineLimit = 'compression' | 'clamp' | null;

export type EyePlacement = {
  side: 'left' | 'right' | 'centre';
  /**
   * Where the eye sits within the rig or the window, in scene units.
   *
   * For a stereo pair this differs between the eyes only along x. No rotation
   * belongs here: rotating an eye is toe-in, which puts the same feature at
   * different heights in the two images and cannot be fused.
   */
  position: Eye;
  /** The asymmetric view volume this eye projects through. */
  frustum: Frustum;
  /** Share of the canvas, as x offset and width in 0..1. */
  viewport: { x: number; width: number };
};

export type StereoPlan = {
  mode: StereoMode;
  /** One placement in mono, two in side-by-side. */
  eyes: EyePlacement[];
  /**
   * The sanitised eye position the pair was built around, without the
   * per-eye baseline offset. This is what a caller should keep as the last
   * good head position: feeding an offset eye back in would apply the
   * separation twice.
   */
  centreEye: Eye;
  /** Eye separation actually used, after both limits. */
  effectiveBaseline: number;
  /**
   * The largest horizontal separation the far background may show between
   * the eyes, in pixels of one eye's viewport. This is the number the pixel
   * limit bounds, so it is the one worth showing beside the control.
   */
  backgroundSeparationPx: number;
  /** Which control shortened the baseline, when one of them did. */
  limit: BaselineLimit;
  /** Width of one eye's viewport in pixels, backing-store rather than CSS. */
  eyeViewportWidthPx: number;
  /**
   * True when the eye position could not be used as measured and the previous
   * one was kept. Always false for an orbit pair, which has no tracker.
   */
  eyeRejected: boolean;
};

/**
 * Far-field separation of the eyes' images, in pixels.
 *
 * A point at distance d separates in normalised coordinates by
 * `(baseline / halfWidth) * (1 - zeroParallaxDistance / d)`, which tends to
 * `baseline / halfWidth` for anything far enough away. Normalised coordinates
 * span two units across a viewport, so one viewport width is half of that in
 * pixels.
 */
export function maxBackgroundSeparationPx(
  baseline: number,
  screenHalfWidth: number,
  eyeViewportWidthPx: number,
): number {
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  if (!(screenHalfWidth > 0) || !(eyeViewportWidthPx > 0)) return 0;
  return (baseline / screenHalfWidth / 2) * eyeViewportWidthPx;
}

/**
 * Which limit is responsible for the separation being what it is.
 *
 * `effectiveBaseline` already applies both limits and returns the tighter
 * result, so this only has to say which side of the minimum that result came
 * from. It never changes the number.
 */
function limitOf(requested: number, compression: number, separation: number): BaselineLimit {
  const factor = Number.isFinite(compression) ? Math.max(0, compression) : 1;
  const compressed = Math.max(0, requested * factor);
  if (separation < compressed - 1e-12) return 'clamp';
  if (compressed < requested - 1e-12) return 'compression';
  return null;
}

function viewportFor(
  side: 'left' | 'right' | 'centre',
  sbs: boolean,
  swapLR: boolean,
): { x: number; width: number } {
  if (!sbs) return { x: 0, width: 1 };
  // The left eye is drawn into the left half unless the caller has asked for
  // cross-eyed free viewing, which exchanges the halves rather than the eyes.
  // Swapping the eyes themselves would flip the sign of every off-axis shift
  // and put the scene behind the screen, mirrored.
  const inFirstHalf = side === 'left' ? !swapLR : swapLR;
  return { x: inFirstHalf ? 0 : 0.5, width: 0.5 };
}

function assemble(
  mode: StereoMode,
  eyes: EyePlacement[],
  centreEye: Eye,
  requestedBaseline: number,
  separation: number,
  compression: number,
  screenHalfWidth: number,
  eyeViewportWidthPx: number,
  eyeRejected = false,
): StereoPlan {
  const effective = mode === 'sbs' ? separation : 0;
  return {
    mode,
    eyes,
    centreEye,
    effectiveBaseline: effective,
    backgroundSeparationPx: maxBackgroundSeparationPx(
      effective,
      screenHalfWidth,
      eyeViewportWidthPx,
    ),
    limit: mode === 'sbs' ? limitOf(requestedBaseline, compression, effective) : null,
    eyeViewportWidthPx,
    eyeRejected,
  };
}

/**
 * The eye pair for an orbiting camera.
 *
 * The camera rig is already at the orbit position and looking at its target.
 * Each eye is a child displaced along the rig's own right axis, keeping the
 * rig's orientation: the pair is translated apart, never toed in. The
 * zero-parallax plane is the plane of the target, `zeroParallaxDistance` in
 * front of the eyes, so `computeStereoEye` can build both view volumes from a
 * single description.
 */
export function planOrbitEyes({
  mode,
  baseline,
  compression = 1,
  clampPx = 0,
  swapLR = false,
  zeroParallaxDistance,
  fovYDeg,
  canvasWidthPx,
  canvasHeightPx,
  near,
  far,
}: {
  mode: StereoMode;
  baseline: number;
  compression?: number;
  clampPx?: number;
  swapLR?: boolean;
  zeroParallaxDistance: number;
  fovYDeg: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  near: number;
  far: number;
}): StereoPlan {
  const sbs = mode === 'sbs';
  const width = Math.max(1, canvasWidthPx);
  const height = Math.max(1, canvasHeightPx);
  // Each eye in a side-by-side pair gets half the canvas, so that is the
  // viewport aspect its projection has to match.
  const eyeWidthPx = sbs ? width / 2 : width;
  const aspect = eyeWidthPx / height;

  // A saved parameter file or a typed value can carry a negative separation.
  // `computeStereoEye` refuses one, so it is clamped here to keep a bad number
  // from taking down the frame rather than showing no depth at all.
  const requested = Number.isFinite(baseline) ? Math.max(0, baseline) : 0;
  const separation = sbs
    ? effectiveBaseline({
      baseline: requested,
      compression,
      clampPx,
      eyeViewportWidthPx: eyeWidthPx,
      zeroParallaxDistance,
      fovYDeg,
      aspect,
    })
    : 0;

  const sides: Array<'left' | 'right' | 'centre'> = sbs ? ['left', 'right'] : ['centre'];
  const eyes = sides.map((side): EyePlacement => {
    const view = computeStereoEye(side, {
      baseline: separation,
      zeroParallaxDistance,
      fovYDeg,
      aspect,
      near,
      far,
    });
    return {
      side,
      // The rig already sits at the viewpoint; the eye only moves sideways
      // inside it.
      position: { x: view.offsetX, y: 0, z: 0 },
      frustum: view.frustum,
      viewport: viewportFor(side, sbs, swapLR),
    };
  });

  const { halfWidth } = screenHalfExtents(zeroParallaxDistance, fovYDeg, aspect);
  return assemble(
    mode, eyes, { x: 0, y: 0, z: 0 }, requested, separation, compression, halfWidth, eyeWidthPx);
}

/**
 * The eye pair for the head-tracked window.
 *
 * Here the viewer's own eye position is the starting point rather than zero.
 * Each eye is the tracked head position displaced sideways by half the
 * baseline; vertical and depth positions are shared, which is what keeps the
 * two frusta's vertical extents identical. The window itself is the
 * zero-parallax plane, so a point on the glass lands in the same place in both
 * images however far off-axis the viewer is.
 *
 * `sanitizeEye` is applied here rather than left to the caller: a tracker that
 * has lost the face can report an eye at or behind the glass, and a frustum
 * built from that is degenerate rather than obviously wrong. It rejects those
 * and clamps an implausibly distant eye to `MAX_SUPPORTED_EYE_Z`.
 *
 * Rejection is handled, not thrown past the caller: an eye that cannot be
 * projected from keeps the last placement that could, so a lost tracker leaves
 * the picture where it was with `eyeRejected` set, rather than dropping the
 * frame or building a degenerate view. Pass `previousEye` for that; without it
 * the first rejected sample falls back to a straight-on view.
 */
export function planWindowEyes({
  mode,
  eye,
  previousEye = null,
  baseline,
  compression = 1,
  clampPx = 0,
  swapLR = false,
  windowHalfHeight,
  canvasWidthPx,
  canvasHeightPx,
  near,
  far,
}: {
  mode: StereoMode;
  eye: Partial<Eye> | null | undefined;
  /** The last eye that could be projected from, used when `eye` cannot. */
  previousEye?: Eye | null;
  baseline: number;
  compression?: number;
  clampPx?: number;
  swapLR?: boolean;
  windowHalfHeight: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  near: number;
  far: number;
}): StereoPlan {
  let safe: Eye;
  let eyeRejected = false;
  try {
    safe = sanitizeEye(eye);
  } catch {
    eyeRejected = true;
    // The previous placement is already sanitised, but it is supplied by the
    // caller and this is the one path that must not throw: if it is unusable
    // too, fall back to a plain straight-on view at a plausible distance.
    const candidate = previousEye ?? {
      x: 0,
      y: 0,
      z: Math.max(0.2, windowHalfHeight / Math.tan(Math.PI / 8)),
    };
    try {
      safe = sanitizeEye(candidate);
    } catch {
      safe = { x: 0, y: 0, z: 2.5 };
    }
  }
  const sbs = mode === 'sbs';
  const width = Math.max(1, canvasWidthPx);
  const height = Math.max(1, canvasHeightPx);
  const eyeWidthPx = sbs ? width / 2 : width;
  const aspect = eyeWidthPx / height;
  const halfWidth = windowHalfHeight * aspect;

  // The window is the plane with no parallax, and the eye is `safe.z` in front
  // of it. Expressing the window's own vertical field of view lets
  // `effectiveBaseline` work from the same half-width the frusta use, so the
  // pixel limit is measured against the window that is actually on screen.
  const fovYDeg = (2 * Math.atan(windowHalfHeight / safe.z) * 180) / Math.PI;
  const requested = Number.isFinite(baseline) ? Math.max(0, baseline) : 0;
  const separation = sbs
    ? effectiveBaseline({
      baseline: requested,
      compression,
      clampPx,
      eyeViewportWidthPx: eyeWidthPx,
      zeroParallaxDistance: safe.z,
      fovYDeg,
      aspect,
    })
    : 0;

  const sides: Array<'left' | 'right' | 'centre'> = sbs ? ['left', 'right'] : ['centre'];
  const eyes = sides.map((side): EyePlacement => {
    const offset = side === 'centre' ? 0 : (side === 'left' ? -separation / 2 : separation / 2);
    const position = { x: safe.x + offset, y: safe.y, z: safe.z };
    return {
      side,
      position,
      frustum: computeOffAxisFrustum({
        eyeX: position.x,
        eyeY: position.y,
        eyeZ: position.z,
        screenHalfWidth: halfWidth,
        screenHalfHeight: windowHalfHeight,
        near,
        far,
      }),
      viewport: viewportFor(side, sbs, swapLR),
    };
  });

  return assemble(
    mode, eyes, safe, requested, separation, compression, halfWidth, eyeWidthPx, eyeRejected);
}

/**
 * What each of the two eye entities should be told for this plan.
 *
 * Always two entries, in the same order as the entities, so a mode switch
 * cannot leave one behind. An eye that is not part of the current pair comes
 * back with no placement, a full-canvas viewport and no frustum -- which is
 * exactly what the component needs to switch it off and return it to the
 * engine's own symmetric projection. Writing only the eyes in use would leave
 * the other holding the half-width viewport and asymmetric view volume it had
 * while the pair was on.
 */
export type EyeDrawState = {
  /** The placement to draw, or null when this eye is not part of the pair. */
  eye: EyePlacement | null;
  /** Viewport to use. Full canvas when there is no placement. */
  viewport: { x: number; width: number };
  /** Projection to install, or null to restore the engine's own. */
  frustum: Frustum | null;
};

export function eyeDrawStates(plan: StereoPlan): [EyeDrawState, EyeDrawState] {
  const one = (index: number): EyeDrawState => {
    const eye = plan.eyes[index] ?? null;
    return eye
      ? { eye, viewport: eye.viewport, frustum: eye.frustum }
      : { eye: null, viewport: { x: 0, width: 1 }, frustum: null };
  };
  return [one(0), one(1)];
}
