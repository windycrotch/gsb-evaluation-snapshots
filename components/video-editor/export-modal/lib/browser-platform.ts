// Browser implementation of the RenderPlatform used by FfmpegRender.
//
// Keeping this out of render-engine.ts means the engine itself never imports
// DOM-only or html2canvas-pro code and stays runnable inside plain Node tests.

import type {
  CaptureOptions,
  Html2CanvasLike,
  RenderPlatform,
} from "./render-engine";

/**
 * Adapt html2canvas-pro's `(element, options?: Partial<Options>)` signature to
 * the engine's stricter `Html2CanvasLike`. The engine always passes a complete
 * options object, so wrapping the call keeps both sides fully typed without an
 * `unknown` cast.
 */
const loadHtml2Canvas = async (): Promise<Html2CanvasLike> => {
  const html2canvas = (await import("html2canvas-pro")).default;
  return (element: HTMLElement, options: CaptureOptions) =>
    html2canvas(element, options);
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const animationFrames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const canvasToPng = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Failed to create blob"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });

export const createBrowserPlatform = (
  getZoomPercent: () => number
): RenderPlatform => ({
  waitForFonts: () => document.fonts.ready.then(() => undefined),
  wait,
  animationFrames,
  getZoomPercent,
  captureFramePng: async (element, targetWidth, targetHeight, options) => {
    const html2canvas = await loadHtml2Canvas();
    const capturedCanvas = await html2canvas(element, options);

    // Draw onto an output canvas at the exact target resolution.
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = targetWidth;
    outputCanvas.height = targetHeight;
    const ctx = outputCanvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");

    ctx.drawImage(
      capturedCanvas,
      0,
      0,
      capturedCanvas.width,
      capturedCanvas.height,
      0,
      0,
      targetWidth,
      targetHeight
    );

    return canvasToPng(outputCanvas);
  },
});
