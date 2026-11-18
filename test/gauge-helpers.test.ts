/*!
 * Tests for the pure color/tick/options helpers shared by the card and editor.
 * Runs fully offline with the Node built-in test runner.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildGaugeOptions,
  defaultMajorTicks,
  isDrawableColor,
  isInvalidColor,
  sanitizeCardColors,
  sanitizeGaugeColors,
  withoutEmpty,
} from "../src/gauge-helpers.ts";

// jsdom-free subset of the CSS color grammar the card relies on.
// Browsers accept var(--token) as valid CSS syntax; the canvas limitation is
// enforced separately by the explicit var() check in the helpers
beforeEach(() => {
  (globalThis as any).CSS = {
    supports: (_property: string, value: string) => {
      const v = value.trim().toLowerCase();
      if (v.includes("var(")) return true;
      if (v.startsWith("#")) return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v);
      if (v.startsWith("rgb")) return /^rgba?\(/.test(v);
      return ["red", "green", "blue", "black", "white", "transparent", "gray"].includes(v);
    },
  };
});

test("isDrawableColor accepts strings the canvas can paint", () => {
  assert.equal(isDrawableColor("#fff"), true);
  assert.equal(isDrawableColor("#1a2b3c"), true);
  assert.equal(isDrawableColor("rgba(0,0,0,0.5)"), true);
  assert.equal(isDrawableColor("red"), true);
});

test("isDrawableColor rejects var(--token) and half-typed hex colors", () => {
  assert.equal(isDrawableColor("var(--primary-color)"), false);
  assert.equal(isDrawableColor("#1a"), false);
  assert.equal(isDrawableColor("#gg"), false);
});

test("isDrawableColor passes through empty strings (no gradient) and arrays", () => {
  assert.equal(isDrawableColor(""), true);
  assert.equal(isDrawableColor(["#f00", "#0f0"]), true);
  assert.equal(isDrawableColor(undefined), true);
});

test("isInvalidColor treats blank colors as valid (everything is optional)", () => {
  assert.equal(isInvalidColor("", false), false);
  assert.equal(isInvalidColor(undefined, false), false);
});

test("isInvalidColor rejects var() for gauge colors but allows it where requested", () => {
  assert.equal(isInvalidColor("var(--token)", false), true);
  assert.equal(isInvalidColor("var(--token)", true), false);
  assert.equal(isInvalidColor("#1a", false), true);
  assert.equal(isInvalidColor("#1a", true), true);
  assert.equal(isInvalidColor("#ff0000", false), false);
});

test("defaultMajorTicks spreads six labels over a valid range", () => {
  assert.deepEqual(defaultMajorTicks(0, 100), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(defaultMajorTicks(-10, 10), [-10, -6, -2, 2, 6, 10]);
  assert.equal(defaultMajorTicks(0, 100)?.length, 6);
});

test("defaultMajorTicks returns undefined for non-finite or inverted ranges", () => {
  assert.equal(defaultMajorTicks(Number.NaN, 100), undefined);
  assert.equal(defaultMajorTicks(0, Number.POSITIVE_INFINITY), undefined);
  assert.equal(defaultMajorTicks(100, 100), undefined);
  assert.equal(defaultMajorTicks(100, 0), undefined);
});

test("withoutEmpty drops empty scalar values but keeps empty arrays", () => {
  const result = withoutEmpty({
    keep: "value",
    blank: "",
    missing: undefined,
    nil: null,
    highlights: [],
    ticks: ["a"],
  });
  assert.deepEqual(result, { keep: "value", highlights: [], ticks: ["a"] });
});

test("sanitizeGaugeColors removes undrawable colors and falls back to defaults", () => {
  const result = sanitizeGaugeColors({
    type: "radial-gauge",
    colorPlate: "#1a",
    colorBar: "var(--my-bar)",
    colorNeedle: "#ff0000",
    minValue: 0,
  });
  assert.equal("colorPlate" in result, false);
  assert.equal("colorBar" in result, false);
  assert.equal(result.colorNeedle, "#ff0000");
  assert.equal(result.minValue, 0);
});

test("sanitizeGaugeColors keeps empty-string colors and per-tick arrays", () => {
  const result = sanitizeGaugeColors({
    colorPlateEnd: "",
    colorMajorTicks: ["#f00", "#0f0", "#00f"],
  });
  assert.equal(result.colorPlateEnd, "");
  assert.deepEqual(result.colorMajorTicks, ["#f00", "#0f0", "#00f"]);
});

test("sanitizeGaugeColors strips invalid highlight colors but keeps the range", () => {
  const result = sanitizeGaugeColors({
    highlights: [
      { from: 0, to: 10, color: "#1a" },
      { from: 10, to: 20, color: "#ff0000" },
    ],
  });
  assert.equal(result.highlights[0].color, undefined);
  assert.deepEqual(result.highlights[0], { from: 0, to: 10 });
  assert.deepEqual(result.highlights[1], { from: 10, to: 20, color: "#ff0000" });
});

test("sanitizeCardColors allows var() in background_color and name_color", () => {
  const allowed = sanitizeCardColors({
    background_color: "var(--ha-card-background)",
    name_color: "var(--primary-text-color)",
    name: "Temp",
  });
  assert.equal(allowed.background_color, "var(--ha-card-background)");
  assert.equal(allowed.name_color, "var(--primary-text-color)");
  assert.equal(allowed.name, "Temp");
});

test("sanitizeCardColors rejects colors CSS cannot parse even when var() is allowed", () => {
  const result = sanitizeCardColors({ background_color: "#1a", name_color: "#zz" });
  assert.equal("background_color" in result, false);
  assert.equal("name_color" in result, false);
});

test("buildGaugeOptions skips bad color keys and keeps good ones", () => {
  const canvas = { id: "canvas" } as unknown as HTMLCanvasElement;
  const options = buildGaugeOptions(
    {
      type: "radial-gauge",
      colorPlate: "#1a",
      colorBar: "var(--token)",
      colorNeedle: "#00ff00",
      colorPlateEnd: "",
    },
    canvas,
  );
  assert.equal("colorPlate" in options, false);
  assert.equal("colorBar" in options, false);
  assert.equal(options.colorNeedle, "#00ff00");
  assert.equal(options.colorPlateEnd, "");
  assert.equal(options.renderTo, canvas);
  assert.equal(options.value, 0);
});

test("buildGaugeOptions generates six ticks when majorTicks is absent and range is valid", () => {
  const canvas = {} as HTMLCanvasElement;
  const options = buildGaugeOptions({ minValue: 0, maxValue: 50 }, canvas);
  assert.deepEqual(options.majorTicks, [0, 10, 20, 30, 40, 50]);
});

test("buildGaugeOptions does not invent ticks for an invalid range", () => {
  const canvas = {} as HTMLCanvasElement;
  const options = buildGaugeOptions({ minValue: 100, maxValue: 0 }, canvas);
  assert.equal("majorTicks" in options, false);
});

test("buildGaugeOptions never overrides an explicitly configured majorTicks", () => {
  const canvas = {} as HTMLCanvasElement;
  const options = buildGaugeOptions(
    { minValue: 0, maxValue: 100, majorTicks: ["low", "high"] },
    canvas,
  );
  assert.deepEqual(options.majorTicks, ["low", "high"]);
});

test("buildGaugeOptions passes color arrays through untouched", () => {
  const canvas = {} as HTMLCanvasElement;
  const options = buildGaugeOptions(
    { colorMajorTicks: ["#f00", "#0f0"] },
    canvas,
  );
  assert.deepEqual(options.colorMajorTicks, ["#f00", "#0f0"]);
});
