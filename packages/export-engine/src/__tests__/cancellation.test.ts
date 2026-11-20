import { describe, expect, it, vi } from "vitest";
import { ExportCancellation, asError } from "../cancellation";
import { ExportCancelledError } from "../errors";

describe("ExportCancellation", () => {
  it("is a no-op while the signal is live", () => {
    const controller = new AbortController();
    const cancellation = new ExportCancellation(controller.signal);
    expect(() => cancellation.throwIfAborted()).not.toThrow();
    expect(cancellation.aborted).toBe(false);
  });

  it("throws a cancellation once aborted", () => {
    const cancellation = new ExportCancellation(AbortSignal.abort());
    expect(() => cancellation.throwIfAborted()).toThrow(ExportCancelledError);
  });

  it("surfaces a pending error that existed when an already-aborted signal is seen", () => {
    const error = new Error("encoder already dead");
    const cancellation = new ExportCancellation(AbortSignal.abort(), () => error);
    expect(() => cancellation.throwIfAborted()).toThrow(error);
  });

  it("surfaces a pending error that was present the instant the abort fired", () => {
    const controller = new AbortController();
    const error = new Error("encoder failed before cancel");
    let pending: Error | null = null;
    const cancellation = new ExportCancellation(controller.signal, () => pending);

    // Error lands, then the user cancels — the abort listener samples it.
    pending = error;
    controller.abort();

    expect(() => cancellation.throwIfAborted()).toThrow(error);
  });

  it("does not let an error arriving after the abort relabel the cancel", () => {
    const controller = new AbortController();
    let pending: Error | null = null;
    const cancellation = new ExportCancellation(controller.signal, () => pending);

    controller.abort();
    // A late encoder failure — too late, the cancel was observed first.
    pending = new Error("late failure");

    expect(() => cancellation.throwIfAborted()).toThrow(ExportCancelledError);
  });

  it("rethrow passes a non-abort error straight through", () => {
    const cancellation = new ExportCancellation(new AbortController().signal);
    const error = new Error("plain failure");
    expect(() => cancellation.rethrow(error)).toThrow(error);
  });

  it("rethrow maps an error caught after an abort to the cancellation", () => {
    const error = new Error("render interrupted");
    const cancellation = new ExportCancellation(AbortSignal.abort());
    let caught: unknown;
    try {
      cancellation.rethrow(error);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ExportCancelledError);
  });

  it("detaches its listener on dispose", () => {
    const controller = new AbortController();
    const probe = vi.fn(() => null);
    const cancellation = new ExportCancellation(controller.signal, probe);
    cancellation.dispose();
    controller.abort();
    // Sampling never ran because the listener was removed before the abort.
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("asError", () => {
  it("passes Errors through and wraps everything else", () => {
    const error = new Error("x");
    expect(asError(error)).toBe(error);
    expect(asError("oops").message).toBe("oops");
  });
});
