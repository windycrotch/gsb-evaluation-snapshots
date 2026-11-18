/**
 * Minimal DOM shim for exercising CanvasManager state transitions under the
 * Deno unit-test runtime, which provides no document/window/ResizeObserver
 * globals. Only the surface area CanvasManager touches is implemented; it is
 * not a general-purpose DOM polyfill.
 */

export interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const parsePx = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const camelize = (property: string): string =>
  property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export class FakeCSSStyleDeclaration {
  private readonly declarations = new Map<string, string>();

  setProperty(name: string, value: string): void {
    if (value === "" || value === undefined || value === null) {
      this.declarations.delete(name);
    } else {
      this.declarations.set(name, String(value));
    }
  }

  getPropertyValue(name: string): string {
    return this.declarations.get(name) ?? "";
  }

  removeProperty(name: string): void {
    this.declarations.delete(name);
  }

  get cssText(): string {
    return [...this.declarations.entries()].map(([name, value]) => `${name}: ${value}`).join("; ");
  }

  set cssText(text: string) {
    this.declarations.clear();
    for (const declaration of text.split(";")) {
      const colonIndex = declaration.indexOf(":");
      if (colonIndex === -1) continue;
      const name = declaration.slice(0, colonIndex).trim();
      const value = declaration.slice(colonIndex + 1).trim();
      if (name) this.declarations.set(camelize(name), value);
    }
  }
}

// Allow direct indexed style access (element.style.bottom = "60px").
const styleProxyHandler: ProxyHandler<FakeCSSStyleDeclaration> = {
  get(target, property: string) {
    if (property in target) {
      return (target as unknown as Record<string, unknown>)[property];
    }
    return target.getPropertyValue(property);
  },
  set(target, property: string, value: unknown): boolean {
    if (property in target) {
      (target as unknown as Record<string, unknown>)[property] = value;
    } else {
      target.setProperty(property, String(value));
    }
    return true;
  },
};

export class FakeElement {
  readonly tagName: string;
  readonly style: FakeCSSStyleDeclaration;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private explicitBox: { width: number; height: number } | null = null;
  private readonly viewport: { width: number; height: number };

  constructor(tagName: string, viewport: { width: number; height: number }) {
    this.tagName = tagName.toUpperCase();
    this.viewport = viewport;
    this.style = new Proxy(new FakeCSSStyleDeclaration(), styleProxyHandler) as unknown as FakeCSSStyleDeclaration;
  }

  /** Pin the content box a ResizeObserver would measure for this element. */
  setBox(width: number, height: number): void {
    this.explicitBox = { width, height };
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
    return child;
  }

  private get allocatedWidth(): number {
    if (this.explicitBox) return this.explicitBox.width;
    if (this.parentElement) return this.parentElement.getBoundingClientRect().width;
    return this.viewport.width;
  }

  private get allocatedHeight(): number {
    if (this.explicitBox) return this.explicitBox.height;
    if (this.parentElement) return this.parentElement.getBoundingClientRect().height;
    return this.viewport.height;
  }

  getBoundingClientRect(): FakeRect {
    const style = this.style;
    const left = parsePx(style.getPropertyValue("left"));
    const top = parsePx(style.getPropertyValue("top"));
    const right = parsePx(style.getPropertyValue("right"));
    const bottom = parsePx(style.getPropertyValue("bottom"));
    const explicitWidth = parsePx(style.getPropertyValue("width"));
    const explicitHeight = parsePx(style.getPropertyValue("height"));

    // An explicit CSS width (e.g. the canvas) wins; otherwise the element fills
    // its allocated box minus any positioned insets (e.g. a toolbar reservation).
    const width = explicitWidth > 0 ? explicitWidth : Math.max(0, this.allocatedWidth - left - right);
    const height = explicitHeight > 0 ? explicitHeight : Math.max(0, this.allocatedHeight - top - bottom);

    return {
      x: left,
      y: top,
      width,
      height,
      top,
      left,
      right: left + width,
      bottom: top + height,
    };
  }
}

export class FakeCanvasElement extends FakeElement {
  width = 300;
  height = 150;
}

interface ResizeEntry {
  target: FakeElement;
  contentRect: FakeRect;
}

type ResizeCallback = (entries: ResizeEntry[], observer: FakeResizeObserver) => void;

const observerInstances = new Set<FakeResizeObserver>();

export class FakeResizeObserver {
  private readonly targets = new Set<FakeElement>();
  private disconnected = false;

  constructor(private readonly callback: ResizeCallback) {
    observerInstances.add(this);
  }

  observe(target: FakeElement): void {
    this.targets.add(target);
  }

  unobserve(target: FakeElement): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
    observerInstances.delete(this);
  }

  private deliver(entry: ResizeEntry): void {
    if (!this.disconnected && this.targets.has(entry.target)) {
      this.callback([entry], this);
    }
  }
}

export const elementObservers = (element: FakeElement): FakeResizeObserver[] =>
  [...observerInstances].filter((observer) => observer["targets"].has(element));

/** Simulate the browser delivering a measured content rect to observing ROs. */
export const triggerResize = (
  element: FakeElement,
  width: number,
  height: number,
): void => {
  const entry: ResizeEntry = {
    target: element,
    contentRect: {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
    },
  };
  for (const observer of elementObservers(element)) {
    observer["deliver"](entry);
  }
};

type EventHandler = (event: { type: string }) => void;

export interface FakeWindow {
  devicePixelRatio: number;
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, handler: EventHandler): void;
  removeEventListener(type: string, handler: EventHandler): void;
  dispatchEvent(event: { type: string }): boolean;
}

export interface DomShimHandles {
  window: FakeWindow;
  document: { createElement(tagName: string): FakeElement };
  setViewport(width: number, height: number): void;
  getViewport(): { width: number; height: number };
  triggerResize(element: FakeElement, width: number, height: number): void;
  restore(): void;
}

export function installDomShim(options: {
  width?: number;
  height?: number;
  devicePixelRatio?: number;
} = {}): DomShimHandles {
  const viewport = {
    width: options.width ?? 1000,
    height: options.height ?? 700,
  };

  /**
   * A real ResizeObserver delivery means the element already occupies the new
   * box. Pin that element's allocated box (its parent keeps its own) and then
   * deliver the matching content rect to its observers.
   */
  const triggerSyntheticResize = (element: FakeElement, width: number, height: number) => {
    element.setBox(width, height);
    triggerResize(element, width, height);
  };

  const listeners = new Map<string, Set<EventHandler>>();

  const fakeWindow: FakeWindow = {
    devicePixelRatio: options.devicePixelRatio ?? 1,
    get innerWidth() {
      return viewport.width;
    },
    get innerHeight() {
      return viewport.height;
    },
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? new Set<EventHandler>();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) ?? []) {
        handler(event);
      }
      return true;
    },
  };

  const fakeDocument = {
    createElement(tagName: string): FakeElement {
      return tagName === "canvas" ? new FakeCanvasElement(tagName, viewport) : new FakeElement(tagName, viewport);
    },
  };

  const global = globalThis as unknown as Record<string, unknown>;
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalResizeObserver = global.ResizeObserver;

  global.document = fakeDocument;
  global.window = fakeWindow;
  global.ResizeObserver = FakeResizeObserver;

  return {
    window: fakeWindow,
    document: fakeDocument,
    setViewport(width, height) {
      viewport.width = width;
      viewport.height = height;
    },
    getViewport() {
      return { ...viewport };
    },
    triggerResize: triggerSyntheticResize,
    restore() {
      global.document = originalDocument;
      global.window = originalWindow;
      global.ResizeObserver = originalResizeObserver;
    },
  };
}
