import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build, createServer } from 'vite';
import { addObject, serveExport } from './helpers';

function triangleGlb(animated = false) {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4));
  const animationData = Buffer.alloc(32);
  [0, 1, 0, 0, 0, 1, 0, 0].forEach((value, i) => animationData.writeFloatLE(value, i * 4));
  const binary = animated ? Buffer.concat([positions, animationData]) : positions;
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'MovingMesh' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
      ...(animated ? [{ bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' }] : [])
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length },
      ...(animated ? [{ buffer: 0, byteOffset: 36, byteLength: 8 }, { buffer: 0, byteOffset: 44, byteLength: 24 }] : [])],
    buffers: [{ byteLength: binary.length }],
    ...(animated ? { animations: [{ name: 'Move', samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] } : {})
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

function silentWav() {
  const samples = 16000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

const model = { name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: triangleGlb() };
const texture = {
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
};
const sound = { name: 'tone.wav', mimeType: 'audio/wav', buffer: silentWav() };

test('all export formats package library and multi-scene media as files and load them over HTTP', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  const unused = { name: 'unused.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') };
  const duplicateName = { ...unused, buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>') };
  await page.goto('/');
  await page.getByLabel('Upload assets').setInputFiles([model, texture, sound, unused, duplicateName]);
  await expect(page.getByRole('button', { name: 'Add unused.svg to scene' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Add triangle.glb to scene' }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(texture);
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles(sound);
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Add web image' }).click();
  await page.getByLabel('Web image', { exact: true }).setInputFiles(texture);
  await page.getByRole('button', { name: 'Add web audio' }).click();
  await page.getByLabel('Web audio', { exact: true }).setInputFiles(sound);

  for (const format of ['html', 'react', 'wordpress'] as const) {
    await page.getByLabel('Export format').selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
    const prefix = format === 'html' ? '' : format === 'react' ? 'public/scene/' : 'three-scene-export/scene/';
    const scene = JSON.parse(await zip.file(`${prefix}scene.json`)!.async('string')) as {
      assets: { name: string; url: string }[];
      objects: { properties: { web?: { image?: string; audio?: string } } }[];
      otherScenes: { objects: { properties: { modelData?: string; map?: string; sounds?: { url: string }[] } }[] }[];
    };
    const byName = (name: string) => scene.assets.find(asset => asset.name === name)!.url;
    for (const item of [model, texture, sound, unused]) {
      const path = byName(item.name);
      expect(path).toMatch(/^web3dassets\//);
      expect(await zip.file(prefix + path)!.async('nodebuffer')).toEqual(item.buffer);
    }
    const duplicates = scene.assets.filter(asset => asset.name === unused.name);
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].url).not.toBe(duplicates[1].url);
    expect(await zip.file(prefix + duplicates[1].url)!.async('nodebuffer')).toEqual(duplicateName.buffer);
    const imported = scene.otherScenes[0].objects[0].properties;
    expect(imported.modelData).toBe(byName(model.name));
    expect(imported.map).toBe(byName(texture.name));
    expect(imported.sounds![0].url).toBe(byName(sound.name));
    expect(scene.objects[0].properties.web!.image).toBe(byName(texture.name));
    expect(scene.objects[1].properties.web!.audio).toBe(byName(sound.name));
    expect(await zip.file(`${prefix}scene.js`)!.async('string')).not.toContain('data:image/png;base64,');
    const root = testInfo.outputPath(`asset-${format}`);
    await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(async file => {
      const path = join(root, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await file.async('nodebuffer'));
    }));
    const server = await createServer({
      configFile: false, root: format === 'react' ? root : format === 'wordpress' ? join(root, 'three-scene-export') : root,
      logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }
    });
    const player = await context.newPage();
    try {
      const externalRequests: string[] = [];
      await player.route('https://**', route => {
        externalRequests.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Export test server failed to start');
      const base = `http://127.0.0.1:${address.port}/`;
      await player.goto(base + (format === 'wordpress' ? 'scene/index.html' : ''));
      const frame = format === 'react' ? player.frameLocator('iframe[title="3D scene"]') : player;
      const image = frame.locator('.engine-web-node[data-kind="image"]');
      await expect(image).toHaveAttribute('src', byName(texture.name), { timeout: 15000 });
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
      const audio = frame.locator('.engine-web-node[data-kind="audio"]');
      await expect(audio).toHaveAttribute('src', byName(sound.name));
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
      const modelPage = await context.newPage();
      try {
        await modelPage.route('https://**', route => {
          externalRequests.push(route.request().url());
          return route.abort('internetdisconnected');
        });
        await modelPage.goto(base + (format === 'html' ? '' : 'scene/') + 'scene-1.html');
        await expect.poll(() => modelPage.evaluate(() => Function('return sceneObjects.length')() as number), { timeout: 15000 }).toBe(1);
        await expect(modelPage.locator('#load-error')).toBeHidden();
        const rendered = await modelPage.evaluate(() => Function(`let mesh;
          sceneObjects[0].object.traverse(child => { if (child.isMesh) mesh = child; });
          return { vertices: mesh.geometry.attributes.position.count, textureWidth: mesh.material.map.image.width };`)() as { vertices: number; textureWidth: number });
        expect(rendered).toEqual({ vertices: 3, textureWidth: 1 });
        expect(externalRequests).toEqual([]);
      } finally {
        await modelPage.close();
      }
    } finally {
      await player.close();
      await server.close();
    }
  }
});

test('transparent image planes leave the 3D scene visible in play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Upload assets').setInputFiles({ name: 'clear.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: 'Add clear.png to scene' }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').nth(2).fill('2');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Toggle image');
  await page.getByLabel('Web script').fill(`return { click() {
    const plane = scene.getObjectByName('clear.png');
    plane.visible = !plane.visible;
    element.dataset.visible = String(plane.visible);
  } };`);
  const compareCanvas = async () => {
    const before = (await page.locator('canvas').screenshot()).toString('base64');
    await page.getByRole('button', { name: 'Toggle image' }).click();
    await expect(page.getByRole('button', { name: 'Toggle image' })).toHaveAttribute('data-visible', 'false');
    const after = (await page.locator('canvas').screenshot()).toString('base64');
    const difference = await page.evaluate(async ([a, b]) => {
      const read = async (value: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${value}`)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const first = await read(a);
      const second = await read(b);
      let total = 0;
      for (let index = 0; index < first.length; index++) total += Math.abs(first[index] - second[index]);
      return total / first.length;
    }, [before, after]);
    expect(difference).toBeLessThan(0.5);
  };
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await compareCanvas();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('transparent-plane');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.getByRole('button', { name: 'Toggle image' })).toBeVisible();
  await compareCanvas();
  await expect(page.locator('#load-error')).toBeHidden();
});

test('React and WordPress exports retain GLB animation and web scene transitions', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('GLB finished');
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.locator('#model-upload').setInputFiles({
    name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: triangleGlb(true)
  });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('GLB animation clip', { exact: true }).selectOption({ label: 'Move' });
  await page.getByLabel('GLB completion scene').selectOption({ label: 'Scene 2 / Page 2' });
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Start clip');
  await page.getByLabel('Web action').selectOption('playClip');
  await page.getByLabel('Web action target').selectOption({ label: 'animated' });
  await page.getByLabel('Web action clip').selectOption({ label: 'Move' });

  for (const format of ['react', 'wordpress'] as const) {
    await page.getByLabel('Export format').selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
    const root = testInfo.outputPath(format);
    await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(async file => {
      const path = join(root, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await file.async('nodebuffer'));
    }));
    if (format === 'wordpress') {
      expect(await zip.file('three-scene-export/three-scene-export.php')!.async('string')).toContain("add_shortcode('three_scene'");
    }
    const server = await createServer({
      configFile: false, root: format === 'react' ? root : join(root, 'three-scene-export'),
      logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }
    });
    const player = await context.newPage();
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Export test server failed to start');
      await player.goto(`http://127.0.0.1:${address.port}/${format === 'react' ? '' : 'scene/index.html'}`);
      const scene = format === 'react' ? player.frameLocator('iframe[title="3D scene"]') : player;
      await expect(scene.locator('canvas')).toBeVisible({ timeout: 15000 });
      await scene.getByRole('button', { name: 'Start clip' }).click();
      await expect(scene.getByRole('heading', { name: 'GLB finished' })).toBeVisible({ timeout: 15000 });
      await expect(scene.locator('#load-error')).toBeHidden();
    } finally {
      await player.close();
      await server.close();
    }
    if (format === 'react') await build({ configFile: false, root, logLevel: 'silent' });
  }
});

test('scene agent adds GLB, image, audio and video assets to an empty scene', async ({ page }, testInfo) => {
  await page.goto('/');
  const videoData = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    await new Promise(resolve => setTimeout(resolve, 300));
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach(track => track.stop());
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  });
  await page.getByLabel('Upload assets').setInputFiles([model, texture, sound, {
    name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(videoData.split(',')[1], 'base64')
  }]);
  await expect(page.getByRole('button', { name: 'Add clip.webm to scene' })).toBeVisible();
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: { objects: unknown[]; assets: { id: string; name: string }[] } };
    expect(body.context.objects).toHaveLength(0);
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Add library assets', additions:
      body.context.assets.map(asset => ({ kind: 'asset', assetId: asset.id, name: asset.name,
        usage: asset.name.endsWith('.glb') ? '3d' : 'web' })) }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Add these assets');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(4);
  for (const name of ['triangle.glb', 'pixel.png', 'tone.wav', 'clip.webm']) {
    await expect(page.getByRole('button', { name: `Add ${name} to scene` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.engine-web-node[data-kind="image"]')).toHaveAttribute('src', /^data:image\/png/);
  await expect(page.locator('.engine-web-node[data-kind="audio"]')).toHaveAttribute('src', /^data:audio\/wav/);
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveAttribute('src', /^data:video\/webm/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('agent-media');
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.locator('.engine-web-node[data-kind="image"]')).toHaveAttribute('src', /^web3dassets\/.*\.png$/, { timeout: 15000 });
  await expect(page.locator('.engine-web-node[data-kind="audio"]')).toHaveAttribute('src', /^web3dassets\/.*\.wav$/);
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveAttribute('src', /^web3dassets\/.*\.webm$/);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('a button-started GLB clip opens a scene when it finishes', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('GLB finished');
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.locator('#model-upload').setInputFiles({
    name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: triangleGlb(true)
  });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('GLB animation clip', { exact: true }).selectOption({ label: 'Move' });
  await page.getByLabel('GLB completion scene').selectOption({ label: 'Scene 2 / Page 2' });
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Start clip');
  await page.getByLabel('Web action').selectOption('playClip');
  await page.getByLabel('Web action target').selectOption({ label: 'animated' });
  await page.getByLabel('Web action clip').selectOption({ label: 'Move' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Start clip' }).click();
  await expect(page.getByRole('heading', { name: 'GLB finished' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('Play GLB animation').check();
  await page.getByLabel('Loop GLB animation').uncheck();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GLB finished' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('Play GLB animation').uncheck();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('glb-transition');
  await page.goto(await serveExport(page, zip, directory));
  await page.getByRole('button', { name: 'Start clip' }).click({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'GLB finished' })).toBeVisible({ timeout: 15000 });
});

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/projects');
  const projects = await response.json() as { id: string; name: string }[];
  for (const project of projects.filter(item => ['Media test scene', 'Asset library test'].includes(item.name))) {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
  }
});

test('asset library imports and adds models, images, audio and video and restores projects', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.goto('/');
  const videoData = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    await new Promise(resolve => setTimeout(resolve, 300));
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach(track => track.stop());
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  });
  const video = { name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(videoData.split(',')[1], 'base64') };
  await page.getByLabel('Upload assets').setInputFiles([model, texture, sound, video]);
  for (const file of [model, texture, sound, video]) {
    await expect(page.getByRole('button', { name: `Add ${file.name} to scene` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add triangle.glb to scene' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Add pixel.png to scene' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').nth(6).fill('3');
  await page.getByRole('button', { name: 'Add pixel.png to web' }).click();
  await page.getByLabel('Web width').fill('120');
  await expect(page.locator('.engine-web-node[data-kind="image"]')).toHaveCSS('width', '120px');
  await page.getByRole('button', { name: 'Add tone.wav to scene' }).click();
  await expect(page.locator('.engine-web-node[data-kind="audio"]')).toHaveAttribute('src', /^data:audio\/wav/);
  await page.getByRole('button', { name: 'Add clip.webm to scene' }).click();
  await page.getByLabel('Web width').fill('160');
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveCSS('width', '160px');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Asset library test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  for (const file of [model, texture, sound, video]) await page.getByRole('button', { name: `Remove ${file.name}` }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Asset library test', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  for (const file of [model, texture, sound, video]) await expect(page.getByRole('button', { name: `Add ${file.name} to scene` })).toBeVisible();
  await page.reload();
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveCSS('width', '160px');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const snapshot = JSON.parse(await zip.file('scene.json')!.async('string')) as {
    objects: { type: string; properties: { scale: number[] } }[];
  };
  expect(snapshot.objects.find(object => object.type === 'imagePlane')?.properties.scale[0]).toBe(3);
  const directory = testInfo.outputPath('asset-export');
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.locator('.engine-web-node[data-kind="image"]')).toHaveCSS('width', '120px', { timeout: 15000 });
  await expect(page.locator('.engine-web-node[data-kind="audio"]')).toHaveAttribute('src', /^web3dassets\/.*\.wav$/);
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveCSS('width', '160px');
  await expect(page.locator('#load-error')).toBeHidden();
});

test('web buttons play a selected model clip and sound in editor and export', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (window as Window & { testAudio?: HTMLMediaElement }).testAudio = this;
      return original.call(this);
    };
  });
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({
    name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: triangleGlb(true)
  });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles(sound);
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('tone.wav')).toBeVisible();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); } };");
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Animate');
  await page.getByLabel('Web action').selectOption('playClip');
  await page.getByLabel('Web action target').selectOption({ label: 'animated' });
  await page.getByLabel('Web action clip').selectOption({ label: 'Move' });
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Sound');
  await page.getByLabel('Web action').selectOption('playSound');
  await page.getByLabel('Web action target').selectOption({ label: 'animated' });
  await page.getByLabel('Web action sound').selectOption({ label: 'tone.wav' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const position = () => page.locator('body').getAttribute('data-clip-position').then(Number);
  await expect.poll(position).toBe(0);
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await expect.poll(position).toBeGreaterThan(0.7);
  await expect.poll(position).toBeGreaterThan(0.99);
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await expect.poll(position).toBeLessThan(0.5);
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { testAudio?: HTMLMediaElement }).testAudio?.currentTime ?? 0)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('button-media');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.getByRole('button', { name: 'Animate', exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(position).toBe(0);
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await expect.poll(position).toBeGreaterThan(0.7);
  await expect.poll(position).toBeGreaterThan(0.99);
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await expect.poll(position).toBeLessThan(0.5);
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { testAudio?: HTMLMediaElement }).testAudio?.currentTime ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('GLB animation clips persist and play in the editor and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({
    name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: triangleGlb(true)
  });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await page.getByLabel('GLB animation clip', { exact: true }).selectOption({ label: 'Move' });
  await page.getByLabel('Play GLB animation').check();
  await page.getByLabel('Loop GLB animation').uncheck();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); }, stop() { delete document.body.dataset.clipPosition; } };");
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('editor', 'readonly').objectStore('editor').get('current');
      read.onsuccess = () => { resolve(read.result?.currentScene.objects[0]?.properties.script); db.close(); };
      read.onerror = () => { reject(read.error); db.close(); };
    };
  }))).toContain('clipPosition');
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'GLB Animation Clips' }).click();
  await expect(page.getByLabel('GLB animation clip', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Play GLB animation')).toBeChecked();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await expect(page.getByLabel('Object script')).toHaveValue(/clipPosition/);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const position = () => page.locator('body').getAttribute('data-clip-position').then(value => Number(value));
  await expect.poll(position).toBeGreaterThan(0.7);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('animated-model');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
  await expect.poll(position, { timeout: 15000 }).toBeGreaterThan(0.7);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('GLB, texture and sound survive project and browser reload and run in the downloaded game', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (window as Window & { testAudio?: HTMLMediaElement }).testAudio = this;
      return original.call(this);
    };
  });
  await page.goto('/');
  await page.getByLabel('Upload assets').setInputFiles(model);
  await page.getByRole('button', { name: 'Add triangle.glb to scene' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(texture);
  await page.getByLabel('Material Type').selectOption('phong');
  await page.getByLabel('Material Type').selectOption('standard');
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles(sound);
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('tone.wav')).toBeVisible();
  await page.getByLabel('Play automatically').check();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Media test scene');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset Scene' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Media test scene', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add triangle.glb to scene' })).toBeVisible();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('tone.wav')).toBeVisible();
  await expect(page.getByLabel('Play automatically')).toBeChecked();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { testAudio?: HTMLMediaElement }).testAudio?.currentTime ?? 0)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  const zip = await JSZip.loadAsync(await readFile(downloadPath!));
  const snapshot = JSON.parse(await zip.file('scene.json')!.async('string'));
  expect(snapshot.objects[0].properties.modelData).toMatch(/^web3dassets\/.*\.glb$/);
  expect(snapshot.objects[0].properties.map).toMatch(/^web3dassets\/.*\.png$/);
  expect(snapshot.objects[0].properties.materialType).toBe('standard');
  expect(snapshot.objects[0].properties.sounds[0].url).toMatch(/^web3dassets\/.*\.wav$/);
  const directory = testInfo.outputPath('media-game');
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.locator('#load-error')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Function('return sceneObjects.length')() as number), { timeout: 15000 }).toBe(1);
  const rendered = await page.evaluate(() => Function(`const root = sceneObjects[0].object;
    let mesh; root.traverse(child => { if (child.isMesh) mesh = child; });
    return { vertices: mesh.geometry.attributes.position.count, textureWidth: mesh.material.map.image.width, scale: root.scale.x };`)() as { vertices: number; textureWidth: number; scale: number });
  expect(rendered).toEqual({ vertices: 3, textureWidth: 1, scale: 1 });
  if (await page.getByRole('button', { name: 'Enable sound' }).isVisible()) {
    await page.getByRole('button', { name: 'Enable sound' }).click();
  }
  await expect.poll(() => page.evaluate(() => (window as Window & { testAudio?: HTMLMediaElement }).testAudio?.currentTime ?? 0)).toBeGreaterThan(0);
});

test('invalid model and texture imports report errors', async ({ page }) => {
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({ name: 'invalid.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('not a GLB') });
  await expect(page.getByText('Failed to load model')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(page.getByText('Failed to load texture')).toBeVisible();
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await expect(page.getByText('Failed to load sound')).toBeVisible();
  await page.locator('#model-upload').setInputFiles(model);
  await expect(page.getByText('Loaded triangle', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
});

test('mobile panels start closed and can be opened', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('No objects in scene yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.getByText('Components', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.getByRole('button', { name: 'Toggle panel' }).click();
  await expect(page.getByText('Assets', { exact: true })).toBeVisible();
});
