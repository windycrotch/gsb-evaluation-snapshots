"use client";

import { ExportCancelledError, type ExportPlan, type VideoWriter } from "@cutaway/export-engine";
import type { MediaContainer } from "./MediaContainer";
import type { ResolvedVideoConfig } from "./capabilities";

/**
 * A VideoWriter that encodes frames with WebCodecs into a shared MediaContainer.
 *
 * The engine drives *when* each frame is written and at what timestamp; this
 * class owns *how* — encoder configuration, keyframe cadence, and backpressure.
 * The muxer lives in the container (shared with the audio track), so this
 * writer's `finalize` flushes the video encoder and then finalises the whole
 * file — by which point any audio has already been muxed in.
 *
 * Three correctness details:
 * - Timestamps come from the engine, not the source frame: each frame is
 *   re-wrapped with the engine's PTS/duration before encoding, so the chunk's
 *   own timestamp is exact and the muxer needs no override. The encoder runs in
 *   `realtime` latency mode, disabling B-frames, so decode order == presentation
 *   order and no composition-time bookkeeping is needed.
 * - Backpressure is honoured via the encoder's `dequeue` event, so a long export
 *   doesn't buffer every frame in memory at once.
 * - **Cancellation.** WebCodecs reports errors through an async `error`
 *   callback, so the writer cannot just `try/catch` the failure; it records the
 *   first fatal error and surfaces it on the next call. The engine samples that
 *   record the moment an abort fires ({@link pendingError}), which is how an
 *   encoder error that happened *before* a cancel wins over the cancel while one
 *   that arrives *after* it does not. The writer also refuses to append frames
 *   once its signal has aborted, and never finalizes the container after an
 *   abort, so a cancelled export cannot produce bytes.
 */
export class WebCodecsVideoWriter implements VideoWriter<VideoFrame> {
  private readonly encoder: VideoEncoder;
  private readonly container: MediaContainer;
  private readonly keyFrameInterval: number;
  private readonly signal: AbortSignal | undefined;
  private framesEncoded = 0;
  /** The first fatal encoder error, surfaced on the next call. */
  private failure: Error | null = null;
  private disposed = false;

  private constructor(
    encoder: VideoEncoder,
    container: MediaContainer,
    keyFrameInterval: number,
    signal: AbortSignal | undefined,
  ) {
    this.encoder = encoder;
    this.container = container;
    this.keyFrameInterval = keyFrameInterval;
    this.signal = signal;
  }

  /** Configures a video encoder that feeds the shared container. */
  static create(
    plan: ExportPlan,
    container: MediaContainer,
    config: ResolvedVideoConfig,
    signal?: AbortSignal,
  ): WebCodecsVideoWriter {
    // A keyframe every ~2 seconds: enough seek granularity without inflating the
    // file the way all-keyframe output would.
    const keyFrameInterval = Math.max(1, Math.round(plan.frameRate * 2));

    const writer = new WebCodecsVideoWriter(
      new VideoEncoder({
        // The chunk's own timestamp is the engine PTS (each frame is re-stamped
        // before encoding), so the muxer needs no timestamp override.
        output: (chunk, meta) => {
          try {
            container.addVideoChunk(chunk, meta);
          } catch (error) {
            writer.failure ??= asError(error);
          }
        },
        error: (error) => {
          writer.failure ??= asError(error);
        },
      }),
      container,
      keyFrameInterval,
      signal,
    );

    // realtime mode disables B-frames, keeping decode order == presentation order.
    writer.encoder.configure({ ...config.encoderConfig, latencyMode: "realtime" });
    return writer;
  }

  /** The first fatal encoder error, without throwing. Read by the engine on abort. */
  pendingError(): Error | null {
    // Reported unconditionally: the engine samples this the instant the abort
    // fires, so an error recorded *before* the cancel is seen and wins, while one
    // recorded afterwards is simply outside that snapshot and cannot mask the
    // cancellation.
    return this.failure;
  }

  async addFrame(
    frame: VideoFrame,
    timestampMicros: number,
    durationMicros: number,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    throwIfAborted(this.signal);

    // Backpressure: let the encoder drain before piling on more work.
    while (this.encoder.encodeQueueSize > 8) {
      await waitForDequeue(this.encoder);
      if (this.failure) throw this.failure;
      // Stopped while queued: do not feed the encoder another frame, but let the
      // caller release the frame it already handed over.
      throwIfAborted(this.signal);
    }

    const keyFrame = this.framesEncoded % this.keyFrameInterval === 0;
    // A fresh VideoFrame carrying the engine's timestamp/duration makes the
    // encoded chunk's own timing exact, so the muxer needs no PTS override.
    const stamped = new VideoFrame(frame, {
      timestamp: timestampMicros,
      duration: durationMicros,
    });
    try {
      this.encoder.encode(stamped, { keyFrame });
    } finally {
      stamped.close();
    }
    this.framesEncoded += 1;
  }

  /** Flushes the video encoder and finalises the whole container. */
  async finalize(): Promise<Uint8Array> {
    if (this.failure) throw this.failure;
    throwIfAborted(this.signal);

    await this.encoder.flush();
    if (this.failure) throw this.failure;
    // A cancel during the flush must not turn into a file: the bytes are only
    // generated after this check.
    throwIfAborted(this.signal);

    return this.container.finalize();
  }

  /** Releases the encoder. Idempotent and safe after an encoder error. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.encoder.state !== "closed") this.encoder.close();
    } catch {
      // Already errored/closed by the browser; nothing left to release.
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

/** Resolves when the encoder signals it has drained a chunk, or after a tick. */
function waitForDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      encoder.removeEventListener("dequeue", done);
      resolve();
    };
    encoder.addEventListener("dequeue", done, { once: true });
    // Fallback in case the browser does not emit 'dequeue' promptly.
    setTimeout(done, 8);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
