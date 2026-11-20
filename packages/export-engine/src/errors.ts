/**
 * The error type that means "the user stopped this export".
 *
 * It lives in its own module so the run loop, the cancellation helpers, and the
 * job manager can all refer to it without importing each other.
 */

/** Raised when an export is aborted through its `AbortSignal`. */
export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelledError";
  }
}
