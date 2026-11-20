import { vi } from "vitest";
import type { ExportSettings, ProjectDocument } from "@cutaway/types";
import type { ExportPlan } from "../plan";
import { planExport } from "../plan";
import type { FrameSource, VideoWriter } from "../providers";

/**
 * Shared fakes for the export-engine tests.
 *
 * A "frame" is just its timeline index plus a `close()` spy, which is enough to
 * prove the orchestrator releases every frame exactly once. The writer records
 * what it was asked to encode and whether it was finalized — the two facts every
 * cancellation/failure test turns on.
 */

export interface FakeFrame {
  frame: number;
  close: () => void;
}

/** A project with one visible video clip spanning the whole timeline. */
export function makePlan(totalFrames: number, frameRate = 30): ExportPlan {
  return planExport(
    {
      durationFrames: totalFrames,
      entities: {
        clips: {
          c1: {
            id: "c1",
            trackId: "t1",
            startFrame: 0,
            durationFrames: totalFrames,
            hidden: false,
            content: { kind: "media", mediaId: "m1", mediaKind: "video" },
          },
        },
        tracks: { t1: { id: "t1", kind: "video", hidden: false } },
        captionTracks: {},
      },
    } as unknown as ProjectDocument,
    {
      format: "mp4",
      resolution: { width: 640, height: 480 },
      frameRate,
      videoBitrate: 1_000_000,
      audioBitrate: 128_000,
      videoCodec: "h264",
      audioCodec: "aac",
      range: null,
    } as ExportSettings,
  );
}

export interface FakeSource extends FrameSource<FakeFrame> {
  readonly frames: number[];
  readonly closes: ReturnType<typeof vi.fn>[];
}

/**
 * A frame source that records each rendered frame. `onRender` lets a test run
 * side effects mid-export — aborting, throwing, or reporting an encoder error.
 */
export function fakeSource(
  onRender?: (frame: number, source: FakeSource) => void | Promise<void>,
): FakeSource {
  const frames: number[] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const source: FakeSource = {
    frames,
    closes,
    renderFrame: vi.fn(async (frame: number) => {
      frames.push(frame);
      await onRender?.(frame, source);
      const close = vi.fn();
      closes.push(close);
      return { frame, close };
    }),
    dispose: vi.fn(),
  };
  return source;
}

export interface FakeWriter extends VideoWriter<FakeFrame> {
  readonly added: { frame: number; ts: number; duration: number }[];
  setPendingError(error: Error | null): void;
}

/**
 * A writer that records frames and finalization. `onAddFrame` / `pendingError`
 * let a test inject an encoder failure — synchronously, or asynchronously to
 * mimic WebCodecs' `error` callback.
 */
export function fakeWriter(
  options: {
    onAddFrame?: (frame: FakeFrame, index: number) => void;
    finalize?: () => Promise<Uint8Array>;
  } = {},
): FakeWriter {
  const added: { frame: number; ts: number; duration: number }[] = [];
  let pending: Error | null = null;

  return {
    added,
    setPendingError: (error) => {
      pending = error;
    },
    pendingError: () => pending,
    addFrame: vi.fn(async (frame: FakeFrame, ts: number, duration: number) => {
      options.onAddFrame?.(frame, added.length);
      added.push({ frame: frame.frame, ts, duration });
    }),
    finalize: vi.fn(options.finalize ?? (async () => new Uint8Array([1, 2, 3]))),
    dispose: vi.fn(),
  };
}
