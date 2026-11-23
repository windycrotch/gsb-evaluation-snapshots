// Baseline comparison: the pre-change implementation is kept as a fixture and run through the
// same harness. These tests document the behavioural contract of the fixes and fail against
// the old code, which is what makes the other tests meaningful as regressions.
//
// Run: node --test test/baseline-comparison.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstance,
  flush,
  resetEnv,
  env,
  importImplementation,
  advance,
  window
} from './helpers/harness.mjs';

after(() => window.close());

const Original = await importImplementation('../../test/fixtures/original-three-render-objects.js');
const Fixed = await importImplementation('../../src/three-render-objects.js');

const skyOf = inst => inst.scene().children.find(c => c.type === 'Mesh');

const runFrames = (inst, stepMs, frames) => {
  for (let i = 0; i < frames; i++) {
    advance(stepMs);
    inst.tick();
  }
};

test('BASELINE: original implementation lets an older image win the race', async () => {
  resetEnv();
  const inst = createInstance({}, { backgroundImageUrl: 'a.png' }, Original);
  await flush();
  inst.backgroundImageUrl('b.png');
  await flush();

  const [a, b] = env.loader.requests;
  b.resolve();
  await flush();
  a.resolve();
  await flush();

  assert.notEqual(skyOf(inst).material.map, b.texture, 'old code: latest texture is overwritten by stale one');
  assert.equal(a.texture.disposed, false, 'old code: stale texture leaks');

  inst._destructor();
});

test('BASELINE: original implementation fires every completion callback', async () => {
  resetEnv();
  let count = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'a.png' }, Original);
  inst.onBackgroundImageLoaded(() => count++);
  await flush();
  inst.backgroundImageUrl('b.png');
  await flush();

  env.loader.requests[0].resolve();
  env.loader.requests[1].resolve();
  await flush();

  assert.ok(count > 1, `old code: fired ${count} times`);

  inst._destructor();
});

test('BASELINE: original implementation applies a stale image after the url was cleared', async () => {
  resetEnv();
  const inst = createInstance({}, { backgroundImageUrl: 'a.png' }, Original);
  await flush();
  inst.backgroundImageUrl(null);
  await flush();
  env.loader.requests[0].resolve();
  await flush();

  assert.equal(skyOf(inst).visible, true, 'old code: stale image becomes visible after clear');

  inst._destructor();
});

test('BASELINE: original implementation snaps to the abandoned target when interrupted', async () => {
  resetEnv();
  const inst = createInstance({}, {}, Original);
  await flush();

  inst.cameraPosition({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
  runFrames(inst, 100, 2);

  const mid = inst.cameraPosition();
  inst.cameraPosition({ x: 0, y: 500, z: 0 }, { x: 0, y: 0, z: 0 }, 500);

  assert.ok(
    Math.abs(inst.cameraPosition().x - mid.x) > 1,
    'old code: end() snapped the camera to the old destination'
  );

  inst._destructor();
});

test('BASELINE: original implementation renders after teardown', async () => {
  resetEnv();
  const inst = createInstance({}, { backgroundImageUrl: 'a.png' }, Original);
  await flush();

  inst._destructor();
  const rendersBefore = env.renderers.at(-1).renderCount;
  inst.tick();

  assert.ok(env.renderers.at(-1).renderCount > rendersBefore, 'old code: tick still renders after teardown');
});

// Sanity check that the same harness passes these expectations against the fixed build.
test('FIXED: latest image wins, callback once, stale texture disposed', async () => {
  resetEnv();
  let count = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'a.png' }, Fixed);
  inst.onBackgroundImageLoaded(() => count++);
  await flush();
  inst.backgroundImageUrl('b.png');
  await flush();

  const [a, b] = env.loader.requests;
  b.resolve();
  await flush();
  a.resolve();
  await flush();

  assert.equal(count, 1);
  assert.equal(skyOf(inst).material.map, b.texture);
  assert.equal(a.texture.disposed, true);

  inst._destructor();
});
