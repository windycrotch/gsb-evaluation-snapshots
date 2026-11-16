// Local verification sample for backgroundImageStatus / backgroundImageUrl behavior.
//
// Runs entirely offline: three.js and float-tooltip are replaced by controllable
// in-memory mocks (see ./mocks and ./register-hooks.mjs), so no real image is
// ever fetched. Texture loads are completed manually and out of order via
// resolveTextureLoad / rejectTextureLoad.
//
// Run with:
//   npm test
// or:
//   node --import ./test/register-hooks.mjs ./test/background-image.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal DOM globals (must exist before the module is imported) ----
function makeElement(tag = 'div') {
  return {
    tag,
    children: [],
    style: {},
    className: '',
    textContent: '',
    _eventListeners: {},
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    addEventListener(type, fn) {
      (this._eventListeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      this._eventListeners[type] = (this._eventListeners[type] || []).filter(cb => cb !== fn);
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0 };
    }
  };
}

const documentStub = {
  createElement: makeElement
};

globalThis.document = documentStub;
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  pageXOffset: 0,
  pageYOffset: 0,
  THREE: undefined // filled in below from the mocked three module
};
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);

// window.THREE must point at the same mock instance the kapsule module will see
const threeMock = await import('three');
globalThis.window.THREE = threeMock;

const {
  pendingTextureLoads,
  resolveTextureLoad,
  rejectTextureLoad
} = threeMock;

// Import the component under test (specifiers are redirected by register-hooks)
const { default: ThreeRenderObjects } = await import('../src/three-render-objects.js');

// ---- Helpers ----
const waitForDigest = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

function createInstance(options) {
  const node = makeElement();
  const instance = new ThreeRenderObjects(node, options);
  return { node, instance };
}

function getSkysphere(instance) {
  // The skysphere is the only scene mesh when no objects are added
  return instance.scene().children[0];
}

function latestLoad() {
  return pendingTextureLoads[pendingTextureLoads.length - 1];
}

function loadAt(indexFromEnd) {
  return pendingTextureLoads[pendingTextureLoads.length - 1 - indexFromEnd];
}

// ---- Tests ----
test('default status is idle and the skysphere is hidden', () => {
  const { instance } = createInstance();
  assert.equal(instance.backgroundImageStatus(), 'idle');
  assert.equal(getSkysphere(instance).visible, false);
});

test('external setter rejects values outside the four allowed statuses', () => {
  const { instance } = createInstance();
  instance.backgroundImageStatus('loading');
  assert.equal(instance.backgroundImageStatus(), 'loading');

  instance.backgroundImageStatus('bogus');
  assert.equal(instance.backgroundImageStatus(), 'loading'); // invalid value ignored

  instance.backgroundImageStatus('error');
  assert.equal(instance.backgroundImageStatus(), 'error');

  instance.backgroundImageStatus(null);
  assert.equal(instance.backgroundImageStatus(), 'error'); // invalid value ignored

  instance.backgroundImageStatus('idle'); // reset for subsequent assertions
  assert.equal(instance.backgroundImageStatus(), 'idle');
});

test('successful load: idle -> loading -> loaded, skysphere shown, load completed, callback fired', async () => {
  let callbackCount = 0;
  const { instance } = createInstance({ waitForLoadComplete: true });
  instance.onBackgroundImageLoaded(() => callbackCount++);

  assert.equal(instance.scene().visible, false); // first render is blocked

  instance.backgroundImageUrl('https://example.com/bg-success.png');
  assert.equal(instance.backgroundImageStatus(), 'loading');
  assert.equal(getSkysphere(instance).visible, false);

  await waitForDigest();
  const entry = latestLoad();
  assert.equal(entry.url, 'https://example.com/bg-success.png');
  assert.equal(entry.settled, false);

  resolveTextureLoad(entry);

  assert.equal(instance.backgroundImageStatus(), 'loaded');
  const skysphere = getSkysphere(instance);
  assert.equal(skysphere.visible, true);
  assert.equal(skysphere.material.map, entry.texture);
  assert.equal(entry.texture.colorSpace, threeMock.SRGBColorSpace);
  assert.equal(instance.scene().visible, true); // waitForLoadComplete released
  assert.equal(instance.backgroundImageUrl(), 'https://example.com/bg-success.png');

  // callback is triggered asynchronously
  await waitForDigest();
  assert.equal(callbackCount, 1);
});

test('failed load: idle -> loading -> error, skysphere stays hidden, no failed texture referenced, wait released', async () => {
  let callbackCount = 0;
  const { instance } = createInstance({ waitForLoadComplete: true });
  instance.onBackgroundImageLoaded(() => callbackCount++);

  assert.equal(instance.scene().visible, false);

  instance.backgroundImageUrl('https://example.com/bg-broken.png');
  assert.equal(instance.backgroundImageStatus(), 'loading');

  await waitForDigest();
  const entry = latestLoad();
  rejectTextureLoad(entry);

  assert.equal(instance.backgroundImageStatus(), 'error');
  const skysphere = getSkysphere(instance);
  assert.equal(skysphere.visible, false);
  assert.ok(skysphere.material === undefined || skysphere.material.map === null);
  assert.equal(instance.scene().visible, true); // first render must not stay blocked

  await waitForDigest();
  assert.equal(callbackCount, 0); // success-only callback never fires on error
});

test('out-of-order completion: only the latest URL result applies, stale late responses are ignored', async () => {
  let callbackCount = 0;
  const { instance } = createInstance();
  instance.onBackgroundImageLoaded(() => callbackCount++);

  instance.backgroundImageUrl('https://example.com/first.png');
  instance.backgroundImageUrl('https://example.com/second.png');
  assert.equal(instance.backgroundImageStatus(), 'loading');

  await waitForDigest();
  assert.equal(pendingTextureLoads.length >= 2, true);
  const first = loadAt(1);
  const second = latestLoad();
  assert.equal(first.url, 'https://example.com/first.png');
  assert.equal(second.url, 'https://example.com/second.png');

  // The newest request finishes first
  resolveTextureLoad(second);
  assert.equal(instance.backgroundImageStatus(), 'loaded');
  const skysphere = getSkysphere(instance);
  assert.equal(skysphere.visible, true);
  assert.equal(skysphere.material.map, second.texture);

  // The stale first request fails afterwards: must be fully ignored
  rejectTextureLoad(first);
  assert.equal(instance.backgroundImageStatus(), 'loaded');
  assert.equal(skysphere.visible, true);
  assert.equal(skysphere.material.map, second.texture);

  // And if the stale request had succeeded, it would be ignored too
  instance.backgroundImageUrl('https://example.com/third.png');
  await waitForDigest();
  const third = latestLoad();
  assert.equal(instance.backgroundImageStatus(), 'loading');

  // Re-fire the old first request's success handler late: it must not win
  const staleTexture = first.texture;
  first.onLoad(staleTexture);
  assert.equal(instance.backgroundImageStatus(), 'loading');
  assert.notEqual(skysphere.material.map, staleTexture);

  resolveTextureLoad(third);
  assert.equal(instance.backgroundImageStatus(), 'loaded');
  assert.equal(skysphere.material.map, third.texture);

  await waitForDigest();
  assert.equal(callbackCount, 2); // second and third only
});

test('setting an empty url resets to idle and hides the skysphere', async () => {
  const { instance } = createInstance();

  instance.backgroundImageUrl('https://example.com/bg.png');
  await waitForDigest();
  resolveTextureLoad(latestLoad());
  assert.equal(instance.backgroundImageStatus(), 'loaded');
  assert.equal(getSkysphere(instance).visible, true);

  instance.backgroundImageUrl(null);
  assert.equal(instance.backgroundImageStatus(), 'idle');
  const skysphere = getSkysphere(instance);
  assert.equal(skysphere.visible, false);
  assert.equal(skysphere.material.map, null);

  // empty string is treated the same way
  instance.backgroundImageUrl('https://example.com/bg2.png');
  await waitForDigest();
  resolveTextureLoad(latestLoad());
  assert.equal(instance.backgroundImageStatus(), 'loaded');

  instance.backgroundImageUrl('');
  assert.equal(instance.backgroundImageStatus(), 'idle');
  assert.equal(getSkysphere(instance).visible, false);
});

test('empty url while waiting for first load releases the render wait', () => {
  const { instance } = createInstance({ waitForLoadComplete: true });
  assert.equal(instance.scene().visible, false);

  instance.backgroundImageUrl('https://example.com/bg.png');
  instance.backgroundImageUrl(null); // cleared before anything loads

  assert.equal(instance.backgroundImageStatus(), 'idle');
  assert.equal(instance.scene().visible, true);
  assert.equal(getSkysphere(instance).visible, false);
});

test('in-flight request is ignored when the url is cleared before it settles', async () => {
  const { instance } = createInstance();

  instance.backgroundImageUrl('https://example.com/bg.png');
  await waitForDigest();
  const entry = latestLoad();

  instance.backgroundImageUrl(null);
  assert.equal(instance.backgroundImageStatus(), 'idle');

  // Late success from the superseded request
  resolveTextureLoad(entry);
  assert.equal(instance.backgroundImageStatus(), 'idle');
  assert.equal(getSkysphere(instance).visible, false);

  // Late failure from the superseded request is harmless too
  const { instance: instance2 } = createInstance();
  instance2.backgroundImageUrl('https://example.com/bg-other.png');
  await waitForDigest();
  const entry2 = latestLoad(); // load belonging to instance2 (the most recent one)
  instance2.backgroundImageUrl(null);
  rejectTextureLoad(entry2);
  assert.equal(instance2.backgroundImageStatus(), 'idle');
  assert.equal(getSkysphere(instance2).visible, false);
});

test('with waitForLoadComplete=false the scene is visible from the start, including after an error', async () => {
  const { instance } = createInstance({ waitForLoadComplete: false });
  assert.equal(instance.scene().visible, true);

  instance.backgroundImageUrl('https://example.com/bg-broken.png');
  await waitForDigest();
  rejectTextureLoad(latestLoad());

  assert.equal(instance.backgroundImageStatus(), 'error');
  assert.equal(instance.scene().visible, true);
  assert.equal(getSkysphere(instance).visible, false);
});
