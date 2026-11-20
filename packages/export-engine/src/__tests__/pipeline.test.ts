import { describe, expect, it, vi } from "vitest";
import { ExportCancelledError } from "../errors";
import { runExportPipeline } from "../pipeline";
import { fakeSource, fakeWriter, makePlan } from "./fakes";

/**
 * The pipeline tests exercise the stage boundaries that `runVideoExport` does
 * not own: audio preparation, frame-source creation, and writer construction —
 * and prove that a cancel or throw at any of them still disposes the shared
 * container exactly once, in the fixed order, with nothing left half-built.
 */

function makeResource(label: string, order: string[]) {
  return { dispose: vi.fn(() => void order.push(label)) };
}

describe("runExportPipeline — success", () => {
  it("runs audio first, then frames, and disposes source, writer, resource in order", async () => {
    const order: string[] = [];
    const source = fakeSource();
    source.dispose = vi.fn(() => void order.push("source"));
    const writer = fakeWriter();
    writer.dispose = vi.fn(() => void order.push("writer"));
    let audioFinished = false;

    const bytes = await runExportPipeline({
      plan: makePlan(3),
      resource: makeResource("resource", order),
      prepareAudio: async () => {
        audioFinished = true;
        order.push("audio");
      },
      createFrameSource: async () => {
        order.push("source-create");
        expect(audioFinished).toBe(true);
        return source;
      },
      createVideoWriter: () => {
        order.push("writer-create");
        return writer;
      },
    });

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(order.slice(0, 3)).toEqual(["audio", "source-create", "writer-create"]);
    // Fixed teardown order: frame source, then writer, then the shared container.
    expect(order.slice(-3)).toEqual(["source", "writer", "resource"]);
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("disposing the resource a second time is harmless", async () => {
    const resource = { dispose: vi.fn() };
    await runExportPipeline({
      plan: makePlan(3),
      resource,
      createFrameSource: async () => fakeSource(),
      createVideoWriter: () => fakeWriter(),
    });
    await resource.dispose(); // caller's own cleanup, after the pipeline ran
    expect(resource.dispose).toHaveBeenCalledTimes(2);
  });
});

describe("runExportPipeline — cancellation", () => {
  it("cancelling during audio preparation skips frames and disposes the container", async () => {
    const controller = new AbortController();
    const resource = { dispose: vi.fn() };
    const createFrameSource = vi.fn();

    await expect(
      runExportPipeline({
        plan: makePlan(5),
        signal: controller.signal,
        resource,
        prepareAudio: async () => {
          controller.abort();
        },
        createFrameSource,
        createVideoWriter: () => fakeWriter(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(createFrameSource).not.toHaveBeenCalled();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("cancelling before audio even starts runs nothing", async () => {
    const prepareAudio = vi.fn();
    const createFrameSource = vi.fn();
    const resource = { dispose: vi.fn() };

    await expect(
      runExportPipeline({
        plan: makePlan(5),
        signal: AbortSignal.abort(),
        resource,
        prepareAudio,
        createFrameSource,
        createVideoWriter: () => fakeWriter(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(prepareAudio).not.toHaveBeenCalled();
    expect(createFrameSource).not.toHaveBeenCalled();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("a cancel that races a source-creation failure surfaces as cancellation", async () => {
    const controller = new AbortController();
    const resource = { dispose: vi.fn() };

    await expect(
      runExportPipeline({
        plan: makePlan(5),
        signal: controller.signal,
        resource,
        createFrameSource: async () => {
          controller.abort();
          throw new Error("renderer init failed");
        },
        createVideoWriter: () => fakeWriter(),
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("cancelling during frame encoding stops the loop and disposes everything once", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const source = fakeSource();
    const writer = fakeWriter({
      onAddFrame: (_frame, index) => {
        if (index === 1) controller.abort();
      },
    });
    const resource = makeResource("resource", order);

    await expect(
      runExportPipeline({
        plan: makePlan(10),
        signal: controller.signal,
        resource,
        createFrameSource: async () => source,
        createVideoWriter: () => writer,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);

    expect(writer.finalize).not.toHaveBeenCalled();
    // Source and writer disposed by the run loop, container by the pipeline.
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(writer.dispose).toHaveBeenCalledOnce();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });
});

describe("runExportPipeline — failures", () => {
  it("a source-creation error disposes the container and propagates the error", async () => {
    const resource = { dispose: vi.fn() };
    const createVideoWriter = vi.fn(() => fakeWriter());

    await expect(
      runExportPipeline({
        plan: makePlan(3),
        resource,
        createFrameSource: async () => {
          throw new Error("cannot build renderer");
        },
        createVideoWriter,
      }),
    ).rejects.toThrow("cannot build renderer");

    expect(createVideoWriter).not.toHaveBeenCalled();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("a mid-run encoder error is not relabelled as cancellation", async () => {
    const writer = fakeWriter({
      onAddFrame: () => {
        throw new Error("encode queue overflow");
      },
    });

    await expect(
      runExportPipeline({
        plan: makePlan(3),
        createFrameSource: async () => fakeSource(),
        createVideoWriter: () => writer,
      }),
    ).rejects.toThrow("encode queue overflow");
  });
});
