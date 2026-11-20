/**
 * The full export pipeline: audio preparation, frame-source and writer
 * construction, the render loop, and a single, fixed teardown.
 *
 * `runVideoExport` handles the loop but assumes the source and writer already
 * exist. In the browser the chain is longer — audio is mixed and encoded into
 * the shared container *first*, then the frame source is built, then the writer
 * — and a cancellation (or a throw) can land between any two stages. Without one
 * owner for the whole thing, an early failure leaks the container that was
 * already created, or a source that was half-built.
 *
 * This function is that owner. Whatever happens it disposes, in this order:
 * frame source, video writer, shared resource (the muxer container). Disposal is
 * best-effort and idempotent, so a caller decommissioning the container again
 * is harmless and a cleanup failure never masks the run's real outcome.
 *
 * It stays backend-agnostic: every browser-specific piece arrives as a factory
 * callback, so tests drive it with fake sources and writers.
 */

import { ExportCancellation } from "./cancellation";
import type { ExportPlan } from "./plan";
import type { ExportProgress } from "./progress";
import type { DisposableResource, FrameReleaser, FrameSource, VideoWriter } from "./providers";
import { runVideoExport } from "./run";

export interface ExportPipelineOptions<TFrame> {
  plan: ExportPlan;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /**
   * A resource shared by the audio and video stages — the muxer container. It is
   * created by the caller (it needs codec configuration) and owned by the
   * pipeline from the moment it is passed: disposed last, and never finalized
   * by the pipeline itself (only the writer finalizes, on success).
   */
  resource?: DisposableResource;
  /**
   * Mixes and encodes audio into {@link resource}. Runs first, may take a while,
   * and must honour the signal: once aborted it must not append more chunks.
   */
  prepareAudio?: (signal: AbortSignal | undefined) => Promise<void>;
  /**
   * Builds and initialises the frame source. If it throws — including on
   * cancellation mid-initialisation — it must clean up anything it allocated
   * before throwing; the pipeline can only dispose a source it was handed.
   */
  createFrameSource: (signal: AbortSignal | undefined) => Promise<FrameSource<TFrame>>;
  /** Builds the writer bound to {@link resource}. */
  createVideoWriter: () => VideoWriter<TFrame>;
  /** How to release each frame; defaults to the writer/source convention. */
  releaseFrame?: FrameReleaser<TFrame>;
}

/**
 * Runs the whole export and returns the finished bytes, or throws the
 * cancellation / encoder error that ended it.
 */
export async function runExportPipeline<TFrame>(
  options: ExportPipelineOptions<TFrame>,
): Promise<Uint8Array> {
  const { plan, signal, onProgress, resource, prepareAudio, createFrameSource, createVideoWriter } =
    options;
  const cancellation = new ExportCancellation(signal);

  let frameSource: FrameSource<TFrame> | undefined;
  let videoWriter: VideoWriter<TFrame> | undefined;
  // Once `runVideoExport` takes over it disposes the source and writer itself;
  // disposing again here would only be redundant (idempotent, but noisy in
  // tests that count calls).
  let handedToRun = false;

  try {
    cancellation.throwIfAborted();
    await prepareAudio?.(signal);
    cancellation.throwIfAborted();

    frameSource = await createFrameSource(signal);
    cancellation.throwIfAborted();

    videoWriter = createVideoWriter();
    handedToRun = true;

    return await runVideoExport<TFrame>({
      plan,
      frameSource,
      videoWriter,
      signal,
      onProgress,
      releaseFrame: options.releaseFrame,
    });
  } catch (error) {
    // Before the run started, the signal is the only authority: a throw that
    // raced an abort is a cancellation. After it started, `runVideoExport`
    // already resolved the error/cancel race, so pass its outcome through
    // untouched.
    if (!handedToRun) cancellation.rethrow(error);
    throw error;
  } finally {
    cancellation.dispose();
    if (!handedToRun) {
      await safeDispose(frameSource);
      await safeDispose(videoWriter);
    }
    await safeDispose(resource);
  }
}

async function safeDispose(target: DisposableResource | undefined): Promise<void> {
  try {
    await target?.dispose?.();
  } catch {
    // Cleanup must never mask the outcome that got us here.
  }
}
