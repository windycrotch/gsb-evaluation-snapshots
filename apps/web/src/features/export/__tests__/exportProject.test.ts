/**
 * Adapter-level tests for `exportProjectToBlob`: the browser pieces (container,
 * encoders, frame source) are faked, but the *real* engine orchestrator drives
 * the frame loop, so the cancel/error wiring under test is the production one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCancelledError } from "@cutaway/export-engine";
import type { ExportSettings, ProjectDocument } from "@cutaway/types";

// Shared fake state, rebuilt per test. vi.hoisted makes it available inside
// the (hoisted) module factories below.
const mocks = vi.hoisted(() => ({
  container: null as null | {
    addAudioChunk: ReturnType<typeof vi.fn>;
    addVideoChunk: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  },
  frameSource: null as null | {
    renderFrame: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
  videoWriter: null as null | {
    addFrame: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
  mixProjectAudio: vi.fn(),
  encodeAudioBuffer: vi.fn(),
  cacheDestroy: vi.fn(),
}));

vi.mock("../capabilities", () => ({
  isExportSupported: () => true,
  resolveVideoConfig: vi.fn(async () => ({
    encoderConfig: { codec: "avc1.42001f" },
    muxerCodec: "avc",
    codec: "h264",
  })),
  resolveAudioConfig: vi.fn(async () => ({
    encoderConfig: { codec: "mp4a.40.2" },
    muxerCodec: "aac",
  })),
}));

vi.mock("../mixAudio", () => ({ mixProjectAudio: mocks.mixProjectAudio }));
vi.mock("../encodeAudio", () => ({ encodeAudioBuffer: mocks.encodeAudioBuffer }));

vi.mock("../MediaContainer", () => ({
  MediaContainer: { create: vi.fn(() => mocks.container) },
}));

vi.mock("../PixiExportFrameSource", () => ({
  PixiExportFrameSource: { create: vi.fn(async () => mocks.frameSource) },
}));

vi.mock("../WebCodecsVideoWriter", () => ({
  WebCodecsVideoWriter: { create: vi.fn(() => mocks.videoWriter) },
}));

vi.mock("@/features/preview/MediaTextureCache", () => ({
  MediaTextureCache: class {
    destroy = mocks.cacheDestroy;
  },
}));

import { exportProjectToBlob } from "../exportProject";

const settings = {
  format: "mp4",
  resolution: { width: 640, height: 480 },
  frameRate: 30,
  videoBitrate: 1_000_000,
  audioBitrate: 128_000,
  videoCodec: "h264",
  audioCodec: "aac",
  range: null,
} as ExportSettings;

const project = {
  name: "Demo Reel",
  durationFrames: 5,
  exportSettings: settings,
  entities: {
    clips: {
      c1: {
        id: "c1",
        trackId: "t1",
        startFrame: 0,
        durationFrames: 5,
        hidden: false,
        content: { kind: "media", mediaId: "m1", mediaKind: "video" },
      },
    },
    tracks: { t1: { id: "t1", kind: "video", hidden: false } },
    captionTracks: {},
    media: {},
  },
} as unknown as ProjectDocument;

const store = {} as never;

beforeEach(() => {
  vi.clearAllMocks();

  mocks.container = {
    addAudioChunk: vi.fn(),
    addVideoChunk: vi.fn(),
    finalize: vi.fn(() => new Uint8Array([9, 9, 9])),
    discard: vi.fn(),
  };
  mocks.frameSource = {
    renderFrame: vi.fn(async (frame: number) => ({ frame, close: vi.fn() })),
    dispose: vi.fn(),
  };
  mocks.videoWriter = {
    addFrame: vi.fn(async () => {}),
    // Mirrors the real WebCodecsVideoWriter: finalize finalises the shared
    // container, abort discards it.
    finalize: vi.fn(async () => mocks.container!.finalize()),
    abort: vi.fn(() => mocks.container!.discard()),
    dispose: vi.fn(),
  };
  mocks.mixProjectAudio.mockResolvedValue({
    numberOfChannels: 2,
    sampleRate: 48_000,
    length: 48_000,
  });
  // The audio encoder pushes its chunks into the shared container.
  mocks.encodeAudioBuffer.mockImplementation(
    async (_buffer: unknown, _config: unknown, container: (typeof mocks)["container"]) => {
      container!.addAudioChunk({ fake: "audio-chunk" });
    },
  );
});

describe("exportProjectToBlob", () => {
  it("completes: audio first, then frames, then a finalised container", async () => {
    const result = await exportProjectToBlob(project, store, {});

    expect(result.filename).toBe("Demo_Reel.mp4");
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(3);

    // Audio was encoded into the container before the video loop ran.
    expect(mocks.encodeAudioBuffer).toHaveBeenCalledOnce();
    expect(mocks.container!.addAudioChunk).toHaveBeenCalled();
    const audioOrder = mocks.encodeAudioBuffer.mock.invocationCallOrder[0]!;
    const videoOrder = mocks.videoWriter!.addFrame.mock.invocationCallOrder[0]!;
    expect(audioOrder).toBeLessThan(videoOrder);

    // The finished container was returned, not discarded.
    expect(mocks.container!.finalize).toHaveBeenCalledOnce();
    expect(mocks.container!.discard).not.toHaveBeenCalled();
    expect(mocks.videoWriter!.abort).not.toHaveBeenCalled();

    // Everything was released.
    expect(mocks.frameSource!.dispose).toHaveBeenCalledOnce();
    expect(mocks.videoWriter!.dispose).toHaveBeenCalledOnce();
    expect(mocks.cacheDestroy).toHaveBeenCalledOnce();
  });

  it("mid-export cancel: discards the container and releases everything", async () => {
    const controller = new AbortController();
    mocks.frameSource!.renderFrame.mockImplementation(async (frame: number) => {
      if (frame === 2) controller.abort();
      return { frame, close: vi.fn() };
    });

    await expect(
      exportProjectToBlob(project, store, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // The partial file is invalidated, never finalised.
    expect(mocks.videoWriter!.abort).toHaveBeenCalledOnce();
    expect(mocks.container!.discard).toHaveBeenCalled();
    expect(mocks.container!.finalize).not.toHaveBeenCalled();

    // Frames, decoders, encoders, textures all released.
    expect(mocks.frameSource!.dispose).toHaveBeenCalledOnce();
    expect(mocks.videoWriter!.dispose).toHaveBeenCalledOnce();
    expect(mocks.cacheDestroy).toHaveBeenCalledOnce();
  });

  it("writer throws: the error propagates and the container is discarded", async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    mocks.frameSource!.renderFrame.mockImplementation(async (frame: number) => {
      const close = vi.fn();
      closes.push(close);
      return { frame, close };
    });
    let calls = 0;
    mocks.videoWriter!.addFrame.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error("encoder blew up");
    });

    await expect(exportProjectToBlob(project, store, {})).rejects.toThrow("encoder blew up");

    // The frame being encoded when the writer threw was still released.
    expect(closes).toHaveLength(2);
    expect(closes.every((c) => c.mock.calls.length === 1)).toBe(true);

    expect(mocks.videoWriter!.abort).toHaveBeenCalledOnce();
    expect(mocks.container!.discard).toHaveBeenCalled();
    expect(mocks.container!.finalize).not.toHaveBeenCalled();
    expect(mocks.frameSource!.dispose).toHaveBeenCalledOnce();
    expect(mocks.videoWriter!.dispose).toHaveBeenCalledOnce();
    expect(mocks.cacheDestroy).toHaveBeenCalledOnce();
  });

  it("failure after audio was written: the audio-only container is discarded, not returned", async () => {
    const controller = new AbortController();
    mocks.frameSource!.renderFrame.mockImplementation(async (frame: number) => {
      controller.abort(); // cancel as soon as the video loop starts
      return { frame, close: vi.fn() };
    });

    await expect(
      exportProjectToBlob(project, store, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // The audio track really did land in the container first…
    expect(mocks.encodeAudioBuffer).toHaveBeenCalledOnce();
    expect(mocks.container!.addAudioChunk).toHaveBeenCalled();
    // …but those bytes were discarded, never finalised into a "product".
    expect(mocks.container!.discard).toHaveBeenCalled();
    expect(mocks.container!.finalize).not.toHaveBeenCalled();
    expect(mocks.videoWriter!.dispose).toHaveBeenCalledOnce();
  });

  it("audio encode failure also discards the container before the video loop exists", async () => {
    mocks.encodeAudioBuffer.mockRejectedValueOnce(new Error("audio encoder blew up"));

    await expect(exportProjectToBlob(project, store, {})).rejects.toThrow("audio encoder blew up");

    expect(mocks.container!.discard).toHaveBeenCalled();
    expect(mocks.container!.finalize).not.toHaveBeenCalled();
    expect(mocks.cacheDestroy).toHaveBeenCalledOnce();
  });
});
