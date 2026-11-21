import { expect, type Page } from '@playwright/test';
import type JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

export async function extractExport(zip: JSZip, directory: string) {
  await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(async file => {
    const path = join(directory, file.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await file.async('nodebuffer'));
  }));
}

export async function serveExport(page: Page, zip: JSZip, directory: string) {
  await extractExport(zip, directory);
  const server = await createServer({
    configFile: false, root: directory, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }
  });
  await server.listen();
  page.once('close', () => { void server.close(); });
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Export test server failed to start');
  return `http://127.0.0.1:${address.port}/index.html`;
}

export async function addObject(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().locator('..').getByRole('button', { name: 'Add' }).click();
}

export async function enablePlayer(page: Page) {
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'Character Controller', exact: true }).click();
  await page.getByRole('region', { name: 'Character Controller' }).getByRole('checkbox').first().check();
}

export async function playerState(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/store/editorStore.ts';
    const { useEditorStore } = await import(/* @vite-ignore */ modulePath);
    const state = useEditorStore.getState();
    const player = state.sceneObjects[0];
    return {
      position: player.object.position.toArray() as number[],
      grounded: player.properties.characterController?.isGrounded as boolean,
      playing: state.isPlaying as boolean,
    };
  });
}

export async function play(page: Page) {
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.locator('canvas').click({ position: { x: 10, y: 10 } });
}
