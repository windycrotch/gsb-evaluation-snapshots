/**
 * Shared parameter validation for the audio worklets.
 *
 * The Rust modules validate every value again before using it (defense in
 * depth), but doing the cheap checks here as well keeps the queue semantics
 * correct before the WASM module exists: an illegal request must never
 * overwrite the last legal one.
 */

export type ParameterName = "bits" | "normfreq" | "cutoff" | "resonance";

export type ParameterSpec = {
  /** Smallest accepted value (inclusive). */
  min: number;
  /** Largest accepted value (inclusive). */
  max: number;
  /** When true the value must also be a whole number. */
  integer?: boolean;
  /** Human readable description used in error messages. */
  description: string;
};

export const PARAMETER_SPECS: Record<ParameterName, ParameterSpec> = {
  bits: {
    min: 1,
    max: 32,
    integer: true,
    description: "an integer between 1 and 32",
  },
  normfreq: {
    min: 0,
    max: 1,
    description: "a number between 0 and 1",
  },
  cutoff: {
    min: 0,
    max: 1,
    description: "a number between 0 and 1",
  },
  resonance: {
    min: 0,
    max: 20,
    description: "a number between 0 and 20",
  },
};

/** Values used when the caller passes something illegal at construction time. */
export const DEFAULT_PARAMETERS: Record<ParameterName, number> = {
  bits: 4,
  normfreq: 0.1,
  cutoff: 0.065,
  resonance: 3.5,
};

/**
 * Port message type used to update a parameter, e.g. `bits` -> `set-bits`.
 * Keeping these in one place stops the worklet and the node wrapper from
 * drifting apart.
 */
export function parameterMessageType(parameter: ParameterName): string {
  return `set-${parameter}`;
}

export type ParameterValidation =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** Render a bad value in a way that distinguishes NaN from undefined etc. */
export function formatParameterValue(value: unknown): string {
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "number" && value === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (typeof value === "number" && value === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

export function validateParameter(
  parameter: ParameterName,
  value: unknown
): ParameterValidation {
  const spec = PARAMETER_SPECS[parameter];
  const invalid = (): ParameterValidation => ({
    ok: false,
    message: `Invalid ${parameter}: expected ${spec.description}, received ${formatParameterValue(
      value
    )}`,
  });

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid();
  }

  if (spec.integer && !Number.isInteger(value)) {
    return invalid();
  }

  if (value < spec.min || value > spec.max) {
    return invalid();
  }

  return { ok: true, value };
}

/**
 * Validate an initial value, falling back to the documented default instead of
 * throwing. Used while wiring a freshly created node together.
 */
export function resolveInitialParameter(
  parameter: ParameterName,
  value: unknown
): number {
  const result = validateParameter(parameter, value);
  return result.ok ? result.value : DEFAULT_PARAMETERS[parameter];
}
