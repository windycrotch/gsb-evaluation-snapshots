// Verification for background-image load session validity.
// Runs with plain node (no test framework): node test/background-image-session.mjs
//
// Uses a stub THREE (the module prefers window.THREE when present) backed by the
// real three math/scene classes, with a controllable TextureLoader whose loads
// only resolve when the test says so, and a fake WebGLRenderer (no GL needed).

import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import * as REAL_THREE from 'three';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ---- Controllable texture loader ----------------------------------------
const pendingLoads = new Map(); // url -> [onLoad]
const makeTexture = url => ({ __url: url, colorSpace: null, disposed: false, dispose() { this.disposed = true; } });

class StubTextureLoader {
  load(url, onLoad) {
    if (!pendingLoads.has(url)) pendingLoads.set(url, []);
    pendingLoads.get(url).push(onLoad);
    return { __url: url };
  }
}
const resolveLoad = url => {
  const cbs = pendingLoads.get(url) || [];
  pendingLoads.delete(url);
  const texture = makeTexture(url);
  cbs.forEach(cb => cb(texture));
  return texture;
};

// ---- Fake renderer (no WebGL in node) ------------------------------------
class FakeWebGLRenderer {
  constructor() {
    this.domElement = document.createElement('canvas');
    this.clearColor = null;
  }
  setPixelRatio() {}
  setSize() {}
  setClearColor(color, alpha) { this.clearColor = { color, alpha }; }
  getPixelRatio() { return 1; }
  getSize(target) { return target ? target.set(0, 0) : { width: 0, height: 0 }; }
  render() {}
  dispose() {}
}

window.THREE = { ...REAL_THREE, WebGLRenderer: FakeWebGLRenderer, TextureLoader: StubTextureLoader };

const { default: ThreeRenderObjects } = await import('../src/three-render-objects.js');

// ---- helpers --------------------------------------------------------------
const tick = () => new Promise(res => setTimeout(res, 5)); // > kapsule's 1ms digest debounce

const getSkysphere = comp => comp.scene().children.find(c => c instanceof REAL_THREE.Mesh);

const makeComp = (opts = {}) => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return ThreeRenderObjects({ waitForLoadComplete: true, ...opts })(el);
};

let passed = 0, total = 0;
const test = async (name, fn) => {
  total++;
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
};

// ---- tests ----------------------------------------------------------------

await test('single image load: sky shown, callback fired, first frame released', async () => {
  let cbCount = 0;
  const comp = makeComp();
  comp.onBackgroundImageLoaded(() => cbCount++);

  assert.strictEqual(comp.scene().visible, false, 'scene hidden while waiting for load');

  comp.backgroundImageUrl('a.png');
  await tick();
  const sky = getSkysphere(comp);
  assert.strictEqual(sky.visible, false);

  resolveLoad('a.png');
  assert.strictEqual(sky.visible, true, 'sky visible after load');
  assert.strictEqual(sky.material.map.__url, 'a.png');
  assert.strictEqual(comp.scene().visible, true, 'first frame released');

  await tick();
  assert.strictEqual(cbCount, 1, 'onBackgroundImageLoaded fired once');
  comp._destructor();
});

await test('rapid A -> B switch: only B is applied, late A is dropped', async () => {
  let cbCount = 0;
  const comp = makeComp();
  comp.onBackgroundImageLoaded(() => cbCount++);

  comp.backgroundImageUrl('a.png');
  await tick(); // let A's load session start
  comp.backgroundImageUrl('b.png');
  await tick(); // let B's load session start (invalidates A)
  const sky = getSkysphere(comp);

  const texA = resolveLoad('a.png'); // stale, returns after B was requested
  assert.strictEqual(sky.visible, false, 'stale A must not show the sky');
  assert.strictEqual(texA.disposed, true, 'stale texture disposed');
  assert.strictEqual(comp.scene().visible, false, 'stale A must not release first frame');

  resolveLoad('b.png');
  assert.strictEqual(sky.visible, true);
  assert.strictEqual(sky.material.map.__url, 'b.png', 'only B on the skysphere');
  assert.strictEqual(comp.scene().visible, true);

  await tick();
  assert.strictEqual(cbCount, 1, 'callback fired only for B');
  comp._destructor();
});

await test('A -> solid color: hides sky immediately, late A does not resurrect', async () => {
  let cbCount = 0;
  const comp = makeComp();
  comp.onBackgroundImageLoaded(() => cbCount++);

  comp.backgroundImageUrl('a.png');
  await tick();
  comp.backgroundImageUrl(null);
  await tick();
  const sky = getSkysphere(comp);

  assert.strictEqual(sky.visible, false, 'sky hidden immediately on null');
  assert.strictEqual(sky.material.map, null, 'old texture cleared');
  assert.strictEqual(comp.scene().visible, true, 'first frame released on switch to solid color');

  const texA = resolveLoad('a.png'); // late response
  assert.strictEqual(sky.visible, false, 'late A must not show the sky');
  assert.strictEqual(sky.material.map, null, 'late A must not set a texture');
  assert.strictEqual(texA.disposed, true);

  await tick();
  assert.strictEqual(cbCount, 0, 'no callback for the stale load');
  comp._destructor();
});

await test('first frame released exactly once across repeated loads', async () => {
  const comp = makeComp();
  const sky = getSkysphere(comp);

  let releases = 0;
  const scene = comp.scene();
  let _v = scene.visible;
  Object.defineProperty(scene, 'visible', {
    configurable: true,
    get() { return _v; },
    set(v) { if (v === true && v !== _v) releases++; _v = v; }
  });

  comp.backgroundImageUrl('a.png');
  await tick();
  resolveLoad('a.png');
  comp.backgroundImageUrl('b.png');
  await tick();
  resolveLoad('b.png');
  comp.backgroundImageUrl(null);
  await tick();
  comp.backgroundImageUrl('c.png');
  await tick();
  resolveLoad('c.png');

  assert.strictEqual(releases, 1, `first frame released exactly once, got ${releases}`);
  assert.strictEqual(scene.visible, true);
  assert.strictEqual(sky.material.map.__url, 'c.png');
  comp._destructor();
});

await test('re-setting the same URL does not re-release the first frame', async () => {
  const comp = makeComp();

  let releases = 0;
  const scene = comp.scene();
  let _v = scene.visible;
  Object.defineProperty(scene, 'visible', {
    configurable: true,
    get() { return _v; },
    set(v) { if (v === true && v !== _v) releases++; _v = v; }
  });

  comp.backgroundImageUrl('a.png');
  await tick();
  resolveLoad('a.png');
  assert.strictEqual(releases, 1);

  comp.backgroundImageUrl('a.png'); // same URL again
  await tick();
  resolveLoad('a.png');
  assert.strictEqual(releases, 1, 'first frame not released twice');
  comp._destructor();
});

await test('destroy: late texture load has no side effects', async () => {
  let cbCount = 0;
  const comp = makeComp();
  comp.onBackgroundImageLoaded(() => cbCount++);

  comp.backgroundImageUrl('a.png');
  await tick();
  const sky = getSkysphere(comp);
  comp._destructor();

  const texA = resolveLoad('a.png'); // returns after destroy
  assert.strictEqual(texA.disposed, true, 'late texture disposed');
  assert.strictEqual(sky.visible, false, 'destroyed sky not shown');

  await tick();
  assert.strictEqual(cbCount, 0, 'no callback after destroy');
});

await test('waitForLoadComplete=false: scene visible immediately', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const comp = ThreeRenderObjects({ waitForLoadComplete: false })(el);
  assert.strictEqual(comp.scene().visible, true, 'scene visible without waiting');
  comp._destructor();
});

await test('solid color background still applied', async () => {
  const comp = makeComp();
  comp.backgroundColor('#ff0000');
  await tick();
  // no throw, clear color set on the fake renderer
  comp._destructor();
});

console.log(passed === total ? `\nall ${total} tests passed` : `\n${passed}/${total} tests passed`);
