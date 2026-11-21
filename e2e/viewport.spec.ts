import { test, expect, type Page } from '@playwright/test';
import { addObject } from './helpers';

test('editor starts without loading individual icon modules', async ({ page }) => {
  const iconRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/lucide-react/dist/esm/icons/')) iconRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  const logo = page.locator('header img');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', '/game-engine-logo.svg');
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', '/game-engine-logo.svg');
  expect((await page.request.get('/game-engine-logo.svg')).ok()).toBe(true);
  expect(iconRequests).toHaveLength(0);
});

test('play viewport shrinks to fit after resizing to mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const box = await page.locator('canvas').boundingBox();
    return box && Math.round(box.y + box.height);
  }).toBe(844);
});

test('device preview resizes the 3D canvas and remains within the available area', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  const preview = page.getByLabel('3D preview viewport');
  const canvas = page.locator('canvas');
  const size = page.getByLabel('Web preview size');
  for (const [device, width] of [['768px', 768], ['375px', 375]] as const) {
    await size.selectOption(device);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.width)).toBe(width);
    await expect.poll(async () => Math.round((await preview.boundingBox())!.width)).toBe(width);
    await expect.poll(() => canvas.evaluate(element => element.width / element.height)).toBeCloseTo(
      (await canvas.boundingBox())!.width / (await canvas.boundingBox())!.height, 2);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= 320;
  }).toBe(true);
});

test('component sidebar fits and remains usable across viewport widths', async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    if (width < 1024) await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    const sidebar = page.getByRole('heading', { name: 'Components', exact: true }).locator('..');
    await expect(sidebar).toBeVisible();
    const container = sidebar.locator('..');
    await expect.poll(() => container.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect.poll(async () => {
      const box = await container.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= width;
    }).toBe(true);
    await expect(page.getByRole('button', { name: 'Add web image' })).toBeVisible();
    await page.getByRole('button', { name: 'Add web image' }).click();
    await expect(page.getByRole('button', { name: 'Web', exact: true })).toBeVisible();
  }
});

test('dragging the transform gizmo moves and persists the selected object', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const positionX = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').first();
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2 + 45, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 115, canvas.y + canvas.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await positionX.inputValue()))).toBeGreaterThan(0.1);
  const x = await positionX.inputValue();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('editor').objectStore('editor').get('current');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result.currentScene.objects[0].properties.position[0]); database.close(); };
    };
  }))).toBeCloseTo(Number(x), 2);
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await expect(positionX).toHaveValue(x);
});

test('dragging the vertical gizmo moves the selected object upward', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const positionY = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton').nth(1);
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2 - 45);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2 - 115, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Number(await positionY.inputValue())).toBeGreaterThan(0.1);
});

async function canvasPixels(page: Page) {
  const image = (await page.locator('canvas').screenshot()).toString('base64');
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let gridPixels = 0;
    let brightness = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [red, green, blue] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (blue > 100 && green > 35 && blue > red * 1.3) gridPixels++;
      brightness += red + green + blue;
    }
    return { gridPixels, brightness };
  }, image);
}

test('viewport retains its grid and ambient light after scene changes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(async () => (await canvasPixels(page)).gridPixels).toBeGreaterThan(1000);
  await addObject(page, 'Box');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect.poll(async () => (await canvasPixels(page)).gridPixels).toBeGreaterThan(1000);
  const bounds = await page.locator('canvas').boundingBox();
  expect(bounds).not.toBeNull();
  await page.locator('canvas').click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
  await expect(page.getByRole('button', { name: 'Transform', exact: true })).toBeVisible();
  await page.locator('canvas').click({ button: 'right', position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
  await expect(page.getByText('Duplicate', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  const slider = page.getByRole('region', { name: 'Lighting' }).getByRole('slider');
  await slider.focus();
  await slider.press('Home');
  const dark = await canvasPixels(page);
  await slider.press('End');
  await expect.poll(async () => (await canvasPixels(page)).brightness).toBeGreaterThan(dark.brightness);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await canvasPixels(page)).gridPixels).toBeLessThan(100);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await canvasPixels(page)).gridPixels).toBeGreaterThan(1000);
});
