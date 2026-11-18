/*!
 * Card-level tests: warning states must never create a canvas gauge, and
 * switching back to a valid config must rebuild one showing the current state.
 */
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import "./dom-setup.ts";
import type { HomeAssistant } from "../src/types.js";

// Records every gauge construction so tests can assert lifecycle behavior
const created: Array<{ kind: string; options: Record<string, unknown> }> = [];
const destroyed: FakeGauge[] = [];

class FakeGauge {
  public options: Record<string, unknown>;
  public value: unknown;
  public draws = 0;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.value = options.value;
    created.push({ kind: this.constructor.name, options });
  }
  draw(): void {
    this.draws += 1;
  }
  destroy(): void {
    destroyed.push(this);
  }
}
class FakeLinearGauge extends FakeGauge {}
class FakeRadialGauge extends FakeGauge {}

const cardUrl = new URL("../src/canvas-gauge-card.ts", import.meta.url).href;
const editorUrl = new URL("../src/editor.ts", import.meta.url).href;

beforeEach(async () => {
  created.length = 0;
  destroyed.length = 0;
  mock.module("canvas-gauges", {
    exports: {
      default: { LinearGauge: FakeLinearGauge, RadialGauge: FakeRadialGauge },
    },
  });
  // The editor pulls in ha-form and a large schema; the card only imports it
  // for getConfigElement, so an empty module keeps the card test focused.
  // The import's side effect registers the canvas-gauge-card custom element
  mock.module(editorUrl, { exports: {} });
  await import(cardUrl);
});

afterEach(() => {
  mock.restoreAll();
});

const validGauge = () => ({
  type: "radial-gauge",
  width: 220,
  height: 220,
  minValue: 0,
  maxValue: 100,
});

const hassWith = (states: Record<string, unknown>) =>
  ({ states }) as unknown as HomeAssistant;

async function mount(config: Record<string, any>, hass: unknown) {
  const el = document.createElement("canvas-gauge-card") as any;
  el.setConfig(config);
  el.hass = hass;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

test("no_entity warning renders without creating a gauge", async () => {
  const el = await mount({ gauge: validGauge() }, hassWith({}));
  assert.match(el.shadowRoot.textContent, /No entity configured/);
  assert.equal(el.shadowRoot.querySelector("#canvaselement"), null);
  assert.equal(created.length, 0);
});

test("entity_not_found warning includes the entity id and creates no gauge", async () => {
  const el = await mount(
    { entity: "sensor.missing", gauge: validGauge() },
    hassWith({ "sensor.other": { state: "1" } }),
  );
  assert.match(el.shadowRoot.textContent, /Entity not found: sensor\.missing/);
  assert.equal(el.shadowRoot.querySelector("#canvaselement"), null);
  assert.equal(created.length, 0);
});

test("invalid_gauge_type warning shows the actual type and creates no gauge", async () => {
  const el = await mount(
    { entity: "sensor.temp", gauge: { ...validGauge(), type: "pie-gauge" } },
    hassWith({ "sensor.temp": { state: "42", attributes: {} } }),
  );
  const text = el.shadowRoot.textContent as string;
  assert.match(text, /radial-gauge/);
  assert.match(text, /pie-gauge/);
  assert.equal(el.shadowRoot.querySelector("#canvaselement"), null);
  assert.equal(created.length, 0);
});

test("a valid config builds a radial gauge and shows the current state", async () => {
  const el = await mount(
    { entity: "sensor.temp", gauge: validGauge() },
    hassWith({ "sensor.temp": { state: "42", attributes: {} } }),
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "FakeRadialGauge");
  assert.notEqual(el.shadowRoot.querySelector("#canvaselement"), null);
  const instance = el._gauge as FakeGauge;
  assert.equal(instance.value, "42");
  assert.ok(instance.draws > 0);
});

test("a linear-gauge config builds a LinearGauge", async () => {
  const el = await mount(
    { entity: "sensor.temp", gauge: { ...validGauge(), type: "linear-gauge" } },
    hassWith({ "sensor.temp": { state: "7", attributes: {} } }),
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "FakeLinearGauge");
  assert.equal(el._gauge.value, "7");
});

test("going from a warning to a valid config rebuilds the gauge", async () => {
  const el = await mount(
    { entity: "sensor.gone", gauge: validGauge() },
    hassWith({}),
  );
  assert.equal(created.length, 0);
  assert.equal(el._gauge, undefined);

  el.setConfig({ entity: "sensor.temp", gauge: validGauge() });
  el.hass = hassWith({ "sensor.temp": { state: "12", attributes: {} } });
  await el.updateComplete;

  assert.equal(created.length, 1);
  assert.equal(el._gauge.value, "12");
});

test("going from a valid gauge to a warning destroys the gauge with no leftover instance", async () => {
  const el = await mount(
    { entity: "sensor.temp", gauge: validGauge() },
    hassWith({ "sensor.temp": { state: "12", attributes: {} } }),
  );
  const instance = el._gauge as FakeGauge;
  assert.ok(instance);

  el.setConfig({ entity: "sensor.gone", gauge: validGauge() });
  await el.updateComplete;

  assert.match(el.shadowRoot.textContent, /Entity not found/);
  assert.equal(el._gauge, undefined);
  assert.ok(destroyed.includes(instance));
});

test("bad gauge type leaves no instance, then a fixed type rebuilds", async () => {
  const state = hassWith({ "sensor.temp": { state: "3", attributes: {} } });
  const el = await mount(
    { entity: "sensor.temp", gauge: { ...validGauge(), type: "broken" } },
    state,
  );
  assert.equal(created.length, 0);

  el.setConfig({ entity: "sensor.temp", gauge: validGauge() });
  await el.updateComplete;
  assert.equal(created.length, 1);
  assert.equal(el._gauge.value, "3");
});

test("undrawable colors are skipped when options are built", async () => {
  await mount(
    {
      entity: "sensor.temp",
      gauge: {
        ...validGauge(),
        colorPlate: "#1a",
        colorBar: "var(--primary-color)",
        colorNeedle: "#00ff00",
      },
    },
    hassWith({ "sensor.temp": { state: "1", attributes: {} } }),
  );
  const options = created[0].options;
  assert.equal("colorPlate" in options, false);
  assert.equal("colorBar" in options, false);
  assert.equal(options.colorNeedle, "#00ff00");
});

test("six default ticks are generated when majorTicks is omitted and range is valid", async () => {
  await mount(
    { entity: "sensor.temp", gauge: { ...validGauge(), minValue: 0, maxValue: 50 } },
    hassWith({ "sensor.temp": { state: "1", attributes: {} } }),
  );
  assert.deepEqual(created[0].options.majorTicks, [0, 10, 20, 30, 40, 50]);
});

test("no ticks are generated when maxValue is not greater than minValue", async () => {
  await mount(
    { entity: "sensor.temp", gauge: { ...validGauge(), minValue: 100, maxValue: 0 } },
    hassWith({ "sensor.temp": { state: "1", attributes: {} } }),
  );
  assert.equal("majorTicks" in created[0].options, false);
});

test("an entity state change updates the value without rebuilding the gauge", async () => {
  const el = await mount(
    { entity: "sensor.temp", gauge: validGauge() },
    hassWith({ "sensor.temp": { state: "10", attributes: {} } }),
  );
  assert.equal(created.length, 1);
  const instance = el._gauge as FakeGauge;

  el.hass = hassWith({ "sensor.temp": { state: "55", attributes: {} } });
  await el.updateComplete;

  assert.equal(created.length, 1, "no second gauge should be constructed");
  assert.equal(el._gauge, instance, "the same gauge instance must be reused");
  assert.equal(instance.value, "55");
});
