/**
 * A tiny, framework-free controller for "start / cancel / start again" export
 * sessions.
 *
 * The React hook is only a view over this: all the state machine that keeps two
 * exports from stepping on each other lives here, where it can be tested
 * without a browser or a renderer.
 *
 * What it guarantees:
 *
 * - A new run supersedes the old one *synchronously*: the previous signal is
 *   aborted before the new runner is invoked, so a second export never inherits
 *   the first's container, encoder, or frame cache (each run builds its own from
 *   the runner closure).
 * - Progress and the settled callback are delivered **only for the current
 *   run**. A late event from a cancelled or superseded run is dropped, so the
 *   second export's progress can never jump because the first one reported in
 *   arrears.
 * - A cancelled run settles as `cancelled`; a run that failed with an encoder
 *   error settles as `failed` with that error; only the current run's success is
 *   reported as `success`, so a superseded run silently finishing cannot trigger
 *   a stale download.
 */

import { asError } from "./cancellation";
import { ExportCancelledError } from "./errors";
import type { ExportProgress } from "./progress";

/** The handle an export runner receives for one run. */
export interface ExportRunContext {
  /** Aborted when the user cancels or a newer run supersedes this one. */
  readonly signal: AbortSignal;
  /** Reports progress for this run; ignored once the run is stale. */
  onProgress(progress: ExportProgress): void;
}

/** How one run ended. */
export type ExportOutcome<TResult> =
  | { status: "success"; result: TResult }
  | { status: "cancelled" }
  | { status: "failed"; error: Error };

export interface ExportSessionCallbacks<TResult> {
  /** A new run is starting; clear the previous run's UI state here. */
  onStart?: () => void;
  /** Progress from the current run only. */
  onProgress?: (progress: ExportProgress) => void;
  /** The current run's final outcome. Stale runs do not fire this. */
  onSettled?: (outcome: ExportOutcome<TResult>) => void;
}

export type ExportRunner<TArg, TResult> = (
  arg: TArg,
  context: ExportRunContext,
) => Promise<TResult>;

export class ExportSession<TArg = void, TResult = unknown> {
  private current: { id: number; controller: AbortController } | null = null;
  private nextRunId = 1;
  private disposed = false;

  constructor(
    private readonly runner: ExportRunner<TArg, TResult>,
    private readonly callbacks: ExportSessionCallbacks<TResult> = {},
  ) {}

  /** True while the current run is in flight. */
  get isRunning(): boolean {
    return this.current !== null;
  }

  /**
   * Starts a run, superseding any run already in flight. Returns that run's
   * outcome; the same outcome is also delivered through `onSettled` when the
   * run is still current.
   */
  start(arg: TArg): Promise<ExportOutcome<TResult>> {
    if (this.disposed) throw new Error("Export session has been disposed.");

    // Supersede first, synchronously: the old run is aborted and stops counting
    // before the new one is minted, so there is no window where both are current.
    this.current?.controller.abort();

    const id = this.nextRunId++;
    const controller = new AbortController();
    this.current = { id, controller };
    this.callbacks.onStart?.();

    const isCurrent = () => this.current?.id === id;
    const context: ExportRunContext = {
      signal: controller.signal,
      onProgress: (progress) => {
        // Progress counts only while this run is current *and* still live: once
        // cancelled or superseded, its late events are dropped rather than
        // landing in a newer export's bar.
        if (isCurrent() && !controller.signal.aborted) this.callbacks.onProgress?.(progress);
      },
    };

    return this.execute(arg, context, isCurrent);
  }

  /** Aborts the current run, if any. */
  cancel(): void {
    this.current?.controller.abort();
  }

  /** Aborts the current run and refuses further starts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current?.controller.abort();
    this.current = null;
  }

  private async execute(
    arg: TArg,
    context: ExportRunContext,
    isCurrent: () => boolean,
  ): Promise<ExportOutcome<TResult>> {
    let outcome: ExportOutcome<TResult>;
    try {
      const result = await this.runner(arg, context);
      // A run that finished after being superseded must not masquerade as this
      // session's success.
      outcome = isCurrent() ? { status: "success", result } : { status: "cancelled" };
    } catch (error) {
      outcome =
        !isCurrent() || error instanceof ExportCancelledError
          ? { status: "cancelled" }
          : { status: "failed", error: asError(error) };
    }

    if (isCurrent()) {
      this.current = null;
      this.callbacks.onSettled?.(outcome);
    }
    return outcome;
  }
}
