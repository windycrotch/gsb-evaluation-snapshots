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
  for (const project of projects.filter(item => ['Container layout test', 'Media layout test', 'Slider layout test'].includes(item.name))) {
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
  }
});

test('scene list remains selectable above a full-height web section', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web height').fill('1500');
  await page.getByRole('button', { name: 'Select', exact: true }).first().click({ timeout: 5000 });
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('Box');
});

test('device layouts inherit, reset and follow resize in the exported player', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Responsive heading');
  await page.getByLabel('Web font size').fill('40');
  await page.getByLabel('Web width').fill('300');
  const heading = page.locator('.engine-web-node[data-kind="heading"]');
  await page.getByLabel('Web layout device').selectOption('tablet');
  await page.getByLabel('Web font size').fill('28');
  await page.getByLabel('Web layout device').selectOption('mobile');
  await page.getByLabel('Web font size').fill('48');
  await page.getByLabel('Web width').fill('200');
  await page.getByLabel('Web padding').fill('5');
  await expect(heading).toHaveCSS('font-size', '48px');
  await expect(heading).toHaveCSS('width', '200px');
  await page.getByRole('button', { name: 'Reset device layout to desktop' }).click();
  await expect(page.getByLabel('Web font size')).toHaveValue('40');
  await page.getByLabel('Web font size').fill('48');
  await page.getByLabel('Web width').fill('200');
  await page.getByLabel('Web padding').fill('5');
  await page.getByLabel('Web layout device').selectOption('desktop');
  await expect(page.getByLabel('Web width')).toHaveValue('300');
  await page.reload();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByLabel('Web layout device').selectOption('mobile');
  await expect(page.getByLabel('Web font size')).toHaveValue('48');
  await expect(heading).toHaveCSS('padding-top', '5px');
  await page.getByLabel('Web layout device').selectOption('desktop');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('responsive-layout');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  for (const [width, fontSize, elementWidth] of [[1025, '40px', '300px'], [1024, '28px', '300px'],
    [768, '28px', '300px'], [767, '48px', '200px']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(heading).toHaveCSS('font-size', fontSize);
    await expect(heading).toHaveCSS('width', elementWidth);
  }
  await expect(page.locator('#load-error')).toBeHidden();
});

test('explicit device column counts override automatic stacking', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web container' }).click();
  await page.getByLabel('Container item width').selectOption('4');
  await page.getByLabel('Web layout device').selectOption('mobile');
  await page.getByLabel('Container item width').selectOption('2');
  const grid = page.locator('.engine-web-node[data-kind="container"]');
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);
  await page.getByRole('button', { name: 'Reset device layout to desktop' }).click();
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
});

test('visual controls override scripted backgrounds and allow 3D interaction in play and export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web CSS class').fill('forced-background');
  await page.getByLabel('Web script').fill(`return {
    start() { state.style = document.createElement('style'); state.style.textContent = '.forced-background{background:red!important;pointer-events:auto!important;padding:77px!important}'; document.head.appendChild(state.style); },
    stop() { state.style.remove(); }
  };`);
  await page.getByLabel('Web background', { exact: true }).fill('#112233');
  await page.getByLabel('Web background', { exact: true }).fill('transparent');
  await expect(page.getByLabel('Web background mode')).toHaveValue('transparent');
  await page.getByLabel('Web padding').fill('23');
  await page.getByLabel('Web pointer mode').selectOption('pass-through');
  await page.getByLabel('Web content layout').selectOption('column');
  await page.getByLabel('Web justify content').selectOption('center');
  await page.getByLabel('Web minimum height (vh)').fill('80');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Interactive child');
  const section = page.locator('.engine-web-node[data-kind="section"]');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(section).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(section).toHaveCSS('pointer-events', 'none');
  await expect(section).toHaveCSS('padding-top', '23px');
  await expect(section).toHaveCSS('display', 'flex');
  await expect(section).toHaveCSS('justify-content', 'center');
  await expect(page.getByRole('button', { name: 'Interactive child' })).toHaveCSS('pointer-events', 'auto');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('visual-controls');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(section).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(section).toHaveCSS('pointer-events', 'none');
  await expect(section).toHaveCSS('padding-top', '23px');
  await expect(section).toHaveCSS('display', 'flex');
  await expect(page.getByRole('button', { name: 'Interactive child' })).toBeVisible();
  await expect(page.locator('#load-error')).toBeHidden();
});

test('slider nests responsive content and media, persists, and runs in export', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  const videoData = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    const context = canvas.getContext('2d')!;
    for (let frame = 0; frame < 5; frame++) {
      context.fillStyle = frame % 2 ? 'red' : 'blue';
      context.fillRect(0, 0, 32, 32);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach(track => track.stop());
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  });
  const wav = Buffer.alloc(44 + 8000 * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  wav.fill(128, 44);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>');

  await page.getByRole('button', { name: 'Add web slider' }).click();
  await page.getByLabel('Slide background image').setInputFiles({ name: 'background.svg', mimeType: 'image/svg+xml', buffer: svg });
  await page.getByLabel('Slide background video').setInputFiles({ name: 'background.webm', mimeType: 'video/webm', buffer: Buffer.from(videoData.split(',')[1], 'base64') });
  const slider = page.locator('.engine-web-node[data-kind="slider"]');
  const slides = slider.locator(':scope > .engine-web-slide');
  await expect(slides.first().locator('.engine-web-background-video')).toHaveAttribute('src', /^data:video\/webm/);
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByRole('button', { name: 'Add web container' }).click();
  await page.getByLabel('Container item width').selectOption('4');
  await page.getByRole('button', { name: 'Add web card' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('First slide');
  await page.getByRole('button', { name: 'Add web image' }).click();
  await page.getByLabel('Web image', { exact: true }).setInputFiles({ name: 'image.svg', mimeType: 'image/svg+xml', buffer: svg });
  await page.getByRole('button', { name: 'Add web audio' }).click();
  await page.getByLabel('Web audio', { exact: true }).setInputFiles({ name: 'sound.wav', mimeType: 'audio/wav', buffer: wav });
  await page.getByLabel('Web audio loop').check();
  await expect(slides.first().locator('audio')).toHaveAttribute('src', /^data:audio\/wav/);
  await page.getByRole('button', { name: 'Select', exact: true }).nth(1).click();
  await page.getByRole('button', { name: 'Add web slide', exact: true }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Second slide');
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByLabel('Slider full screen').check();
  await page.getByLabel('Web border radius').fill('24');
  await page.getByLabel('Web padding').fill('0');
  await expect(slider).toHaveCSS('border-radius', '24px');
  await expect(slider).toHaveCSS('padding-top', '0px');
  await expect(slides).toHaveCount(2);
  const grid = slides.first().locator('[data-kind="container"]');
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4);
  await page.getByLabel('Web preview size').selectOption('375px');
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.getByLabel('Web preview size').selectOption('100%');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Slider layout test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(slides).toHaveCount(2);
  await expect(slider).toHaveCSS('border-radius', '24px');
  await expect(slides.first()).toHaveCSS('background-image', /data:image/);
  await page.getByRole('button', { name: 'Reset Scene' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Slider layout test', exact: true }).click();
  await expect(page.getByText('Project opened', { exact: true })).toBeVisible();
  await expect(slides).toHaveCount(2);
  await expect(slides.first()).toHaveCSS('background-image', /data:image/);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(slides.first()).toBeVisible();
  await expect(slides.last()).toBeHidden();
  const audio = slides.first().locator('audio');
  const backgroundVideo = slides.first().locator('.engine-web-background-video');
  await expect.poll(() => backgroundVideo.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await audio.evaluate(async element => { const sound = element as HTMLAudioElement; sound.muted = true; await sound.play(); });
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
  await page.getByRole('button', { name: 'Next slide' }).click();
  await expect(slides.first()).toBeHidden();
  await expect(slides.last()).toBeVisible();
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  await expect.poll(() => backgroundVideo.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await page.getByRole('button', { name: 'Previous slide' }).click();
  await expect(slides.first()).toBeVisible();
  await page.getByRole('button', { name: 'Next slide' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(slides.last()).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('slider-game');
  await page.goto(await serveExport(page, zip, directory));
  await expect(slides.first()).toBeVisible({ timeout: 15000 });
  await expect(slides.last()).toBeHidden();
  await expect(slider).toHaveCSS('border-radius', '24px');
  await expect(slides.first().locator('audio')).toHaveAttribute('src', /^web3dassets\/.*\.wav$/);
  await expect(slides.first().locator('.engine-web-background-video')).toHaveAttribute('src', /^web3dassets\/.*\.webm$/);
  await expect.poll(() => slides.first().locator('.engine-web-background-video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await slides.first().locator('audio').evaluate(async element => { const sound = element as HTMLAudioElement; sound.muted = true; await sound.play(); });
  await page.getByRole('button', { name: 'Next slide' }).click();
  await expect.poll(() => slides.first().locator('audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Second slide' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Previous slide' }).click();
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  await expect.poll(() => slider.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(844);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('slider hierarchy is protected when moving or deleting components', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web slide', exact: true }).click();
  await expect(page.getByText('Select a slider or one of its slides first.')).toBeVisible();
  await page.getByRole('button', { name: 'Add web slider' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Kept content');
  await expect(page.getByLabel('Web parent').getByRole('option', { name: 'Slider', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add web text' }).click();
  await expect(page.getByText('Select a slide to add content inside a slider.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect(page.locator('.engine-web-node[data-kind="slider"]')).toHaveCount(0);
  await expect(page.locator('.engine-web-node[data-kind="section"] .engine-web-node[data-kind="heading"]')).toHaveText('Kept content');
  await page.reload();
  await expect(page.locator('.engine-web-node[data-kind="section"] .engine-web-node[data-kind="heading"]')).toHaveText('Kept content');
});

test('video components import and play locally in editor and export', async ({ page }, testInfo) => {
  await page.goto('/');
  const formats = await page.evaluate(() => ({
    webm: MediaRecorder.isTypeSupported('video/webm;codecs=vp8'),
    mp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E')
  }));
  expect(formats.webm).toBe(true);
  expect(formats.mp4).toBe(true);
  const makeVideo = async (mime: string) => {
    const data = await page.evaluate(async type => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d')!;
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: type });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type })); });
      recorder.start();
      for (let frame = 0; frame < 8; frame++) {
        context.fillStyle = frame % 2 ? 'red' : 'blue';
        context.fillRect(0, 0, 32, 32);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      recorder.stop();
      const blob = await finished;
      stream.getTracks().forEach(track => track.stop());
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }, mime);
    return Buffer.from(data.split(',')[1], 'base64');
  };
  for (const [mime, name] of [['video/webm;codecs=vp8', 'demo.webm'], ['video/mp4;codecs=avc1.42E01E', 'demo.mp4']]) {
    const buffer = await makeVideo(mime);
    await page.getByRole('button', { name: 'Add web video' }).click();
    await page.getByLabel('Web video', { exact: true }).setInputFiles({ name, mimeType: mime.split(';')[0], buffer });
    const video = page.locator('.engine-web-node[data-kind="video"]').last();
    await expect(video).toHaveAttribute('src', /^data:video\//);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Media layout test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.engine-web-node[data-kind="video"]')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('video-game');
  await page.goto(await serveExport(page, zip, directory));
  const videos = page.locator('.engine-web-node[data-kind="video"]');
  await expect(videos).toHaveCount(2, { timeout: 15000 });
  for (let index = 0; index < 2; index++) {
    await expect.poll(() => videos.nth(index).evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  }
  await expect(page.locator('#load-error')).toBeHidden();
});

test('Lottie JSON animates in editor and self-contained export', async ({ page }, testInfo) => {
  const animation = {
    v: '5.7.4', fr: 30, ip: 0, op: 30, w: 100, h: 100, nm: 'Moving circle', ddd: 0, assets: [],
    layers: [{
      ddd: 0, ind: 1, ty: 4, nm: 'circle', sr: 1,
      ks: {
        o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
        p: { a: 1, k: [{ t: 0, s: [10, 50, 0], e: [80, 50, 0], i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] } }, { t: 30, s: [80, 50, 0] }] },
        a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }
      }, ao: 0, shapes: [
        { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [12, 12] }, nm: 'ellipse' },
        { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'fill' }
      ], ip: 0, op: 30, st: 0, bm: 0
    }]
  };
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web lottie' }).click();
  await page.getByLabel('Web Lottie JSON').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByText('Invalid Lottie animation')).toBeVisible();
  await page.getByLabel('Web Lottie JSON').setInputFiles({ name: 'external.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...animation, assets: [{ p: 'image.png' }] })) });
  await expect(page.getByText('Lottie external assets must be embedded')).toBeVisible();
  await page.getByLabel('Web Lottie JSON').setInputFiles({ name: 'animation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(animation)) });
  const node = page.locator('.engine-web-node[data-kind="lottie"]');
  await expect(node.locator('svg path')).toBeVisible();
  const group = node.locator('svg g[transform]').first();
  const first = await group.getAttribute('transform');
  await expect.poll(() => group.getAttribute('transform')).not.toBe(first);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Media layout test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(node.locator('svg path')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  expect(zip.file('lottie.min.js')).not.toBeNull();
  const directory = testInfo.outputPath('lottie-game');
  await extractExport(zip, directory);
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(node.locator('svg path')).toBeVisible({ timeout: 15000 });
  const exportedFirst = await group.getAttribute('transform');
  await expect.poll(() => group.getAttribute('transform')).not.toBe(exportedFirst);
  await expect(page.locator('#load-error')).toBeHidden();
});

test('container cards, image formats and margins survive responsive export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web container' }).click();
  await page.getByLabel('Container item width').selectOption('4');
  const container = page.locator('.engine-web-node[data-kind="container"]');
  const columns = () => container.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  await expect.poll(columns).toBe(4);
  for (const count of [2, 3, 4, 6]) {
    await page.getByLabel('Container item width').selectOption(String(count));
    await expect.poll(columns).toBe(count);
    await page.getByLabel('Web preview size').selectOption('768px');
    await expect.poll(columns).toBe(Math.floor(count / 2));
    await page.getByLabel('Web preview size').selectOption('375px');
    await expect.poll(columns).toBe(1);
    await page.getByLabel('Web preview size').selectOption('100%');
  }
  await page.getByLabel('Container item width').selectOption('4');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="red"/></svg>');
  const gif = Buffer.from('R0lGODlhAwADAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAKAAAACwAAAAAAwADAAAIBwABCBw4MCAAIfkEASgAAQAsAAAAAAMAAwCBAAD/AAAAAAAAAAAACAcAAQgcODAgADs=', 'base64');
  for (let index = 0; index < 4; index++) {
    if (index) await page.getByRole('button', { name: 'Select', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add web card' }).click();
    await page.getByRole('button', { name: 'Add web image' }).click();
    await page.getByLabel('Web image', { exact: true }).setInputFiles(index % 2 === 0
      ? { name: 'icon.svg', mimeType: 'image/svg+xml', buffer: svg }
      : { name: 'animated.gif', mimeType: 'image/gif', buffer: gif });
    await expect(container.locator('img')).toHaveCount(index + 1);
    await expect(container.locator('img').last()).toHaveAttribute('src', /^data:image\//);
  }
  await page.getByLabel('Web margin top').fill('5');
  await page.getByLabel('Web margin right').fill('7');
  await page.getByLabel('Web margin bottom').fill('9');
  await page.getByLabel('Web margin left').fill('11');
  await expect(container.locator('img').last()).toHaveCSS('margin-left', '11px');
  await expect(container.locator('[data-kind="card"]')).toHaveCount(4);
  const gifImage = container.locator('img').nth(1);
  const firstFrame = (await gifImage.screenshot()).toString('base64');
  await expect.poll(async () => (await gifImage.screenshot()).toString('base64')).not.toBe(firstFrame);
  await page.getByLabel('Web preview size').selectOption('768px');
  await expect.poll(columns).toBe(2);
  await page.getByLabel('Web preview size').selectOption('375px');
  await expect.poll(columns).toBe(1);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Scene Name').fill('Container layout test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(container.locator('img')).toHaveCount(4);
  await expect(container.locator('img').last()).toHaveCSS('margin-left', '11px');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const scene = JSON.parse(await zip.file('scene.json')!.async('string'));
  expect(scene.objects.filter((item: { properties: { web?: { kind: string } } }) => item.properties.web?.kind === 'card')).toHaveLength(4);
  expect(await zip.file('scene.js')!.async('string')).toContain('web3dassets/icon.svg');
  const directory = testInfo.outputPath('container-game');
  await page.goto(await serveExport(page, zip, directory));
  await expect(container.locator('img')).toHaveCount(4, { timeout: 15000 });
  await expect.poll(columns).toBe(4);
  await page.setViewportSize({ width: 800, height: 500 });
  await expect.poll(columns).toBe(2);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(columns).toBe(1);
  await expect(container.locator('img').last()).toHaveCSS('margin-left', '11px');
  await expect(page.locator('#load-error')).toBeHidden();
});

test('visual web components persist, interact with 3D and export with optional jQuery', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web component name').fill('Hero');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Hello camera');
  await page.getByLabel('Web CSS class').fill('hero-title');
  await page.getByLabel('Web tags').fill('headline, landing');
  await page.getByLabel('Web tags').blur();
  await expect(page.locator('.engine-web-node[data-kind="heading"]')).toHaveText('Hello camera');
  await expect(page.locator('.engine-web-node[data-kind="heading"]')).toHaveClass(/hero-title/);
  await expect(page.locator('.engine-web-node[data-kind="heading"]')).toHaveAttribute('data-tags', 'headline,landing');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Turn camera');
  await page.getByLabel('Web action').selectOption('rotate');
  await page.getByLabel('Web action target').selectOption({ label: 'Box' });
  await page.getByLabel('Web script').fill("return { start() { window.jQuery(element).attr('data-ready', 'yes'); }, click() { window.jQuery(element).text('Turned'); } };");
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Enable jQuery').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.engine-web-node[data-kind="heading"]')).toHaveText('Hello camera');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText('WASD / Arrow Keys - Move')).toHaveCount(0);
  const rotation = () => page.evaluate(async () => {
    const path = '/src/store/editorStore.ts';
    const { useEditorStore } = await import(/* @vite-ignore */ path);
    return useEditorStore.getState().sceneObjects.find((item: { type: string }) => item.type === 'box').object.rotation.y as number;
  });
  if (process.env.E2E_PREVIEW !== '1') expect(await rotation()).toBe(0);
  await expect(page.getByRole('button', { name: 'Turn camera' })).toHaveAttribute('data-ready', 'yes');
  await page.getByRole('button', { name: 'Turn camera' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Turned' })).toBeVisible();
  if (process.env.E2E_PREVIEW !== '1') expect(await rotation()).toBeGreaterThan(0.7);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'jQuery'))).toBe('undefined');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  expect(zip.file('jquery.min.js')).not.toBeNull();
  const directory = testInfo.outputPath('web-game');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.getByRole('heading', { name: 'Hello camera' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Turn camera' })).toHaveAttribute('data-ready', 'yes');
  await page.getByRole('button', { name: 'Turn camera' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Turned' })).toBeVisible();
  expect(await page.evaluate(() => Function('return sceneObjects.find(item => item.type === "box").object.rotation.y')())).toBeGreaterThan(0.7);
});

test('columns respond to preview sizes and support visual drag reparenting', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web columns' }).click();
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Column heading');
  await page.getByRole('button', { name: 'Add web text' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Column text');
  const columns = page.locator('.engine-web-node[data-kind="columns"]');
  const gridWidth = () => columns.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  await expect.poll(gridWidth).toBe(2);
  await page.getByLabel('Web preview size').selectOption('375px');
  await expect.poll(gridWidth).toBe(1);
  await page.getByRole('button', { name: 'Add web section' }).click();
  const section = page.locator('.engine-web-node[data-kind="section"]');
  await page.locator('.engine-web-node[data-kind="heading"]').dragTo(section);
  await expect(section.locator('[data-kind="heading"]')).toHaveText('Column heading');
});

test('keyboard and scroll triggers work while the 3D scene is playing', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web component name').fill('First section');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web component name').fill('Target title');
  await page.getByLabel('Web text', { exact: true }).fill('Toggle me');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web event', { exact: true }).selectOption('key');
  await page.getByLabel('Web event key').fill('k');
  await page.getByLabel('Web action').selectOption('toggle');
  await page.getByLabel('Web action target').selectOption({ label: 'Target title' });
  await page.getByLabel('Web script').fill("return { scroll() { document.body.dataset.testScroll = 'yes'; }, stop() { delete document.body.dataset.testScroll; } };");
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web component name').fill('Second section');
  await page.getByLabel('Web parent').selectOption('');
  await page.getByLabel('Web event', { exact: true }).selectOption('scroll');
  await page.getByLabel('Web action').selectOption('rotate');
  await page.getByLabel('Web action target').selectOption({ label: 'Box' });
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web parent').selectOption('');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web parent').selectOption('');
  await page.getByLabel('Web animation').selectOption('fade');
  await page.getByLabel('Web animation trigger').selectOption('scroll');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const animated = page.locator('.engine-web-node[data-kind="section"]').last();
  await expect(animated).not.toHaveAttribute('data-animation', 'fade');
  const title = page.getByRole('heading', { name: 'Toggle me' });
  await expect(title).toBeVisible();
  await page.keyboard.press('k');
  await expect(title).toBeHidden();
  await page.keyboard.press('k');
  await expect(title).toBeVisible();
  const rotation = () => page.evaluate(async () => {
      const path = '/src/store/editorStore.ts';
      const { useEditorStore } = await import(/* @vite-ignore */ path);
      return useEditorStore.getState().sceneObjects.find((item: { type: string }) => item.type === 'box').object.rotation.y as number;
  });
  if (process.env.E2E_PREVIEW !== '1') await expect.poll(rotation).toBe(0);
  await page.locator('canvas').hover();
  await page.mouse.wheel(0, 400);
  await expect(page.locator('body')).toHaveAttribute('data-test-scroll', 'yes');
  if (process.env.E2E_PREVIEW !== '1') await expect.poll(rotation).toBeGreaterThan(0.7);
  await page.mouse.wheel(0, 1000);
  await expect(animated).toHaveAttribute('data-animation', 'fade');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('scroll-game');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.getByRole('heading', { name: 'Toggle me' })).toBeVisible({ timeout: 15000 });
  await page.locator('canvas').hover();
  await page.mouse.wheel(0, 400);
  await expect(page.locator('body')).toHaveAttribute('data-test-scroll', 'yes');
  await page.mouse.wheel(0, 1000);
  await expect(page.locator('.engine-web-node[data-kind="section"]').last()).toHaveAttribute('data-animation', 'fade');
});

test.describe('touch web scrolling', () => {
  test.use({ hasTouch: true });

  test('swiping the 3D canvas scrolls web sections', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto('/');
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Add web section' }).click();
      await page.getByLabel('Web parent').selectOption('');
    }
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 700 });
    const canvas = page.locator('canvas');
    await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(375);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 600 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 190, y: 300 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.engine-web-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    await cdp.detach();
  });
});

test('non-interactive web sections do not block 3D clicks', async ({ page }, testInfo) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill(`return {
    start() { document.body.dataset.testHits = '0'; window.testObjectPosition = () => {
      const point = object.getWorldPosition(new THREE.Vector3()).project(camera);
      return [point.x, point.y];
    }; },
    click() { document.body.dataset.testHits = String(Number(document.body.dataset.testHits) + 1); },
    stop() { delete window.testObjectPosition; delete document.body.dataset.testHits; }
  };`);
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web padding').fill('200');
  await page.getByLabel('Web background', { exact: true }).fill('transparent');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const canvas = page.locator('canvas');
  await expect(page.locator('body')).toHaveAttribute('data-test-hits', '0');
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(page.viewportSize()!.width);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Canvas is not visible');
  const [x, y] = await page.evaluate(() => Reflect.get(window, 'testObjectPosition')() as number[]);
  const sectionBounds = await page.locator('.engine-web-section').boundingBox();
  if (!sectionBounds) throw new Error('Section is not visible');
  expect(bounds.y + (1 - y) * bounds.height / 2).toBeLessThan(sectionBounds.y + sectionBounds.height);
  await canvas.click({ position: { x: (x + 1) * bounds.width / 2, y: (1 - y) * bounds.height / 2 } });
  await expect(page.locator('body')).toHaveAttribute('data-test-hits', '1');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('click-game');
  await extractExport(zip, directory);
  page.once('dialog', dialog => dialog.accept());
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  await expect(page.locator('body')).toHaveAttribute('data-test-hits', '0', { timeout: 15000 });
  const exportedCanvas = page.locator('canvas');
  const exportedBounds = await exportedCanvas.boundingBox();
  if (!exportedBounds) throw new Error('Exported canvas is not visible');
  const [exportedX, exportedY] = await page.evaluate(() => Reflect.get(window, 'testObjectPosition')() as number[]);
  await exportedCanvas.click({ position: { x: (exportedX + 1) * exportedBounds.width / 2, y: (1 - exportedY) * exportedBounds.height / 2 } });
  await expect(page.locator('body')).toHaveAttribute('data-test-hits', '1');
});

test('optional jQuery is available to 3D object start scripts', async ({ page }) => {
  await page.goto('/');
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { start() { if (!window.jQuery) throw Error('jQuery missing'); object.userData.ready = true; } };");
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Enable jQuery').check();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  if (process.env.E2E_PREVIEW !== '1') {
    await expect.poll(() => page.evaluate(async () => {
      const path = '/src/store/editorStore.ts';
      const { useEditorStore } = await import(/* @vite-ignore */ path);
      return useEditorStore.getState().sceneObjects[0].object.userData.ready;
    })).toBe(true);
  } else {
    await expect(page.getByText('Script error:', { exact: false })).toHaveCount(0);
  }
});

test('scroll actions navigate sections and deleting a container preserves its children', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web component name').fill('Top section');
  await page.getByRole('button', { name: 'Add web heading' }).click();
  await page.getByLabel('Web text', { exact: true }).fill('Keep this');
  await page.getByRole('button', { name: 'Add web button' }).click();
  await page.getByLabel('Web component name').fill('Jump button');
  await page.getByLabel('Web text', { exact: true }).fill('Jump to end');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web parent').selectOption('');
  await page.getByLabel('Web component name').fill('Destination');
  await page.getByRole('button', { name: 'Add web section' }).click();
  await page.getByLabel('Web parent').selectOption('');
  await page.locator('.engine-web-node[data-kind="button"]').click();
  await page.getByLabel('Web action').selectOption('scroll');
  await page.getByLabel('Web action target').selectOption({ label: 'Destination' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Jump to end' }).click();
  await expect.poll(() => page.locator('.engine-web-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(40);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const top = page.locator('.engine-web-node[data-kind="section"]').first();
  await top.click({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Delete component' }).click();
  await expect(page.locator('.engine-web-content > [data-kind="heading"]')).toHaveText('Keep this');
  await page.reload();
  await expect(page.locator('.engine-web-content > [data-kind="heading"]')).toHaveText('Keep this');
});
