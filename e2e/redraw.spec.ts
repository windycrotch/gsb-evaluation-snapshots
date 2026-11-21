import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type UiModule = typeof import('../src/store/ui');
type GlModule = typeof import('../src/render/gl');
type SampleModule = typeof import('../src/store/sample');
type AssetsModule = typeof import('../src/store/assets');
const UI = '/src/store/ui.ts';
const GL = '/src/render/gl.ts';
const SAMPLE = '/src/store/sample.ts';
const ASSETS = '/src/store/assets.ts';

interface Probe {
  /** canvases that were resized and not painted again before the browser got to show them */
  blank: string[];
  resized: number;
}

/**
 * Watches every canvas: when its size is set the picture in it is gone, so something must paint it again before the browser shows the
 * frame. The check runs in a microtask right after the resize, i.e. before the frame is shown. A canvas that is repainted only in the
 * next animation frame blinks (black for the viewport, the page colour for the timeline) once per step while a panel is dragged.
 */
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { blank: [], resized: 0 };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const painted = new WeakSet<HTMLCanvasElement>();
    const mark = (proto: object, names: string[]) => {
      for (const n of names) {
        const orig = (proto as Record<string, (...a: unknown[]) => unknown>)[n];
        (proto as Record<string, unknown>)[n] = function (this: { canvas: HTMLCanvasElement }, ...a: unknown[]) {
          painted.add(this.canvas);
          return orig.apply(this, a);
        };
      }
    };
    mark(CanvasRenderingContext2D.prototype, ['fillRect', 'clearRect', 'fill', 'stroke', 'drawImage', 'fillText']);
    mark(WebGL2RenderingContext.prototype, ['clear', 'drawElements', 'drawArrays']);
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      ...d,
      set(this: HTMLCanvasElement, v: number) {
        const changed = (d.get as () => number).call(this) !== v;
        (d.set as (v: number) => void).call(this, v);
        if (!changed) return;
        probe.resized++;
        painted.delete(this);
        queueMicrotask(() => {
          if (painted.has(this) || !this.isConnected) return;
          const place = this.parentElement?.className || this.parentElement?.tagName || '';
          probe.blank.push(`${place} > canvas#${[...(this.parentElement?.querySelectorAll('canvas') ?? [])].indexOf(this)}`);
        });
      },
    });
  });
}

async function openDemo(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.locator('.overlay .choice.primary').click();
  await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
  await page.waitForTimeout(600);
}

test('dragging the panel edges never leaves a canvas blank for a frame', async ({ page }) => {
  await installProbe(page);
  await openDemo(page);
  await page.evaluate(() => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    p.blank.length = 0;
    p.resized = 0;
  });
  // the timeline in Animate mode has canvases too (dopesheet, ruler)
  await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    uiStore.patch({ mode: 'animate' });
  }, UI);
  await page.waitForTimeout(400);
  const steps = [
    { left: 300 },
    { left: 340, right: 280 },
    { right: 330, bottom: 300 },
    { bottom: 200, left: 250 },
    { left: 400, right: 400, bottom: 160 },
  ];
  for (const s of steps) {
    await page.evaluate(
      async ([url, patch]) => {
        const { uiStore } = (await import(url)) as UiModule;
        uiStore.patch({ panel: { ...uiStore.get().panel, ...(patch as object) } });
      },
      [UI, s] as const,
    );
    await page.waitForTimeout(160);
  }
  const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
  expect(probe.resized, 'the canvases were resized at all').toBeGreaterThan(4);
  expect([...new Set(probe.blank)]).toEqual([]);
});

test('loading the demo while another rig is open never shows pictures missing (white shapes)', async ({ page }) => {
  await openDemo(page);
  const missing = await page.evaluate(
    async ([glUrl, sampleUrl]) => {
      const GL = (await import(glUrl)) as GlModule;
      const sample = (await import(sampleUrl)) as SampleModule;
      let nullTex = 0;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the renderer as `this`
      const orig = GL.GLRenderer.prototype.texture;
      GL.GLRenderer.prototype.texture = function (this: InstanceType<typeof GL.GLRenderer>, n: string) {
        const r = orig.call(this, n);
        if (!r) nullTex++;
        return r;
      };
      await sample.loadSample();
      await new Promise((r) => setTimeout(r, 700));
      GL.GLRenderer.prototype.texture = orig;
      return nullTex;
    },
    [GL, SAMPLE],
  );
  expect(missing).toBe(0);
});

test('a data URL is turned into a picture file without the network stack, and quickly', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async (url0) => {
    const { dataURLToBlob } = (await import(url0)) as AssetsModule;
    const bytes = new Uint8Array(5_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 30000) bin += String.fromCharCode(...bytes.subarray(i, i + 30000));
    const url = `data:image/png;base64,${btoa(bin)}`;
    const t = performance.now();
    const blob = await dataURLToBlob(url);
    const ms = performance.now() - t;
    const back = new Uint8Array(await blob.arrayBuffer());
    return {
      ms,
      type: blob.type,
      size: blob.size,
      same: back[0] === bytes[0] && back[4_999_999] === bytes[4_999_999] && back[123457] === bytes[123457],
    };
  }, ASSETS);
  expect(r.type).toBe('image/png');
  expect(r.size).toBe(5_000_000);
  expect(r.same).toBe(true);
  expect(r.ms).toBeLessThan(60); // fetch(url) needed about 80 ms for the same size
});

type EncodeModule = typeof import('../src/store/encodeInWorker');
const ENCODE = '/src/store/encodeInWorker.ts';

test('a GIF is encoded in a worker: the page keeps answering, and Cancel stops it at once', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async (url) => {
    const { encodeInWorker, CANCELLED } = (await import(url)) as EncodeModule;
    const frames = Array.from({ length: 40 }, (_, k) => {
      const d = new Uint8ClampedArray(800 * 800 * 4);
      for (let i = 0; i < 800 * 800; i++) {
        d[i * 4] = (i * 7 + k * 40) & 255;
        d[i * 4 + 1] = (i * 3 + k) & 255;
        d[i * 4 + 2] = (i + k * 90) & 255;
        d[i * 4 + 3] = 255;
      }
      return d;
    });
    const options = { width: 800, height: 800, delayCs: 4 };
    // a frame loop measures how long the page did not answer
    const gaps: number[] = [];
    let last = performance.now();
    let on = true;
    const tick = (t: number) => {
      gaps.push(t - last);
      last = t;
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const bytes = await encodeInWorker({ kind: 'gif', frames, options }).result;
    const ms = Math.round(performance.now() - t0);
    on = false;
    // Cancel: the promise rejects at once and the worker is gone
    const again = Array.from({ length: 40 }, () => new Uint8ClampedArray(800 * 800 * 4).fill(90));
    const job = encodeInWorker({ kind: 'gif', frames: again, options });
    const t1 = performance.now();
    setTimeout(() => job.cancel(), 150);
    let message = '';
    try {
      await job.result;
    } catch (e) {
      message = (e as Error).message;
    }
    return {
      ms,
      maxGap: Math.max(...gaps),
      head: String.fromCharCode(...bytes.subarray(0, 6)),
      cancelMs: Math.round(performance.now() - t1),
      cancelled: message === CANCELLED,
    };
  }, ENCODE);
  expect(r.head).toBe('GIF89a');
  expect(r.ms, 'the encode took long enough to matter').toBeGreaterThan(800);
  expect(r.maxGap, 'the page stalled while the worker encoded').toBeLessThan(250);
  expect(r.cancelled).toBe(true);
  expect(r.cancelMs).toBeLessThan(600);
});

test('the Export window renders the demo animation to a GIF through the worker, and the file downloads', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    uiStore.patch({ exportOpen: true });
  }, UI);
  await page.getByRole('radio', { name: /Animation \(GIF/ }).click();
  const render = page.getByRole('button', { name: 'Render' });
  await expect(render).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), render.click()]);
  expect(download.suggestedFilename()).toMatch(/\.gif$/);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(path).subarray(0, 6).toString('latin1')).toBe('GIF89a');
});
