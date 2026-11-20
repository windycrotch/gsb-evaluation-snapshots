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
 * The contract it guarantees is deliberately narrow and total:
 *
 * - **Success** resolves once with the writer's bytes and with every resource
 *   disposed.
 * - **Cancellation** (the `AbortSignal` firing at *any* point) rejects with
 *   {@link ExportCancelledError}, never appends another frame after the abort is
 *   observed, never calls `finalize`, and still releases every frame it
 *   rendered — including one already in flight to the writer.
 * - **Failure** (a frame source or writer error) rejects with that error and is
 *   never relabelled as success.
 * - **Disposal** runs in one fixed order — frame source, writer, then any shared
 *   resources (the muxer container) — regardless of how the run ended, and every
 *   step is idempotent.
 *
 * Cancellation and encoder errors race; see {@link ExportCancellation} for the
 * rule that decides which one the caller sees.
 */

import { ExportCancellation } from "./cancellation";
import { ExportCancelledError } from "./errors";
import { frameDurationMicros, frameTimestampMicros, type ExportPlan } from "./plan";
import { exportProgress, type ExportProgress } from "./progress";
import type { DisposableResource, FrameReleaser, FrameSource, VideoWriter } from "./providers";

// Re-exported here because "cancel" is part of the run loop's public contract;
// the declaration itself lives in `errors` so the other modules can share it.
export { ExportCancelledError } from "./errors";

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
  /**
   * Extra resources shared with the writer — chiefly the muxer container. They
   * are disposed after the source and writer, in the order given. Disposal is
   * best-effort and idempotent; a cleanup failure never masks the run's outcome.
   */
  resources?: readonly DisposableResource[];
}

/**
 * Renders every frame in the plan and encodes it, returning the finished file
 * bytes.
 *
 * Throws {@link ExportCancelledError} if the signal aborts, and always disposes
 * the source, writer and shared resources — including on error — so a failed or
 * cancelled export never leaks an encoder, a decoder, or a half-written muxer.
 */
export async function runVideoExport<TFrame>(
  options: RunVideoExportOptions<TFrame>,
): Promise<Uint8Array> {
  const { plan, frameSource, videoWriter, signal, onProgress } = options;
  const release = options.releaseFrame ?? defaultRelease;
  const resources = options.resources ?? [];
  const frameDuration = frameDurationMicros(plan);
  const cancellation = new ExportCancellation(signal, () => videoWriter.pendingError?.() ?? null);

  const report = (phase: Parameters<typeof exportProgress>[0], completed: number) =>
    onProgress?.(exportProgress(phase, completed, plan.totalFrames));

  /**
   * Runs an awaited step and, if it throws, maps the failure to the run's
   * outcome: an abort that landed while the step was in flight wins over the
   * step's own error (unless the encoder had already failed before the abort).
   */
  const guard = async <T>(step: () => Promise<T> | T): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      return cancellation.rethrow(error);
    }
  };

  try {
    cancellation.throwIfAborted();
    report("preparing", 0);

    for (let i = 0; i < plan.totalFrames; i++) {
      cancellation.throwIfAborted();

      const timelineFrame = plan.startFrame + i;
      const frame = await guard(() => frameSource.renderFrame(timelineFrame));

      // Ownership begins now: release the frame on every path, including a
      // cancellation observed between rendering and encoding.
      try {
        cancellation.throwIfAborted();
        await guard(() =>
          videoWriter.addFrame(frame, frameTimestampMicros(plan, i), frameDuration),
        );
        // A cancel that raced the encode is honoured *before* the next frame,
        // so the encoder queue is never fed once the user has stopped us.
        cancellation.throwIfAborted();
      } finally {
        releaseSafely(release, frame);
      }

      report("rendering", i + 1);
    }

    cancellation.throwIfAborted();
    report("finalizing", plan.totalFrames);
    const bytes = await guard(() => videoWriter.finalize());
    // A cancel that raced the flush is still a cancel: report it and discard the
    // bytes rather than handing back a file the user asked not to make.
    cancellation.throwIfAborted();

    report("done", plan.totalFrames);
    return bytes;
  } finally {
    cancellation.dispose();
    // One fixed teardown order no matter how the run ended. Each disposal is
    // idempotent and best-effort, so a caller cleaning up the muxer again is
    // harmless and a cleanup error cannot mask the outcome.
    await safeDispose(frameSource);
    await safeDispose(videoWriter);
    for (const resource of resources) await safeDispose(resource);
  }
}

/** Closes a frame if it exposes `close()` (the WebCodecs `VideoFrame` shape). */
function defaultRelease<TFrame>(frame: TFrame): void {
  const closable = frame as { close?: () => void };
  if (typeof closable?.close === "function") closable.close();
}

function releaseSafely<TFrame>(release: FrameReleaser<TFrame>, frame: TFrame): void {
  try {
    release(frame);
  } catch {
    // Releasing is bookkeeping; a throwing `close()` must not replace the real
    // outcome of the export.
  }
}

async function safeDispose(target: DisposableResource): Promise<void> {
  try {
    await target.dispose?.();
  } catch {
    // A cleanup failure must not mask the real outcome (success or the original
    // error); the resources are being discarded regardless.
  }
}
