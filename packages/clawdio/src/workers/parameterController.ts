import {
  type ParameterName,
  validateParameter,
} from "../shared/parameters.ts";

/**
 * Message posted back to the main thread when a parameter update is rejected.
 * The `type` is stable so callers can switch on it.
 */
export type ParameterErrorMessage = {
  type: "parameter-error";
  data: {
    parameter: ParameterName;
    /** The offending value, so the UI can show it. */
    value: unknown;
    /** Human readable reason. */
    message: string;
  };
};

export type ParameterPost = (message: ParameterErrorMessage) => void;

export type ParameterApply<T> = (
  module: T,
  parameter: ParameterName,
  value: number
) => boolean;

export type ParameterControllerOptions<T> = {
  /** Every parameter this controller owns, in a stable order. */
  parameters: readonly ParameterName[];
  /** Sends an error back to the main thread. */
  post: ParameterPost;
  /** Applies a validated value to the live module, returning false on refusal. */
  apply: ParameterApply<T>;
};

export type ParameterSnapshot = Partial<Record<ParameterName, number>>;

/**
 * Owns the "last legal value wins" semantics for one AudioWorkletProcessor.
 *
 * The controller is deliberately independent of the WASM module's lifetime so
 * it can be unit tested without Web Audio:
 *
 * - Before `attach()` the WASM module does not exist yet. Updates are validated
 *   and queued instead of being dropped or thrown on.
 * - `attach()` replays the queue in order, so a slider moved before the module
 *   finished compiling still takes effect.
 * - Every update that fails validation is reported through `post()` and leaves
 *   the last applied value untouched, so audio keeps running with known-good
 *   parameters.
 */
export class ParameterController<T> {
  private readonly parameters: readonly ParameterName[];
  private readonly post: ParameterPost;
  private readonly apply: ParameterApply<T>;

  private module: T | null = null;
  private readonly values = new Map<ParameterName, number>();
  private readonly queued: Array<{ parameter: ParameterName; value: number }> = [];

  constructor(options: ParameterControllerOptions<T>) {
    this.parameters = options.parameters;
    this.post = options.post;
    this.apply = options.apply;
  }

  /** True once a live module has been attached. */
  get isReady(): boolean {
    return this.module !== null;
  }

  /** Number of updates waiting for a module (used by tests/diagnostics). */
  get pendingCount(): number {
    return this.queued.length;
  }

  /** Current last-known-legal values. */
  get snapshot(): ParameterSnapshot {
    const snapshot: ParameterSnapshot = {};
    for (const parameter of this.parameters) {
      const value = this.values.get(parameter);
      if (value !== undefined) snapshot[parameter] = value;
    }
    return snapshot;
  }

  /**
   * Attach the freshly constructed WASM module and flush anything requested
   * while it was still compiling. `initial` holds the values the module was
   * constructed with.
   *
   * The initial values go through the normal apply path as well: some
   * parameters (e.g. the bitcrusher's normfreq) are not stored inside Rust and
   * only take effect once applied, so assuming the constructor covered them
   * would silently drop the configured value.
   */
  attach(module: T, initial: ParameterSnapshot): void {
    this.module = module;

    for (const parameter of this.parameters) {
      const value = initial[parameter];
      if (value !== undefined) this.set(parameter, value);
    }

    const queued = this.queued.splice(0, this.queued.length);
    for (const { parameter, value } of queued) {
      // Re-run through the normal path so a value that became invalid (e.g. a
      // different module type) is still rejected rather than forced through.
      this.set(parameter, value);
    }
  }

  /**
   * Request a new value. Returns true when the value is legal (even if it is
   * still queued for a module that does not exist yet).
   */
  set(parameter: ParameterName, value: unknown): boolean {
    const validation = validateParameter(parameter, value);
    if (!validation.ok) {
      this.report(parameter, value, validation.message);
      return false;
    }

    return this.applyOrQueue(parameter, validation.value);
  }

  private applyOrQueue(parameter: ParameterName, value: number): boolean {
    if (this.module === null) {
      // Coalesce per parameter: a fast slider drag can enqueue hundreds of
      // updates before WASM finishes compiling, and only the last one matters.
      const existing = this.queued.findIndex(
        (entry) => entry.parameter === parameter
      );
      if (existing === -1) {
        this.queued.push({ parameter, value });
      } else {
        this.queued[existing].value = value;
      }
      return true;
    }

    try {
      if (!this.apply(this.module, parameter, value)) {
        this.report(
          parameter,
          value,
          `The WASM module rejected the ${parameter} update; keeping the previous value`
        );
        return false;
      }
    } catch (error) {
      this.report(
        parameter,
        value,
        `Failed to apply ${parameter}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }

    this.values.set(parameter, value);
    return true;
  }

  private report(
    parameter: ParameterName,
    value: unknown,
    message: string
  ): void {
    this.post({ type: "parameter-error", data: { parameter, value, message } });
  }
}
