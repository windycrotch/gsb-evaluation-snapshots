// @vitest-environment jsdom
/**
 * Hook-level tests for the export controller: re-trigger guarding, cancel
 * semantics, and the state baseline. The export itself is mocked; what is
 * under test is the state machine around it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ExportCancelledError } from "@cutaway/export-engine";
import type { ExportProgress } from "@cutaway/export-engine";

const mocks = vi.hoisted(() => ({
  exportProjectToBlob: vi.fn(),
}));

vi.mock("@/state/editorStore", () => ({
  useEditorStore: { getState: () => ({ project: { name: "Demo" } }) },
}));

vi.mock("@/features/media/MediaImportProvider", () => ({
  useMediaImportContext: () => ({ store: () => ({}) }),
}));

vi.mock("../exportProject", () => ({ exportProjectToBlob: mocks.exportProjectToBlob }));

import { useExport } from "../useExport";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const finished = { blob: new Blob([new Uint8Array([1])]), filename: "Demo.mp4" };

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom lacks these; the download itself is not what is under test.
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

describe("useExport", () => {
  it("runs to completion and reports done", async () => {
    const run = deferred<typeof finished>();
    mocks.exportProjectToBlob.mockReturnValue(run.promise);
    const { result } = renderHook(() => useExport());

    act(() => result.current.start());
    expect(result.current.isExporting).toBe(true);

    await act(async () => {
      run.resolve(finished);
      await run.promise;
    });

    expect(result.current.isExporting).toBe(false);
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("ignores start while an export is already running", async () => {
    const run = deferred<typeof finished>();
    mocks.exportProjectToBlob.mockReturnValue(run.promise);
    const { result } = renderHook(() => useExport());

    act(() => result.current.start());
    act(() => result.current.start());
    act(() => result.current.start());

    expect(mocks.exportProjectToBlob).toHaveBeenCalledTimes(1);

    await act(async () => {
      run.resolve(finished);
      await run.promise;
    });
    expect(mocks.exportProjectToBlob).toHaveBeenCalledTimes(1);
  });

  it("cancel resets to a clean baseline and is not shown as an error", async () => {
    const run = deferred<typeof finished>();
    mocks.exportProjectToBlob.mockImplementation(
      (
        _project: unknown,
        _store: unknown,
        options: { onProgress: (p: ExportProgress) => void },
      ) => {
        options.onProgress({ phase: "rendering", completedFrames: 1, totalFrames: 2, ratio: 0.5 });
        return run.promise;
      },
    );
    const { result } = renderHook(() => useExport());

    act(() => result.current.start());
    expect(result.current.progress?.ratio).toBe(0.5);

    act(() => result.current.cancel());

    // Clean baseline, immediately.
    expect(result.current.isExporting).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.done).toBe(false);

    // The in-flight run now settles as cancelled — still no error surfaces.
    await act(async () => {
      run.reject(new ExportCancelledError());
      await run.promise.catch(() => {});
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isExporting).toBe(false);
  });

  it("can restart after cancel, and the stale run cannot clobber the new one", async () => {
    const first = deferred<typeof finished>();
    const second = deferred<typeof finished>();
    mocks.exportProjectToBlob
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useExport());

    act(() => result.current.start());
    act(() => result.current.cancel());
    act(() => result.current.start());

    expect(mocks.exportProjectToBlob).toHaveBeenCalledTimes(2);
    expect(result.current.isExporting).toBe(true);

    // The cancelled run resolves late: no download, no state change.
    await act(async () => {
      first.resolve(finished);
      await first.promise;
    });
    expect(result.current.done).toBe(false);
    expect(result.current.isExporting).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    // The live run completes normally.
    await act(async () => {
      second.resolve(finished);
      await second.promise;
    });
    expect(result.current.done).toBe(true);
    expect(result.current.isExporting).toBe(false);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("surfaces a failure as an error, then recovers for the next run", async () => {
    const first = deferred<typeof finished>();
    const second = deferred<typeof finished>();
    mocks.exportProjectToBlob
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useExport());

    act(() => result.current.start());
    await act(async () => {
      first.reject(new Error("encoder blew up"));
      await first.promise.catch(() => {});
    });

    expect(result.current.error).toBe("encoder blew up");
    expect(result.current.isExporting).toBe(false);
    expect(result.current.done).toBe(false);

    // A fresh start clears the error and runs again.
    act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(result.current.isExporting).toBe(true);

    await act(async () => {
      second.resolve(finished);
      await second.promise;
    });
    expect(result.current.done).toBe(true);
  });
});
