/**
 * Cancellation bookkeeping for one export run.
 *
 * An `AbortSignal` alone is not enough: WebCodecs encoders report fatal errors
 * *asynchronously* through a callback, so a cancel and an encoder error can race
 * within the same turn. The rule the export contract promises is decided by
 * order of observation:
 *
 * - if the encoder had already recorded an error when the abort fired, that
 *   error is the outcome (a cancel must not relabel a real failure as success or
 *   as a plain cancel);
 * - if the abort is observed first, a later encoder error surfaces as the
 *   cancellation — the user stopped the work before it failed.
 *
 * This class samples the writer's pending error at the exact moment the abort
 * fires, then answers every checkpoint consistently from that snapshot.
 */

import { ExportCancelledError } from "./errors";

export class ExportCancellation {
  private readonly signal: AbortSignal | undefined;
  private readonly probe: (() => Error | null) | undefined;
  private sampled = false;
  private errorAtAbort: Error | null = null;
  private readonly onAbort = () => this.sample();

  /**
   * @param signal The run's abort signal.
   * @param probe Returns the encoder's pending fatal error, if any. Sampled
   *   synchronously when the signal aborts (and immediately if it already has).
   */
  constructor(signal?: AbortSignal, probe?: () => Error | null) {
    this.signal = signal;
    this.probe = probe;
    if (signal?.aborted) this.sample();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  get aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  /** Throws the run's cancellation outcome if the signal has aborted. */
  throwIfAborted(): void {
    if (!this.aborted) return;
    this.sample();
    throw this.errorAtAbort ?? new ExportCancelledError();
  }

  /**
   * Maps an error caught at an `await` to the run's outcome: the error itself
   * when not aborted, the pre-abort encoder error when one was pending, and the
   * cancellation otherwise.
   */
  rethrow(error: unknown): never {
    if (this.aborted) {
      this.sample();
      if (this.errorAtAbort) throw this.errorAtAbort;
      throw new ExportCancelledError();
    }
    throw error;
  }

  /** Detaches the abort listener. Idempotent. */
  dispose(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  private sample(): void {
    if (this.sampled) return;
    this.sampled = true;
    this.errorAtAbort = this.probe?.() ?? null;
  }
}

/** Normalises an unknown thrown value into an `Error`. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
