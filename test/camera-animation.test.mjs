import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstance,
  flush,
  resetEnv,
  advance,
  env,
  lastRenderer,
  window
} from './helpers/harness.mjs';

after(() => window.close());

// Helper: run frames at a fixed step until `predicate()` is true or the budget runs out.
const runFrames = (inst, stepMs, frames) => {
  for (let i = 0; i < frames; i++) {
    advance(stepMs);
    inst.tick();
  }
};

const approxEqual = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertPos = (actual, expected, msg) => {
  ['x', 'y', 'z'].forEach(dim => {
    assert.ok(
      approxEqual(actual[dim], expected[dim]),
      `${msg}: ${dim} expected ${expected[dim]}, got ${actual[dim]}`
    );
  });
};

test('cameraPosition without duration moves immediately', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 0 });
  assertPos(inst.cameraPosition(), { x: 10, y: 20, z: 30 }, 'immediate');

  inst._destructor();
});

test('animated cameraPosition reaches its target', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 300);
  runFrames(inst, 100, 5);

  assertPos(inst.cameraPosition(), { x: 100, y: 0, z: 0 }, 'after animation');

  inst._destructor();
});

test('a new cameraPosition during an animation stops the old one; final pose is the last call', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
  runFrames(inst, 100, 2); // start moving towards 1000

  const mid = inst.cameraPosition();
  assert.ok(mid.x > 0 && mid.x < 1000, `expected mid-animation x, got ${mid.x}`);

  // Interrupt with a different destination
  inst.cameraPosition({ x: 0, y: 500, z: 0 }, { x: 0, y: 0, z: 0 }, 500);

  // Advance well past BOTH the old and the new duration.
  runFrames(inst, 100, 15);

  assertPos(inst.cameraPosition(), { x: 0, y: 500, z: 0 }, 'final pose reflects the last call');

  inst._destructor();
});

test('interrupting an animation does not snap the camera to the abandoned target', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
  runFrames(inst, 100, 2);

  const mid = inst.cameraPosition();
  assert.ok(mid.x > 0 && mid.x < 1000, `expected to be mid-flight, got x=${mid.x}`);

  inst.cameraPosition({ x: 0, y: 500, z: 0 }, { x: 0, y: 0, z: 0 }, 500);

  // The new tween starts from wherever the camera is, so it must not jump to the old target.
  const afterInterrupt = inst.cameraPosition();
  assert.ok(
    approxEqual(afterInterrupt.x, mid.x, 1e-3),
    `camera should continue from its mid-flight position (${mid.x}), not jump to ${afterInterrupt.x}`
  );

  inst._destructor();
});

test('fitToBbox during a camera animation cancels it; final camera fits the bbox', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  const bbox = { x: [-10, 10], y: [-10, 10], z: [-10, 10] };

  // Start a long camera move far away
  inst.cameraPosition({ x: 5000, y: 5000, z: 5000 }, { x: 0, y: 0, z: 0 }, 2000);
  runFrames(inst, 100, 2);

  inst.fitToBbox(bbox, 400);
  runFrames(inst, 100, 20);

  const cam = inst.cameraPosition();
  const camera = inst.camera();
  const forward = camera.getWorldDirection(new (await import('three')).Vector3());

  // The camera should end up looking straight at the bbox center (the interrupted animation
  // was heading to (5000,5000,5000), so this also proves the old tween was dropped).
  const toCenter = { x: -cam.x, y: -cam.y, z: -cam.z };
  const toCenterLen = Math.hypot(toCenter.x, toCenter.y, toCenter.z);
  assert.ok(toCenterLen > 0, 'camera must not sit on the bbox center');
  const alignment =
    (forward.x * toCenter.x + forward.y * toCenter.y + forward.z * toCenter.z) / toCenterLen;
  assert.ok(alignment > 0.999, `camera should face the bbox center, alignment=${alignment}`);

  const dist = Math.hypot(cam.x, cam.y, cam.z);
  assert.ok(dist > 0 && dist < 5000, `camera should have zoomed in, distance=${dist}`);

  inst._destructor();
});

test('zoomToFit during an animation supersedes it and frames the objects', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  const { Mesh, BoxGeometry, MeshBasicMaterial } = await import('three');
  const obj = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial());
  inst.objects([obj]);
  await flush();

  inst.cameraPosition({ x: -4000, y: 4000, z: -4000 }, { x: 0, y: 0, z: 0 }, 1500);
  runFrames(inst, 100, 2);

  inst.zoomToFit(300, 10);
  runFrames(inst, 100, 20);

  const cam = inst.cameraPosition();
  const dist = Math.hypot(cam.x, cam.y, cam.z);
  assert.ok(dist > 0 && dist < 4000, `zoomToFit should have brought the camera close, distance=${dist}`);

  inst._destructor();
});

test('several rapid cameraPosition calls: only the last one determines the final pose', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 100, y: 0, z: 0 }, null, 800);
  runFrames(inst, 50, 2);
  inst.cameraPosition({ x: 0, y: 200, z: 0 }, null, 800);
  runFrames(inst, 50, 2);
  inst.cameraPosition({ x: 0, y: 0, z: 300 }, null, 800);

  runFrames(inst, 50, 40);

  assertPos(inst.cameraPosition(), { x: 0, y: 0, z: 300 }, 'last call wins');

  inst._destructor();
});

test('an immediate cameraPosition during an animation snaps and cancels the tween', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 1000, y: 1000, z: 1000 }, null, 1000);
  runFrames(inst, 100, 2);

  inst.cameraPosition({ x: 7, y: 8, z: 9 }); // no duration

  // Even after enough time for the original tween to have completed, the camera must not move.
  runFrames(inst, 100, 20);

  assertPos(inst.cameraPosition(), { x: 7, y: 8, z: 9 }, 'immediate call is not overridden by the old tween');

  inst._destructor();
});

test('no camera update or render happens after _destructor', async () => {
  resetEnv();
  const inst = createInstance();
  await flush();

  inst.cameraPosition({ x: 1000, y: 0, z: 0 }, null, 500);
  runFrames(inst, 100, 1);

  const renderer = lastRenderer();
  inst._destructor();

  const rendersBefore = renderer.renderCount;
  const poseBefore = inst.cameraPosition();
  runFrames(inst, 100, 10);

  assert.equal(renderer.renderCount, rendersBefore, 'no render after teardown');
  assertPos(inst.cameraPosition(), poseBefore, 'camera frozen after teardown');

  // Camera setters after teardown are inert
  inst.cameraPosition({ x: 1, y: 2, z: 3 });
  assertPos(inst.cameraPosition(), poseBefore, 'camera setters inert after teardown');
});
