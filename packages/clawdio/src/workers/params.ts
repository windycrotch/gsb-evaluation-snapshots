/**
 * Shared helpers for the AudioWorklet processors.
 *
 * These keep every worklet consistent on three guarantees:
 *  - illegal parameters (NaN / +/-Infinity) never reach the WASM module;
 *  - out-of-range values are clamped to the documented bounds;
 *  - any processing error degrades to silence instead of crashing the
 *    audio thread or emitting non-finite samples.
 */

/** Bounds for a continuous (floating point) parameter. */
export type ParamRange = {
  min: number;
  max: number;
};

/**
 * Reject NaN / +/-Infinity and clamp a finite value into `[min, max]`.
 * Returns `null` for a non-finite value so callers can skip the update.
 */
export const sanitizeNumber = (
  value: unknown,
  { min, max }: ParamRange,
): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, value));
};

/**
 * Like {@link sanitizeNumber} but rounds to the nearest integer before
 * clamping. Used for parameters the Rust side stores as `usize` (e.g.
 * the Bitcrusher bit depth).
 */
export const sanitizeInt = (
  value: unknown,
  { min, max }: ParamRange,
): number | null => {
  const sanitized = sanitizeNumber(value, { min, max });
  if (sanitized === null) return null;
  return Math.round(sanitized);
};

/**
 * Overwrite every output channel with zeros.
 *
 * An `AudioWorkletProcessor` that returns `true` keeps running, and an
 * untouched output buffer is spec-defined as silence anyway — but writing
 * zeros explicitly guarantees no stale/non-finite data survives a failed
 * WASM call.
 */
export const silenceOutputs = (outputs: Float32Array[][]): void => {
  outputs.forEach((channels) => {
    channels.forEach((channel) => channel.fill(0));
  });
};

/** True when every sample of every output channel is finite. */
export const outputsAreFinite = (outputs: Float32Array[][]): boolean => {
  for (const channels of outputs) {
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i += 1) {
        if (!Number.isFinite(channel[i])) {
          return false;
        }
      }
    }
  }
  return true;
};

/**
 * Cache the latest parameter value received before the WASM module is
 * ready. Only the most recent value per parameter is retained, so once the
 * module initializes it converges on exactly the last value the user set.
 */
export class PendingParams<T extends string> {
  private values = new Map<T, number>();

  set(key: T, value: number): void {
    this.values.set(key, value);
  }

  get(key: T): number | undefined {
    return this.values.get(key);
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }
}
