"use client";

import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import type { ExportPlan } from "@cutaway/export-engine";
import type { ResolvedAudioConfig, ResolvedVideoConfig } from "./capabilities";

/**
 * Owns the muxer and both media tracks for one export.
 *
 * Video and audio are encoded by separate WebCodecs encoders but must land in
 * the *same* file, so the muxer can't belong to either encoder — it lives here,
 * declared with both tracks up front (the container format requires that). The
 * video writer and the audio encoder each push their chunks in; whoever runs
 * last calls `finalize`. Order between tracks doesn't matter: with in-memory
 * fast-start the muxer interleaves samples by timestamp at finalize.
 *
 * A container is single-use. Once it is finalized or disposed it is *closed*:
 * any further chunk is refused, because appending to a finished muxer either
 * corrupts the file or throws from deep inside the muxer. Closing is idempotent
 * so the run's fixed teardown can dispose it without caring whether `finalize`
 * already ran.
 */
type Backing =
  { kind: "mp4"; muxer: Mp4Muxer<Mp4Target> } | { kind: "webm"; muxer: WebmMuxer<WebmTarget> };

export class MediaContainer {
  private closed = false;

  private constructor(private readonly backing: Backing) {}

  static create(
    plan: ExportPlan,
    video: ResolvedVideoConfig,
    audio: ResolvedAudioConfig | null,
  ): MediaContainer {
    const { width, height } = plan.resolution;

    if (plan.format === "webm") {
      const muxer = new WebmMuxer({
        target: new WebmTarget(),
        video: { codec: video.muxerCodec, width, height, frameRate: plan.frameRate },
        audio: audio
          ? {
              codec: audio.muxerCodec,
              numberOfChannels: audio.encoderConfig.numberOfChannels,
              sampleRate: audio.encoderConfig.sampleRate,
            }
          : undefined,
        firstTimestampBehavior: "offset",
      });
      return new MediaContainer({ kind: "webm", muxer });
    }

    const muxer = new Mp4Muxer({
      target: new Mp4Target(),
      video: {
        codec: video.muxerCodec as "avc" | "hevc" | "vp9" | "av1",
        width,
        height,
        frameRate: plan.frameRate,
      },
      audio: audio
        ? {
            codec: audio.muxerCodec as "aac" | "opus",
            numberOfChannels: audio.encoderConfig.numberOfChannels,
            sampleRate: audio.encoderConfig.sampleRate,
          }
        : undefined,
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });
    return new MediaContainer({ kind: "mp4", muxer });
  }

  /** True once the file is finished or the container was disposed. */
  get isClosed(): boolean {
    return this.closed;
  }

  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (this.closed) return; // Post-cancel/close stragglers are dropped, not thrown.
    this.backing.muxer.addVideoChunk(chunk, meta);
  }

  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    if (this.closed) return;
    this.backing.muxer.addAudioChunk(chunk, meta);
  }

  /**
   * Finishes the file and returns its bytes. Call once, after all chunks. A
   * second call (or a call after {@link dispose}) throws rather than returning
   * garbage, so a lifecycle mistake is loud instead of producing a broken file.
   */
  finalize(): Uint8Array {
    if (this.closed) throw new Error("Media container already finalized or disposed.");
    this.closed = true;
    this.backing.muxer.finalize();
    return new Uint8Array(this.backing.muxer.target.buffer);
  }

  /**
   * Abandons the container without producing a file. Safe to call after
   * {@link finalize} and safe to call repeatedly — the muxer holds only memory,
   * so closing is just latching the closed flag and letting the buffer go.
   */
  dispose(): void {
    this.closed = true;
  }
}
