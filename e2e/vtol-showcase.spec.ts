import { test, expect, type Page, type Locator } from '@playwright/test';
import JSZip from 'jszip';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addObject, serveExport } from './helpers';

test.skip(process.env.VTOL_SHOWCASE !== '1', 'Run explicitly with VTOL_SHOWCASE=1 and the local VTOL asset.');
test.setTimeout(600000);

async function selectSceneItem(page: Page, name: string) {
  const list = page.locator('.absolute.bottom-0');
  await list.getByText(name, { exact: true }).locator('..').locator('..').getByTitle('Select').click({ timeout: 15000 });
}

async function styleWeb(page: Page, text: string, width: number, size: number, background: string) {
  await page.getByLabel('Web text', { exact: true }).fill(text);
  await page.getByLabel('Web width').fill(String(width));
  await page.getByLabel('Web font size').fill(String(size));
  await page.getByLabel('Web background', { exact: true }).fill(background);
}

async function configureTrack(page: Page, property: string, objectName: string, values: number[]) {
  await page.getByLabel('Timeline channel').selectOption(property);
  await page.getByRole('button', { name: 'Add channel', exact: true }).click();
  const row: Locator = page.getByRole('button', { name: `Delete ${objectName} ${property} channel` }).locator('..').locator('..');
  await row.getByRole('button', { name: 'Add keyframe' }).click();
  await row.getByLabel(`${property} keyframe time`).nth(1).fill('2');
  await row.getByRole('button', { name: 'Add keyframe' }).click();
  await row.getByLabel(`${property} keyframe time`).nth(2).fill('4');
  for (let index = 0; index < values.length; index++) {
    await row.getByLabel(`${property} keyframe value`).nth(index).fill(String(values[index]));
  }
}

test('VTOL showcase is authored in the editor and works after export', async ({ page }, testInfo) => {
  const started = Date.now();
  const progress = (stage: string) => console.log(`VTOL ${stage}: ${Math.round((Date.now() - started) / 1000)}s`);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/');
  const models = join(process.cwd(), 'test 3d assets', 'vtol');
  const filename = (await readdir(models)).find(name => name.toLowerCase().endsWith('.glb'));
  if (!filename) throw new Error('VTOL GLB was not found in test 3d assets');
  await page.locator('#model-upload').setInputFiles(join(models, filename));
  await expect(page.getByText('Loaded', { exact: false }).first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  await page.getByLabel('Object name').fill('AEROVA VTOL');
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Material Type').selectOption('basic');

  await addObject(page, 'Camera');
  await selectSceneItem(page, 'Camera');
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const transform = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await transform.nth(1).fill('1');
  await transform.nth(2).fill('4');
  await transform.nth(3).fill('-12');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Play Camera').selectOption({ label: 'Camera' });
  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  await page.getByRole('region', { name: 'Lighting' }).getByRole('slider').fill('1');
  progress('model and camera');

  const sections = [
    { name: 'Hero', title: 'Ucusun yeni perspektifi.', detail: 'AEROVA VTOL | Yeni nesil kentsel hava araci konsepti.', button: 'Motoru incele' },
    { name: 'Propulsion', title: 'Itis sistemine yakindan bakin.', detail: 'Scroll ile araci dondurun, itis konseptini kesfedin.', button: 'Kabini kesfet' },
    { name: 'Cabin', title: 'Yolculugun merkezi: kabin.', detail: 'Ucus deneyimini farkli bir aciyla inceleyin.', button: 'Teklif bilgisi' },
    { name: 'Contact', title: 'Gelecege birlikte bakalim.', detail: 'Bu ornek bir konsept tanitimidir. Odeme veya gercek siparis alinmaz.', button: '' }
  ];
  for (const section of sections) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
    await page.getByLabel('Web component name').fill(section.name);
    await page.getByLabel('Web background', { exact: true }).fill('transparent');
    await page.getByLabel('Web height').fill('820');
    await page.getByLabel('Web padding').fill('40');
    await page.getByRole('button', { name: 'Add web heading' }).click();
    await styleWeb(page, section.title, 450, 52, 'rgba(5, 14, 28, 0.78)');
    await page.getByLabel('Web border radius').fill('14');
    await page.getByLabel('Web animation').selectOption('slide');
    await page.getByLabel('Web animation trigger').selectOption('scroll');
    await page.getByRole('button', { name: 'Add web text' }).click();
    await styleWeb(page, section.detail, 450, 20, 'rgba(5, 14, 28, 0.78)');
    await page.getByLabel('Web border radius').fill('14');
    if (section.button) {
      await page.getByRole('button', { name: 'Add web button' }).click();
      await page.getByLabel('Web component name').fill(section.button);
      await styleWeb(page, section.button, 220, 18, '#7ce1cf');
      await page.getByLabel('Web text color').fill('#071820');
      await page.getByLabel('Web border radius').fill('14');
    }
    progress(`section ${section.name}`);
  }
  for (const [button, target] of [['Motoru incele', 'Propulsion'], ['Kabini kesfet', 'Cabin'], ['Teklif bilgisi', 'Contact']]) {
    await selectSceneItem(page, button);
    await page.getByLabel('Web action').selectOption('scroll');
    await page.getByLabel('Web action target').selectOption({ label: target });
  }
  progress('navigation');

  await selectSceneItem(page, 'Camera');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('6');
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await configureTrack(page, 'position.x', 'Camera', [0, -0.8, 0.3, 0]);
  await configureTrack(page, 'position.y', 'Camera', [1, 0.65, 1.15, 1]);
  await configureTrack(page, 'position.z', 'Camera', [4, 2.4, 1.6, 4]);
  await configureTrack(page, 'rotation.x', 'Camera', [-12, -8, -27, -12]);
  await configureTrack(page, 'rotation.y', 'Camera', [0, -18, 12, 0]);
  await page.getByRole('button', { name: 'In Scene', exact: true }).click();
  await selectSceneItem(page, 'AEROVA VTOL');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await configureTrack(page, 'rotation.y', 'AEROVA VTOL', [0, 55, 115, 180]);
  progress('timeline');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const scroll = page.locator('.engine-web-scroll');
  const cameraState = () => page.evaluate(async () => {
    const path = '/src/store/editorStore.ts';
    const { useEditorStore } = await import(/* @vite-ignore */ path);
    const objects = useEditorStore.getState().sceneObjects;
    const camera = objects.find((item: { type: string }) => item.type === 'camera').object;
    const model = objects.find((item: { type: string }) => item.type === 'model').object;
    return { position: camera.position.toArray() as number[], modelY: model.rotation.y as number };
  });
  await expect(page.getByRole('heading', { name: sections[0].title })).toBeVisible();
  const first = await cameraState();
  await page.getByRole('button', { name: 'Motoru incele' }).click();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(400);
  await expect.poll(async () => (await cameraState()).position[2]).toBeLessThan(first.position[2] - 0.5);
  await expect(page.getByRole('heading', { name: sections[1].title })).toBeInViewport();
  await page.getByRole('button', { name: 'Kabini kesfet' }).click();
  await expect(page.getByRole('heading', { name: sections[2].title })).toBeInViewport();
  await expect.poll(async () => (await cameraState()).modelY).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Teklif bilgisi' }).click();
  await expect(page.getByRole('heading', { name: sections[3].title })).toBeInViewport();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  progress('play verified');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zipPath = (await (await download).path())!;
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const directory = testInfo.outputPath('site');
  await page.goto(await serveExport(page, zip, directory));
  await expect(page.getByRole('heading', { name: sections[0].title })).toBeVisible({ timeout: 30000 });
  const exportedState = () => page.evaluate(() => Function('return { z: camera.position.z, y: sceneObjects.find(item => item.type === "model").object.rotation.y }')() as { z: number; y: number });
  const before = await exportedState();
  await page.getByRole('button', { name: 'Motoru incele' }).click();
  await expect(page.getByRole('heading', { name: sections[1].title })).toBeInViewport();
  await expect.poll(async () => (await exportedState()).z).toBeLessThan(before.z - 0.5);
  await page.getByRole('button', { name: 'Kabini kesfet' }).click();
  await expect(page.getByRole('heading', { name: sections[2].title })).toBeInViewport();
  await expect.poll(async () => (await exportedState()).y).toBeGreaterThan(1);
  await expect(page.locator('#load-error')).toBeHidden();
  const output = process.env.VTOL_OUTPUT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await copyFile(zipPath, join(output, 'vtol-showcase.zip'));
    await page.screenshot({ path: join(output, 'vtol-desktop.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('heading', { name: sections[0].title })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (output) await page.screenshot({ path: join(output, 'vtol-mobile.png') });
  await page.getByRole('button', { name: 'Motoru incele' }).click();
  await expect(page.getByRole('heading', { name: sections[1].title })).toBeInViewport();
  progress('export verified');
});
