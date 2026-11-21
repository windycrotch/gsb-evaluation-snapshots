import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron, expect } from '@playwright/test';
import JSZip from 'jszip';

test('packaged desktop saves, restores and exports a project', { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'game-editor-desktop-e2e-'));
  let application;
  t.after(async () => {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const launch = async () => {
    application = await electron.launch({
      executablePath: resolve('release', 'win-unpacked', 'Game Engine Editor.exe'),
      env: { ...process.env, GAME_ENGINE_EDITOR_DATA_DIR: directory },
      timeout: 60000,
    });
    const page = await application.firstWindow();
    await expect(page.getByText('Restoring scene...', { exact: true })).toBeHidden({ timeout: 60000 });
    return page;
  };
  let page = await launch();
  await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
  const icon = await readFile(resolve('desktop', 'icon.ico'));
  const count = icon.readUInt16LE(4);
  let icon32;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (icon[entry] === 32 && icon[entry + 1] === 32) {
      icon32 = icon.subarray(icon.readUInt32LE(entry + 12), icon.readUInt32LE(entry + 12) + icon.readUInt32LE(entry + 8));
      break;
    }
  }
  assert.ok(icon32, 'Windows icon must contain a 32-pixel image');
  for (const path of [resolve('release', 'win-unpacked', 'Game Engine Editor.exe'), resolve('Game Engine Editor Setup.exe')]) {
    const extracted = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Drawing
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:GAME_ENGINE_ICON_TEST_PATH)
      $bitmap = $icon.ToBitmap()
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [Convert]::ToBase64String($stream.ToArray())
      $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose()
    `], { encoding: 'utf8', env: { ...process.env, GAME_ENGINE_ICON_TEST_PATH: path } }).trim();
    const iconsMatch = await application.evaluate(({ nativeImage }, images) => {
      const expected = nativeImage.createFromBuffer(Buffer.from(images.expected, 'base64')).toBitmap();
      const actual = nativeImage.createFromBuffer(Buffer.from(images.actual, 'base64')).toBitmap();
      return actual.equals(expected);
    }, { expected: icon32.toString('base64'), actual: extracted });
    assert.ok(iconsMatch, `${path} must contain the new Windows icon`);
  }
  const logo = page.locator('header img');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/game-engine-logo.svg');
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByLabel('New project name').fill('Desktop test');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByText('New project created')).toBeVisible();
  await page.getByText('Box', { exact: true }).first().locator('..').getByRole('button', { name: 'Add' }).click();
  await page.getByText('SDF Text', { exact: true }).first().locator('..').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible({ timeout: 30000 });
  await application.close();
  application = undefined;

  page = await launch();
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByRole('button', { name: 'Desktop test', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Desktop test', exact: true }).click();
  await expect(page.getByText('Project opened')).toBeVisible();
  await expect(page.locator('.absolute.bottom-0.z-30').getByText('Box', { exact: true })).toBeVisible();
  await expect(page.locator('.absolute.bottom-0.z-30').getByText('SDF Text', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const path = join(directory, 'export.zip');
  await application.evaluate(({ dialog, session }, output) => {
    dialog.showSaveDialogSync = () => output;
    globalThis.exportFinished = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.once('done', (_doneEvent, state) => resolve(state));
      });
    });
  }, path);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  assert.equal(await application.evaluate(() => globalThis.exportFinished), 'completed');
  const zip = await JSZip.loadAsync(await readFile(path));
  assert.ok(zip.file('index.html'));
  assert.ok(zip.file('scene.js'));
  assert.ok(zip.file('vendor/SDF-TEXT-LICENSE.txt'));
  for (const name of ['three-LICENSE.txt', 'tween-LICENSE.txt', 'droid-NOTICE.txt', 'noto-sans-LICENSE.txt',
    'troika-three-text-LICENSE.txt', 'troika-three-utils-LICENSE.txt', 'troika-worker-utils-LICENSE.txt',
    'webgl-sdf-generator-LICENSE.txt', 'bidi-js-LICENSE.txt']) {
    assert.ok((await readFile(resolve('release', 'win-unpacked', 'resources', 'third-party', name), 'utf8')).length > 100);
  }
});
