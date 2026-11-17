import { test, expect, type Page, type TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { addObject, enablePlayer, playerState, serveExport } from './helpers';

async function openDownloadedGame(page: Page, testInfo: TestInfo) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloadPromise).path())!));
  const directory = testInfo.outputPath('downloaded-game');
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
}

test('export packages scene data and player files', async ({ page }) => {
  await page.goto('/');
  await enablePlayer(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const zip = await JSZip.loadAsync(await readFile(path!));
  expect(Object.keys(zip.files).sort()).toEqual(['index.html', 'scene.js', 'scene.json', 'vendor/', 'vendor/GLTFLoader.js', 'vendor/THREE-LICENSE.txt', 'vendor/three.min.js']);
  const scene = JSON.parse(await zip.file('scene.json')!.async('string'));
  expect(scene.objects[0].properties.characterController.enabled).toBe(true);
});

test('export falls back to CDN for missing or invalid local libraries and reports total failure', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const three = await zip.file('vendor/three.min.js')!.async('string');
  const loader = await zip.file('vendor/GLTFLoader.js')!.async('string');
  let local = 'missing';
  let failCdn = false;
  const fallbackRequests: string[] = [];
  await page.route('**/vendor/*.js', route => local === 'missing'
    ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: '/* Invalid library */' }));
  await page.route('https://cdnjs.cloudflare.com/**', route => {
    fallbackRequests.push('three');
    return failCdn ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: three });
  });
  await page.route('https://cdn.jsdelivr.net/**', route => {
    fallbackRequests.push('loader');
    return failCdn ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: loader });
  });
  const url = await serveExport(page, zip, testInfo.outputPath('cdn-fallback'));
  await page.goto(url);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  expect(fallbackRequests).toEqual(['three', 'loader']);
  local = 'invalid';
  fallbackRequests.length = 0;
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  expect(fallbackRequests).toEqual(['three', 'loader']);
  failCdn = true;
  await page.reload();
  await expect(page.locator('#load-error')).toContainText('Could not load the game:');
  await expect(page.locator('#load-error')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('Tween.js and Float persist and run offline in all export formats', async ({ page, context }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Tween Animation' }).click();
  await page.getByLabel('Enable tween animation').check();
  await page.getByLabel('Tween target X').fill('2');
  await page.getByLabel('Tween duration').fill('0.4');
  await page.getByRole('button', { name: 'Float', exact: true }).click();
  await page.getByLabel('Enable float').check();
  await page.getByLabel('Float height').fill('0.7');
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Tween Animation' }).click();
  await expect(page.getByLabel('Tween target X')).toHaveValue('2');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await playerState(page)).position[0]).toBeCloseTo(2, 1);
  await expect.poll(async () => Math.abs((await playerState(page)).position[1])).toBeGreaterThan(0.05);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect((await playerState(page)).position[1]).toBeCloseTo(0);

  for (const format of ['html', 'react', 'wordpress'] as const) {
    await page.getByLabel('Export format').selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
    const prefix = format === 'html' ? '' : format === 'react' ? 'public/scene/' : 'three-scene-export/scene/';
    expect(zip.file(`${prefix}vendor/tween.umd.js`)).not.toBeNull();
    expect(zip.file(`${prefix}vendor/TWEEN-LICENSE.txt`)).not.toBeNull();
    const player = await context.newPage();
    try {
      const external: string[] = [];
      await player.route('https://**', route => {
        external.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      const root = await serveExport(player, zip, testInfo.outputPath(`tween-${format}`));
      await player.goto(root.replace('index.html', `${prefix}index.html`));
      await expect(player.locator('canvas')).toBeVisible({ timeout: 15000 });
      await expect.poll(() => player.evaluate(() => Function('return sceneObjects[0].object.position.x')() as number), { timeout: 15000 }).toBeCloseTo(2, 1);
      await expect.poll(() => player.evaluate(() => Math.abs(Function('return sceneObjects[0].object.position.y')() as number))).toBeGreaterThan(0.05);
      await expect(player.locator('#load-error')).toBeHidden();
      expect(external).toEqual([]);
    } finally {
      await player.close();
    }
  }
});

test('3D text with Turkish glyphs persists and exports its font offline', async ({ page, context }, testInfo) => {
  await page.goto('/');
  await addObject(page, '3D Text');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: '3D Text', exact: true }).last().click();
  await page.getByLabel('3D text', { exact: true }).fill('İşçi');
  await page.getByLabel('3D text depth').fill('0.4');
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.objects[0]?.properties.text3d?.depth); database.close(); };
    };
  }))).toBe(0.4);
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: '3D Text', exact: true }).last().click();
  await expect(page.getByLabel('3D text', { exact: true })).toHaveValue('İşçi');
  await expect(page.getByLabel('3D text depth')).toHaveValue('0.4');
  for (const format of ['html', 'react', 'wordpress'] as const) {
    await page.getByLabel('Export format').selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
    const prefix = format === 'html' ? '' : format === 'react' ? 'public/scene/' : 'three-scene-export/scene/';
    expect(zip.file(`${prefix}vendor/droid_sans_regular.typeface.json`)).not.toBeNull();
    expect(zip.file(`${prefix}vendor/DROID-FONT-NOTICE.txt`)).not.toBeNull();
    const player = await context.newPage();
    try {
      const external: string[] = [];
      await player.route('https://**', route => {
        external.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      const root = await serveExport(player, zip, testInfo.outputPath(`text-${format}`));
      await player.goto(root.replace('index.html', `${prefix}index.html`));
      await expect(player.locator('canvas')).toBeVisible({ timeout: 15000 });
      const geometry = await player.evaluate(() => Function(`const g = sceneObjects[0].object.geometry;
        g.computeBoundingBox(); return { count: g.attributes.position.count, depth: g.boundingBox.max.z - g.boundingBox.min.z };`)() as { count: number; depth: number });
      expect(geometry.count).toBeGreaterThan(0);
      expect(geometry.depth).toBeCloseTo(0.4, 2);
      await expect(player.locator('#load-error')).toBeHidden();
      expect(external).toEqual([]);
    } finally {
      await player.close();
    }
  }
});

test('SDF text renders Turkish and Latin characters offline in all exports', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  await page.goto('/');
  await addObject(page, 'SDF Text');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'SDF Text', exact: true }).last().click();
  await page.getByLabel('3D text', { exact: true }).fill('中');
  await expect(page.getByText('SDF text supports Latin-1 and Turkish characters only')).toBeVisible();
  await page.getByLabel('3D text', { exact: true }).fill('İşçi A');
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.objects[0]?.properties.text3d?.text); database.close(); };
    };
  }))).toBe('İşçi A');
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'SDF Text', exact: true }).last().click();
  await expect(page.getByLabel('3D text', { exact: true })).toHaveValue('İşçi A');
  for (const format of ['html', 'react', 'wordpress'] as const) {
    await page.getByLabel('Export format').selectOption(format);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
    const prefix = format === 'html' ? '' : format === 'react' ? 'public/scene/' : 'three-scene-export/scene/';
    expect(zip.file(`${prefix}vendor/SDF-TEXT-LICENSE.txt`)).not.toBeNull();
    expect(zip.file(`${prefix}vendor/NOTO-SANS-LICENSE.txt`)).not.toBeNull();
    const player = await context.newPage();
    try {
      const external: string[] = [];
      const shaderErrors: string[] = [];
      player.on('console', message => { if (message.type() === 'error') shaderErrors.push(message.text()); });
      await player.route('https://**', route => {
        external.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      const root = await serveExport(player, zip, testInfo.outputPath(`sdf-${format}`));
      await player.goto(root.replace('index.html', `${prefix}index.html`));
      await expect.poll(() => player.evaluate(() => Function('return sceneObjects[0]?.object.textRenderInfo?.glyphBounds.length || 0')() as number), { timeout: 30000 }).toBeGreaterThanOrEqual(20);
      const pixelsChanged = await player.evaluate(() => Function(`const gl = renderer.getContext();
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const read = () => { renderer.render(scene, camera); const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels; };
        const text = sceneObjects[0].object; text.visible = false; const without = read();
        text.visible = true; const withText = read(); let changed = 0;
        for (let i = 0; i < without.length; i += 4) {
          if (without[i] !== withText[i] || without[i + 1] !== withText[i + 1] || without[i + 2] !== withText[i + 2]) changed++;
        } return changed;`)() as number);
      expect(pixelsChanged).toBeGreaterThan(20);
      await expect(player.locator('#load-error')).toBeHidden();
      expect(external).toEqual([]);
      expect(shaderErrors).toEqual([]);
    } finally {
      await player.close();
    }
  }
});

test('environment presets and uploaded HDR work offline in each export', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  const hdr = Buffer.concat([
    Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),
    Buffer.from([255, 200, 100, 128])
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  await page.getByLabel('Enable environment').check();
  await page.getByLabel('Environment preset').selectOption('sunset');
  await page.getByLabel('Environment background').check();
  for (const kind of ['sunset', 'hdr'] as const) {
    if (kind === 'hdr') {
      await page.getByLabel('Upload HDR environment').setInputFiles({ name: 'studio.hdr', mimeType: 'application/octet-stream', buffer: hdr });
      await expect(page.getByText('HDR environment loaded')).toBeVisible();
      await expect(page.getByLabel('Environment preset')).toHaveValue('hdr');
    }
    for (const format of ['html', 'react', 'wordpress'] as const) {
      await page.getByLabel('Export format').selectOption(format);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
      const prefix = format === 'html' ? '' : format === 'react' ? 'public/scene/' : 'three-scene-export/scene/';
      const scene = JSON.parse(await zip.file(`${prefix}scene.json`)!.async('string')) as {
        sceneOptions: { environment: { source: string; data?: string } }
      };
      expect(scene.sceneOptions.environment.source).toBe(kind);
      if (kind === 'hdr') {
        expect(scene.sceneOptions.environment.data).toMatch(/^web3dassets\//);
        expect(await zip.file(prefix + scene.sceneOptions.environment.data!)!.async('nodebuffer')).toEqual(hdr);
        expect(zip.file(`${prefix}vendor/RGBELoader.js`)).not.toBeNull();
      }
      const player = await context.newPage();
      try {
        const external: string[] = [];
        await player.route('https://**', route => {
          external.push(route.request().url());
          return route.abort('internetdisconnected');
        });
        const root = await serveExport(player, zip, testInfo.outputPath(`env-${kind}-${format}`));
        await player.goto(root.replace('index.html', `${prefix}index.html`));
        await expect(player.locator('canvas')).toBeVisible({ timeout: 15000 });
        await expect.poll(() => player.evaluate(() => Function('return !!scene.environment && scene.background === scene.environment')() as boolean),
          { timeout: 15000 }).toBe(true);
        await expect(player.locator('#load-error')).toBeHidden();
        expect(external).toEqual([]);
      } finally {
        await player.close();
      }
    }
  }
});

test('linear damping persists and applies consistently in editor and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await page.getByRole('region', { name: 'Physics' }).getByRole('checkbox').first().check();
  await page.getByLabel('Linear damping').fill('2');
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.objects[0]?.properties.physics?.linearDamping); database.close(); };
    };
  }))).toBe(2);
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await expect(page.getByLabel('Linear damping')).toHaveValue('2');
  if (process.env.E2E_PREVIEW !== '1') {
    const result = await page.evaluate(async () => {
      const threePath = '/node_modules/three/build/three.module.js';
      const physicsPath = '/src/systems/PhysicsEngine.ts';
      const storePath = '/src/store/editorStore.ts';
      const THREE = await import(/* @vite-ignore */ threePath);
      const { advancePhysics } = await import(/* @vite-ignore */ physicsPath);
      const { useEditorStore } = await import(/* @vite-ignore */ storePath);
      const source = useEditorStore.getState().sceneObjects[0];
      const simulate = (linearDamping: number | undefined, steps: number, isKinematic = false) => {
        const item = { ...source, object: source.object.clone(), properties: { ...source.properties,
          physics: { ...source.properties.physics, linearDamping, useGravity: false, isKinematic,
            velocity: [10, 0, 0], acceleration: [0, 0, 0] } } };
        item.object.position.y = 5;
        for (let i = 0; i < steps; i++) advancePhysics([item], 0.1 / steps, -9.8, THREE);
        return item.properties.physics.velocity[0] as number;
      };
      return { value: simulate(2, 1), smallSteps: simulate(2, 2), legacy: simulate(undefined, 1), kinematic: simulate(2, 1, true) };
    });
    expect(result.value).toBeCloseTo(10 * Math.exp(-0.2), 5);
    expect(result.smallSteps).toBeCloseTo(result.value, 5);
    expect(result.legacy).toBe(10);
    expect(result.kinematic).toBe(10);
  }
  await openDownloadedGame(page, testInfo);
  const result = await page.evaluate(() => Function(`
    const item = sceneObjects[0];
    item.object.position.y = 5;
    item.properties.physics.useGravity = false;
    item.properties.physics.velocity = [10, 0, 0];
    advancePhysics([item], 0.1, -9.8, THREE);
    return { damping: item.properties.physics.linearDamping, velocity: item.properties.physics.velocity[0] };
  `)() as { damping: number; velocity: number });
  expect(result.damping).toBe(2);
  expect(result.velocity).toBeCloseTo(10 * Math.exp(-0.2), 5);
});

test('box triggers detect entry and exit without blocking in play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  const physics = page.getByRole('region', { name: 'Physics' });
  await physics.getByRole('checkbox').first().check();
  await physics.getByRole('checkbox').nth(2).check();
  await page.getByLabel('Collider', { exact: true }).selectOption('box');
  await page.getByLabel('Collider size X').fill('2');
  await page.getByLabel('Trigger', { exact: true }).check();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { triggerEnter(other) { document.body.dataset.enter = other.name; }, triggerExit(other) { document.body.dataset.exit = other.name; } };");
  await addObject(page, 'Sphere');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').first().fill('1.2');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await physics.getByRole('checkbox').first().check();
  await physics.getByRole('checkbox').nth(1).uncheck();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("let elapsed = 0; return { update(delta) { elapsed += delta; if (elapsed > 0.5) object.position.x += delta * 4; } };");
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-enter', 'Sphere');
  await expect(page.locator('body')).toHaveAttribute('data-exit', 'Sphere', { timeout: 5000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await openDownloadedGame(page, testInfo);
  await expect(page.locator('body')).toHaveAttribute('data-enter', 'Sphere', { timeout: 15000 });
  await expect(page.locator('body')).toHaveAttribute('data-exit', 'Sphere', { timeout: 5000 });
  await expect(page.locator('#load-error')).toBeHidden();
});

for (const mode of ['fps', 'rpg'] as const) {
  test(`${mode} player camera follows movement in play and export`, async ({ page }, testInfo) => {
    await page.goto('/');
    await enablePlayer(page);
    await page.getByLabel('Player camera mode').selectOption(mode);
    await page.getByLabel('Camera height').fill('2');
    if (mode === 'rpg') await page.getByLabel('Camera distance').fill('4');
    await page.getByRole('button', { name: 'JavaScript' }).click();
    await page.getByLabel('Object script').fill("return { update() { document.body.dataset.camera = JSON.stringify(camera.position.toArray()); document.body.dataset.player = JSON.stringify(object.position.toArray()); document.body.dataset.orientation = JSON.stringify(camera.quaternion.toArray()); } };");
    const vector = (name: string) => page.locator('body').getAttribute(`data-${name}`).then(value => JSON.parse(value ?? 'null') as number[] | null);
    async function check() {
      await expect.poll(() => vector('camera')).not.toBeNull();
      const before = (await vector('player'))!;
      await page.keyboard.down('w');
      await page.waitForTimeout(500);
      await page.keyboard.up('w');
      const player = (await vector('player'))!;
      const camera = (await vector('camera'))!;
      expect(Math.hypot(player[0] - before[0], player[2] - before[2])).toBeGreaterThan(0.5);
      const offset = Math.hypot(camera[0] - player[0], camera[1] - player[1] - 2, camera[2] - player[2]);
      if (mode === 'fps') expect(offset).toBeLessThan(0.2);
      else expect(offset).toBeCloseTo(4, 0);
      await page.locator('canvas').click({ position: { x: 10, y: 10 } });
      await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');
      const beforeLook = await vector('orientation');
      await page.mouse.move(300, 180);
      await expect.poll(() => vector('orientation')).not.toEqual(beforeLook);
      await page.keyboard.press('Escape');
    }
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await check();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await openDownloadedGame(page, testInfo);
    await check();
    await expect(page.locator('#load-error')).toBeHidden();
  });
}

test('scene AI settings persist and algorithms work in play and exported code', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 1 0\n0 1 0\n0 0 0');
  await page.getByLabel('AI start').fill('0,0');
  await page.getByLabel('AI goal').fill('2,0');
  await page.getByLabel('AI regression data').fill('0,1\n1,3\n2,5');
  await page.getByLabel('AI prediction X').fill('4');
  const result = () => page.getByLabel('AI result').textContent().then(text => JSON.parse(text ?? '{}'));
  await page.getByLabel('AI grid').fill('0 2 0');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  await expect(page.getByText('Grid cells must be 0 or 1.')).toBeVisible();
  await page.getByLabel('AI grid').fill('0 1 0\n1 1 0\n0 0 0');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  expect(await result()).toEqual({ path: [], cost: null });
  await page.getByLabel('AI grid').fill('0 1 0\n0 1 0\n0 0 0');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  expect((await result()).cost).toBe(6);
  await page.getByLabel('AI algorithm', { exact: true }).selectOption('dijkstra');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  expect((await result()).cost).toBe(6);
  await page.getByLabel('AI algorithm', { exact: true }).selectOption('q');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  const learningResult = await result();
  expect(learningResult.reachedGoal).toBe(true);
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  expect(await result()).toEqual(learningResult);
  await page.getByLabel('AI algorithm', { exact: true }).selectOption('regression');
  await page.getByLabel('AI regression data').fill('1,2\n1,4');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  await expect(page.getByText('Regression requires different X values.')).toBeVisible();
  await page.getByLabel('AI regression data').fill('0,1\n1,3\n2,5');
  await page.getByRole('button', { name: 'Run algorithm' }).click();
  expect(await result()).toEqual({ slope: 2, intercept: 1, prediction: 9 });
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.sceneOptions.ai?.predictionX); database.close(); };
    };
  }))).toBe(4);
  await page.reload();
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await expect(page.getByLabel('AI goal')).toHaveValue('2,0');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { start() { document.body.dataset.ai = JSON.stringify({ a: state.ai.findPath('astar').cost, d: state.ai.findPath('dijkstra').cost, q: state.ai.train().reachedGoal, r: state.ai.regress().prediction }); } };");
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const output = () => page.locator('body').getAttribute('data-ai').then(value => JSON.parse(value ?? '{}'));
  await expect.poll(output).toEqual({ a: 6, d: 6, q: true, r: 9 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await openDownloadedGame(page, testInfo);
  await expect.poll(output).toEqual({ a: 6, d: 6, q: true, r: 9 });
  await expect(page.locator('#load-error')).toBeHidden();
});

for (const algorithm of ['astar', 'dijkstra', 'q'] as const) {
test(`NPC follows a ${algorithm} grid path back and forth in play and export`, async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 1 0\n0 0 0');
  await page.getByLabel('AI start').fill('0,0');
  await page.getByLabel('AI goal').fill('2,0');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(0).fill('5');
  await fields.nth(1).fill('2');
  await fields.nth(2).fill('7');
  await page.getByRole('button', { name: 'AI Navigation' }).click();
  await page.getByLabel('Enable AI navigation').check();
  await page.getByLabel('NPC path algorithm').selectOption(algorithm);
  await page.getByLabel('NPC speed').fill('3');
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.npcPosition = JSON.stringify(object.position.toArray()); } };");
  const position = () => page.locator('body').getAttribute('data-npc-position').then(value => JSON.parse(value ?? 'null') as number[] | null);
  async function checkRoute() {
    await expect.poll(position).not.toBeNull();
    await expect.poll(async () => {
      const current = await position();
      return current && current[0] < 5.2 && current[2] > 7.3 && current[2] < 8.1;
    }, { intervals: [30], timeout: 5000 }).toBe(true);
    await expect.poll(async () => {
      const current = await position();
      return current && current[0] > 6.8 && current[2] < 7.2;
    }, { intervals: [30], timeout: 5000 }).toBe(true);
    await expect.poll(async () => {
      const current = await position();
      return current && current[0] < 5.2 && current[2] < 7.2 && current[1] === 2;
    }, { intervals: [30], timeout: 5000 }).toBe(true);
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await checkRoute();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await expect(fields.nth(0)).toHaveValue('5');
  await expect(fields.nth(1)).toHaveValue('2');
  await expect(fields.nth(2)).toHaveValue('7');
  page.once('dialog', dialog => dialog.accept());
  await openDownloadedGame(page, testInfo);
  await checkRoute();
  await expect(page.locator('#load-error')).toBeHidden();
});
}

for (const algorithm of ['astar', 'q'] as const) {
test(`an unreachable NPC route reports a ${algorithm} error in play and export`, async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 1 0');
  await page.getByLabel('AI start').fill('0,0');
  await page.getByLabel('AI goal').fill('2,0');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'AI Navigation' }).click();
  await page.getByLabel('Enable AI navigation').check();
  await page.getByLabel('NPC path algorithm').selectOption(algorithm);
  const error = algorithm === 'q' ? 'Box: Q-learning did not find a path to the goal.' : 'Box: The goal is unreachable on the AI grid.';
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(error)).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openDownloadedGame(page, testInfo);
  await expect(page.locator('#load-error')).toContainText(error);
});
}

test('conflicting NPC movement animation reports an error in play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 0');
  await page.getByLabel('AI start').fill('0,0');
  await page.getByLabel('AI goal').fill('1,0');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'AI Navigation' }).click();
  await page.getByLabel('Enable AI navigation').check();
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  await page.getByRole('button', { name: 'Movement', exact: true }).click();
  await page.getByRole('button', { name: 'Enable movement play on start' }).click();
  const error = 'Box: Disable conflicting movement or rotation animations on this path follower.';
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(error)).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openDownloadedGame(page, testInfo);
  await expect(page.locator('#load-error')).toContainText(error);
});

test('NPC facing and a Y rotation timeline conflict in play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 0');
  await page.getByLabel('AI start').fill('0,0');
  await page.getByLabel('AI goal').fill('1,0');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'AI Navigation' }).click();
  await page.getByLabel('Enable AI navigation').check();
  await page.getByLabel('NPC face path').check();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline channel').selectOption('rotation.y');
  await page.getByRole('button', { name: 'Add channel', exact: true }).click();
  const error = 'Box: Remove conflicting X/Z position or Y rotation timeline channels from this path follower.';
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(error)).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openDownloadedGame(page, testInfo);
  await expect(page.locator('#load-error')).toContainText(error);
});

for (const algorithm of ['astar', 'dijkstra', 'q'] as const) {
test(`NPC replans ${algorithm} around a moving collider and crosses a trigger in play and export`, async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Algorithms' }).click();
  await page.getByLabel('AI grid').fill('0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0');
  await page.getByLabel('AI start').fill('0,1');
  await page.getByLabel('AI goal').fill('4,1');
  await page.getByRole('button', { name: 'Save AI settings' }).click();

  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).nth(0).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  let fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(1).fill('1');
  for (const index of [6, 7, 8]) await fields.nth(index).fill('0.3');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  let physics = page.getByRole('region', { name: 'Physics' });
  await physics.getByRole('checkbox').nth(0).check();
  await physics.getByRole('checkbox').nth(2).check();
  await page.getByRole('button', { name: 'AI Navigation' }).click();
  await page.getByLabel('Enable AI navigation').check();
  await expect(page.getByLabel('Avoid scene obstacles')).toBeChecked();
  await page.getByLabel('NPC path algorithm').selectOption(algorithm);
  await page.getByLabel('NPC speed').fill('2');
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill(`let maxZ = 0, maxX = 0;
    return {
      update() {
        maxZ = Math.max(maxZ, Math.abs(object.position.z));
        maxX = Math.max(maxX, object.position.x);
        if (object.position.x > 1.65 && object.position.x < 2.35 && Math.abs(object.position.z) < 0.36) document.body.dataset.wallCrossed = 'yes';
        document.body.dataset.npcRoute = JSON.stringify([maxX, maxZ]);
      },
      triggerEnter() { document.body.dataset.npcTrigger = 'entered'; },
      triggerExit() { document.body.dataset.npcTrigger = 'exited'; }
    };`);

  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).nth(1).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(0).fill('2');
  await fields.nth(1).fill('1');
  await fields.nth(2).fill('2');
  await fields.nth(6).fill('0.4');
  await fields.nth(8).fill('0.4');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  physics = page.getByRole('region', { name: 'Physics' });
  await physics.getByRole('checkbox').nth(0).check();
  await physics.getByRole('checkbox').nth(2).check();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("let elapsed = 0; return { update(delta) { elapsed += delta; if (elapsed > 0.3) object.position.z = 0; } };");

  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).nth(2).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(0).fill('2');
  await fields.nth(1).fill('1');
  await fields.nth(6).fill('0.3');
  await fields.nth(8).fill('4');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  physics = page.getByRole('region', { name: 'Physics' });
  await physics.getByRole('checkbox').nth(0).check();
  await physics.getByRole('checkbox').nth(2).check();
  await page.getByLabel('Trigger', { exact: true }).check();

  if (algorithm === 'astar') {
    await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open('game-engine-editor');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction('editor').objectStore('editor').get('current');
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          resolve(read.result?.currentScene.objects[0]?.properties.pathFollower?.avoidObstacles === true
            && read.result?.currentScene.objects[2]?.properties.physics?.isTrigger === true);
          database.close();
        };
      };
    }))).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Select', exact: true }).nth(0).click();
    await page.getByRole('button', { name: 'AI Navigation' }).click();
    await expect(page.getByLabel('Avoid scene obstacles')).toBeChecked();
  }

  async function checkRoute() {
    const route = () => page.locator('body').getAttribute('data-npc-route').then(value => JSON.parse(value ?? '[0,0]') as number[]);
    await expect.poll(async () => (await route())[0], { timeout: 10000 }).toBeGreaterThan(3.8);
    expect((await route())[1]).toBeGreaterThan(0.7);
    await expect(page.locator('body')).toHaveAttribute('data-npc-trigger', 'exited');
    await expect(page.locator('body')).not.toHaveAttribute('data-wall-crossed', 'yes');
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await checkRoute();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await openDownloadedGame(page, testInfo);
  await checkRoute();
  await expect(page.locator('#load-error')).toBeHidden();
});
}

test('exported NPC waits for blocked routes, resumes safely, and emits collision events', async ({ page }, testInfo) => {
  await page.goto('/');
  await openDownloadedGame(page, testInfo);
  const result = await page.evaluate(() => Function(`
    const make = (name, x, z, size, isKinematic) => ({
      id: name, name, type: 'box',
      object: new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial()),
      properties: {
        position: [x, 1, z], rotation: [0, 0, 0], scale: [1, 1, 1],
        physics: { enabled: true, isKinematic, mass: 1, useGravity: false, velocity: [0, 0, 0], acceleration: [0, 0, 0] }
      }
    });
    const ai = { grid: [[0,0,0],[0,0,0],[0,0,0]], start: [0,1], goal: [2,1],
      learning: { episodes: 500, rate: 0.3, discount: 0.9, exploration: 0.3, seed: 1 }, points: [], predictionX: 0 };
    const npc = make('npc', 0, 0, [0.2, 0.5, 0.2], true);
    npc.object.position.set(0, 1, 0);
    npc.properties.pathFollower = { enabled: true, algorithm: 'astar', speed: 10, cellSize: 1, faceDirection: false, avoidObstacles: true };
    const wall = make('wall', 1, 0, [0.1, 1, 4], true);
    wall.object.position.set(1, 1, 0);
    const errors = [], recoveries = [];
    const nav = createPathFollowers([npc, wall], ai, undefined, createSceneAI, message => errors.push(message), THREE, getPhysicsBounds, message => recoveries.push(message));
    for (let i = 0; i < 10; i++) nav.update(0.1);
    const stopped = npc.object.position.x;
    wall.object.position.z = 10;
    let furthest = 0;
    for (let i = 0; i < 20; i++) { nav.update(0.1); furthest = Math.max(furthest, npc.object.position.x); }

    const narrowNPC = make('narrowNPC', 0, 0, [0.2, 0.5, 0.2], true);
    narrowNPC.object.position.set(0, 1, 0);
    narrowNPC.properties.pathFollower = { ...npc.properties.pathFollower, speed: 5 };
    const narrow = make('narrow', 0.5, 0, [0.05, 1, 0.4], true);
    narrow.object.position.set(0.5, 1, 0);
    const narrowNav = createPathFollowers([narrowNPC, narrow], ai, undefined, createSceneAI, message => errors.push(message), THREE, getPhysicsBounds);
    let detour = 0, reached = 0, crossed = false;
    for (let i = 0; i < 40; i++) {
      narrowNav.update(0.1);
      const { x, z } = narrowNPC.object.position;
      detour = Math.max(detour, Math.abs(z));
      reached = Math.max(reached, x);
      if (x > 0.4 && x < 0.6 && Math.abs(z) < 0.3) crossed = true;
    }

    const moving = make('moving', 0.45, 0, [0.4, 0.5, 0.4], false);
    moving.object.position.set(0.45, 1, 0);
    npc.object.position.set(0.2, 1, 0);
    npc.properties.script = "return { collisionEnter() { document.body.dataset.collisionEnter = 'yes'; }, collisionExit() { document.body.dataset.collisionExit = 'yes'; } };";
    const scripts = createObjectScripts([npc, moving], new THREE.Scene(), new THREE.PerspectiveCamera(), THREE,
      message => errors.push(message), () => {}, []);
    scripts.start();
    const collisions = createCollisionSystem((id, method, other) => scripts.trigger(id, method, other));
    collisions.begin();
    advancePhysics([npc, moving], 0.01, 0, THREE, (a, b) => collisions.contact(a, b));
    collisions.end();
    const pushed = moving.object.position.x;
    moving.object.position.x = 5;
    collisions.begin();
    advancePhysics([npc, moving], 0.01, 0, THREE, (a, b) => collisions.contact(a, b));
    collisions.end();
    return { stopped, furthest, errors, recoveries, detour, reached, crossed, pushed, entered: document.body.dataset.collisionEnter, exited: document.body.dataset.collisionExit };
  `)() as { stopped: number; furthest: number; errors: string[]; recoveries: string[]; detour: number; reached: number; crossed: boolean; pushed: number; entered?: string; exited?: string });
  expect(result.stopped).toBeLessThan(0.9);
  expect(result.furthest).toBeGreaterThan(1.9);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('No usable route');
  expect(result.recoveries).toEqual(result.errors);
  expect(result.detour).toBeGreaterThan(0.9);
  expect(result.reached).toBeGreaterThan(1.9);
  expect(result.crossed).toBe(false);
  expect(result.pushed).toBeGreaterThan(0.45);
  expect(result.entered).toBe('yes');
  expect(result.exited).toBe('yes');
});

test('a play notification does not block exporting', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Play mode stopped')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click({ timeout: 5000 });
  expect(await download).toBeTruthy();
});

test('export prevents duplicate requests and recovers after an error', async ({ page }) => {
  await page.addInitScript(() => {
    URL.createObjectURL = () => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Export"]');
      document.body.dataset.exportWasDisabled = String(button?.disabled);
      throw new Error('Simulated export failure');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText('Simulated export failure')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-export-was-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
});

test('web scenes with a character retain movement instructions', async ({ page }, testInfo) => {
  await page.goto('/');
  await enablePlayer(page);
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText('WASD / Arrow Keys - Move')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openDownloadedGame(page, testInfo);
  await expect(page.locator('#controls')).toBeVisible();
});

test('downloaded game runs from disk and supports movement and jumping', async ({ page }, testInfo) => {
  await page.goto('/');
  await enablePlayer(page);
  await openDownloadedGame(page, testInfo);
  await page.waitForTimeout(500);
  const position = () => page.evaluate(() =>
    Function('return sceneObjects[0].object.position.toArray()')() as [number, number, number]
  );
  const before = await position();
  await page.keyboard.down('d');
  await page.waitForTimeout(350);
  await page.keyboard.up('d');
  expect((await position())[0]).toBeGreaterThan(before[0] + 0.1);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  expect((await position())[1]).toBeGreaterThan(before[1] + 0.2);
});

test('downloaded game supports landing and jumping on a platform', async ({ page }, testInfo) => {
  await page.goto('/');
  await enablePlayer(page);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(1).fill('1');
  await fields.nth(6).fill('3');
  await fields.nth(7).fill('0.5');
  await fields.nth(8).fill('3');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await page.getByRole('region', { name: 'Physics' }).getByRole('checkbox').first().check();
  await page.getByRole('region', { name: 'Physics' }).getByRole('checkbox').nth(2).check();
  await openDownloadedGame(page, testInfo);
  await page.evaluate(() => {
    Function('sceneObjects[0].object.position.set(0, 3, 0); sceneObjects[0].properties.physics.velocity = [0, 0, 0]')();
  });
  const state = () => page.evaluate(() =>
    Function('return { y: sceneObjects[0].object.position.y, grounded: sceneObjects[0].properties.characterController.isGrounded }')() as { y: number; grounded: boolean }
  );
  await expect.poll(async () => {
    const current = await state();
    return current.grounded && current.y >= 1.7 && current.y < 1.9;
  }, { timeout: 5000 }).toBe(true);
  const landed = await state();
  expect(landed.y).toBeGreaterThan(1.5);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  expect((await state()).y).toBeGreaterThan(landed.y + 0.2);
});
