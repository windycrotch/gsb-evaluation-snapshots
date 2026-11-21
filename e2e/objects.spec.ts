import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addObject, extractExport, serveExport } from './helpers';

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/projects');
  expect(response.ok()).toBe(true);
  const projects = await response.json() as { id: string; name: string }[];
  for (const project of projects.filter(item => ['Mixed components test', 'Scene agent test'].includes(item.name))) {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
  }
});

test('scene agent creates objects, adds assets and removes scene instances after review', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'agent-image.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
  });
  await expect(page.getByRole('button', { name: 'Add agent-image.png to scene' })).toBeVisible();
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: { objects: { id: string }[]; assets: { id: string }[] } };
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Replace the box and add content',
      removals: [body.context.objects[0].id],
      additions: [
        { kind: 'primitive', type: 'sphere', name: 'Agent sphere', position: [1, 2, 3], javascript: "return { start() { document.body.dataset.sphere = 'started'; } };" },
        { kind: 'asset', assetId: body.context.assets[0].id, usage: '3d', name: 'Agent image' },
        { kind: 'web', type: 'heading', name: 'Agent title', text: 'Created by agent', css: 'color: rgb(23, 45, 67);' }
      ] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Replace box and add content');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  const proposal = page.getByRole('region', { name: 'Scene change proposal' });
  await expect(proposal).toContainText('Remove from scene: Box');
  await expect(proposal).toContainText('agent-image.png as 3d');
  await expect(proposal).toContainText('Agent sphere');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Add agent-image.png to scene' })).toBeVisible();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Scene agent test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(3);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Created by agent' })).toHaveCSS('color', 'rgb(23, 45, 67)');
  await expect(page.locator('body')).toHaveAttribute('data-sphere', 'started');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const data = JSON.parse(await zip.file('scene.json')!.async('string')) as { objects: { name: string; properties: { position: number[] } }[] };
  expect(data.objects.map(object => object.name)).toEqual(['Agent sphere', 'Agent image', 'Agent title']);
  expect(data.objects[0].properties.position).toEqual([1, 2, 3]);
  const directory = testInfo.outputPath('agent-add-remove');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.getByRole('heading', { name: 'Created by agent' })).toHaveCSS('color', 'rgb(23, 45, 67)', { timeout: 15000 });
  await expect(page.locator('body')).toHaveAttribute('data-sphere', 'started');
  await expect(page.locator('#load-error')).toBeHidden();
});

test('model discovery and agent timeline proposals are visible and survive export', async ({ page }, testInfo) => {
  await page.route('**/api/ai/models', async route => {
    await route.fulfill({ json: { models: ['local-model-a', 'local-model-b'] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Agent timeline');
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { model: string; prompt: string; context: {
      objects: { id: string; type: string }[]; timeline: { duration: number }; scenes: { id: string }[]
    } };
    expect(body.model).toBe('local-model-a');
    expect(body.prompt.length).toBe(15000);
    expect(body.context.timeline.duration).toBe(5);
    expect(body.context.scenes.length).toBe(1);
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Animate heading',
      edits: [{ objectId: body.context.objects[0].id, web: { text: 'Agent timeline updated', color: '#123456' } }],
      timelineTracks: [{ targetId: body.context.objects[0].id, property: 'web.opacity',
        keyframes: [{ time: 0, value: 0 }, { time: 5, value: 1, easing: 'linear' }] }] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByLabel('AI model')).toHaveValue('local-model-a');
  await expect(page.getByText('2 available')).toBeVisible();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('x'.repeat(15000));
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByRole('region', { name: 'Scene change proposal' })).toContainText('Heading / web.opacity');
  await expect(page.getByRole('region', { name: 'Scene change proposal' })).toContainText('Agent timeline updated');
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Agent timeline updated' });
  await expect(heading).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect.poll(async () => Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const scene = JSON.parse(await zip.file('scene.json')!.async('string')) as { sceneOptions: { timeline: { tracks: { property: string }[] } } };
  expect(scene.sceneOptions.timeline.tracks[0].property).toBe('web.opacity');
  const directory = testInfo.outputPath('agent-timeline');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect.poll(async () => Number(await heading.evaluate(element => getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await expect(heading).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(page.locator('#load-error')).toBeHidden();
});

test('model discovery errors remain visible and allow manual model entry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/ai/models', async route => {
    if (fail) await route.fulfill({ status: 502, json: { error: 'Model service unavailable' } });
    else {
      await new Promise(resolve => setTimeout(resolve, 300));
      await route.fulfill({ json: { models: ['other-model'] } });
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByText('Model service unavailable', { exact: false })).toBeVisible();
  await page.getByLabel('AI model').fill('custom-model');
  fail = false;
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect(page.getByText('1 available')).toBeVisible();
  await expect(page.getByLabel('AI model')).toHaveValue('custom-model');
});

test('failed agent asset preparation leaves all scene objects and assets unchanged', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'broken.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('invalid model')
  });
  await expect(page.getByRole('button', { name: 'Add broken.glb to scene' })).toBeVisible();
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: { objects: { id: string }[]; assets: { id: string }[] } };
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Replace box',
      removals: [body.context.objects[0].id],
      additions: [{ kind: 'asset', assetId: body.context.assets[0].id, usage: '3d', name: 'Broken model' }]
    }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Replace box');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByText('Could not prepare Broken model:', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add broken.glb to scene' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reviewed changes' })).toBeEnabled();
});

test('scene agent reviews multiple object edits, screenshot and CSS through Play and export', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const stream = canvas.captureStream(10);
      setTimeout(() => { canvas.getContext('2d')!.fillRect(0, 0, 32, 32); }, 100);
      return stream;
    } });
  });
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Agent heading');
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'asset.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
  });
  await expect(page.getByRole('button', { name: 'Add asset.png to scene' })).toBeVisible();
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as {
      mode: string; screenshot: string;
      context: { objects: { id: string; type: string }[]; assets: { name: string }[] };
    };
    expect(body.mode).toBe('scene-agent');
    expect(body.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.context.assets.map(asset => asset.name)).toContain('asset.png');
    expect(JSON.stringify(body.context)).not.toContain('data:image/');
    const box = body.context.objects.find(object => object.type === 'box')!;
    const heading = body.context.objects.find(object => object.type === 'web')!;
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Update two objects', edits: [
      { objectId: box.id, javascript: "return { start() { document.body.dataset.agentObject = 'yes'; } };" },
      { objectId: heading.id, javascript: "return { start() { element.dataset.applied = 'yes'; } };", css: 'color: rgb(12, 34, 56);' }
    ] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByRole('button', { name: 'Capture screen' }).click();
  await expect(page.getByAltText('Captured screen preview')).toBeVisible();
  await page.getByLabel('AI prompt').fill('Change box and heading');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByRole('region', { name: 'Scene change proposal' })).toContainText('Update two objects');
  await expect(page.getByLabel('Proposed CSS for Heading')).toHaveValue('color: rgb(12, 34, 56);');
  await expect(page.getByLabel('Web custom CSS')).toHaveValue('');
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByLabel('Web custom CSS')).toHaveValue('color: rgb(12, 34, 56);');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Scene agent test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent heading' })).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(page.getByRole('heading', { name: 'Agent heading' })).toHaveAttribute('data-applied', 'yes');
  await expect(page.locator('body')).toHaveAttribute('data-agent-object', 'yes');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('scene-agent');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.getByRole('heading', { name: 'Agent heading' })).toHaveCSS('color', 'rgb(12, 34, 56)', { timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Agent heading' })).toHaveAttribute('data-applied', 'yes');
  await expect(page.locator('body')).toHaveAttribute('data-agent-object', 'yes');
});

test('scene agent rejects unknown edits and refuses a stale proposal', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  let invalid = true;
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: { objects: { id: string }[] } };
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Test', edits: [
      { objectId: invalid ? 'unknown' : body.context.objects[0].id, javascript: 'return {};' }
    ] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Change object');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByText('Assistant referenced an unknown object:', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reviewed changes' })).toHaveCount(0);
  invalid = false;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByRole('button', { name: 'Apply reviewed changes' })).toBeVisible();
  await page.locator('[aria-label="Create scene"]').evaluate((button: HTMLButtonElement) => button.click());
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect(page.getByText('The scene or asset library changed.', { exact: false })).toBeVisible();
});

test('scene agent rejects invalid asset, parent and conflicting removal proposals', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  let attempt = 0;
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: { objects: { id: string }[] } };
    const id = body.context.objects[0].id;
    const changes = [
      { additions: [{ kind: 'asset', name: 'Missing image', assetId: 'missing', usage: 'web' }] },
      { additions: [{ kind: 'web', name: 'Invalid child', type: 'heading', parentId: id }] },
      { edits: [{ objectId: id, javascript: 'return {};' }], removals: [id] },
      { timelineTracks: [{ targetId: id, property: 'position.x', keyframes: [{ time: -0.5, value: 0 }, { time: 1, value: 1 }] }] },
      { edits: [{ objectId: id, web: { text: 'Not a web object' } }] }
    ];
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Invalid change', ...changes[attempt++] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Change scene');
  for (const message of ['invalid asset or usage', 'invalid or deleted web parent', 'cannot edit and remove the same object',
    'Invalid or unordered timeline keyframe', 'visual settings require a web component']) {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText(message, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply reviewed changes' })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
});

test('new AI providers can be selected and send the configured model or workspace', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/ai/generate', async route => {
    const request = route.request().postDataJSON();
    expect(request.prompt).toBe('spin');
    expect(request.model).toBe(request.provider === 'anythingllm' ? 'my-workspace' : 'custom/model');
    await route.fulfill({ json: { code: 'return {};' } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('AI prompt').fill('spin');
  for (const provider of ['openrouter', 'lmstudio', 'anythingllm']) {
    await page.getByLabel('AI provider').selectOption(provider);
    await page.getByLabel(provider === 'anythingllm' ? 'AnythingLLM workspace slug' : 'AI model')
      .fill(provider === 'anythingllm' ? 'my-workspace' : 'custom/model');
    page.once('dialog', dialog => dialog.accept());
    const response = page.waitForResponse('**/api/ai/generate');
    await page.getByRole('button', { name: 'Generate code' }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByLabel('Generated code')).toHaveValue('return {};');
  }
});

test('single-object assistant uses web script context and applies to the selected component', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web script').fill("return { start() { element.dataset.old = 'yes'; } };");
  await page.route('**/api/ai/generate', async route => {
    expect(route.request().postDataJSON().targetKind).toBe('web');
    await route.fulfill({ json: { code: "return { start() { element.dataset.agent = 'yes'; } };" } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByText('Target: Heading (web component).', { exact: false })).toBeVisible();
  await page.getByLabel('AI prompt').fill('Update heading');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await page.getByText('Current script', { exact: true }).click();
  await expect(page.getByRole('dialog').getByText("return { start() { element.dataset.old = 'yes'; } };")).toBeVisible();
  await page.getByRole('button', { name: 'Apply to selected object' }).click();
  await expect(page.getByLabel('Web script')).toHaveValue("return { start() { element.dataset.agent = 'yes'; } };");
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your heading' })).toHaveAttribute('data-agent', 'yes');
});

test('single-object assistant rejects stale targets and clears code after a failed regeneration', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  let fail = false;
  await page.route('**/api/ai/generate', async route => {
    if (fail) await route.fulfill({ status: 502, json: { error: 'Generation failed' } });
    else await route.fulfill({ json: { code: "return { start() { element.dataset.agent = 'yes'; } };" } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('AI prompt').fill('Update heading');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByLabel('Generated code')).toBeVisible();
  await page.getByRole('button', { name: 'Select', exact: true }).first().evaluate((button: HTMLButtonElement) => button.click());
  await page.getByRole('button', { name: 'Apply to selected object' }).click();
  await expect(page.getByText('The selected target changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  fail = true;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByText('Generation failed; no changes were applied.')).toBeVisible();
  await expect(page.getByLabel('Generated code')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply to selected object' })).toHaveCount(0);
});

test('scroll rotates the chosen axis in Play and exported code', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.scrollRotation = JSON.stringify([object.rotation.x, object.rotation.y]); } };");
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  await page.getByRole('button', { name: 'Rotation', exact: true }).click();
  await page.getByLabel('Animation trigger').selectOption('mouseWheel');
  await page.getByLabel('Rotation speed x').fill('1');
  await page.getByLabel('Rotation speed y').fill('0');
  await expect(page.getByLabel('Scroll direction')).toHaveValue('both');
  await expect(page.getByLabel('Rotation speed y')).toHaveValue('0');
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        resolve(read.result?.currentScene.objects[0]?.properties.animations?.[0]?.params.rotationSpeed?.y);
        database.close();
      };
    };
  }))).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  await expect(page.getByLabel('Animation trigger')).toHaveValue('mouseWheel');
  const rotation = async () => JSON.parse((await page.locator('body').getAttribute('data-scroll-rotation')) ?? '[0,0]') as number[];
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 30, canvas.y + 150);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await rotation())[0]).toBeCloseTo(1, 2);
  expect((await rotation())[1]).toBeCloseTo(0, 2);
  await page.mouse.wheel(0, -50);
  await expect.poll(async () => (await rotation())[0]).toBeCloseTo(0.5, 2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('scroll-rotation');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await page.mouse.move(50, 150);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await rotation())[0]).toBeCloseTo(1, 2);
  expect((await rotation())[1]).toBeCloseTo(0, 2);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('selected play camera persists and matches the exported player', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { start() { document.body.dataset.cameraPose = JSON.stringify([camera.position.x, camera.position.y, camera.position.z, camera.rotation.y, camera.fov]); }, stop() { camera.position.x = 10000; } };");
  await addObject(page, 'Camera');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(0).fill('3');
  await fields.nth(1).fill('4');
  await fields.nth(2).fill('8');
  await fields.nth(4).fill('30');
  await page.getByRole('button', { name: 'Camera Settings' }).click();
  await page.getByRole('region', { name: 'Camera Settings' }).getByRole('slider').fill('60');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption({ label: 'Camera' });
  const cameraId = await page.getByLabel('Play Camera').inputValue();
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.sceneOptions.activeCameraId); database.close(); };
    };
  }))).toBe(cameraId);
  await page.reload();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByLabel('Play Camera')).toHaveValue(cameraId);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('body').getAttribute('data-camera-pose')).not.toBeNull();
  const editorPose = JSON.parse((await page.locator('body').getAttribute('data-camera-pose'))!) as number[];
  expect(editorPose[0]).toBeCloseTo(3);
  expect(editorPose[1]).toBeCloseTo(4);
  expect(editorPose[2]).toBeCloseTo(8);
  expect(editorPose[3]).toBeCloseTo(Math.PI / 6);
  expect(editorPose[4]).toBe(60);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption('');
  await page.evaluate(() => { delete document.body.dataset.cameraPose; });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('body').getAttribute('data-camera-pose')).not.toBeNull();
  const restoredPose = JSON.parse((await page.locator('body').getAttribute('data-camera-pose'))!) as number[];
  expect(restoredPose[0]).not.toBe(10000);
  expect(restoredPose[4]).not.toBe(60);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption(cameraId);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('camera-game');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect.poll(() => page.locator('body').getAttribute('data-camera-pose'), { timeout: 15000 }).not.toBeNull();
  const exportedPose = JSON.parse((await page.locator('body').getAttribute('data-camera-pose'))!) as number[];
  exportedPose.forEach((value, index) => expect(value).toBeCloseTo(editorPose[index]));
  await expect(page.locator('#load-error')).toBeHidden();
});

test('deleting the active camera returns to the default camera', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Camera');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption({ label: 'Camera' });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByLabel('Play Camera')).toHaveValue('');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
});

test('non-looping object animations run from start and hold their end in editor and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.moveX = String(object.position.x); document.body.dataset.rotateY = String(object.rotation.y); } };");
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  for (const kind of ['Rotation', 'Movement']) {
    await page.getByRole('button', { name: kind, exact: true }).click();
    const card = page.getByText(kind.toLowerCase(), { exact: true }).locator('..').locator('..');
    await card.getByRole('spinbutton').first().fill('300');
    await card.getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: `Enable ${kind.toLowerCase()} play on start` }).click();
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const movement = () => page.locator('body').getAttribute('data-move-x').then(Number);
  const rotation = () => page.locator('body').getAttribute('data-rotate-y').then(Number);
  await expect.poll(movement).toBeGreaterThan(0.99);
  await expect.poll(rotation).toBeGreaterThan(0.29);
  await page.waitForTimeout(500);
  expect(await movement()).toBeCloseTo(1, 2);
  expect(await rotation()).toBeCloseTo(0.3, 2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('object-animations');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect.poll(movement, { timeout: 15000 }).toBeGreaterThan(0.99);
  await expect.poll(rotation).toBeGreaterThan(0.29);
  await page.waitForTimeout(500);
  expect(await movement()).toBeCloseTo(1, 2);
  expect(await rotation()).toBeCloseTo(0.3, 2);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('3D and web components coexist through save, play and export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  for (const name of ['Ground', 'Box', 'Sphere', 'Cylinder', 'Cone', 'Point Light', 'Spot Light', 'Camera']) {
    await addObject(page, name);
  }
  for (const kind of ['section', 'columns', 'heading', 'text', 'button', 'menu', 'image']) {
    await page.getByRole('button', { name: `Add web ${kind}` }).click();
  }
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(15);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Mixed components test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(15);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.locator('.engine-web-node[data-kind="button"]')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const snapshot = JSON.parse(await zip.file('scene.json')!.async('string')) as { objects: { type: string }[] };
  expect(snapshot.objects).toHaveLength(15);
  const directory = testInfo.outputPath('mixed-components');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.locator('.engine-web-node[data-kind="button"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Function('return sceneObjects.filter(item => item.type === "web").length')() as number)).toBe(7);
});

test('object metadata and script survive reload and run in editor and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Identity' }).click();
  await page.getByLabel('Object name').fill('Hero');
  await page.getByLabel('Object class').fill('Player');
  await page.getByLabel('Object tags').fill('hero, friendly');
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill('return { update(delta) { object.position.x += delta * 2; } };');
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.objects[0]?.properties.script); database.close(); };
    };
  }))).toContain('object.position.x');
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Identity' }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('Hero');
  await expect(page.getByLabel('Object tags')).toHaveValue('hero, friendly');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  if (process.env.E2E_PREVIEW !== '1') {
    await expect.poll(() => page.evaluate(async () => {
      const path = '/src/store/editorStore.ts';
      const { useEditorStore } = await import(/* @vite-ignore */ path);
      return useEditorStore.getState().sceneObjects[0].object.position.x as number;
    })).toBeGreaterThan(0.1);
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = await (await downloadPromise).path();
  expect(path).not.toBeNull();
  const zip = await JSZip.loadAsync(await readFile(path!));
  const scene = JSON.parse(await zip.file('scene.json')!.async('string'));
  expect(scene.objects[0].name).toBe('Hero');
  expect(scene.objects[0].properties.className).toBe('Player');
  expect(scene.objects[0].properties.tags).toEqual(['hero', 'friendly']);
  const directory = testInfo.outputPath('script-game');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect.poll(() => page.evaluate(() => Function('return sceneObjects[0]?.object.position.x ?? 0')() as number), { timeout: 15000 }).toBeGreaterThan(0.1);
});

test('image and audio components are restored after reload', async ({ page }) => {
  await page.goto('/');
  const image = { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') };
  await page.getByLabel('Add image plane').setInputFiles(image);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.getByLabel('Add image sprite').setInputFiles(image);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  const wave = Buffer.alloc(16044);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(16000, 40);
  await page.getByLabel('Add audio source').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wave });
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result?.currentScene.objects.length ?? 0); database.close(); };
    };
  }))).toBe(3);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByLabel('AI provider')).toHaveValue('ollama');
  await page.getByRole('button', { name: 'Close options' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.route('**/api/ai/generate', async route => {
    expect(route.request().postDataJSON().prompt).toBe('spin');
    expect(route.request().postDataJSON().thinking).toBe(false);
    expect(route.request().postDataJSON().temperature).toBe(0);
    await route.fulfill({ json: { code: 'return { update(delta) { object.rotation.y += delta; } };' } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('AI prompt').fill('spin');
  await page.getByLabel('Enable model reasoning').uncheck();
  await page.getByLabel('Ollama temperature').fill('0');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByLabel('Generated code')).toHaveValue(/object.rotation.y/);
  await page.getByLabel('Generated code').fill('return {');
  await page.getByRole('button', { name: 'Apply to selected object' }).click();
  await expect(page.getByText('Invalid JavaScript:', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Generated code').fill('return { update(delta) { object.rotation.y += delta; } };');
  await page.getByRole('button', { name: 'Apply to selected object' }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await expect(page.getByLabel('Object script')).toHaveValue(/object.rotation.y/);
});
