import { test, expect } from '@playwright/test';
import { addObject, enablePlayer, extractExport, serveExport } from './helpers';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';

async function setupDestination(page: Page) {
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Destination reached');
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
}

async function openExport(page: Page, testInfo: TestInfo, directoryName: string, hasScripts = false) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath(directoryName);
  await extractExport(zip, directory);
  if (hasScripts) page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
}

test('non-looping object animation opens a scene only after completion', async ({ page }, testInfo) => {
  await page.goto('/');
  await setupDestination(page);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  await page.getByRole('button', { name: 'Movement', exact: true }).click();
  const animation = page.getByText('movement', { exact: true }).locator('..').locator('..');
  await animation.getByRole('spinbutton').first().fill('500');
  await page.getByLabel('movement completion scene').selectOption({ label: 'Scene 2 / Page 2' });
  await page.getByRole('button', { name: 'Enable movement play on start' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Animations', exact: true }).click();
  await animation.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo, 'animation-transition');
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
});

test('web entrance completion opens a scene in normal and reduced motion', async ({ page }, testInfo) => {
  await page.goto('/');
  await setupDestination(page);
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Intro');
  await page.getByLabel('Web animation', { exact: true }).selectOption('fade');
  await page.getByLabel('Web event').selectOption('animationEnd');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Scene 2 / Page 2' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openExport(page, testInfo, 'web-animation-transition');
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible({ timeout: 15000 });
});

test('object and web scripts can navigate and stopped scripts cannot navigate later', async ({ page }, testInfo) => {
  await page.goto('/');
  await setupDestination(page);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { start() { setTimeout(() => openScene(scenes.find(s => s.name === 'Scene 2 / Page 2').id), 1200); } };");
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('button', { name: 'Open scene New Scene' })).toHaveAttribute('aria-current', 'page');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo, 'object-script-transition', true);
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible({ timeout: 15000 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill('');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Script transition');
  await page.getByLabel('Web script').fill("return { click() { openScene(scenes.find(s => s.name === 'Scene 2 / Page 2').id); } };");
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Script transition' }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo, 'script-transition', true);
  await page.getByRole('button', { name: 'Script transition' }).click({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible({ timeout: 15000 });
});

test('scene buttons navigate in Play and an exported multi-page project', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Go to second');
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Second page');
  await page.getByLabel('Web margin top').fill('13');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Return to first');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'New Scene' });
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Scene 2 / Page 2' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Go to second' }).click();
  await expect(page.getByRole('heading', { name: 'Second page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Second page' })).toHaveCSS('margin-top', '13px');
  await page.getByRole('button', { name: 'Return to first' }).click();
  await expect(page.getByRole('button', { name: 'Go to second' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to second' }).click();
  await expect(page.getByRole('heading', { name: 'Second page' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open scene New Scene' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('multi-page');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.getByRole('button', { name: 'Go to second' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Go to second' }).click();
  await expect(page.getByRole('heading', { name: 'Second page' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Second page' })).toHaveCSS('margin-top', '13px');
  await page.getByRole('button', { name: 'Return to first' }).click();
  await expect(page.getByRole('button', { name: 'Go to second' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
});

test('scene agent identifies types and creates a reviewed scene button', async ({ page }, testInfo) => {
  await page.goto('/');
  await setupDestination(page);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  let invalid = true;
  await page.route('**/api/ai/generate', async route => {
    const body = route.request().postDataJSON() as { context: {
      activeSceneId: string;
      objects: { type: string; gameengine_type: string }[];
      scenes: { id: string; name: string; objects?: { gameengine_type: string }[] }[];
      gameengine_actions: Record<string, string>;
    } };
    expect(body.context.objects.find(item => item.type === 'box')?.gameengine_type).toBe('box');
    expect(body.context.objects.find(item => item.type === 'web')?.gameengine_type).toBe('heading');
    expect(body.context.gameengine_actions.addscenebutton).toContain('sceneId');
    const destination = body.context.scenes.find(scene => scene.id !== body.context.activeSceneId)!;
    expect(destination.objects?.[0].gameengine_type).toBe('heading');
    await route.fulfill({ json: { code: JSON.stringify({ summary: 'Add a page button', additions: [{
      kind: 'web', type: 'button', name: 'Page button', parentId: null, text: 'Open destination',
      sceneId: invalid ? 'unknown-scene' : destination.id
    }] }) } });
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByLabel('Assistant mode').selectOption('scene');
  await page.getByLabel('AI prompt').fill('Add a button to the second scene');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByText('Page button: invalid destination scene for button.')).toBeVisible();
  invalid = false;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Generate code' }).click();
  await expect(page.getByRole('region', { name: 'Scene change proposal' })).toContainText('Destination: Scene 2 / Page 2');
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Open destination' }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  await page.goto(await serveExport(page, zip, testInfo.outputPath('agent-scene-button')));
  await page.getByRole('button', { name: 'Open destination' }).click();
  await expect(page.getByRole('heading', { name: 'Destination reached' })).toBeVisible();
});

test('multiple scenes retain independent objects through save, reopen and deletion', async ({ page, request }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Create scene' }).click();
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No objects in scene yet.', { exact: false })).toBeVisible();
  await addObject(page, 'Sphere');
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await expect(page.getByText('Box', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.locator('.group').filter({ hasText: 'Sphere' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Reset Scene' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'New Scene', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' }).click();
  await expect(page.locator('.group').filter({ hasText: 'Sphere' }).last()).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete scene Scene 2 / Page 2' }).click();
  await expect(page.getByRole('button', { name: 'Open scene New Scene' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toHaveCount(0);
  const projects = await (await request.get('/api/projects')).json() as { id: string; name: string }[];
  for (const project of projects.filter(item => item.name === 'New Scene')) await request.delete(`/api/projects/${project.id}`);
});

test('new project starts with independent scenes and assets and persists', async ({ page, request }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'old.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  });
  await expect(page.getByRole('button', { name: 'Remove old.svg' })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('New project name').fill('Independent project');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await (await request.get('/api/projects')).json() as { name: string }[])
    .some(item => item.name === 'Independent project')).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByText('New project created')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove old.svg' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open scene Independent project' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'New Scene', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove old.svg' })).toBeVisible();
  const projects = await (await request.get('/api/projects')).json() as { id: string; name: string }[];
  for (const project of projects.filter(item => ['New Scene', 'Independent project'].includes(item.name))) {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
  }
});

test('renaming scenes persists and deleted scene links report an error', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create scene' }).click();
  page.once('dialog', dialog => dialog.accept('Destination'));
  await page.getByRole('button', { name: 'Rename scene Scene 2 / Page 2' }).click();
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Open destination');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Destination' });
  const targetId = await page.getByLabel('Web action target').inputValue();
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const open = indexedDB.open('game-engine-editor');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('editor').objectStore('editor').get('current');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result?.currentScene.objects[0]?.properties.web?.targetId);
        open.result.close();
      };
    };
  }))).toBe(targetId);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open scene Destination' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete scene Destination' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Open destination' }).click();
  await expect(page.getByText('Target scene no longer exists')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('missing-scene');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await page.getByRole('button', { name: 'Open destination' }).click({ timeout: 15000 });
  await expect(page.locator('#load-error')).toHaveText('Target scene no longer exists');
});

test('scene can be saved, reopened and deleted', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Game Engine Editor');
  await enablePlayer(page);
  await addObject(page, 'Ground');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset Scene' }).click();
  await expect(page.getByText('No objects in scene yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'New Scene', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'Character Controller', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Character Controller' }).getByRole('checkbox').first()).toBeChecked();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete New Scene' }).click();
  await expect(page.getByText('No saved projects.')).toBeVisible();
});

test('editing a ground plane preserves its rotation across reload', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Ground');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await expect(fields.nth(3)).toHaveValue('-90');
  await fields.nth(0).fill('1');
  await expect.poll(() => page.evaluate(() => new Promise<number | undefined>((resolve, reject) => {
    const open = indexedDB.open('game-engine-editor');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('editor').objectStore('editor').get('current');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result?.currentScene.objects[0]?.properties.position[0]);
        open.result.close();
      };
    };
  }))).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const restored = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await expect(restored.nth(0)).toHaveValue('1');
  await expect(restored.nth(3)).toHaveValue('-90');
});
