import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { addObject, serveExport } from './helpers';

const pixelA = {
  name: 'pixel.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
};
// Same file name, different content.
const pixelB = {
  name: 'pixel.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
};

async function downloadExport(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return JSZip.loadAsync(await readFile((await (await download).path())!));
}

function fileNames(zip: JSZip) {
  return Object.values(zip.files).filter(file => !file.dir).map(file => file.name);
}

async function readSceneJson(zip: JSZip) {
  return JSON.parse(await zip.file('scene.json')!.async('string')) as {
    objects: { type: string; properties: { map?: string } }[];
    sceneOptions: { name: string };
    otherScenes?: { objects: { type: string; properties: { map?: string } }[]; sceneOptions: { name: string } }[];
  };
}

// Every web3dassets reference in scene.json must resolve to a real ZIP entry.
function expectReferencesResolve(zip: JSZip, scene: unknown) {
  const references = [...JSON.stringify(scene).matchAll(/web3dassets\/[^"\\]+/g)].map(match => match[0]);
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) expect(zip.file(reference), reference).not.toBeNull();
  return references;
}

async function expectPageRuns(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

test('single-scene export packages assets and runs standalone', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(pixelA);

  const zip = await downloadExport(page);
  const names = fileNames(zip);
  expect(names).toContain('index.html');
  expect(names).toContain('scene.js');
  expect(names).toContain('scene.json');
  expect(names).not.toContain('scene-1.html');
  expect(names).not.toContain('scene-1.js');
  const assets = names.filter(name => name.startsWith('web3dassets/'));
  expect(assets).toHaveLength(1);

  const scene = await readSceneJson(zip);
  expect(scene.otherScenes ?? []).toHaveLength(0);
  expect(scene.objects[0].properties.map).toBe(assets[0]);
  expectReferencesResolve(zip, scene);
  expect(await zip.file(assets[0])!.async('nodebuffer')).toEqual(pixelA.buffer);
  expect(await zip.file('scene.js')!.async('string')).not.toContain('data:image/png;base64,');

  await expectPageRuns(page, await serveExport(page, zip, testInfo.outputPath('single-scene')));
});

test('multi-scene export dedupes assets, names pages in scene order and navigates between real pages', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.goto('/');
  // Scene 1 ("New Scene"): box textured with pixelA.
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(pixelA);
  // Create scenes 2 and 3, then fill scene 2.
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(pixelB);
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('To page 3');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Scene 3 / Page 3' });
  // Scene 3 reuses pixelA (same data as scene 1) and links back to the main scene.
  await page.getByRole('button', { name: 'Open scene Scene 3 / Page 3' }).click();
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(pixelA);
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Back to start');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'New Scene' });
  // Scene 1 links forward to scene 2.
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('To page 2');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Scene 2 / Page 2' });

  const zip = await downloadExport(page);
  const names = fileNames(zip);
  for (const file of ['index.html', 'scene-1.html', 'scene-2.html', 'scene.js', 'scene-1.js', 'scene-2.js', 'scene.json']) {
    expect(names).toContain(file);
  }
  // pixelA is shared by scenes 1 and 3 (one file); pixelB has the same file name but
  // different content and must be kept as a second file.
  const assets = names.filter(name => name.startsWith('web3dassets/'));
  expect(assets).toHaveLength(2);

  const scene = await readSceneJson(zip);
  expect(scene.sceneOptions.name).toBe('New Scene');
  const [scene2, scene3] = scene.otherScenes!;
  expect(scene2.sceneOptions.name).toBe('Scene 2 / Page 2');
  expect(scene3.sceneOptions.name).toBe('Scene 3 / Page 3');
  const mainMap = scene.objects[0].properties.map!;
  const map2 = scene2.objects[0].properties.map!;
  const map3 = scene3.objects[0].properties.map!;
  expect(mainMap).toMatch(/^web3dassets\//);
  expect(map3).toBe(mainMap);
  expect(map2).not.toBe(mainMap);
  expect(await zip.file(mainMap)!.async('nodebuffer')).toEqual(pixelA.buffer);
  expect(await zip.file(map2)!.async('nodebuffer')).toEqual(pixelB.buffer);
  expectReferencesResolve(zip, scene);
  expect(await zip.file('scene.js')!.async('string')).not.toContain('data:image/png;base64,');
  expect(await zip.file('scene-1.js')!.async('string')).not.toContain('data:image/png;base64,');

  // Every exported page opens and navigation hits real pages.
  const root = await serveExport(page, zip, testInfo.outputPath('multi-scene'));
  await expectPageRuns(page, root);
  await page.getByRole('button', { name: 'To page 2' }).click();
  await expect(page).toHaveURL(/scene-1\.html/, { timeout: 15000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await page.getByRole('button', { name: 'To page 3' }).click();
  await expect(page).toHaveURL(/scene-2\.html/, { timeout: 15000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await page.getByRole('button', { name: 'Back to start' }).click();
  await expect(page).toHaveURL(/index\.html/, { timeout: 15000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#load-error')).toBeHidden();
  for (const file of ['index.html', 'scene-1.html', 'scene-2.html']) {
    await expectPageRuns(page, root.replace('index.html', file));
  }
});

test('a missing scene target reports an in-page error instead of a blank page', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Open missing');
  await page.getByLabel('Web action').selectOption('scene');
  await page.getByLabel('Web action target').selectOption({ label: 'Scene 2 / Page 2' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete scene Scene 2 / Page 2' }).click();

  const zip = await downloadExport(page);
  const root = await serveExport(page, zip, testInfo.outputPath('missing-target'));
  await page.goto(root);
  await page.getByRole('button', { name: 'Open missing' }).click({ timeout: 15000 });
  await expect(page.locator('#load-error')).toHaveText('Target scene no longer exists');
  await expect(page).toHaveURL(/index\.html/);
});

test('a broken asset aborts the export and a fixed project exports cleanly', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles(pixelA);

  // Corrupt the stored texture so decoding fails during packaging.
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    state.updateObjectProperties(state.sceneObjects[0].id, { map: 'data:image/png;base64,!!!not-valid-base64!!!' });
  });
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/Could not decode export asset/)).toBeVisible();
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();

  // Fix the asset and re-export: the result must be complete, with no stale paths.
  await page.evaluate(async (dataUrl) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    state.updateObjectProperties(state.sceneObjects[0].id, { map: dataUrl });
  }, `data:image/png;base64,${pixelA.buffer.toString('base64')}`);
  const zip = await downloadExport(page);
  const assets = fileNames(zip).filter(name => name.startsWith('web3dassets/'));
  expect(assets).toHaveLength(1);
  const scene = await readSceneJson(zip);
  expect(scene.objects[0].properties.map).toBe(assets[0]);
  expect(JSON.stringify(scene)).not.toContain('not-valid-base64');
  expectReferencesResolve(zip, scene);
  expect(await zip.file(assets[0])!.async('nodebuffer')).toEqual(pixelA.buffer);

  await expectPageRuns(page, await serveExport(page, zip, testInfo.outputPath('retried-export')));
});

test('a font download failure aborts the export and a retry succeeds', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'SDF Text');
  await page.route(/\.woff(\?.*)?$/, route => route.abort());
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/Could not load bundled font/)).toBeVisible();
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();

  await page.unroute(/\.woff(\?.*)?$/);
  const zip = await downloadExport(page);
  expect(zip.file('vendor/noto-latin.woff')).not.toBeNull();
  expect(zip.file('vendor/noto-latin-ext.woff')).not.toBeNull();
  await expectPageRuns(page, await serveExport(page, zip, testInfo.outputPath('font-retry')));
});
