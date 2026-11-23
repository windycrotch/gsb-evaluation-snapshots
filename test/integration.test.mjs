import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstance,
  flush,
  resetEnv,
  env,
  advance,
  window
} from './helpers/harness.mjs';

after(() => window.close());

const skyOf = inst => inst.scene().children.find(c => c.type === 'Mesh');

const runFrames = (inst, stepMs, frames) => {
  for (let i = 0; i < frames; i++) {
    advance(stepMs);
    inst.tick();
  }
};

test('background load and an animated zoomToFit in the same session stay consistent', async () => {
  resetEnv();

  const { Mesh, BoxGeometry, MeshBasicMaterial } = await import('three');

  let loaded = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => loaded++);

  const obj = new Mesh(new BoxGeometry(40, 40, 40), new MeshBasicMaterial());
  inst.objects([obj]);
  await flush();

  // Fit while the image is still loading
  inst.zoomToFit(400, 10);
  runFrames(inst, 100, 10);

  // Scene is still waiting on the image, so it remains hidden, but the camera fit has run.
  assert.equal(inst.scene().visible, false, 'still waiting for the background image');
  const camBeforeLoad = inst.cameraPosition();
  const distBefore = Math.hypot(camBeforeLoad.x, camBeforeLoad.y, camBeforeLoad.z);
  assert.ok(distBefore > 0 && distBefore < 1000, `camera fitted despite pending image, dist=${distBefore}`);

  // Image arrives: the scene becomes visible and shows the correct texture, camera unchanged.
  env.loader.requests[0].resolve();
  await flush();

  assert.equal(inst.scene().visible, true);
  assert.equal(skyOf(inst).visible, true);
  assert.equal(skyOf(inst).material.map, env.loader.requests[0].texture);
  assert.equal(loaded, 1);

  const camAfterLoad = inst.cameraPosition();
  assert.ok(Math.abs(camAfterLoad.x - camBeforeLoad.x) < 1e-6, 'image load must not disturb the camera pose');

  inst._destructor();
});

test('fitting again after the image arrives respects the interrupted camera animation', async () => {
  resetEnv();

  const { Mesh, BoxGeometry, MeshBasicMaterial } = await import('three');
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });

  const obj = new Mesh(new BoxGeometry(100, 100, 100), new MeshBasicMaterial());
  inst.objects([obj]);
  await flush();

  env.loader.requests[0].resolve();
  await flush();

  // Long camera flight, then a fit mid-flight
  inst.cameraPosition({ x: 3000, y: 3000, z: 3000 }, { x: 0, y: 0, z: 0 }, 1000);
  runFrames(inst, 100, 2);
  inst.zoomToFit(300, 10);
  runFrames(inst, 100, 20);

  const cam = inst.cameraPosition();
  const dist = Math.hypot(cam.x, cam.y, cam.z);
  assert.ok(dist > 0 && dist < 2000, `final camera should frame the object, dist=${dist}`);
  assert.equal(skyOf(inst).visible, true, 'background stays applied');

  inst._destructor();
});

test('several url changes within one digest coalesce into a single request for the final url', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'bg-1.png' });

  // Synchronous burst, before the debounced update runs
  inst.backgroundImageUrl('bg-2.png');
  inst.backgroundImageUrl('bg-3.png');
  inst.backgroundImageUrl('bg-4.png');

  await flush();

  assert.equal(env.loader.requests.length, 1, 'only the final url is requested');
  assert.equal(env.loader.requests[0].url, 'bg-4.png');

  inst._destructor();
});

test('destroying mid camera-animation stops it and fires nothing afterwards', async () => {
  resetEnv();

  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  await flush();

  let loaded = 0;
  inst.onBackgroundImageLoaded(() => loaded++);

  inst.cameraPosition({ x: 1000, y: 0, z: 0 }, null, 500);
  runFrames(inst, 100, 1);

  const poseAtDestroy = inst.cameraPosition();
  inst._destructor();

  runFrames(inst, 100, 20);

  const poseNow = inst.cameraPosition();
  assert.ok(Math.abs(poseNow.x - poseAtDestroy.x) < 1e-6, 'animation halted at teardown');
  assert.equal(loaded, 0, 'no load callback after teardown');
});

test('destroying during load does not fire the background callback on late resolve', async () => {
  resetEnv();

  let loaded = 0;
  const inst = createInstance({}, { backgroundImageUrl: 'bg-a.png' });
  inst.onBackgroundImageLoaded(() => loaded++);
  await flush();

  // Resolve so the deferred callback gets scheduled, then destroy before it can run.
  env.loader.requests[0].resolve();
  inst._destructor();
  await flush();

  assert.equal(loaded, 0, 'scheduled callback cancelled by teardown');
  assert.equal(env.loader.requests[0].texture.disposed, true, 'applied texture disposed at teardown');
});
