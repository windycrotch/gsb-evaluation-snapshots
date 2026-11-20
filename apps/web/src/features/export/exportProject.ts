"use client";

import type { MediaBlobStore } from "@cutaway/media-engine";
import {
  ExportCancelledError,
  exportFilename,
  exportMimeType,
  planExport,
  runExportPipeline,
  type ExportProgress,
} from "@cutaway/export-engine";
import type { ExportSettings, ProjectDocument } from "@cutaway/types";
import { MediaTextureCache } from "@/features/preview/MediaTextureCache";
import { isExportSupported, resolveAudioConfig, resolveVideoConfig } from "./capabilities";
import { MediaContainer } from "./MediaContainer";
import { PixiExportFrameSource } from "./PixiExportFrameSource";
import { WebCodecsVideoWriter } from "./WebCodecsVideoWriter";
import { mixProjectAudio } from "./mixAudio";
import { encodeAudioBuffer } from "./encodeAudio";

export interface ExportResult {
  blob: Blob;
  filename: string;
}

export interface ExportProjectOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /** Overrides the project's stored export settings for this run. */
  settings?: ExportSettings;
}

/**
 * Renders and encodes a project to a video Blob using the project's own export
 * settings.
 *
 * Each call is a self-contained job: it builds its own container, encoder, frame
 * source and texture cache, and tears all of them down before it settles. Nothing
 * is shared between calls, so a second export started right after a cancelled or
 * failed one can never inherit a stale muxer, encoder or frame cache.
 *
 * The order is deliberate: audio is mixed and encoded into the shared container
 * *first* (it's cheap and one-shot), then the video loop runs, whose final step
 * finalises the container with both tracks in place. `runExportPipeline` owns
 * that whole sequence — including cancellation at any stage and the single fixed
 * teardown — so this function only wires the browser pieces together and
 * degrades to video-only when there is no audio or the browser can't encode it.
 *
 * It resolves to a {@link Blob} (with the container's MIME type and a sanitised
 * filename) only on success. Cancellation rejects with `ExportCancelledError`
 * and an encoder/container failure rejects with that error; in neither case is a
 * partial file produced.
 */
export async function exportProjectToBlob(
  project: ProjectDocument,
  store: MediaBlobStore,
  options: ExportProjectOptions = {},
): Promise<ExportResult> {
  if (!isExportSupported()) {
    throw new Error(
      "This browser can't export video — it lacks the WebCodecs API. Try a recent Chrome or Edge.",
    );
  }

  const settings = options.settings ?? project.exportSettings;
  const plan = planExport(project, settings);
  const signal = options.signal;

  // Codec probing is async and allocates nothing worth cleaning up, so it runs
  // before the pipeline takes over. A cancel that lands during probing is caught
  // by the pipeline's entry checkpoint.
  const videoConfig = await resolveVideoConfig(plan);
  if (signal?.aborted) throw new ExportCancelledError();

  // Mixing needs the plan but not the container; resolving the audio config needs
  // the mix's channel/sample layout. Both happen up front so the container can be
  // declared with both tracks (the container format requires it). Either step may
  // yield nothing (no audio, audio disabled, unsupported) → video-only.
  let mixed: AudioBuffer | null = null;
  let audioConfig = null;
  if (plan.audioCodec !== "none") {
    mixed = await mixProjectAudio(project, store, plan, signal);
    if (mixed && !signal?.aborted) {
      audioConfig = await resolveAudioConfig(plan, mixed.numberOfChannels, mixed.sampleRate);
    }
  }

  // The container must exist before the audio is encoded into it; the pipeline
  // owns it from here and disposes it last, whatever happens next.
  const container = MediaContainer.create(plan, videoConfig, audioConfig);

  const bytes = await runExportPipeline<VideoFrame>({
    plan,
    signal,
    onProgress: options.onProgress,
    resource: container,
    prepareAudio: async (audioSignal) => {
      if (!mixed || !audioConfig || audioSignal?.aborted) return;
      await encodeAudioBuffer(mixed, audioConfig, container, audioSignal);
    },
    createFrameSource: (sourceSignal) =>
      PixiExportFrameSource.create(
        project,
        store,
        // A fresh cache per export: the previous run's textures and object URLs
        // are released with its source, never reused here.
        new MediaTextureCache(store),
        plan.resolution,
        plan.frameRate,
        plan.startFrame,
        plan.endFrame,
        sourceSignal,
      ),
    createVideoWriter: () => WebCodecsVideoWriter.create(plan, container, videoConfig, signal),
  });

  const mime = exportMimeType(plan.format);
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return { blob, filename: exportFilename(project.name, plan.format) };
}

// Re-exported so callers that only import this module keep working; the
// definitions live in the pure engine so they are tested there.
export { exportFilename, exportMimeType };
