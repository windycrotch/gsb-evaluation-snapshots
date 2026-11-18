/*!
 * Pure, side-effect-free helpers shared by the card and its visual editor.
 *
 * They are kept free of Lit/DOM imports so the normal and broken-config paths
 * can be exercised in plain Node tests. CSS.supports is a browser global and
 * is expected to be stubbed where it is missing.
 */

/**
 * Card-side color check. canvas-gauges throws on a gradient color it cannot
 * parse (e.g. "#1a" part-typed in the editor) and a canvas cannot draw
 * var(--token), so such colors fall back to the library default.
 *
 * - non-string values (per-tick color arrays, numbers) are not colors here
 * - an empty string means "no gradient" and must pass through untouched
 * - everything else must be a color the canvas can actually paint
 */
export function isDrawableColor(value: unknown): boolean {
  if (typeof value !== "string" || value === "") {
    return true;
  }
  return CSS.supports("color", value) && !value.includes("var(");
}

/**
 * Editor-side color check. Blank is not an error: every color is optional.
 * background_color and name_color allow var(--token); the gauge itself is
 * drawn on a canvas, so every other color (including highlight colors) is not.
 */
export function isInvalidColor(color: unknown, allowVar: boolean): boolean {
  return typeof color === "string" && color !== ""
    && (!CSS.supports("color", color) || (!allowVar && color.includes("var(")));
}

/**
 * canvas-gauges labels the scale 0-100 whatever minValue and maxValue are, so
 * configs without their own majorTicks get 6 labels spread over the real range.
 * Returns undefined when the range is unusable instead of producing NaNs.
 */
export function defaultMajorTicks(min: number, max: number): number[] | undefined {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return undefined;
  }
  return Array.from({ length: 6 }, (_, i) => Number((min + ((max - min) * i) / 5).toFixed(2)));
}

/**
 * Removes cleared fields so they do not linger in the YAML as empty values.
 * Empty arrays are kept: canvas-gauges treats e.g. highlights: [] as
 * "no highlights".
 */
export function withoutEmpty(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Names of color fields in a gauge section schema, including nested grid rows. */
export function fieldNames(schema: readonly any[]): string[] {
  return schema.reduce<string[]>(
    (names, item) => names.concat(item.schema ? fieldNames(item.schema) : [item.name]),
    [],
  );
}

export const ALLOW_VAR_COLOR_FIELDS = new Set(["background_color", "name_color"]);

/**
 * Drops color values the editor must not write into the config: gauge colors
 * that reference a CSS variable or fail CSS.supports, and the same for each
 * highlight entry's color. Empty strings stay (they are removed later by
 * withoutEmpty for scalar fields, while an empty highlights array is kept).
 */
export function sanitizeGaugeColors(gauge: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(gauge)) {
    if (key.startsWith("color") && isInvalidColor(value, false)) {
      continue;
    }
    if (key === "highlights" && Array.isArray(value)) {
      out[key] = value.map((highlight: any) =>
        highlight && isInvalidColor(highlight.color, false)
          ? withoutEmpty({ ...highlight, color: "" })
          : highlight
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Card-level colors get the same treatment. background_color and name_color
 * may use var(--token), so only values CSS itself cannot parse are rejected.
 */
export function sanitizeCardColors(
  config: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ALLOW_VAR_COLOR_FIELDS.has(key) && isInvalidColor(value, true)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Builds the gauge options object handed to a canvas-gauges constructor. */
export function buildGaugeOptions(
  gaugeConfig: Record<string, any>,
  canvas: HTMLCanvasElement,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key in gaugeConfig) {
    if (Object.prototype.hasOwnProperty.call(gaugeConfig, key)) {
      const value = gaugeConfig[key];
      if (key.startsWith("color") && !isDrawableColor(value)) {
        continue;
      }
      options[key] = value;
    }
  }
  if (options.majorTicks === undefined) {
    // 0 and 100 are the canvas-gauges defaults
    const ticks = defaultMajorTicks(Number(options.minValue ?? 0), Number(options.maxValue ?? 100));
    if (ticks) {
      options.majorTicks = ticks;
    }
  }
  options.renderTo = canvas;
  options.value = 0;
  return options;
}
