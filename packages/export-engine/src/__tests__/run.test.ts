import { describe, expect, it, vi } from "vitest";
import type { ExportProgress } from "../progress";
import type { FrameSource, VideoWriter } from "../providers";
import { ExportCancelledError, runVideoExport } from "../run";
import { fakeSource, fakeWriter, makePlan, type FakeFrame } from "./fakes";

describe("runVideoExport — success", () => {
  it("renders every frame in order and returns the finalized bytes", async () => {
    const source = fakeSource();
    const writer = fakeWriter();

    const bytes = await runVideoExport({
      plan: makePlan(4),
      frameSource: source,
      videoWriter: writer,
    });

    expect(writer.added.map((f) => f.frame)).toEqual([0, 1, 2, 3]);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(writer.finalize).toHaveBeenCalledOnce();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("stamps monotonic timestamps derived from the frame rate", async () => {
    const writer = fakeWriter();
    await runVideoExport({
      plan: makePlan(3, 30),
      frameSource: fakeSource(),
      videoWriter: writer,
    });
    expect(writer.added.map((f) => f.ts)).toEqual([0, 33_333, 66_667]);
    expect(writer.added.every((f) => f.duration === 33_333)).toBe(true);
  });

  it("offsets timestamps to zero when exporting a sub-range", async () => {
    const plan = makePlan(300);
    const ranged = { ...plan, startFrame: 60, endFrame: 63, totalFrames: 3, durationSeconds: 0.1 };
    const source = fakeSource();
    const writer = fakeWriter();

    await runVideoExport({ plan: ranged, frameSource: source, videoWriter: writer });

    expect(source.frames).toEqual([60, 61, 62]);
    expect(writer.added[0]!.ts).toBe(0);
  });

  it("reports progress through the phases ending at ratio 1", async () => {
    const events: ExportProgress[] = [];
    await runVideoExport({
      plan: makePlan(2),
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

  it("releases every frame it renders, exactly once", async () => {
    const source = fakeSource();
    await runVideoExport({ plan: makePlan(3), frameSource: source, videoWriter: fakeWriter() });
    expect(source.closes).toHaveLength(3);
    expect(source.closes.every((c) => c.mock.calls.length === 1)).toBe(true);
  });

  it("disposes shared resources after the source and writer", async () => {
    const order: string[] = [];
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => ({ frame, close: vi.fn() }),
      dispose: () => void order.push("source"),
    };
    const writer: VideoWriter<FakeFrame> = {
      addFrame: () => {},
      finalize: async () => new Uint8Array([9]),
      dispose: () => void order.push("writer"),
    };

    await runVideoExport({
      plan: makePlan(1),
      frameSource: source,
      videoWriter: writer,
      resources: [{ dispose: () => void order.push("resource") }],
    });

    expect(order).toEqual(["source", "writer", "resource"]);
  });

  it("tolerates repeated disposal of every resource", async () => {
    const resource = { dispose: vi.fn() };
    const source = fakeSource();
    const writer = fakeWriter();

    await runVideoExport({
      plan: makePlan(1),
      frameSource: source,
      videoWriter: writer,
      resources: [resource],
    });
    // A caller cleaning up again must not throw and reaches the same state.
    await expect(
      runVideoExport({
        plan: makePlan(1),
        frameSource: source,
        videoWriter: writer,
        resources: [resource],
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("runVideoExport — cancellation", () => {
  it("aborts before rendering when the signal is already aborted", async () => {
    const source = fakeSource();
    const writer = fakeWriter();
    await expect(
      runVideoExport({
        plan: makePlan(5),
        frameSource: source,
        videoWriter: writer,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(source.renderFrame).not.toHaveBeenCalled();
    expect(writer.addFrame).not.toHaveBeenCalled();
    expect(writer.finalize).not.toHaveBeenCalled();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("stops mid-export when cancelled, never finalizing the container", async () => {
    const controller = new AbortController();
    const writer = fakeWriter();
    const source = fakeSource((frame) => {
      if (frame === 2) controller.abort();
    });

    await expect(
      runVideoExport({
        plan: makePlan(10),
        frameSource: source,
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // Frames 0,1 were encoded before the abort fired during frame 2's render;
    // that frame is never handed to the encoder but is still released.
    expect(writer.added.map((f) => f.frame)).toEqual([0, 1]);
    expect(source.closes).toHaveLength(3);
    expect(source.closes[2]!.mock.calls.length).toBe(1);
    expect(writer.finalize).not.toHaveBeenCalled();
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("releases the in-flight frame when cancelled between render and encode", async () => {
    const controller = new AbortController();
    const writer = fakeWriter({
      onAddFrame: () => controller.abort(),
    });
    const source = fakeSource();

    await expect(
      runVideoExport({
        plan: makePlan(5),
        frameSource: source,
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    // Only frame 0 reached the writer, and its frame was released despite the
    // cancel that raced the encode.
    expect(writer.added.map((f) => f.frame)).toEqual([0]);
    expect(source.closes).toHaveLength(1);
    expect(source.closes[0]!.mock.calls.length).toBe(1);
    expect(writer.finalize).not.toHaveBeenCalled();
  });

  it("discards bytes and reports cancellation when aborted during finalize", async () => {
    const controller = new AbortController();
    const writer = fakeWriter({
      finalize: async () => {
        controller.abort();
        return new Uint8Array([1, 2, 3]);
      },
    });

    await expect(
      runVideoExport({
        plan: makePlan(2),
        frameSource: fakeSource(),
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
  });

  it("reports cancellation when a render rejects because it observed the abort", async () => {
    const controller = new AbortController();
    const source: FrameSource<FakeFrame> = {
      renderFrame: async () => {
        controller.abort();
        throw new Error("decoder interrupted");
      },
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({
        plan: makePlan(3),
        frameSource: source,
        videoWriter: fakeWriter(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
  });
});

describe("runVideoExport — failures", () => {
  it("releases the frame and disposes when the writer throws", async () => {
    const source = fakeSource();
    const writer: VideoWriter<FakeFrame> = {
      addFrame: async () => {
        throw new Error("encoder blew up");
      },
      finalize: async () => new Uint8Array(),
      dispose: vi.fn(),
    };

    await expect(
      runVideoExport({ plan: makePlan(3), frameSource: source, videoWriter: writer }),
    ).rejects.toThrow("encoder blew up");

    expect(source.closes).toHaveLength(1);
    expect(source.closes[0]!.mock.calls.length).toBe(1);
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("propagates a finalize error without returning bytes", async () => {
    const writer = fakeWriter({
      finalize: async () => {
        throw new Error("muxer failed");
      },
    });
    await expect(
      runVideoExport({ plan: makePlan(2), frameSource: fakeSource(), videoWriter: writer }),
    ).rejects.toThrow("muxer failed");
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("lets an encoder error that preceded the cancel win over cancellation", async () => {
    const controller = new AbortController();
    const encoderError = new Error("encoder died first");
    const writer = fakeWriter({
      onAddFrame: () => {
        // WebCodecs records the error asynchronously, then the user cancels.
        writer.setPendingError(encoderError);
        controller.abort();
      },
    });

    await expect(
      runVideoExport({
        plan: makePlan(5),
        frameSource: fakeSource(),
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBe(encoderError);
  });

  it("does not let a later encoder error mask a cancellation", async () => {
    const controller = new AbortController();
    const writer = fakeWriter({
      onAddFrame: () => {
        // The user cancels first; the encoder only reports its error afterwards.
        controller.abort();
        writer.setPendingError(new Error("late encoder failure"));
      },
    });

    await expect(
      runVideoExport({
        plan: makePlan(5),
        frameSource: fakeSource(),
        videoWriter: writer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
  });

  it("does not let a cleanup failure mask the original error", async () => {
    const source: FrameSource<FakeFrame> = {
      renderFrame: async (frame) => ({ frame, close: vi.fn() }),
      dispose: () => {
        throw new Error("dispose failed");
      },
    };
    const writer = fakeWriter({
      onAddFrame: () => {
        throw new Error("real failure");
      },
    });

    await expect(
      runVideoExport({ plan: makePlan(2), frameSource: source, videoWriter: writer }),
    ).rejects.toThrow("real failure");
  });
});
