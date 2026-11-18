/**
 * Self-made canvas / image fakes plus DOM globals, so the engine can be
 * tested in plain Node without jsdom. Every draw is recorded on the fake
 * 2d context, which makes the rendered output verifiable.
 */

export type ContextCall = { method: string; args: unknown[] };

export class FakeContext2D {
  calls: ContextCall[] = [];
  globalAlpha = 1;

  clearRect(...args: unknown[]) {
    this.calls.push({ method: "clearRect", args });
  }

  drawImage(...args: unknown[]) {
    this.calls.push({ method: "drawImage", args });
  }

  /** Sources passed to drawImage, in call order. */
  drawnImages() {
    return this.calls
      .filter((call) => call.method === "drawImage")
      .map((call) => call.args[0]);
  }

  count(method: string) {
    return this.calls.filter((call) => call.method === method).length;
  }

  reset() {
    this.calls = [];
  }
}

export class FakeCanvas {
  width = 300;
  height = 150;
  clientWidth = 300;
  clientHeight = 150;
  context = new FakeContext2D();

  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
}

type Listener = () => void;

export class FakeImage {
  src = "";
  complete = false;
  naturalWidth = 64;
  naturalHeight = 32;
  #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Simulate a successful load. */
  succeed() {
    this.complete = true;
    this.#listeners.get("load")?.forEach((listener) => listener());
  }

  /** Simulate a failed load. */
  fail() {
    this.#listeners.get("error")?.forEach((listener) => listener());
  }
}

/** Every <img> created through document.createElement, in order. */
export const createdImages: FakeImage[] = [];

const documentMock = {
  createElement(tag: string) {
    if (tag === "img") {
      const image = new FakeImage();
      createdImages.push(image);
      return image;
    }
    throw new Error(`Unexpected createElement("${tag}") in test`);
  },
  querySelector: () => null,
};

const windowMock = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

type FrameCallback = (time: number) => void;

const rafCallbacks = new Map<number, FrameCallback>();
let rafSeq = 0;

export const rafControl = {
  /** Run all queued animation-frame callbacks once, with the current time. */
  step() {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  },
  pending() {
    return rafCallbacks.size;
  },
  reset() {
    rafCallbacks.clear();
  },
};

export function installGlobals() {
  globalThis.HTMLCanvasElement = FakeCanvas as unknown as typeof HTMLCanvasElement;
  globalThis.HTMLImageElement = FakeImage as unknown as typeof HTMLImageElement;
  globalThis.document = documentMock as unknown as Document;
  globalThis.window = windowMock as unknown as Window & typeof globalThis;
  globalThis.requestAnimationFrame = (callback: FrameCallback) => {
    rafSeq += 1;
    rafCallbacks.set(rafSeq, callback);
    return rafSeq;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    rafCallbacks.delete(id);
  };
}

export function resetFakes() {
  createdImages.length = 0;
  rafControl.reset();
}
