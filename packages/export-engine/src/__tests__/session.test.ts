import { describe, expect, it, vi } from "vitest";
import { ExportCancelledError } from "../errors";
import type { ExportProgress } from "../progress";
import { ExportSession, type ExportRunContext } from "../session";

/** A deferred promise a test can resolve or reject from the outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ExportSession — single run", () => {
  it("reports progress and settles success for the current run", async () => {
    const progress: ExportProgress[] = [];
    const settled: string[] = [];
    const session = new ExportSession<void, string>(
      async (_arg, { onProgress }) => {
        onProgress({ phase: "rendering", completedFrames: 1, totalFrames: 2, ratio: 0.5 });
        return "file-blob";
      },
      {
        onProgress: (p) => progress.push(p),
        onSettled: (outcome) => settled.push(outcome.status),
      },
    );

    const outcome = await session.start();

    expect(outcome).toEqual({ status: "success", result: "file-blob" });
    expect(progress).toHaveLength(1);
    expect(settled).toEqual(["success"]);
    expect(session.isRunning).toBe(false);
  });

  it("settles cancelled with no error when the runner throws a cancellation", async () => {
    const onSettled = vi.fn();
    const session = new ExportSession<void, string>(
      async () => {
        throw new ExportCancelledError();
      },
      { onSettled },
    );

    const outcome = await session.start();

    expect(outcome).toEqual({ status: "cancelled" });
    expect(onSettled).toHaveBeenCalledWith({ status: "cancelled" });
  });

  it("settles failed with the encoder error when the runner throws anything else", async () => {
    const onSettled = vi.fn();
    const session = new ExportSession<void, string>(
      async () => {
        throw new Error("encoder died");
      },
      { onSettled },
    );

    const outcome = await session.start();

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error.message).toBe("encoder died");
  });
});

describe("ExportSession — consecutive runs", () => {
  it("starting again aborts the previous run and keeps its result from landing", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const settled: string[] = [];
    const progress: number[] = [];

    let call = 0;
    const session = new ExportSession<void, string>(
      (_arg, context) => {
        call += 1;
        const which = call;
        // Each run reports progress under its own tag.
        context.onProgress({
          phase: "rendering",
          completedFrames: which,
          totalFrames: 10,
          ratio: which / 10,
        });
        return which === 1 ? first.promise : second.promise;
      },
      {
        onProgress: (p) => progress.push(p.completedFrames),
        onSettled: (outcome) => settled.push(outcome.status),
      },
    );

    const runner1 = session.start();
    const runner2 = session.start();

    second.resolve("second-file");
    const secondOutcome = await runner2;
    first.resolve("first-file");
    const firstOutcome = await runner1;

    expect(secondOutcome).toEqual({ status: "success", result: "second-file" });
    // The superseded run resolves as cancelled, never as a stale success.
    expect(firstOutcome).toEqual({ status: "cancelled" });
    // Only the current run's settlement reached the UI.
    expect(settled).toEqual(["success"]);
    expect(progress).toEqual([1, 2]);
  });

  it("drops late progress from a cancelled run", async () => {
    const first = deferred<string>();
    const progress: number[] = [];

    const contexts: ExportRunContext[] = [];
    const session = new ExportSession<void, string>(
      (_arg, context) => {
        contexts.push(context);
        return contexts.length === 1 ? first.promise : Promise.resolve("second");
      },
      { onProgress: (p) => progress.push(p.ratio) },
    );

    const run1 = session.start();
    session.cancel();
    // The cancelled run emits a late progress event after cancellation.
    contexts[0]!.onProgress({
      phase: "rendering",
      completedFrames: 9,
      totalFrames: 10,
      ratio: 0.9,
    });
    first.resolve("stale");

    const run2 = session.start();
    contexts[1]!.onProgress({
      phase: "rendering",
      completedFrames: 5,
      totalFrames: 10,
      ratio: 0.5,
    });

    await Promise.all([run1, run2]);
    // Only the second run's progress is visible.
    expect(progress).toEqual([0.5]);
  });

  it("a second run after a failure starts with a fresh abort signal", async () => {
    const signals: AbortSignal[] = [];
    const session = new ExportSession<void, string>(async (_arg, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) throw new Error("boom");
      return "ok";
    });

    const first = await session.start();
    const second = await session.start();

    expect(first.status).toBe("failed");
    expect(second).toEqual({ status: "success", result: "ok" });
    // A completed run's signal is not kept alive; the next run gets its own,
    // so no state from the failed run leaks into the retry.
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe("ExportSession — dispose", () => {
  it("aborts the current run and refuses further starts", async () => {
    let signal: AbortSignal | undefined;
    const session = new ExportSession<void, string>(async (_arg, context) => {
      signal = context.signal;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return "ok";
    });

    const pending = session.start();
    session.dispose();

    expect(signal?.aborted).toBe(true);
    await pending;
    expect(() => session.start()).toThrow(/disposed/);
  });
});
