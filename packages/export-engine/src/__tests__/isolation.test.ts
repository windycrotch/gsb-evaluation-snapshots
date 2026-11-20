import { describe, expect, it, vi } from "vitest";
import type { ExportProgress } from "../progress";
import { runExportPipeline } from "../pipeline";
import type { VideoWriter } from "../providers";
import { ExportSession, type ExportRunContext } from "../session";
import { fakeSource, fakeWriter, makePlan, type FakeFrame } from "./fakes";

/**
 * Two exports started back-to-back on the same page — the second immediately
 * after the first was cancelled or failed.
 *
 * These compose the real {@link ExportSession} with the real
 * {@link runExportPipeline}, driving both with fake sources, writers and
 * containers. The point is to prove the guarantees that only appear when the
 * pieces are wired together:
 *
 * - the second run builds fresh resources (no shared container/encoder/cache);
 * - the first run's frames, writer and container are all disposed, and the
 *   first writer never finalizes;
 * - progress from the first run, even arriving after the second started, never
 *   shows up in the second run's bar.
 */

interface Job {
  source: ReturnType<typeof fakeSource>;
  writer: ReturnType<typeof fakeWriter>;
  resource: { dispose: ReturnType<typeof vi.fn> };
  context: ExportRunContext;
}

/** How the first run should end; the second always succeeds. */
type FirstRunBehaviour = "cancel-midway" | "encoder-error" | "success";

function makeSession(onProgress: (p: ExportProgress) => void, first: FirstRunBehaviour) {
  const jobs: Job[] = [];
  let session!: ExportSession<void, Uint8Array>;

  const runner = async (_arg: void, context: ExportRunContext): Promise<Uint8Array> => {
    const index = jobs.length;
    const source = fakeSource();
    const resource = { dispose: vi.fn() };

    const writer =
      index === 0 && first === "encoder-error"
        ? errorWriter(new Error("encoder exploded"))
        : fakeWriter({
            onAddFrame: (_frame: FakeFrame, added: number) => {
              // The first job cancels itself after its second frame is encoded,
              // mimicking a user hitting Cancel mid-render.
              if (index === 0 && first === "cancel-midway" && added === 1) session.cancel();
            },
          });

    const job: Job = { source, writer: writer as Job["writer"], resource, context };
    jobs.push(job);

    return runExportPipeline({
      plan: makePlan(6),
      signal: context.signal,
      onProgress: context.onProgress,
      resource,
      prepareAudio: async () => {},
      createFrameSource: async () => source,
      createVideoWriter: () => writer,
    });
  };

  session = new ExportSession<void, Uint8Array>(runner, { onProgress });
  return { session, jobs };
}

/** A writer whose first frame fails, standing in for a dead encoder. */
function errorWriter(error: Error): VideoWriter<FakeFrame> {
  return {
    addFrame: () => {
      throw error;
    },
    finalize: async () => new Uint8Array(),
    dispose: vi.fn(),
  };
}

describe("consecutive exports", () => {
  it("a retry after a cancel never reuses the first run's resources", async () => {
    const progress: number[] = [];
    const { session, jobs } = makeSession((p) => progress.push(p.completedFrames), "cancel-midway");

    expect(await session.start()).toEqual({ status: "cancelled" });
    expect(await session.start()).toEqual({ status: "success", result: new Uint8Array([1, 2, 3]) });

    expect(jobs).toHaveLength(2);
    const [a, b] = jobs as [Job, Job];

    // Every piece is a distinct instance — nothing is shared across runs.
    expect(a.source).not.toBe(b.source);
    expect(a.writer).not.toBe(b.writer);
    expect(a.resource).not.toBe(b.resource);
    expect(a.context.signal).not.toBe(b.context.signal);

    // The cancelled run produced no file and released everything exactly once.
    expect(a.writer.finalize).not.toHaveBeenCalled();
    expect(a.writer.dispose).toHaveBeenCalledOnce();
    expect(a.source.dispose).toHaveBeenCalledOnce();
    expect(a.resource.dispose).toHaveBeenCalledOnce();

    // The retry ran to completion with its own resources.
    expect(b.writer.finalize).toHaveBeenCalledOnce();
    expect(b.writer.dispose).toHaveBeenCalledOnce();
    expect(b.resource.dispose).toHaveBeenCalledOnce();
  });

  it("drops a first-run progress event that arrives after the retry began", async () => {
    const progress: number[] = [];
    const { session, jobs } = makeSession((p) => progress.push(p.completedFrames), "cancel-midway");

    await session.start();
    const firstJob = jobs[0] as Job;
    const afterFirst = progress.length;

    const retry = session.start();
    // The cancelled run reports a late, inflated event after the retry started.
    firstJob.context.onProgress({
      phase: "rendering",
      completedFrames: 5,
      totalFrames: 6,
      ratio: 5 / 6,
    });
    await retry;

    // Only the retry's progress is visible after the first run ended: preparing
    // at 0, then ascending 1..6, with the finalize/done reports also at 6. The
    // stale 5 from the cancelled run does not appear interleaved.
    expect(progress.slice(afterFirst)).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6]);
  });

  it("a retry after an encoder failure starts clean", async () => {
    const progress: number[] = [];
    const { session, jobs } = makeSession((p) => progress.push(p.completedFrames), "encoder-error");

    const first = await session.start();
    expect(first.status).toBe("failed");

    const second = await session.start();
    expect(second.status).toBe("success");
    expect(jobs).toHaveLength(2);

    expect(jobs[0]!.resource).not.toBe(jobs[1]!.resource);
    expect(jobs[0]!.resource.dispose).toHaveBeenCalledOnce();
    expect(jobs[1]!.writer.finalize).toHaveBeenCalledOnce();
  });
});
