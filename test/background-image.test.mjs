import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstance,
  flush,
  resetEnv,
  env,
  lastRenderer,
  window
} from './helpers/harness.mjs';

const skyOf = instance => instance.scene().children.find(c => c.type === 'Mesh');

after(() => window.close());

// --- Normal success path -------------------------------------------------------------------

test('loads image and applies it as the sky texture, firing onBackgroundImageLoaded once', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();

  assert.equal(env.loader.requests.length, 1, 'one image request issued');
  assert.equal(env.loader.requests[0].url, 'bg-a.png');

  const sky = skyOf(inst);
  assert.equal(sky.visible, false, 'sky hidden while loading');
  assert.equal(inst.scene().visible, false, 'scene hidden while loading (waitForLoadComplete default)');

  env.loader.requests[0].resolve();
  await flush();

  assert.equal(sky.visible, true, 'sky shown after load');
  assert.ok(sky.material.map, 'material has a map');
  assert.equal(sky.material.map.colorSpace, 'srgb', 'texture converted to sRGB');
  assert.equal(inst.scene().visible, true, 'scene revealed after load');
  assert.equal(loadedCount, 1, 'callback fired exactly once');

  inst._destructor();
});

// --- Baseline first-frame visibility -------------------------------------------------------

test('baseline: waitForLoadComplete=true keeps scene hidden until the first image resolves', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  await flush();

  assert.equal(inst.scene().visible, false, 'still hidden before resolve');

  env.loader.requests[0].resolve();
  await flush();

  assert.equal(inst.scene().visible, true, 'revealed once the async load finishes');

  inst._destructor();
});

test('baseline: waitForLoadComplete=true with no background image stays visible, as before', async () => {
  resetEnv();

  // The original implementation also revealed the scene on the first digest, because the
  // backgroundImageUrl prop counts as a changed prop and hits the "no url" branch.
  const inst = createInstance();
  await flush();

  assert.equal(inst.scene().visible, true);
  assert.equal(skyOf(inst).visible, false, 'no sky without an image url');

  inst._destructor();
});

test('baseline: waitForLoadComplete=false renders the scene immediately', async () => {
  resetEnv();

  const inst = createInstance({ waitForLoadComplete: false }, { backgroundImageUrl: 'bg-a.png' });
  await flush();

  assert.equal(inst.scene().visible, true, 'scene visible from the first frame');
  assert.equal(skyOf(inst).visible, false, 'sky still hidden until the image arrives');

  inst._destructor();
});

// --- Failure path --------------------------------------------------------------------------

test('load failure leaves the scene visible (no permanent black screen)', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'missing.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();
  env.loader.requests[0].fail();
  await flush();

  const sky = skyOf(inst);
  assert.equal(inst.scene().visible, true, 'scene recovered after failure');
  assert.equal(sky.visible, false, 'no sky shown');
  assert.equal(sky.material.map, null, 'no map left behind');
  assert.equal(loadedCount, 0, 'no load callback on failure');

  inst._destructor();
});

// --- Clearing path -------------------------------------------------------------------------

test('clearing the url during an in-flight load discards it and reveals the scene', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();
  const request = env.loader.requests[0];

  inst.backgroundImageUrl(null);
  await flush();

  assert.equal(inst.scene().visible, true, 'clearing the url must reveal the scene');

  request.resolve();
  await flush();

  assert.equal(loadedCount, 0, 'stale load callback dropped');
  assert.equal(skyOf(inst).visible, false, 'stale image not applied');
  assert.equal(request.texture.disposed, true, 'stale texture disposed');

  inst._destructor();
});

test('clearing an already-applied image releases its texture and hides the sky', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  await flush();

  const request = env.loader.requests[0];
  request.resolve();
  await flush();

  const appliedTexture = skyOf(inst).material.map;
  assert.ok(appliedTexture);

  inst.backgroundImageUrl(null);
  await flush();

  assert.equal(appliedTexture.disposed, true, 'previous texture disposed on clear');
  assert.equal(skyOf(inst).visible, false, 'sky hidden');
  assert.equal(skyOf(inst).material.map, null, 'map detached');
  assert.equal(inst.scene().visible, true, 'scene stays visible');

  inst._destructor();
});

// --- Switching path ------------------------------------------------------------------------

test('switching to a new url disposes the old texture before the new one arrives', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  await flush();
  env.loader.requests[0].resolve();
  await flush();

  const oldTexture = skyOf(inst).material.map;

  inst.backgroundImageUrl('bg-b.png');
  await flush();

  assert.equal(oldTexture.disposed, true, 'old texture released immediately on switch');
  assert.equal(skyOf(inst).visible, false, 'sky hidden until new image is ready');

  env.loader.requests[1].resolve();
  await flush();

  assert.equal(skyOf(inst).visible, true);
  assert.notEqual(skyOf(inst).material.map, oldTexture, 'new texture applied');

  inst._destructor();
});

// --- Concurrency ---------------------------------------------------------------------------

test('rapid consecutive switches: only the last image wins, earlier callbacks dropped', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-1.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();
  inst.backgroundImageUrl('bg-2.png');
  await flush();
  inst.backgroundImageUrl('bg-3.png');
  await flush();

  const [req1, req2, req3] = env.loader.requests;
  assert.deepEqual([req1.url, req2.url, req3.url], ['bg-1.png', 'bg-2.png', 'bg-3.png']);

  // Resolve out of order: the latest resolves first, then earlier stragglers.
  req3.resolve();
  await flush();
  req1.resolve();
  req2.resolve();
  await flush();

  assert.equal(loadedCount, 1, 'only the last image triggers the callback');
  assert.equal(req1.texture.disposed, true, 'stale image 1 disposed');
  assert.equal(req2.texture.disposed, true, 'stale image 2 disposed');
  assert.equal(req3.texture.disposed, false, 'winning image kept');
  assert.equal(skyOf(inst).material.map, req3.texture, 'only the last image is applied');
  assert.equal(inst.scene().visible, true);

  inst._destructor();
});

test('slow earlier response cannot override a faster later response', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-1.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();
  inst.backgroundImageUrl('bg-2.png');
  await flush();

  const [req1, req2] = env.loader.requests;

  req2.resolve();
  await flush();
  req1.resolve();
  await flush();

  assert.equal(loadedCount, 1, 'only the latest load reports completion');
  assert.equal(skyOf(inst).material.map, req2.texture, 'older response discarded');
  assert.equal(req1.texture.disposed, true);

  inst._destructor();
});

test('clearing the url after a failed load still yields a visible scene', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'missing.png' });
  await flush();
  env.loader.requests[0].fail();
  await flush();

  inst.backgroundImageUrl(null);
  await flush();

  assert.equal(inst.scene().visible, true);

  inst._destructor();
});

test('a deferred onBackgroundImageLoaded callback is dropped when a new url supersedes it', async () => {
  resetEnv();

  const calls = [];
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => calls.push('a'));

  await flush();
  // Resolve A: the component applies it and schedules the callback on a macrotask.
  env.loader.requests[0].resolve();

  // Before that deferred callback runs, switch to B.
  inst.backgroundImageUrl('bg-b.png');
  await flush();

  assert.deepEqual(calls, [], 'superseded load must not report completion');

  inst.onBackgroundImageLoaded(() => calls.push('b'));
  env.loader.requests[1].resolve();
  await flush();

  assert.deepEqual(calls, ['b'], 'only the latest image reports completion');

  inst._destructor();
});

// --- Teardown ------------------------------------------------------------------------------

test('_destructor drops pending image loads and suppresses callbacks and rendering', async () => {
  resetEnv();

  let loadedCount = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => loadedCount++);

  await flush();
  const request = env.loader.requests[0];
  const renderer = lastRenderer();

  inst._destructor();

  // Late arrival after teardown must be dropped entirely.
  request.resolve();
  await flush();

  assert.equal(loadedCount, 0, 'no callback after teardown');
  assert.equal(request.texture.disposed, true, 'late texture disposed');

  const rendersBefore = renderer.renderCount;
  inst.tick();
  assert.equal(renderer.renderCount, rendersBefore, 'no rendering after teardown');

  // Prop updates after teardown must not resurrect the scene either.
  inst.backgroundImageUrl('bg-b.png');
  await flush();
  assert.equal(env.loader.requests.length, 1, 'no new loads after teardown');
});
