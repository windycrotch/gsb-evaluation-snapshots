// Framework-agnostic FFmpeg render engine.
//
// All browser APIs and the html2canvas dynamic import are injected through the
// `RenderPlatform` interface so that the whole pipeline (frame loop, ffmpeg
// arguments, cancellation and temp-file cleanup) can be exercised from plain
// Node tests without a DOM, network access or the real FFmpeg WASM build.

/** Raised when the timeline has no duration / no frames to render. */
export class EmptyTimelineError extends Error {
  constructor(message = "Timeline is empty: nothing to export.") {
    super(message);
    this.name = "EmptyTimelineError";
  }
}

/** Raised when an export run is aborted through its AbortSignal. */
export class RenderCancelledError extends Error {
  constructor(message = "Rendering cancelled") {
    super(message);
    this.name = "RenderCancelledError";
  }
}

export interface RenderExportSettings {
  resolution: string;
  quality: string;
  speed: string;
  format?: string;
  fps?: number;
  captureWaitTime?: number;
}

/** Structural subset of the @ffmpeg/ffmpeg FFmpeg class used by the engine. */
export interface FfmpegLike {
  // Return types are `unknown` because the real class returns Promise<boolean>;
  // the engine never inspects these values.
  writeFile: (path: string, data: Uint8Array | string) => Promise<unknown>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<unknown>;
  exec: (args: string[]) => Promise<unknown>;
}

export interface FramePlan {
  /** Frame rate used both for capture timing and the ffmpeg `-framerate`. */
  fps: number;
  /** Total number of frames that will be captured and encoded. */
  totalFrames: number;
  /** Effective frame rate handed to ffmpeg (reduced for GIF). */
  effectiveFps: number;
  format: string;
  width: number;
  height: number;
}

export interface RenderDeps {
  ffmpeg: FfmpegLike;
  previewElement: HTMLElement;
  exportSettings: RenderExportSettings;
  totalDuration: number;
  signal: AbortSignal;
  seekTo: (time: number) => void;
  pause: () => void;
  /** Browser/platform specific capture helpers. */
  platform: RenderPlatform;
  onPhase?: (phase: RenderPhase) => void;
  onProgress?: (currentFrame: number, totalFrames: number) => void;
}

export type RenderPhase = "preparing" | "capturing" | "encoding";

export interface RenderResult {
  blob: Blob;
  fileName: string;
  format: string;
  frameCount: number;
  fps: number;
}

export interface RenderPlatform {
  waitForFonts: () => Promise<void>;
  wait: (ms: number) => Promise<void>;
  animationFrames: (count: number) => Promise<void>;
  /** Current zoom level in percent (100 = no zoom). */
  getZoomPercent: () => number;
  /**
   * Capture `element`, letterbox/scale it onto an output canvas of
   * `targetWidth` x `targetHeight` and return the result as PNG bytes.
   */
  captureFramePng: (
    element: HTMLElement,
    targetWidth: number,
    targetHeight: number,
    options: CaptureOptions
  ) => Promise<Uint8Array>;
}

export interface CaptureOptions {
  backgroundColor: string;
  scale: number;
  logging: boolean;
  useCORS: boolean;
  allowTaint: boolean;
  removeContainer: boolean;
  imageTimeout: number;
  /** Unzoomed source width/height passed to html2canvas. */
  width: number;
  height: number;
  onclone: (doc: Document) => void;
  [key: string]: unknown;
}

export type Html2CanvasLike = (
  element: HTMLElement,
  options: CaptureOptions
) => Promise<HTMLCanvasElement>;

const GIF_MAX_FPS = 10;

// ---------------------------------------------------------------------------
// Quality / resolution mappings (MP4 behaviour — kept identical to before).
// ---------------------------------------------------------------------------

export const getQualitySettings = (
  quality: string,
  speed: string
): { preset: string; crf: number } => {
  const qualityMap: Record<
    string,
    Record<string, { preset: string; crf: number }>
  > = {
    low: {
      fastest: { preset: "ultrafast", crf: 28 },
      fast: { preset: "superfast", crf: 26 },
      balanced: { preset: "fast", crf: 28 },
      slow: { preset: "medium", crf: 28 },
      slowest: { preset: "slow", crf: 28 },
    },
    medium: {
      fastest: { preset: "superfast", crf: 23 },
      fast: { preset: "fast", crf: 23 },
      balanced: { preset: "medium", crf: 23 },
      slow: { preset: "slow", crf: 23 },
      slowest: { preset: "slower", crf: 23 },
    },
    high: {
      fastest: { preset: "fast", crf: 18 },
      fast: { preset: "medium", crf: 18 },
      balanced: { preset: "slow", crf: 18 },
      slow: { preset: "slower", crf: 18 },
      slowest: { preset: "veryslow", crf: 18 },
    },
    ultra: {
      fastest: { preset: "medium", crf: 15 },
      fast: { preset: "slow", crf: 15 },
      balanced: { preset: "slower", crf: 15 },
      slow: { preset: "veryslow", crf: 15 },
      slowest: { preset: "veryslow", crf: 12 },
    },
  };
  return qualityMap[quality]?.[speed] || qualityMap.high.balanced;
};

export const getResolutionDimensions = (
  resolution: string
): { width: number; height: number } => {
  const resMap: Record<string, { width: number; height: number }> = {
    "480p": { width: 854, height: 480 },
    "720p": { width: 1280, height: 720 },
    "1080p": { width: 1920, height: 1080 },
  };
  return resMap[resolution] || resMap["1080p"];
};

export const frameFileName = (frameIndex: number): string =>
  `frame${String(frameIndex).padStart(5, "0")}.png`;

/**
 * Compute the capture/encode plan.
 *
 * For GIF the frame rate is capped at {@link GIF_MAX_FPS} and the frame count
 * is derived from that reduced rate, so the number of captured frames and the
 * ffmpeg `-framerate` always describe the same timeline.
 */
export function computeFramePlan(
  totalDuration: number,
  exportSettings: RenderExportSettings
): FramePlan {
  const outputFps = exportSettings.fps || 30;
  const format = exportSettings.format || "mp4";
  const effectiveFps =
    format === "gif" ? Math.min(outputFps, GIF_MAX_FPS) : outputFps;
  const totalFrames = Math.max(0, Math.ceil(totalDuration * effectiveFps));
  const { width, height } = getResolutionDimensions(
    exportSettings.resolution
  );

  return {
    fps: outputFps,
    totalFrames,
    effectiveFps,
    format,
    width,
    height,
  };
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new RenderCancelledError();
  }
};

/**
 * Run a full export: capture `plan.totalFrames` frames from the preview
 * element, write them into the FFmpeg virtual filesystem, encode them and
 * remove every temporary file again (on success, failure and cancellation).
 */
export async function renderVideo(deps: RenderDeps): Promise<RenderResult> {
  const {
    ffmpeg,
    previewElement,
    exportSettings,
    totalDuration,
    signal,
    seekTo,
    pause,
    onPhase,
    onProgress,
  } = deps;
  const platform = deps.platform;

  // Boundary: an empty timeline must fail explicitly before any frame file is
  // written and before ffmpeg is touched, leaving a retryable state.
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new EmptyTimelineError(
      "Timeline duration is 0 — add at least one scene before exporting."
    );
  }

  const plan = computeFramePlan(totalDuration, exportSettings);
  if (plan.totalFrames <= 0) {
    throw new EmptyTimelineError(
      "No frames could be calculated for this export — check the timeline duration and frame rate."
    );
  }

  throwIfAborted(signal);
  onPhase?.("preparing");

  await platform.waitForFonts();
  throwIfAborted(signal);

  const params = getQualitySettings(
    exportSettings.quality,
    exportSettings.speed
  );

  // Pause playback and seek to start.
  pause();
  seekTo(0);
  await platform.wait(500);
  throwIfAborted(signal);

  const writtenFrames: string[] = [];

  try {
    onPhase?.("capturing");

    for (let frameIndex = 0; frameIndex < plan.totalFrames; frameIndex++) {
      // Cancellation must stop the frame loop immediately, before any more
      // captures or filesystem writes happen.
      throwIfAborted(signal);

      const currentTime = frameIndex / plan.effectiveFps;
      seekTo(Math.min(currentTime, totalDuration));

      await platform.wait(100);
      await platform.animationFrames(3);

      // Ensure all styles are flushed.
      void previewElement.offsetHeight;

      try {
        const rect = previewElement.getBoundingClientRect();
        const zoom = platform.getZoomPercent() / 100;
        const captureWidth = rect.width / zoom;
        const captureHeight = rect.height / zoom;
        const captureScale = plan.width / captureWidth;

        const frameData = await platform.captureFramePng(
          previewElement,
          plan.width,
          plan.height,
          {
            backgroundColor: "#000000",
            scale: captureScale,
            logging: false,
            useCORS: true,
            allowTaint: true,
            removeContainer: true,
            imageTimeout: 0,
            width: captureWidth,
            height: captureHeight,
            onclone: (clonedDoc) => {
              const clonedElement = clonedDoc.querySelector(
                '[data-scene-preview="true"]'
              ) as HTMLElement | null;
              if (!clonedElement) return;

              // Remove the zoom transform from the cloned element so it
              // captures at full size.
              clonedElement.style.transform = "none";
              clonedElement.style.width = `${captureWidth}px`;
              clonedElement.style.height = `${captureHeight}px`;

              const allElements = clonedElement.querySelectorAll("*");
              allElements.forEach((el) => {
                const htmlEl = el as HTMLElement;
                const style = window.getComputedStyle(el);

                if (style.transform && style.transform !== "none") {
                  htmlEl.style.transform = style.transform;
                }
                if (style.opacity) {
                  htmlEl.style.opacity = style.opacity;
                }
                if (style.fontFamily) {
                  htmlEl.style.fontFamily = style.fontFamily;
                }
                if (style.scale && style.scale !== "none") {
                  htmlEl.style.scale = style.scale;
                }
                if (style.rotate && style.rotate !== "none") {
                  htmlEl.style.rotate = style.rotate;
                }
                if (style.translate && style.translate !== "none") {
                  htmlEl.style.translate = style.translate;
                }
              });
            },
          }
        );

        const name = frameFileName(frameIndex);
        await ffmpeg.writeFile(name, frameData);
        writtenFrames.push(name);
      } catch (error) {
        // Preserve the original behaviour: a single failed capture is logged
        // and skipped rather than aborting the whole export — unless the run
        // was cancelled, in which case the next loop iteration will throw.
        if (signal.aborted) throw new RenderCancelledError();
        console.error(`Failed to capture frame ${frameIndex}:`, error);
      }

      onProgress?.(frameIndex + 1, plan.totalFrames);
    }

    throwIfAborted(signal);
    onPhase?.("encoding");

    let outputBlob: Blob;
    let outputFileName: string;

    if (plan.format === "gif") {
      const result = await encodeGif(ffmpeg, plan, signal);
      outputBlob = result.blob;
      outputFileName = "video.gif";
    } else {
      const result = await encodeMp4(ffmpeg, plan, params, totalDuration);
      outputBlob = result.blob;
      outputFileName = "video.mp4";
    }

    return {
      blob: outputBlob,
      fileName: outputFileName,
      format: plan.format,
      frameCount: plan.totalFrames,
      fps: plan.effectiveFps,
    };
  } finally {
    // No temporary files may survive the run — on success, failure or abort.
    await cleanupTempFiles(ffmpeg, writtenFrames, plan.format);
  }
}

async function encodeGif(
  ffmpeg: FfmpegLike,
  plan: FramePlan,
  signal: AbortSignal
): Promise<{ blob: Blob }> {
  const framerate = String(plan.effectiveFps);

  // Generate palette first for better compression. The input framerate and
  // the fps filter both use the reduced GIF rate, matching the number of
  // frames actually captured.
  const paletteArgs = [
    "-framerate",
    framerate,
    "-i",
    "frame%05d.png",
    "-vf",
    `fps=${plan.effectiveFps},scale=${plan.width}:${plan.height}:flags=lanczos,palettegen=max_colors=64`,
    "-y",
    "palette.png",
  ];

  await ffmpeg.exec(paletteArgs);
  throwIfAborted(signal);

  const gifArgs = [
    "-framerate",
    framerate,
    "-i",
    "frame%05d.png",
    "-i",
    "palette.png",
    "-lavfi",
    `fps=${plan.effectiveFps},scale=${plan.width}:${plan.height}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=2`,
    "-loop",
    "0",
    "-y",
    "output.gif",
  ];

  await ffmpeg.exec(gifArgs);
  const gifData = await ffmpeg.readFile("output.gif");
  return { blob: toBlob(gifData, "image/gif") };
}

async function encodeMp4(
  ffmpeg: FfmpegLike,
  plan: FramePlan,
  params: { preset: string; crf: number },
  totalDuration: number
): Promise<{ blob: Blob }> {
  const mp4Args = [
    "-framerate",
    String(plan.effectiveFps),
    "-i",
    "frame%05d.png",
    "-c:v",
    "libx264",
    "-preset",
    params.preset,
    "-crf",
    String(params.crf),
    "-pix_fmt",
    "yuv420p",
    "-t",
    totalDuration.toFixed(3),
    "output.mp4",
  ];

  await ffmpeg.exec(mp4Args);
  const mp4Data = await ffmpeg.readFile("output.mp4");
  return {
    blob: toBlob(mp4Data, "video/mp4"),
  };
}

/**
 * Wrap FFmpeg's `Uint8Array | string` read result in a Blob. The
 * `ArrayBufferLike`/`SharedArrayBuffer` generic mismatch is avoided by copying
 * the bytes into a fresh `Uint8Array` backed by a regular `ArrayBuffer`.
 */
function toBlob(data: Uint8Array | string, type: string): Blob {
  if (typeof data === "string") {
    return new Blob([data], { type });
  }
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Blob([copy], { type });
}

async function cleanupTempFiles(
  ffmpeg: FfmpegLike,
  writtenFrames: string[],
  format: string
): Promise<void> {
  const files = [
    ...writtenFrames,
    "palette.png",
    format === "gif" ? "output.gif" : "output.mp4",
  ];

  for (const file of files) {
    try {
      await ffmpeg.deleteFile(file);
    } catch {
      // File may never have been created (e.g. aborted before encoding);
      // cleanup is best-effort and must never mask the real error.
    }
  }
}
