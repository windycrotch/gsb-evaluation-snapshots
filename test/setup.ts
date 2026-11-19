// jsdom does not implement matchMedia; the player queries it to decide
// between touch and desktop control layouts. Report a desktop environment.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// jsdom lacks IntersectionObserver/ResizeObserver; the player feature-detects
// both and falls back to direct hydration / fixed tray sizing without them.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

// requestVideoFrameCallback is used opportunistically with a timer fallback,
// but jsdom lacks it entirely.
if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    writable: true,
    value: function requestVideoFrameCallback(callback: (now: number, metadata: unknown) => void) {
      return window.setTimeout(() => callback(performance.now(), {}), 0);
    },
  });
}

// jsdom does not implement PointerEvent; the player relies on pointer events
// for scrubbing. Subclass MouseEvent so instanceof checks still work.
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }

  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    PointerEventStub as unknown as typeof PointerEvent;
  (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    PointerEventStub as unknown as typeof PointerEvent;
}

// jsdom does not implement pointer capture; the player uses it to keep
// receiving drag events. Provide no-op bookkeeping so hasPointerCapture
// reflects release calls correctly.
if (!Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element, pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element, pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element, pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}

// jsdom's media element stubs return undefined from play()/pause(); the
// player treats play() as a thenable, so give every media element promise
// based controls (tests can still spy on or override them).
HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
  // jsdom does not fire the pause event itself; the player listens to it.
  this.dispatchEvent(new Event('pause'));
};

// getBoundingClientRect returns zeros in jsdom; progress geometry needs a
// deterministic track width. Tests can override this per element as needed.
Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
  const width = (this as HTMLElement).dataset?.testWidth
    ? Number.parseFloat((this as HTMLElement).dataset.testWidth ?? '0')
    : 0;

  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    width,
    height: width > 0 ? 4 : 0,
    toJSON: () => ({}),
  } as DOMRect;
};
