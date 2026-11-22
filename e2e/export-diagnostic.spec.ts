import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { addObject } from './helpers';

function triangleGlb() {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4));
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Triangle' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] }
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }]
  };
  const text = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.alloc(12);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + positions.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length); jsonHeader.write('JSON', 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(positions.length); binHeader.write('BIN\0', 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, positions]);
}

const pngBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64'
);

const glbBuffer = triangleGlb();

async function exportViaUi(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return JSZip.loadAsync(await readFile(path!));
}

async function expectNoDownload(page: Page, action: () => Promise<void>) {
  let downloaded = false;
  page.once('download', () => { downloaded = true; });
  await action();
  await page.waitForTimeout(800);
  expect(downloaded).toBe(false);
}

async function corruptActiveSceneModel(page: Page) {
  await page.evaluate(async () => {
    const { useEditorStore } = await import(/* @vite-ignore */ '/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    const target = state.sceneObjects.find(obj => obj.type === 'model');
    if (!target) throw new Error('Test setup expected a model in the active scene');
    // Strip the raw GLB payload from the persisted scene, mimicking lost source data.
    const scenes = state.scenes.map(scene => scene.id === state.activeSceneId
      ? {
          ...scene,
          objects: scene.objects.map(obj => obj.id === target.id
            ? { ...obj, properties: { ...obj.properties, modelData: undefined } }
            : obj)
        }
      : scene);
    useEditorStore.setState({
      scenes,
      sceneObjects: state.sceneObjects.map(obj => obj.id === target.id
        ? { ...obj, properties: { ...obj.properties, modelData: undefined } }
        : obj)
    });
  });
}

async function setMissingPlayCamera(page: Page, cameraId = 'missing-camera') {
  await page.evaluate(async (id) => {
    const { useEditorStore } = await import(/* @vite-ignore */ '/src/store/editorStore.ts');
    useEditorStore.getState().updateSceneOptions({ activeCameraId: id });
  }, cameraId);
}

test('multi-scene export keeps pages, scripts and scene.json consistent with shared assets written once', async ({ page }) => {
  await page.goto('/');
  // Scene 1: an uploaded model plus a diffuse texture.
  await page.locator('#model-upload').setInputFiles({ name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: glbBuffer });
  await expect(page.getByRole('button', { name: 'Add triangle.glb to scene' })).toBeVisible();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer });
  await page.getByRole('button', { name: 'Create scene' }).click();
  await expect(page.getByRole('button', { name: 'Open scene Scene 2 / Page 2' })).toBeVisible();
  // Scene 2 reuses the same model asset and the same texture through the asset library.
  await page.getByRole('button', { name: 'Add triangle.glb to scene' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer });
  // Both scenes must hold one model before packaging starts. The active scene lives
  // in sceneObjects, so validate through the same snapshot the exporter consumes.
  await expect.poll(async () => page.evaluate(async () => {
    const { useEditorStore, createProjectSnapshot } = await import(/* @vite-ignore */ '/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    return createProjectSnapshot(state.sceneObjects, state.sceneOptions);
  })).toMatchObject({
    objects: [{ type: 'model' }],
    otherScenes: [{ objects: [{ type: 'model' }] }]
  });

  const zip = await exportViaUi(page);
  const entries = Object.keys(zip.files).sort();
  expect(entries).toEqual(expect.arrayContaining([
    'index.html', 'scene.js', 'scene-1.html', 'scene-1.js', 'scene.json'
  ]));

  const project = JSON.parse(await zip.file('scene.json')!.async('string')) as {
    objects: { properties: { modelData?: string; map?: string } }[];
    otherScenes: { id: string; objects: { properties: { modelData?: string; map?: string } }[] }[];
    activeSceneId: string;
  };
  const first = project.objects[0].properties;
  const second = project.otherScenes[0].objects[0].properties;
  // The same physical resource resolves to a single archive path across scenes.
  expect(second.modelData).toBe(first.modelData);
  expect(second.map).toBe(first.map);
  const assetFiles = entries.filter(name => name.startsWith('web3dassets/'));
  expect(new Set(assetFiles).size).toBe(assetFiles.length);
  for (const path of [first.modelData!, first.map!]) {
    expect(assetFiles).toContain(path);
  }

  // Every scene script embeds the same page table, so scene-to-scene jumps resolve.
  const firstScript = await zip.file('scene.js')!.async('string');
  const secondScript = await zip.file('scene-1.js')!.async('string');
  for (const script of [firstScript, secondScript]) {
    expect(script).toContain('"index.html"');
    expect(script).toContain('"scene-1.html"');
    expect(script).toContain(project.otherScenes[0].id);
    expect(script).toContain(project.activeSceneId);
  }
  // Each page boots its own matching script.
  expect(await zip.file('index.html')!.async('string')).toContain("loadScript('scene.js')");
  expect(await zip.file('scene-1.html')!.async('string')).toContain("loadScript('scene-1.js')");
});

test('export aggregates every problem scene and reason, then succeeds after fixes without leftovers', async ({ page }) => {
  await page.goto('/');
  // Scene 1 gets a model and a reference to a camera that does not exist.
  await page.locator('#model-upload').setInputFiles({ name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: glbBuffer });
  await setMissingPlayCamera(page);
  // Scene 2 gets its own model and a reference to a missing camera.
  await page.getByRole('button', { name: 'Create scene' }).click();
  await page.locator('#model-upload').setInputFiles({ name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: glbBuffer });
  await setMissingPlayCamera(page);
  // Back to scene 1 and strip its model data, so each scene fails for its own reason.
  await page.getByRole('button', { name: 'Open scene New Scene' }).click();
  await corruptActiveSceneModel(page);

  await expectNoDownload(page, () =>
    page.getByRole('button', { name: 'Export', exact: true }).click());
  const toast = page.locator('#_rht_toaster [role=status]').filter({ hasText: 'cannot be exported' });
  await expect(toast).toContainText('2 scenes cannot be exported');
  await expect(toast).toContainText('New Scene');
  await expect(toast).toContainText('Scene 2 / Page 2');
  await expect(toast).toContainText("missing its original GLB data");
  await expect(toast).toContainText('selected play camera is unavailable');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();

  // Re-import the GLB: restore the raw data onto the existing model in scene 1
  // (the editor's re-import flow repopulates modelData on the same object).
  const glbDataUrl = `data:model/gltf-binary;base64,${glbBuffer.toString('base64')}`;
  await page.evaluate(async (dataUrl) => {
    const { useEditorStore } = await import(/* @vite-ignore */ '/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    const scenes = state.scenes.map(scene => scene.id === state.activeSceneId
      ? {
          ...scene,
          objects: scene.objects.map(obj => obj.type === 'model'
            ? { ...obj, properties: { ...obj.properties, modelData: dataUrl } }
            : obj)
        }
      : scene);
    useEditorStore.setState({
      scenes,
      sceneObjects: state.sceneObjects.map(obj => obj.type === 'model'
        ? { ...obj, properties: { ...obj.properties, modelData: dataUrl } }
        : obj)
    });
  }, glbDataUrl);
  // Fix the camera in every scene directly in the store.
  await page.evaluate(async () => {
    const { useEditorStore } = await import(/* @vite-ignore */ '/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    const scenes = state.scenes.map(scene => scene.sceneOptions.activeCameraId
      ? { ...scene, sceneOptions: { ...scene.sceneOptions, activeCameraId: undefined } }
      : scene);
    useEditorStore.setState({
      scenes,
      sceneOptions: state.sceneOptions.activeCameraId
        ? { ...state.sceneOptions, activeCameraId: undefined }
        : state.sceneOptions
    });
  });

  const zip = await exportViaUi(page);
  expect(zip.file('scene.json')).not.toBeNull();
  await expect(page.getByText('Scene exported successfully!')).toBeVisible();
});

test('a resource read failure aborts the whole export with no download and no object URL left behind', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((window as unknown as { __failAssetFetch?: boolean }).__failAssetFetch && url.startsWith('data:')) {
        return Promise.reject(new Error('Simulated asset decode failure'));
      }
      return originalFetch(input, init);
    };
    const created: string[] = [];
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = originalCreate(obj);
      created.push(url);
      return url;
    };
    (window as unknown as { __testObjectUrls: string[] }).__testObjectUrls = created;
  });
  await page.goto('/');
  await page.locator('#model-upload').setInputFiles({ name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: glbBuffer });
  await page.evaluate(() => { ((window as unknown as { __failAssetFetch: boolean }).__failAssetFetch) = true; });

  await expectNoDownload(page, () =>
    page.getByRole('button', { name: 'Export', exact: true }).click());
  await expect(page.locator('#_rht_toaster [role=status]').filter({ hasText: 'Could not decode export asset' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  // Resource failures happen while packaging, before the archive blob URL is created.
  const urls = await page.evaluate(() => (window as unknown as { __testObjectUrls: string[] }).__testObjectUrls);
  expect(urls).toEqual([]);

  // Once resources are readable again the same project exports successfully.
  await page.evaluate(() => { ((window as unknown as { __failAssetFetch: boolean }).__failAssetFetch) = false; });
  await exportViaUi(page);
});

test('two rapid exports stay isolated: the older run never downloads and only the newest format wins', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer });

  const result = await page.evaluate(async () => {
    const [{ exportScene, isExportAbortError }, { useEditorStore, createProjectSnapshot }] = await Promise.all([
      import(/* @vite-ignore */ '/src/services/sceneExporter.ts'),
      import(/* @vite-ignore */ '/src/store/editorStore.ts')
    ]);
    const downloads: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    // Gate asset reads so the first export is guaranteed to be mid-packaging
    // when the second one starts.
    const originalFetch = window.fetch.bind(window);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstDataRead = false;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('data:')) {
        if (!firstDataRead) {
          firstDataRead = true;
          return firstGate.then(() => originalFetch(input, init));
        }
      }
      return originalFetch(input, init);
    };

    const state = useEditorStore.getState();
    const snapshot = () => ({
      ...createProjectSnapshot(state.sceneObjects, state.sceneOptions),
      assets: structuredClone(useEditorStore.getState().assets)
    });

    const first = exportScene(snapshot(), 'html').then(
      () => ({ outcome: 'resolved' as const }),
      error => ({ outcome: (isExportAbortError(error) ? 'aborted' : 'failed') as string, message: (error as Error).message })
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = exportScene(snapshot(), 'react').then(
      () => ({ outcome: 'resolved' as const }),
      error => ({ outcome: (isExportAbortError(error) ? 'aborted' : 'failed') as string, message: (error as Error).message })
    );
    // Let the superseded first run unwind before unblocking asset reads.
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    window.fetch = originalFetch;
    HTMLAnchorElement.prototype.click = originalClick;
    return { firstResult, secondResult, downloads };
  });

  expect(result.firstResult.outcome).toBe('aborted');
  expect(result.secondResult.outcome).toBe('resolved');
  expect(result.downloads).toEqual(['New Scene-react.zip']);
});

test('abandoning an export on page unload releases the in-flight run and its temporary URL', async ({ page }) => {
  await page.goto('/');
  // A texture gives packaging a data: URL to read, so the gated fetch keeps the
  // export genuinely in flight when pagehide fires.
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Material', exact: true }).click();
  await page.getByLabel('Diffuse Map').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer });

  const state = await page.evaluate(async () => {
    const [{ exportScene, isExportAbortError }, { useEditorStore, createProjectSnapshot }] = await Promise.all([
      import(/* @vite-ignore */ '/src/services/sceneExporter.ts'),
      import(/* @vite-ignore */ '/src/store/editorStore.ts')
    ]);
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = originalCreate(obj);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      return originalRevoke(url);
    };
    // Hold the first data-URL read so the export is mid-packaging at unload,
    // then release once the unload signal arrives so the abort check can run.
    const originalFetch = window.fetch.bind(window);
    let releasePackaging: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { releasePackaging = resolve; });
    let firstDataRead = false;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('data:') && !firstDataRead) {
        firstDataRead = true;
        return gate.then(() => originalFetch(input, init));
      }
      return originalFetch(input, init);
    };

    const editor = useEditorStore.getState();
    const promise = exportScene(
      { ...createProjectSnapshot(editor.sceneObjects, editor.sceneOptions), assets: structuredClone(editor.assets) },
      'html'
    ).then(
      () => ({ outcome: 'resolved' as const }),
      error => ({ outcome: (isExportAbortError(error) ? 'aborted' : 'failed') as string, message: (error as Error).message })
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    window.dispatchEvent(new Event('pagehide'));
    releasePackaging();
    const outcome = await promise;
    window.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    return { outcome, created, revoked };
  });

  expect(state.outcome.outcome).toBe('aborted');
  // The run was abandoned before completion, so no blob URL was ever minted.
  expect(state.created).toEqual([]);
  expect(state.revoked).toEqual([]);
});
