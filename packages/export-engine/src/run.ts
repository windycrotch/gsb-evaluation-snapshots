/**
 * The export orchestrator — the pure control flow that ties a frame source to a
 * video writer.
 *
 * It owns the loop, the timestamps, progress reporting, cancellation, and
 * cleanup; it owns none of the rendering or encoding. Because it only talks to
 * the two interfaces, the whole export lifecycle — including "cancel halfway"
 * and "the encoder threw" — is exercised in tests with trivial fakes, no
 * browser required.
 *
 * The frame list comes from the plan, never recomputed here: the loop renders
 * exactly `plan.frameRange` (which includes every transition tail), so the
 * progress denominator and the number of encoded frames are the same number.
 */

import { frameDurationMicros, frameTimestampMicros, type ExportPlan } from "./plan";
import { exportProgress, type ExportProgress } from "./progress";
import type { FrameReleaser, FrameSource, VideoWriter } from "./providers";

/** Raised when an export is aborted through its `AbortSignal`. */
export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelledError";
  }
}

export interface RunVideoExportOptions<TFrame> {
  plan: ExportPlan;
  frameSource: FrameSource<TFrame>;
  videoWriter: VideoWriter<TFrame>;
  /**
   * Releases a frame after it has been encoded. Defaults to calling `close()` if
   * the frame has one (the `VideoFrame` case), so callers rarely pass it.
   */
  releaseFrame?: FrameReleaser<TFrame>;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

/**
 * Renders every frame in the plan and encodes it, returning the finished file
 * bytes. Throws {@link ExportCancelledError} if the signal aborts, and always
 * disposes the source and writer — including on error — so a failed or
 * cancelled export never leaks an encoder or a decoder.
 *
 * Cancellation is observed both before rendering a frame and after a frame has
 * been rendered but before it is encoded: a frame that never reaches the writer
 * is released and never counted as completed, so progress cannot jump past what
 * was actually encoded. Encoder errors likewise release the in-flight frame and
 * every previously rendered frame was already released at the end of its turn.
 */
export async function runVideoExport<TFrame>(
  options: RunVideoExportOptions<TFrame>,
): Promise<Uint8Array> {
  const { plan, frameSource, videoWriter, signal, onProgress } = options;
  const release = options.releaseFrame ?? defaultRelease;
  const frameDuration = frameDurationMicros(plan);
  // The plan is the only authority on which frames exist — including transition
  // tails — so the loop length and the progress denominator are identical.
  const frames = plan.frameRange;

  const report = (phase: Parameters<typeof exportProgress>[0], completed: number) =>
    onProgress?.(exportProgress(phase, completed, plan.totalFrames));

  try {
    throwIfAborted(signal);
    report("preparing", 0);

    for (let index = 0; index < frames.length; index += 1) {
      throwIfAborted(signal);

      const timelineFrame = frames[index]!;
      const frame = await frameSource.renderFrame(timelineFrame);

      // The signal may have aborted while the frame was rendering. That frame
      // was never handed to the writer, so release it and stop before it becomes
      // work-in-progress: it must not be encoded, and it must not count.
      if (signal?.aborted) {
        release(frame);
        throw new ExportCancelledError();
      }

      // The frame must be released even if encoding throws, so the writer's turn
      // is inside its own try — otherwise a mid-export encoder error would leak
      // the last decoded frame.
      try {
        await videoWriter.addFrame(frame, frameTimestampMicros(plan, index), frameDuration);
      } finally {
        release(frame);
      }

      // A frame counts as completed only once it has been encoded; reporting
      // after the writer's turn keeps the counter honest under cancellation.
      report("rendering", index + 1);
    }

    throwIfAborted(signal);
    report("finalizing", plan.totalFrames);
    const bytes = await videoWriter.finalize();

    report("done", plan.totalFrames);
    return bytes;
  } finally {
    // Dispose in a fixed order regardless of how we got here. Cleanup failures
    // are swallowed deliberately: the original outcome (success, cancellation
    // or the encoder's error) must propagate untouched.
    await safeDispose(frameSource);
    await safeDispose(videoWriter);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

/** Closes a frame if it exposes `close()` (the WebCodecs `VideoFrame` shape). */
function defaultRelease<TFrame>(frame: TFrame): void {
  const closable = frame as { close?: () => void };
  if (typeof closable?.close === "function") closable.close();
}

async function safeDispose(target: { dispose?: () => Promise<void> | void }): Promise<void> {
  try {
    await target.dispose?.();
  } catch {
    // A cleanup failure must not mask the real outcome (success or the original
    // error); the resources are being discarded regardless.
  }
}
