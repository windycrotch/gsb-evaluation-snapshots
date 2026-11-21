import { expect, test } from '@playwright/test';
import { addObject } from './helpers';

test('history survives reload, branches, and remains isolated by project', async ({ page, request }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await addObject(page, 'Sphere');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await addObject(page, 'Cone');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  const project = (await (await request.get('/api/projects')).json() as { id: string; name: string }[])
    .find(item => item.name === 'New Scene')!;
  const saved = await (await request.get(`/api/history/${project.id}`)).json();
  expect(saved.snapshots.length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Reset Scene' }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'New Scene', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
});

test('visibility changes are undoable and survive reload', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
});

test('a history write failure does not prevent saving the project', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('Restoring scene...', { exact: true })).toBeHidden();
  await page.route('**/api/history/**', async route => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 500, json: { error: 'History storage unavailable' } });
    } else {
      await route.continue();
    }
  });
  await addObject(page, 'Box');
  await expect(page.getByText('History could not be saved:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved, but history is unavailable.', { exact: false })).toBeVisible();
  const projects = await (await request.get('/api/projects')).json() as { id: string; name: string; sceneData: { objects: unknown[] } }[];
  const project = projects.find(item => item.name === 'New Scene' && item.sceneData.objects.length === 1);
  expect(project).toBeDefined();
  expect((await request.delete(`/api/projects/${project!.id}`)).ok()).toBe(true);
});

test('history limits steps and restores scene and asset changes', async ({ page, request }) => {
  await page.goto('/');
  for (let index = 0; index < 21; index++) await addObject(page, 'Box');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(21);
  await expect.poll(async () => {
    const id = await page.evaluate(() => localStorage.getItem('editor-history-draft'));
    return (await (await request.get(`/api/history/${id}`)).json())?.snapshots.length;
  }).toBe(21);
  for (let index = 0; index < 20; index++) {
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'history.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  });

  await expect(page.getByRole('button', { name: 'Remove history.svg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove history.svg' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove history.svg' })).toBeVisible();
  await page.getByRole('button', { name: 'Create scene' }).click();
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toHaveCount(0);
});

test('typing is one undo step and keyboard shortcuts avoid text inputs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  const input = page.getByLabel('Web text', { exact: true });
  await input.fill('');
  await input.pressSequentially('Hello world');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await input.blur();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('heading', { name: 'Your heading', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('heading', { name: 'Hello world', exact: true })).toBeVisible();
});

test('large assets are deduplicated across history and restored after reload', async ({ page, request }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Upload assets').setInputFiles({
    name: 'large.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)])
  });
  await page.getByRole('button', { name: 'Add large.png to web' }).click();
  const id = await page.evaluate(() => localStorage.getItem('editor-history-draft'));
  await expect.poll(async () => {
    const body = await (await request.get(`/api/history/${id}`)).json();
    const last = body?.snapshots[body.index];
    return last?.scene.objects[0]?.properties.web.image?.$historyBlob === last?.assets[0]?.url?.$historyBlob &&
      typeof last?.assets[0]?.url?.$historyBlob === 'string';
  }, { timeout: 30000 }).toBe(true);
  const body = await (await request.get(`/api/history/${id}`)).text();
  expect(body.length).toBeLessThan(100000);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add large.png to web' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(1);
});
