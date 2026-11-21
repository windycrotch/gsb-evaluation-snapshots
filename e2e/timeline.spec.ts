import { test, expect, type Page, type TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { addObject, serveExport } from './helpers';

function twoClipGlb() {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4));
  const keys = Buffer.alloc(56);
  [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 3, 0, 0].forEach((value, i) => keys.writeFloatLE(value, i * 4));
  const binary = Buffer.concat([positions, keys]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'MovingMesh' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 }, { buffer: 0, byteOffset: 68, byteLength: 24 }
    ],
    buffers: [{ byteLength: binary.length }],
    animations: [2, 3].map((output, index) => ({ name: index ? 'Second' : 'First',
      samplers: [{ input: 1, output, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }))
  };
  const text = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.alloc(12);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length); jsonHeader.write('JSON', 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length); binHeader.write('BIN\0', 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

function silentWav(samples = 16000) {
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  return wave;
}

async function openExport(page: Page, testInfo: TestInfo) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('timeline-export');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
}

test('GLB clip sequence and attached sound persist and run in Play and export', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed ??= [];
      (window as Window & { timelinePlayed: HTMLMediaElement[] }).timelinePlayed.push(this);
      return original.call(this);
    };
  });
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({ name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: twoClipGlb() });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); } };");
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('GLB animation clip', { exact: true }).selectOption({ label: 'First' });
  await page.getByLabel('Play GLB animation').check();
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles({ name: 'timeline.wav', mimeType: 'audio/wav', buffer: silentWav(32000) });
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('timeline.wav', { exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Sounds' }).getByLabel('Play automatically').check();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('3');
  await page.getByLabel('Timeline trigger').selectOption('key');
  await page.getByLabel('Timeline key').fill('t');
  await expect(page.getByLabel('Timeline ruler')).toContainText('3.0s');
  await page.getByRole('button', { name: 'Add XYZ' }).click();
  for (const axis of ['x', 'y', 'z']) await expect(page.getByLabel(`position.${axis} keyframe track`)).toBeVisible();
  await page.getByLabel('Timeline GLB clip').selectOption({ label: 'First' });
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('Timeline GLB clip').selectOption({ label: 'Second' });
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('clip Second start').fill('0.5');
  await expect(page.getByText('GLB clips on the same model cannot overlap')).toBeVisible();
  await expect(page.getByLabel('clip Second start')).toHaveValue('1');
  const second = page.getByRole('button', { name: 'Drag clip Second' });
  await second.scrollIntoViewIfNeeded();
  const secondBox = await second.boundingBox();
  const railBox = await page.getByLabel('clip segment track').last().boundingBox();
  expect(secondBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox!.x + secondBox!.width / 2 + railBox!.width / 3, secondBox!.y + secondBox!.height / 2);
  await page.mouse.up();
  expect(Number(await page.getByLabel('clip Second start').inputValue())).toBeCloseTo(2, 1);
  await page.getByLabel('clip Second start').fill('2');
  await page.getByRole('button', { name: 'Add object sound' }).click();
  await page.getByLabel('sound timeline.wav start').fill('2');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('0.2');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const firstFrame = await page.locator('canvas').screenshot();
  await page.getByLabel('Timeline preview time').fill('2.5');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await page.locator('canvas').screenshot()).equals(firstFrame)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0)).toBe(0);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await expect(page.getByLabel('clip Second start')).toHaveValue('2');
  await expect(page.getByLabel('sound timeline.wav start')).toHaveValue('2');
  await page.reload();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByLabel('clip Second start')).toHaveValue('2');
  await expect(page.getByLabel('sound timeline.wav start')).toHaveValue('2');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const position = () => page.locator('body').getAttribute('data-clip-position').then(value => Number(value));
  await expect.poll(position).toBeCloseTo(0, 1);
  await page.keyboard.press('t');
  await expect.poll(position).toBeGreaterThan(0.25);
  await page.keyboard.press('t');
  await page.waitForTimeout(100);
  const paused = await position();
  await page.waitForTimeout(250);
  expect(await position()).toBeCloseTo(paused, 1);
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0)).toBe(0);
  await page.keyboard.press('t');
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0), { timeout: 6000, intervals: [30] }).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed: HTMLMediaElement[] }).timelinePlayed[0].paused), { intervals: [30] }).toBe(false);
  await page.keyboard.press('t');
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed: HTMLMediaElement[] }).timelinePlayed[0].paused), { intervals: [30] }).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0)).toBe(2);
  await expect.poll(position).toBeCloseTo(3, 1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect.poll(position, { timeout: 15000 }).toBeCloseTo(0, 1);
  await page.keyboard.press('t');
  await expect.poll(position, { timeout: 6000 }).toBeGreaterThan(2);
  await expect.poll(() => page.evaluate(() => (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0)).toBe(1);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('scrolling scrubs GLB sequences forward and backward', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({ name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: twoClipGlb() });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); } };");
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('2');
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('Timeline GLB clip').selectOption({ label: 'Second' });
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const position = () => page.locator('body').getAttribute('data-clip-position').then(value => Number(value));
  await expect.poll(position).toBeCloseTo(0, 1);
  const scroll = page.locator('.engine-web-scroll');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(position).toBeCloseTo(3, 1);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(position).toBeCloseTo(0, 1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect.poll(position, { timeout: 15000 }).toBeCloseTo(0, 1);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(position).toBeCloseTo(3, 1);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(position).toBeCloseTo(0, 1);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('removing an attached sound confirms and removes its timeline segments', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles({
    name: 'remove.wav', mimeType: 'audio/wav', buffer: silentWav()
  });
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('remove.wav', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Add object sound' }).click();
  await expect(page.getByLabel('sound remove.wav start')).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('region', { name: 'Sounds' }).getByRole('button', { name: 'Remove remove.wav' }).click();
  await expect(page.getByLabel('sound remove.wav start')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('region', { name: 'Sounds' }).getByRole('button', { name: 'Remove remove.wav' }).click();
  await expect(page.getByLabel('sound remove.wav start')).toHaveCount(0);
});

test('camera timeline toggles from keyboard, survives reload and runs in export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.cameraX = String(camera.position.x); camera.position.x = 99; } };");
  await addObject(page, 'Camera');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption({ label: 'Camera' });
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('3');
  await page.getByLabel('Timeline trigger').selectOption('key');
  await page.getByLabel('Timeline key').fill('t');
  await page.getByLabel('Timeline channel').selectOption('position.x');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('position.x keyframe value').last().fill('5');
  await expect(page.getByLabel('position.x keyframe track').getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('1.5');
  const previewExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const previewZip = await JSZip.loadAsync(await readFile((await (await previewExport).path())!));
  const previewData = JSON.parse(await previewZip.file('scene.json')!.async('string')) as {
    objects: { type: string; properties: { position: number[] } }[];
  };
  expect(previewData.objects.find(item => item.type === 'camera')!.properties.position[0]).toBe(0);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByLabel('Timeline trigger')).toHaveValue('key');
  await expect(page.getByLabel('position.x keyframe value').last()).toHaveValue('5');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-camera-x'))).toBeCloseTo(0, 1);
  await page.keyboard.press('t');
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-camera-x'))).toBeGreaterThan(0.5);
  await page.keyboard.press('t');
  await page.waitForTimeout(100);
  const paused = Number(await page.locator('body').getAttribute('data-camera-x'));
  await page.waitForTimeout(250);
  expect(Number(await page.locator('body').getAttribute('data-camera-x'))).toBeCloseTo(paused, 1);
  await page.keyboard.press('t');
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-camera-x')), { timeout: 5000 }).toBeCloseTo(5, 1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect(page.locator('#load-error')).toBeHidden({ timeout: 15000 });
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-camera-x'))).toBeCloseTo(0, 1);
  await page.keyboard.press('t');
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-camera-x')), { timeout: 5000 }).toBeCloseTo(5, 1);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('keyframe easing controls preview, scroll playback and exported animation', async ({ page }, testInfo) => {
  await page.goto('/');
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
  }
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Eased heading');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await page.getByLabel('Timeline channel').selectOption('web.opacity');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('web.opacity keyframe value').first().fill('0');
  const easing = page.getByLabel('web.opacity keyframe easing at 0 seconds');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('1.25');
  const heading = page.getByRole('heading', { name: 'Eased heading' });
  for (const [mode, expected] of [['linear', 0.25], ['ease-in', 0.0625], ['ease-out', 0.4375], ['smooth', 0.15625]] as const) {
    await easing.selectOption(mode);
    await expect.poll(async () => Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(expected, 3);
  }
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const checkScroll = async () => {
    await page.locator('.engine-web-scroll').evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.25; });
    await expect.poll(async () => Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeCloseTo(0.15625, 2);
  };
  await checkScroll();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect(heading).toBeVisible({ timeout: 15000 });
  await checkScroll();
  await expect(page.locator('#load-error')).toBeHidden();
});

test('timeline device values adapt 3D and web channels in Play and export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
  }
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.deviceX = String(object.position.x); document.body.dataset.deviceRotation = String(object.rotation.y); } };");
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await page.getByLabel('Timeline channel').selectOption('position.x');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('position.x keyframe value').last().fill('8');
  await page.getByLabel('Timeline device').selectOption('tablet');
  await page.getByLabel('position.x keyframe value').last().fill('16');
  await page.getByLabel('Timeline device').selectOption('mobile');
  await page.getByLabel('position.x keyframe value').last().fill('24');
  await page.getByLabel('Timeline device').selectOption('desktop');
  await page.getByLabel('Timeline channel').selectOption('rotation.y');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('rotation.y keyframe value').last().fill('30');
  await page.getByLabel('Timeline device').selectOption('tablet');
  await page.getByLabel('rotation.y keyframe value').last().fill('60');
  await page.getByLabel('Timeline device').selectOption('mobile');
  await page.getByLabel('rotation.y keyframe value').last().fill('90');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Device heading');
  await page.getByLabel('Timeline channel').selectOption('web.opacity');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('web.opacity keyframe value').last().fill('0.6');
  await page.getByLabel('Timeline device').selectOption('tablet');
  await page.getByLabel('web.opacity keyframe value').last().fill('0.8');
  await page.getByLabel('Reset web.opacity tablet value at 5 seconds').click();
  await expect(page.getByLabel('web.opacity keyframe value').last()).toHaveValue('1');
  await page.getByLabel('web.opacity keyframe value').last().fill('0.8');
  await page.getByLabel('Timeline device').selectOption('desktop');
  await expect(page.getByLabel('web.opacity keyframe value').last()).toHaveValue('1');
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        resolve(read.result?.currentScene.sceneOptions.timeline?.tracks.find((track: { property: string }) =>
          track.property === 'rotation.y')?.keyframes[1]?.deviceValues?.mobile);
        database.close();
      };
    };
  }))).toBe(90);
  await page.reload();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('5');
  const heading = page.getByRole('heading', { name: 'Device heading' });
  await page.getByLabel('Timeline device').selectOption('mobile');
  await expect(heading).toHaveCSS('opacity', '0.6');
  await page.getByLabel('Timeline device').selectOption('tablet');
  await expect(heading).toHaveCSS('opacity', '0.8');
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  async function checkDevices() {
    for (const [width, position, degrees, opacity] of [[1025, 8, 30, 1], [1024, 16, 60, 0.8],
      [768, 16, 60, 0.8], [767, 24, 90, 0.6], [1280, 8, 30, 1]] as const) {
      await page.setViewportSize({ width, height: 720 });
      await page.locator('.engine-web-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect.poll(async () => Number(await page.locator('body').getAttribute('data-device-x'))).toBeCloseTo(position, 1);
      await expect.poll(async () => Number(await page.locator('body').getAttribute('data-device-rotation'))).toBeCloseTo(degrees * Math.PI / 180, 1);
      await expect(heading).toHaveCSS('opacity', String(opacity));
    }
  }
  await checkDevices();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect(heading).toBeVisible({ timeout: 15000 });
  await checkDevices();
  await expect(page.locator('#load-error')).toBeHidden();
});

test('page scroll drives a web opacity timeline in Play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
  }
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Timeline heading');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await page.getByLabel('Timeline channel').selectOption('web.opacity');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('web.opacity keyframe value').first().fill('0');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Timeline preview time').fill('2.5');
  await expect(page.getByRole('heading', { name: 'Timeline heading' })).toHaveCSS('opacity', '0.5');
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Timeline heading' })).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Timeline heading' });
  await expect(heading).toHaveCSS('opacity', '0');
  await page.locator('.engine-web-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(heading).toHaveCSS('opacity', '1');
  await page.locator('.engine-web-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(heading).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect(heading).toHaveCSS('opacity', '0', { timeout: 15000 });
  await page.locator('.engine-web-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(heading).toHaveCSS('opacity', '1');
  await expect(page.locator('#load-error')).toBeHidden();
});

test('dragged keyframes persist and deleting a target removes its channel', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Add channel' }).click();
  const track = page.getByLabel('position.x keyframe track');
  const rectangle = await track.boundingBox();
  expect(rectangle).not.toBeNull();
  const keyframe = page.getByRole('button', { name: 'Drag position.x keyframe at 0 seconds' });
  const keyRect = await keyframe.boundingBox();
  expect(keyRect).not.toBeNull();
  await page.mouse.move(keyRect!.x + keyRect!.width / 2, keyRect!.y + keyRect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rectangle!.x + rectangle!.width / 2, rectangle!.y + rectangle!.height / 2);
  await page.mouse.up();
  await expect(page.getByLabel('position.x keyframe time').first()).toHaveValue('2.5');
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').first().fill('7');
  await page.getByRole('button', { name: 'Capture position.x at 2.5 seconds' }).click();
  await expect(page.getByLabel('position.x keyframe value').first()).toHaveValue('7');
  await page.reload();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByLabel('position.x keyframe time').first()).toHaveValue('2.5');
  await expect(page.getByLabel('position.x keyframe value').first()).toHaveValue('7');
  await page.getByRole('button', { name: 'In Scene', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByText('Select an object and add a channel.')).toBeVisible();
});

test('timeline plays web audio in Play and in the exported player', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web audio' }).click();
  await page.getByLabel('Web audio', { exact: true }).setInputFiles({ name: 'sound.wav', mimeType: 'audio/wav', buffer: silentWav(40000) });
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('0.5');
  await page.getByLabel('Timeline trigger').selectOption('key');
  await page.getByLabel('Timeline key').fill('t');
  await page.getByLabel('Timeline channel').selectOption('media');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('media keyframe value').last().fill('1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const audio = page.locator('.engine-web-node[data-kind="audio"]');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused), { timeout: 15000 }).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('timeline plays web video in Play and in the exported player', async ({ page }, testInfo) => {
  await page.goto('/');
  const data = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    for (let frame = 0; frame < 8; frame++) {
      canvas.getContext('2d')!.fillRect(frame, 0, 4, 4);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop();
    const blob = await finished;
    stream.getTracks().forEach(track => track.stop());
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  });
  await page.getByRole('button', { name: 'Add web video' }).click();
  await page.getByLabel('Web video', { exact: true }).setInputFiles({
    name: 'timeline.webm', mimeType: 'video/webm', buffer: Buffer.from(data.split(',')[1], 'base64')
  });
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('0.5');
  await page.getByLabel('Timeline trigger').selectOption('key');
  await page.getByLabel('Timeline key').fill('t');
  await page.getByLabel('Timeline channel').selectOption('media');
  await page.getByRole('button', { name: 'Add channel' }).click();
  await page.getByLabel('media keyframe value').last().fill('1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const video = page.locator('.engine-web-node[data-kind="video"]');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused), { timeout: 15000 }).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('#load-error')).toBeHidden();
});
