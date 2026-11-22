import { vi, afterEach } from 'vitest';

// happy-dom omits the HTMLMediaElement readyState constants. Define them with
// the values from the HTML spec so production code can keep using the constants.
const READY_STATES = {
  HAVE_NOTHING: 0,
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
  HAVE_FUTURE_DATA: 3,
  HAVE_ENOUGH_DATA: 4,
} as const;
for (const [name, value] of Object.entries(READY_STATES)) {
  if ((HTMLMediaElement as unknown as Record<string, unknown>)[name] === undefined) {
    Object.defineProperty(HTMLMediaElement, name, { configurable: true, writable: false, value });
  }
}

// happy-dom stubs IntersectionObserver with a no-op class. The player relies
// on it to hydrate the lazy video source, so provide a controllable
// implementation that reports the player as intersecting by default.
type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly root: Element | Document | null = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  readonly callback: ObserverCallback;
  target: Element | null = null;
  disconnected = false;

  constructor(callback: ObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
    queueMicrotask(() => {
      if (this.disconnected || !this.target) return;
      const entry = {
        isIntersecting: true,
        target,
        intersectionRatio: 1,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      } as IntersectionObserverEntry;
      this.callback([entry], this);
    });
  }

  unobserve() {
    this.target = null;
  }

  disconnect() {
    this.disconnected = true;
    this.target = null;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class MockResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// happy-dom has no pointer capture implementation; the player calls these
// during scrub / volume / speed drags. Track captured ids so hasPointerCapture
// reflects releasePointerCapture calls made by the player.
const capturedPointers = new WeakMap<Element, Set<number>>();
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element, pointerId: number) {
    const ids = capturedPointers.get(this) ?? new Set<number>();
    ids.add(pointerId);
    capturedPointers.set(this, ids);
  };
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element, pointerId: number) {
    capturedPointers.get(this)?.delete(pointerId);
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element, pointerId: number) {
    return capturedPointers.get(this)?.has(pointerId) ?? false;
  };
}

// The player uses requestVideoFrameCallback when present; happy-dom lacks it,
// which is the rAF fallback path. Assert the assumption so the tests stay
// honest about which path they exercise.
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  throw new Error('Test environment unexpectedly provides requestVideoFrameCallback');
}

vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
vi.stubGlobal('ResizeObserver', MockResizeObserver);

afterEach(() => {
  MockIntersectionObserver.instances.length = 0;
});
