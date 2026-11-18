/*!
 * Offline DOM setup for the card/editor tests. jsdom provides window/document;
 * canvas and the Home Assistant web components are stubbed because neither can
 * run headless without a real browser. Import this before the components.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// Node's test files share a realm, so assign the jsdom globals once
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.customElements = dom.window.customElements;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number): void => clearTimeout(id);

// jsdom has no layout engine; the canvas element only needs to exist as the
// renderTo target, the mocked canvas-gauges never paints it
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    measureText: () => ({ width: 10 }),
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    arc() {},
    rect() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    translate() {},
    rotate() {},
    scale() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
};

// Minimal CSS.supports matching browser behavior for the values under test.
// var(--token) is valid CSS syntax; the canvas cannot paint it, which the
// helpers enforce through their own explicit var() check
dom.window.CSS = {
  supports(property: string, value: string): boolean {
    if (property !== "color") return true;
    const v = value.trim().toLowerCase();
    if (v.includes("var(")) return true;
    if (v.startsWith("#")) {
      return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v);
    }
    if (v.startsWith("rgb")) return /^rgba?\(/.test(v);
    if (v.startsWith("hsl")) return /^hsla?\(/.test(v);
    return ["red", "green", "blue", "black", "white", "transparent", "gray", "orange"].includes(v);
  },
} as unknown as typeof CSS;
globalThis.CSS = dom.window.CSS;

// Home Assistant web components used by the card templates
class StubHaCard extends dom.window.HTMLElement {}
class StubHaForm extends dom.window.HTMLElement {}
dom.window.customElements.define("ha-card", StubHaCard);
dom.window.customElements.define("ha-form", StubHaForm);

export { dom };
