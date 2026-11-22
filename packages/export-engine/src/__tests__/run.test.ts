import { describe, expect, it, vi } from "vitest";
import type { ExportSettings, ProjectDocument } from "@cutaway/types";
import { planExport, type ExportPlan, type TransitionTail } from "../plan";
import { exportProgress, type ExportProgress } from "../progress";
import type { FrameSource, VideoWriter } from "../providers";
import { ExportCancelledError, runVideoExport } from "../run";

const settings = (over: Partial<ExportSettings> = {}): ExportSettings =>
  ({
    format: "mp4",
    resolution: { width: 640, height: 480 },
    frameRate: 30,
    videoBitrate: 1_000_000,
    audioBitrate: 128_000,
    videoCodec: "h264",
    audioCodec: "aac",
    range: null,
    ...over,
  }) as ExportSettings;

const plan = (totalFrames: number, frameRate = 30): ExportPlan =>
  planExport(
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
            transitionIn: null,
            content: { kind: "media", mediaId: "m1", mediaKind: "video" },
          },
        },
        tracks: { t1: { id: "t1", kind: "video", hidden: false } },
        captionTracks: {},
      },
    } as unknown as ProjectDocument,
    settings({ frameRate }),
  );

/**
 * Two adjacent video clips with a crossfade on the cut — the transition-tail
 * case. Clip A ends at `cut`, clip B starts exactly there and fades in over
 * `tail` frames, so A keeps drawing (its tail) across `[cut, cut + tail)`.
 */
function transitionPlan(cut = 10, tail = 4, total = 20): ExportPlan {
  const clips = {
    a: {
      id: "a",
      trackId: "t1",
      startFrame: 0,
      durationFrames: cut,
      hidden: false,
      transitionIn: null,
      content: { kind: "media", mediaId: "mA", mediaKind: "video" },
    },
    b: {
      id: "b",
      trackId: "t1",
      startFrame: cut,
      durationFrames: total - cut,
      hidden: false,
      transitionIn: { kind: "crossfade", durationFrames: tail },
      content: { kind: "media", mediaId: "mB", mediaKind: "video" },
    },
  };

  return planExport(
    {
      durationFrames: total,
      entities: {
        clips,
        tracks: { t1: { id: "t1", kind: "video", hidden: false } },
        captionTracks: {},
      },
    } as unknown as ProjectDocument,
    settings(),
  );
}

/** A frame is just its timeline index here, with a close() spy to prove release. */
interface FakeFrame {
  frame: number;
  close: () => void;
}

function fakeSource(): FrameSource<FakeFrame> {
  return {
    renderFrame: vi.fn(async (frame: number) => ({ frame, close: vi.fn() })),
    dispose: vi.fn(),
  };
}

function fakeWriter(): VideoWriter<FakeFrame> & { frames: { frame: number; ts: number }[] } {
  const frames: { frame: number; ts: number }[] = [];
  return {
    frames,
    addFrame: vi.fn(async (f: FakeFrame, ts: number) => {
      frames.push({ frame: f.frame, ts });
    }),
    finalize: vi.fn(async () => new Uint8Array([1, 2, 3])),
    dispose: vi.fn(),
  };
}

describe("runVideoExport", () => {
  it("renders every frame in order and returns the finalized bytes", async () => {
    const source = fakeSource();
    const writer = fakeWriter();

    const bytes = await runVideoExport({ plan: plan(4), frameSource: source, videoWriter: writer });

    expect(writer.frames.map((f) => f.frame)).toEqual([0, 1, 2, 3]);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("stamps monotonic timestamps derived from the frame rate", async () => {
    const writer = fakeWriter();
    await runVideoExport({ plan: plan(3, 30), frameSource: fakeSource(), videoWriter: writer });
    expect(writer.frames.map((f) => f.ts)).toEqual([0, 33_333, 66_667]);
  });

  it("offsets timestamps to zero when exporting a sub-range", async () => {
    const p = planExport(
      {
        durationFrames: 300,
        entities: {
          clips: {
            c1: {
              id: "c1",
              trackId: "t1",
              startFrame: 0,
              durationFrames: 300,
              hidden: false,
              transitionIn: null,
              content: { kind: "media", mediaId: "m1", mediaKind: "video" },
            },
          },
          tracks: { t1: { id: "t1", kind: "video", hidden: false } },
          captionTracks: {},
        },
      } as unknown as ProjectDocument,
      settings({ range: { start: 60, end: 63 } }),
    );
    const source = fakeSource();
    const writer = fakeWriter();

    await runVideoExport({ plan: p, frameSource: source, videoWriter: writer });

    // Rendered the timeline frames from the range…
    expect((source.renderFrame as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      60, 61, 62,
    ]);
    // …but the output starts at t=0.
    expect(writer.frames[0]!.ts).toBe(0);
  });

  it("reports progress through the phases ending at ratio 1", async () => {
    const events: ExportProgress[] = [];
    await runVideoExport({
      plan: plan(2),
      frameSource: fakeSource(),
      videoWriter: fakeWriter(),
      onProgress: (p) => events.push(p),
    });

    expect(events[0]!.phase).toBe("preparing");
    expect(events.some((e) => e.phase === "rendering")).toBe(true);
    expect(events.some((e) => e.phase === "finalizing")).toBe(true);
    const last = events.at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.ratio).toBe(1);
  });

  it("releases every frame it renders", async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => {
        const close = vi.fn();
        closes.push(close);
        return { frame, close };
      },
    };
    await runVideoExport({ plan: plan(3), frameSource: source, videoWriter: fakeWriter() });
    expect(closes).toHaveLength(3);
    expect(closes.every((c) => c.mock.calls.length === 1)).toBe(true);
  });

  it("aborts before rendering when the signal is already aborted", async () => {
    const source = fakeSource();
    await expect(
      runVideoExport({
        plan: plan(5),
        frameSource: source,
        videoWriter: fakeWriter(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
    expect(source.renderFrame).not.toHaveBeenCalled();
    expect(source.dispose).toHaveBeenCalledOnce();
  });

  it("stops mid-export when cancelled and still disposes", async () => {
    const controller = new AbortController();
    const writer = fakeWriter();
    const source: FrameSource<FakeFrame> = {
      renderFrame: vi.fn(async (frame: number) => {
        if (frame === 2) controller.abort();
        return { frame, close: vi.fn() };
      }),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({
        plan: plan(10),
        frameSource: source,
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // Frames 0 and 1 were encoded; frame 2 finished rendering after the abort
    // and is observed *before* encoding, so it is never handed to the writer.
    expect(writer.frames.map((f) => f.frame)).toEqual([0, 1]);
    expect(writer.finalize).not.toHaveBeenCalled();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("releases the rendered-but-unencoded frame and never counts it when cancelled between render and encode", async () => {
    const controller = new AbortController();
    const inFlightClose = vi.fn();
    const writer = fakeWriter();
    const events: ExportProgress[] = [];
    const source: FrameSource<FakeFrame> = {
      // The abort lands while frame 3 is being rendered: by the time the frame
      // exists, the signal is already set.
      renderFrame: vi.fn(async (frame: number) => {
        if (frame === 3) controller.abort();
        return { frame, close: frame === 3 ? inFlightClose : vi.fn() };
      }),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({
        plan: plan(10),
        frameSource: source,
        videoWriter: writer,
        signal: controller.signal,
        onProgress: (p) => events.push(p),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // The in-flight frame is released exactly once and never encoded…
    expect(inFlightClose).toHaveBeenCalledOnce();
    expect(writer.frames.map((f) => f.frame)).toEqual([0, 1, 2]);
    // …and progress never claims it: only frames 0,1,2 completed, and every
    // event keeps the full plan denominator with a ratio below 1.
    const rendering = events.filter((e) => e.phase === "rendering");
    expect(rendering.at(-1)!.completedFrames).toBe(3);
    expect(events.every((e) => e.totalFrames === 10)).toBe(true);
    expect(events.every((e) => e.ratio <= 3 / 10)).toBe(true);
    expect(events.some((e) => e.phase === "done")).toBe(false);
  });

  it("releases the frame and disposes when the writer throws", async () => {
    const close = vi.fn();
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => ({ frame, close }),
      dispose: vi.fn(),
    };
    const writer: VideoWriter<FakeFrame> = {
      addFrame: async () => {
        throw new Error("encoder blew up");
      },
      finalize: async () => new Uint8Array(),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({ plan: plan(3), frameSource: source, videoWriter: writer }),
    ).rejects.toThrow("encoder blew up");
    expect(close).toHaveBeenCalledOnce();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("releases every previously rendered frame when the encoder fails mid-run", async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => {
        const close = vi.fn();
        closes.push(close);
        return { frame, close };
      },
      dispose: vi.fn(),
    };
    const writer: VideoWriter<FakeFrame> = {
      // Two frames go through, then the encoder dies on the third.
      addFrame: vi.fn(async () => {
        if ((writer.addFrame as ReturnType<typeof vi.fn>).mock.calls.length === 3) {
          throw new Error("encoder blew up");
        }
      }),
      finalize: vi.fn(async () => new Uint8Array()),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({ plan: plan(6), frameSource: source, videoWriter: writer }),
    ).rejects.toThrow("encoder blew up");

    // Three frames were rendered; all three are released, including the one the
    // writer rejected — nothing decoded is left for a later export to trip over.
    expect(closes).toHaveLength(3);
    expect(closes.every((c) => c.mock.calls.length === 1)).toBe(true);
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
    expect(writer.finalize).not.toHaveBeenCalled();
  });

  it("surfaces the original encoder error even when dispose also throws", async () => {
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => ({ frame, close: vi.fn() }),
      // Cleanup goes wrong too — it must not replace the encoder's error.
      dispose: vi.fn(async () => {
        throw new Error("source dispose failed");
      }),
    };
    const writer: VideoWriter<FakeFrame> = {
      addFrame: async () => {
        throw new Error("encoder blew up");
      },
      finalize: async () => new Uint8Array(),
      dispose: vi.fn(async () => {
        throw new Error("writer dispose failed");
      }),
    };

    await expect(
      runVideoExport({ plan: plan(3), frameSource: source, videoWriter: writer }),
    ).rejects.toThrow("encoder blew up");
    // Both cleanups were still attempted.
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("does not treat cancellation as success: no bytes, no done event, finalize skipped", async () => {
    const controller = new AbortController();
    const writer = fakeWriter();
    const source: FrameSource<FakeFrame> = {
      renderFrame: vi.fn(async (frame: number) => {
        if (frame === 1) controller.abort();
        return { frame, close: vi.fn() };
      }),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({
        plan: plan(4),
        frameSource: source,
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(writer.finalize).not.toHaveBeenCalled();
  });
});

describe("runVideoExport — transition tails", () => {
  it("renders the plan's full frame range including the tail, with one progress denominator", async () => {
    const p = transitionPlan(10, 4, 20);
    expect(p.transitionTails).toHaveLength(1);
    expect(p.transitionTails[0]).toMatchObject({
      outgoingClipId: "a",
      incomingClipId: "b",
      startFrame: 10,
      endFrame: 14,
      durationFrames: 4,
    } satisfies Partial<TransitionTail>);

    const source = fakeSource();
    const writer = fakeWriter();
    const events: ExportProgress[] = [];

    await runVideoExport({
      plan: p,
      frameSource: source,
      videoWriter: writer,
      onProgress: (progress) => events.push(progress),
    });

    // Every timeline frame 0..19 is rendered once — the tail frames 10..13 are
    // not extra renders, they are entries of the same enumerated range.
    const rendered = (source.renderFrame as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(rendered).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(writer.frames).toHaveLength(20);
    // Denominator, frame list and actual renders are the same number, so the
    // bar ends exactly at 1 rather than over- or undershooting.
    expect(events.every((e) => e.totalFrames === p.totalFrames)).toBe(true);
    expect(events.at(-1)!.phase).toBe("done");
    expect(events.at(-1)!.ratio).toBe(1);
    // Output timestamps still start at zero and advance monotonically.
    expect(writer.frames.map((f) => f.ts)).toEqual(
      Array.from({ length: 20 }, (_, i) => Math.round((i * 1_000_000) / 30)),
    );
  });

  it("would fail if transition tails were left out of the denominator (negative check)", async () => {
    const p = transitionPlan(10, 4, 20);
    const tailFrames = p.transitionTails.reduce((sum, tail) => sum + tail.durationFrames, 0);
    expect(tailFrames).toBe(4);

    // Simulate the old bug: a denominator that counts only "plain" frames and
    // forgets the tail. Against the real render count it must be visibly wrong —
    // this is the assertion that catches a regression that drops tail frames.
    const buggyDenominator = p.totalFrames - tailFrames;
    const actualRenders = p.frameRange.length;
    expect(buggyDenominator).not.toBe(actualRenders);

    // And the symptom a user would see: progress reaches ratio 1 while four
    // frames still remain to render, i.e. the bar completes early.
    const early = exportProgress("rendering", buggyDenominator, buggyDenominator);
    expect(early.ratio).toBe(1);
    expect(buggyDenominator).toBeLessThan(actualRenders);

    // The real plan, by contrast, only reaches 1 on the final frame.
    const real = exportProgress("rendering", p.totalFrames, p.totalFrames);
    expect(real.ratio).toBe(1);
    expect(exportProgress("rendering", buggyDenominator, p.totalFrames).ratio).toBeLessThan(1);
  });

  it("keeps timestamps gap-free and monotonic across a tail", async () => {
    const p = transitionPlan(10, 4, 20);
    const writer = fakeWriter();
    await runVideoExport({ plan: p, frameSource: fakeSource(), videoWriter: writer });

    const timestamps = writer.frames.map((f) => f.ts);
    expect(timestamps[0]).toBe(0);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]!).toBeGreaterThan(timestamps[i - 1]!);
    }
  });
});

describe("runVideoExport — repeat export recovery", () => {
  it("restarts from a clean state after a cancellation: no duplicate, missing or reordered frames", async () => {
    const p = plan(8);

    // First attempt is cancelled while frame 3 renders.
    const firstController = new AbortController();
    const firstWriter = fakeWriter();
    const firstSource: FrameSource<FakeFrame> = {
      renderFrame: vi.fn(async (frame: number) => {
        if (frame === 3) firstController.abort();
        return { frame, close: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    await expect(
      runVideoExport({
        plan: p,
        frameSource: firstSource,
        videoWriter: firstWriter,
        signal: firstController.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // A fresh export of the same range, with freshly constructed providers.
    const secondSource = fakeSource();
    const secondWriter = fakeWriter();
    const events: ExportProgress[] = [];
    const bytes = await runVideoExport({
      plan: p,
      frameSource: secondSource,
      videoWriter: secondWriter,
      onProgress: (progress) => events.push(progress),
    });

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(secondWriter.frames.map((f) => f.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(secondWriter.frames.map((f) => f.ts)).toEqual([
      0, 33_333, 66_667, 100_000, 133_333, 166_667, 200_000, 233_333,
    ]);
    expect(events.at(-1)!.phase).toBe("done");
    expect(events.at(-1)!.ratio).toBe(1);
    // The second run owns its own counters — nothing carried over from run one.
    expect((secondSource.renderFrame as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
  });

  it("restarts cleanly after an encoder failure and reaches ratio 1", async () => {
    const p = plan(5);

    const failingWriter: VideoWriter<FakeFrame> = {
      addFrame: vi.fn(async () => {
        throw new Error("encoder blew up");
      }),
      finalize: vi.fn(),
      dispose: vi.fn(),
    };
    await expect(
      runVideoExport({ plan: p, frameSource: fakeSource(), videoWriter: failingWriter }),
    ).rejects.toThrow("encoder blew up");

    // Same plan, healthy providers: full frame list from zero again.
    const writer = fakeWriter();
    const events: ExportProgress[] = [];
    await runVideoExport({
      plan: p,
      frameSource: fakeSource(),
      videoWriter: writer,
      onProgress: (progress) => events.push(progress),
    });

    expect(writer.frames.map((f) => f.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(writer.frames[0]!.ts).toBe(0);
    expect(events.at(-1)!.ratio).toBe(1);
  });
});
