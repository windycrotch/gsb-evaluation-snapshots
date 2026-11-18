export type SceneParams = {
  mode: "mono" | "sbs";
  fovDeg: number;
  pivot: {
    point?: { x: number; y: number; z: number };
    screen?: { u: number; v: number };
  };
  stereo: {
    zeroParallax: {
      mode: "pivot" | "fixed";
      value?: number;
      point?: { x: number; y: number; z: number };
    };
    baseline: number;
    compression: number;
    clampPx: number;
  };
  camera: {
    orbitEnabled: boolean;
    panEnabled: boolean;
    dollyEnabled: boolean;
  };
  zoom: {
    dollySpeed: number;
    zoomFactor: number;
  };
};

/** What the editor can ask the viewer to do. */
export type ViewerHandle = {
  capture: (format?: "image/png" | "image/jpeg") => string | null;
  captureAsync?: (
    format?: "image/png" | "image/jpeg",
    options?: { width: number; height: number },
  ) => Promise<string | null>;
  enterFullscreen: () => void;
  /** How far the camera currently is from the point it orbits, in metres. */
  pivotDistance: () => number;
};

/** The stereo settings the viewer is driven by. */
export type StereoSettings = {
  mode: "mono" | "sbs";
  baseline: number;
  compression: number;
  clampPx: number;
  zeroParallaxMode: "pivot" | "fixed";
  zeroParallaxDistance: number;
  /** Draw the left eye into the right half, for cross-eyed free viewing. */
  swapLR: boolean;
};

/**
 * What the last rendered frame's stereo geometry actually came to.
 *
 * The compression and pixel-limit controls shorten the baseline rather than
 * correcting the picture afterwards, so the numbers are worth showing: without
 * them a control that has been made irrelevant by the other one is
 * indistinguishable from a control that is simply not binding.
 */
export type StereoFeedback = {
  mode: "mono" | "sbs";
  /** Eye separation in scene units, after both limits have applied. */
  effectiveBaseline: number;
  /**
   * The largest horizontal separation the far background can show between the
   * eyes, in pixels of one eye's viewport. This is what the pixel limit bounds.
   */
  backgroundSeparationPx: number;
  /** Which control shortened the baseline, or null when neither did. */
  limit: "compression" | "clamp" | null;
  /** Width of one eye's viewport, in backing-store pixels. */
  eyeViewportWidthPx: number;
  /**
   * True when the last head position could not be used and the previous one
   * is still on screen. The tracker can lose a face and report an eye behind
   * the glass; that is clamped away rather than projected, and this says so.
   */
  eyeRejected: boolean;
};
