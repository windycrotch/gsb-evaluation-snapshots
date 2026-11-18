/*!
 * Editor tests for the save path and color validation:
 * - cleared fields disappear, empty arrays stay, untouched defaults stay out
 * - invalid colors surface as section errors and are never written to config
 * - var(--token) is allowed only for background_color and name_color
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import "./dom-setup.ts";
import type { HomeAssistant } from "../src/types.js";

const editorModule = await import("../src/editor.js");
const { CanvasGaugeCardEditor } = editorModule;

const hass = {} as HomeAssistant;

const baseConfig = () => ({
  entity: "sensor.temp",
  gauge: {
    type: "radial-gauge",
    width: 220,
    height: 220,
    minValue: 0,
    maxValue: 100,
  },
});

async function mount(config: Record<string, any>) {
  const el = new CanvasGaugeCardEditor() as any;
  el.setConfig(config);
  el.hass = hass;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

// Builds the data object ha-form would emit: top-level keys plus one object per
// gauge section (all sharing the same gauge data, as willUpdate sets up)
function formValue(el: any, gaugeOverrides: Record<string, any> = {}, cardOverrides: Record<string, any> = {}) {
  const value: Record<string, any> = { ...el._data };
  const gauge = { ...el._data.gauge_main, ...gaugeOverrides };
  for (const key of Object.keys(el._data)) {
    if (key.startsWith("gauge_")) value[key] = gauge;
  }
  Object.assign(value, cardOverrides);
  return value;
}

async function changeGauge(el: any, gaugeOverrides: Record<string, any>, cardOverrides: Record<string, any> = {}) {
  const events: any[] = [];
  el.addEventListener("config-changed", (ev: any) => events.push(ev));
  el.renderRoot
    .querySelector("ha-form")
    .dispatchEvent(new CustomEvent("value-changed", {
      detail: { value: formValue(el, gaugeOverrides, cardOverrides) },
      bubbles: true,
      composed: true,
    }));
  // Lovelace applies the dispatched config back through setConfig, which is
  // when willUpdate rebuilds the form data and merges any rejected color drafts
  const config = events[0].detail.config;
  el.setConfig(config);
  await el.updateComplete;
  return config;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("untouched true defaults are not written into gauge", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, {});
  for (const key of ["valueBox", "strokeTicks", "barProgress", "needle", "animation"]) {
    assert.equal(key in config.gauge, false, `${key} should stay at its library default`);
  }
});

test("a default the user explicitly turns off is saved", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { valueBox: false });
  assert.equal(config.gauge.valueBox, false);
});

test("cleared scalar fields do not linger as empty values", async () => {
  const el = await mount({
    ...baseConfig(),
    name: "Temp",
    gauge: { ...baseConfig().gauge, units: "°C", title: "T" },
  });
  const config = await changeGauge(el, { units: "", title: "" }, { name: "" });
  assert.equal("units" in config.gauge, false);
  assert.equal("title" in config.gauge, false);
  assert.equal("name" in config, false);
});

test("an empty highlights array is preserved", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { highlights: [] });
  assert.deepEqual(config.gauge.highlights, []);
});

test("valid gauge colors are saved", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { colorPlate: "#ffffff", colorBar: "red" });
  assert.equal(config.gauge.colorPlate, "#ffffff");
  assert.equal(config.gauge.colorBar, "red");
});

test("var() in a gauge color is rejected from config but shown as an error", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { colorPlate: "var(--ha-card-background)" });
  assert.equal("colorPlate" in config.gauge, false);
  const errors = el._errors(true);
  assert.ok(errors.gauge_plate.some((m: string) => m.includes("Plate color")));
});

test("a half-typed hex gauge color is rejected and reported", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { colorNeedle: "#1a" });
  assert.equal("colorNeedle" in config.gauge, false);
  const errors = el._errors(true);
  assert.ok(errors.gauge_needle.some((m: string) => m.includes("Needle color")));
});

test("var() is allowed in background_color and name_color", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(
    el,
    { name_color: "var(--primary-text-color)" },
    { background_color: "var(--ha-card-background)" },
  );
  assert.equal(config.background_color, "var(--ha-card-background)");
  assert.equal(config.name_color, "var(--primary-text-color)");
  assert.equal(el._errors(true), undefined);
});

test("an unparseable background_color is rejected even though var() is allowed", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, {}, { background_color: "#1a" });
  assert.equal("background_color" in config, false);
  const errors = el._errors(true);
  assert.ok(errors.background_color.includes("Background color"));
});

test("var() in name_color is fine but a broken hex is not", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { name_color: "#zz" });
  assert.equal("name_color" in config, false);
  const errors = el._errors(true);
  assert.ok(errors.gauge_text.some((m: string) => m.includes("Name color")));
});

test("invalid highlight colors are rejected per entry with an indexed error", async () => {
  const el = await mount(baseConfig());
  const highlights = [
    { from: 0, to: 20, color: "#1a" },
    { from: 20, to: 40, color: "#ff0000" },
  ];
  const config = await changeGauge(el, { highlights });
  assert.deepEqual(config.gauge.highlights[0], { from: 0, to: 20 });
  assert.deepEqual(config.gauge.highlights[1], { from: 20, to: 40, color: "#ff0000" });
  const errors = el._errors(true);
  assert.ok(errors.gauge_highlights.some((m: string) => m.includes("Highlight 1 color")));
});

test("var() in a highlight color is rejected", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, {
    highlights: [{ from: 0, to: 10, color: "var(--accent-color)" }],
  });
  assert.deepEqual(config.gauge.highlights, [{ from: 0, to: 10 }]);
  assert.ok(el._errors(true).gauge_highlights);
});

test("an empty majorTicks list is removed so the card regenerates six ticks", async () => {
  const el = await mount(baseConfig());
  const config = await changeGauge(el, { majorTicks: [] });
  assert.equal("majorTicks" in config.gauge, false);
});

test("a valid change produces no errors", async () => {
  const el = await mount(baseConfig());
  await changeGauge(el, { colorPlate: "#fff", highlights: [{ from: 0, to: 10, color: "red" }] });
  assert.equal(el._errors(true), undefined);
});

test("an invalid color already present in the YAML shows an error on open", async () => {
  const el = await mount({
    ...baseConfig(),
    gauge: { ...baseConfig().gauge, colorPlate: "#1a" },
  });
  // The rejected text is still displayed so the user can see and fix it
  assert.equal(el._data.gauge_main.colorPlate, "#1a");
  const errors = el._errors(true);
  assert.ok(errors.gauge_plate.some((m: string) => m.includes("Plate color")));
});

test("a var() gauge color in the YAML shows an error but var() card colors do not", async () => {
  const el = await mount({
    ...baseConfig(),
    background_color: "var(--ha-card-background)",
    gauge: { ...baseConfig().gauge, colorBar: "var(--my-bar)" },
  });
  const errors = el._errors(true);
  assert.ok(errors.gauge_bar.some((m: string) => m.includes("Bar color")));
  assert.equal(errors.background_color, undefined);
});

test("fixing a rejected color writes it and clears the error", async () => {
  const el = await mount(baseConfig());
  await changeGauge(el, { colorPlate: "var(--token)" });
  assert.ok(el._errors(true).gauge_plate);

  const config = await changeGauge(el, { colorPlate: "#00ff00" });
  assert.equal(config.gauge.colorPlate, "#00ff00");
  assert.equal(el._errors(true), undefined);
});

test("a rejected highlight color recovers when a valid color is entered", async () => {
  const el = await mount(baseConfig());
  await changeGauge(el, { highlights: [{ from: 0, to: 10, color: "var(--accent)" }] });
  assert.ok(el._errors(true).gauge_highlights);

  const config = await changeGauge(el, { highlights: [{ from: 0, to: 10, color: "green" }] });
  assert.deepEqual(config.gauge.highlights, [{ from: 0, to: 10, color: "green" }]);
  assert.equal(el._errors(true), undefined);
});

test("shortening the highlights list drops stale color drafts", async () => {
  const el = await mount(baseConfig());
  await changeGauge(el, {
    highlights: [
      { from: 0, to: 10, color: "#1a" },
      { from: 10, to: 20, color: "#2b" },
    ],
  });
  // Only the first, now invalid, highlight remains
  const config = await changeGauge(el, { highlights: [{ from: 0, to: 10, color: "#1a" }] });
  assert.equal(config.gauge.highlights.length, 1);
  const errors = el._errors(true);
  assert.ok(errors.gauge_highlights.every((m: string) => !m.includes("Highlight 2")));
});

test("an invalid name_color from YAML shows an error while allowing its var() form", async () => {
  const broken = await mount({ ...baseConfig(), name_color: "#zz" });
  assert.ok(broken._errors(true).gauge_text.some((m: string) => m.includes("Name color")));

  const ok = await mount({ ...baseConfig(), name_color: "var(--primary-text-color)" });
  assert.equal(ok._errors(true), undefined);
});
