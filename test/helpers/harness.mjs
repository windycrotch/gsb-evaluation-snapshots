// Local test harness for three-render-objects.
//
// The component is designed for a browser: it constructs a WebGLRenderer and loads background
// images over the network. To test its async/ordering behaviour deterministically we run it in
// jsdom, supply a stubbed THREE (real three for everything except the renderer) and a
// controllable fake TextureLoader. This lets tests decide exactly when (and whether) an image
// request resolves, and observe texture disposal and callback firing.
//
// Usage: create a component with `createInstance(...)`, then drive the fake clock and image
// loader from the returned environment.

import { JSDOM } from 'jsdom';

import * as REAL_THREE from 'three';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
});

const { window } = dom;

// Expose the browser globals the component (and its deps: float-tooltip/d3-selection/preact)
// expect to find at import time.
const defineGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

defineGlobal('window', window);
defineGlobal('document', window.document);
defineGlobal('navigator', window.navigator);
defineGlobal('HTMLElement', window.HTMLElement);
defineGlobal('Element', window.Element);
defineGlobal('Event', window.Event);
defineGlobal('MouseEvent', window.MouseEvent);
defineGlobal('getComputedStyle', window.getComputedStyle.bind(window));
defineGlobal('requestAnimationFrame', cb => setTimeout(() => cb(env.clock), 0));
defineGlobal('cancelAnimationFrame', id => clearTimeout(id));

// Deterministic clock shared with the camera tweening (@tweenjs/tween.js reads performance.now)
// and three's Timer.
export const env = {
  clock: 0,
  renderers: [],
  controls: [],
  loader: null
};

globalThis.performance.now = () => env.clock;

// --- Fake background image loader ---------------------------------------------------------
// Records every request so a test can resolve / fail it explicitly. Returns a real Texture so
// colorSpace handling and disposal behave like production.

let requestSeq = 0;

class FakeTextureLoader {
  load(url, onLoad, onProgress, onError) {
    const request = {
      id: ++requestSeq,
      url,
      texture: new REAL_THREE.Texture(),
      settled: false,
      disposed: false,
      resolve() {
        if (request.settled) return;
        request.settled = true;
        onLoad?.(request.texture);
      },
      fail(error = new Error(`Failed to load ${url}`)) {
        if (request.settled) return;
        request.settled = true;
        onError?.(error);
      }
    };

    request.texture.dispose = () => {
      request.texture.disposed = true;
      REAL_THREE.Texture.prototype.dispose.call(request.texture);
    };
    request.texture.disposed = false;

    env.loader.requests.push(request);
    return request.texture;
  }
}

class FakeLoader {
  constructor() {
    this.requests = [];
  }

  get pending() {
    return this.requests.filter(r => !r.settled);
  }
}

const resetLoader = () => {
  env.loader = new FakeLoader();
};

// --- Stub WebGL renderer ------------------------------------------------------------------
// Implements only the surface the component and three's EffectComposer touch. render() and
// clear() are counted so tests can assert whether a frame was drawn (e.g. after teardown).

class StubRenderer {
  constructor(params = {}) {
    this.params = params;
    this.domElement = window.document.createElement('canvas');
    this.autoClear = true;
    this.autoClearColor = true;
    this.autoClearDepth = true;
    this.autoClearStencil = true;
    this.state = { buffers: { stencil: { setFunc() {} } } };

    this._pixelRatio = 1;
    this._size = undefined;
    this._clearColor = new REAL_THREE.Color(0x000000);
    this._clearAlpha = 1;

    this.renderCount = 0;
    this.clearCount = 0;
    this.disposeCount = 0;
    this.renderTarget = null;
    this.calls = [];

    env.renderers.push(this);
  }

  setPixelRatio(r) { this._pixelRatio = r; }
  getPixelRatio() { return this._pixelRatio; }

  setSize(w, h) { this._size = { width: w, height: h }; }
  getSize(target) {
    if (target) {
      target.width = this._size?.width ?? 0;
      target.height = this._size?.height ?? 0;
      return target;
    }
    return { ...this._size };
  }

  setClearColor(color, alpha = 1) {
    this._clearColor = color?.clone ? color.clone() : new REAL_THREE.Color(color);
    this._clearAlpha = alpha;
  }
  getClearColor(target) { target?.copy?.(this._clearColor); return this._clearColor; }
  getClearAlpha() { return this._clearAlpha; }
  setClearAlpha(a) { this._clearAlpha = a; }

  getRenderTarget() { return this.renderTarget; }
  setRenderTarget(rt) { this.renderTarget = rt ?? null; }

  clear() { this.clearCount++; }
  render() { this.renderCount++; }
  getContext() { return {}; }
  dispose() { this.disposeCount++; }
}

// --- Stub controls ------------------------------------------------------------------------
// Replaces the real trackball/orbit/etc. controls, which need a fully-featured DOM canvas.
// Mirrors the small surface the component relies on (target, enabled, update, dispose).

class StubControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = true;
    this.target = new REAL_THREE.Vector3();
    this.updateCount = 0;
    this.disposed = false;
    this.listeners = {};
    env.controls.push(this);
  }
  update() { this.updateCount++; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispose() { this.disposed = true; }
}

// Expose real three, but swap in the stubs the component looks up through window.THREE.
const THREE_FOR_COMPONENT = {
  ...REAL_THREE,
  WebGLRenderer: StubRenderer,
  TextureLoader: FakeTextureLoader
};

window.THREE = THREE_FOR_COMPONENT;
defineGlobal('THREE', THREE_FOR_COMPONENT);

// Import the component only after globals + THREE are in place.
const implCache = new Map();

// Loads a ThreeRenderObjects implementation (defaults to the one under test). Passing another
// path lets the baseline-comparison tests run the pre-change implementation through the very
// same harness. Paths are resolved relative to this file.
export const importImplementation = async (path = '../../src/three-render-objects.js') => {
  const resolved = new URL(path, import.meta.url).href;
  if (!implCache.has(resolved)) {
    implCache.set(resolved, (await import(resolved)).default);
  }
  return implCache.get(resolved);
};

const defaultImplementation = await importImplementation();

// --- Test helpers -------------------------------------------------------------------------

// The component's update() is debounced (kapsule, 1ms). Flush pending microtask/timer work.
export const flush = (ms = 6) => new Promise(resolve => setTimeout(resolve, ms));

// Advance the deterministic clock (drives camera tweens via tick()).
export const advance = ms => { env.clock += ms; };

export const resetEnv = () => {
  resetLoader();
  env.renderers.length = 0;
  env.controls.length = 0;
  env.clock = 0;
};

export const createInstance = (config = {}, props = {}, Implementation = defaultImplementation) => {
  const el = window.document.createElement('div');
  window.document.body.appendChild(el);

  const instance = new Implementation(el, {
    controlType: StubControls,
    waitForLoadComplete: true,
    ...config
  });

  Object.entries(props).forEach(([k, v]) => instance[k](v));

  return instance;
};

export const lastRenderer = () => env.renderers[env.renderers.length - 1];
export const lastControls = () => env.controls[env.controls.length - 1];

export { window, REAL_THREE };
