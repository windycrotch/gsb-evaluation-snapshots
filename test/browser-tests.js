/* eslint-disable */
// Browser-runnable verification for the export chain.
//
// This page loads the real application modules (export panel, PNG/WebP
// exporters) and drives the real buttons with tiny generated PNG fixtures.
// Results are POSTed back to the runner (`test/run-browser-tests.mjs`) and also
// exposed on `window.__EXPORT_TEST_RESULT__`.

import {
    ADDRESS_CLAMP_TO_EDGE,
    Application,
    Asset,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    TEXTURETYPE_DEFAULT,
    Texture
} from 'playcanvas';

import { TextureExportPanel } from '../src/export-panel';
import { PngExporter } from '../src/png-exporter';
import { ModuleCache, WebpExporter } from '../src/webp-exporter';
import { TextureDoc } from '../src/texture-doc';
import { TextureManager } from '../src/texture-manager';

const report = document.getElementById('report');
const results = [];

const log = (text, cls) => {
    const line = document.createElement('div');
    line.textContent = text;
    if (cls) {
        line.className = cls;
    }
    report.appendChild(line);
};

const record = (name, error) => {
    if (error) {
        results.push({ name, ok: false, error: `${error && error.stack ? error.stack : error}` });
        log(`FAIL ${name}\n    ${error}`, 'fail');
    } else {
        results.push({ name, ok: true });
        log(`PASS ${name}`, 'pass');
    }
};

const assert = (condition, message) => {
    if (!condition) {
        throw new Error(message || 'assertion failed');
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (fn, label, timeout = 20000, interval = 25) => {
    const start = performance.now();
    for (;;) {
        let value;
        try {
            value = fn();
        } catch (err) {
            value = undefined;
        }
        if (value) {
            return value;
        }
        if (performance.now() - start > timeout) {
            throw new Error(`timed out waiting for ${label}`);
        }
        await sleep(interval);
    }
};

// capture downloads instead of navigating
const downloads = [];
const blobUrls = new Map();
const originalCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (obj) => {
    const url = originalCreateObjectURL(obj);
    if (obj instanceof Blob) {
        blobUrls.set(url, obj);
    }
    return url;
};
const originalAnchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
        downloads.push({ filename: this.download, blob: blobUrls.get(this.href) });
    }
};

// capture errors reported by the export panel
const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
    consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : `${arg}`)).join(' '));
    originalConsoleError(...args);
};

const readBlob = async (blob) => new Uint8Array(await blob.arrayBuffer());

// guard against regressions where a promise is never settled: without this a
// lost promise would hang the whole suite instead of failing the assertion
const withTimeout = (promise, label, ms = 15000) => {
    return Promise.race([
        promise,
        sleep(ms).then(() => {
            throw new Error(`promise never settled: ${label}`);
        })
    ]);
};

const loadFixture = (textureManager, filename) =>
    new Promise((resolve, reject) => {
        const url = new URL(`./fixtures/${filename}`, window.location.href).href;
        textureManager.addTextureDocByUrl(url, filename, (err, doc) => {
            if (err || !doc) {
                reject(err || new Error(`failed to load ${filename}`));
            } else {
                resolve(doc);
            }
        });
    });

class Gate {
    constructor() {
        this.promise = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    release() {
        this.resolve();
    }
}

// exporter the panel is pointed at; delegates to the real encoder unless a test
// mode is selected
class RoutingExporter {
    constructor(extension, real) {
        this.extension = extension;
        this.real = real;
        this.mode = 'real';
        this.calls = 0;
        this.gate = null;
    }

    async run(words, width, height) {
        this.calls += 1;
        if (this.mode === 'gate') {
            await this.gate.promise;
        } else if (this.mode === 'fail') {
            throw new Error('synthetic encode failure');
        }
        return this.real.run(words, width, height);
    }
}

class FakeWorker {
    constructor() {
        this.listeners = new Map();
        this.terminated = false;
        this.onPost = () => {};
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        const index = list.indexOf(fn);
        if (index !== -1) {
            list.splice(index, 1);
        }
    }

    dispatch(type, payload) {
        (this.listeners.get(type) || []).forEach((fn) => fn(payload));
    }

    postMessage(data) {
        this.onPost(data);
    }

    terminate() {
        this.terminated = true;
    }
}

class MockWebpModule {
    constructor() {
        this.buffer = new Uint8Array(1 << 20);
        this.HEAPU8 = this.buffer;
        this.HEAPU32 = new Uint32Array(this.buffer.buffer);
        this.next = 64;
    }

    _malloc(size) {
        const ptr = this.next;
        this.next += Math.max(8, size);
        return ptr;
    }

    _free() {}

    _webp_encode_lossless_rgba(data, width, height, stride, outPtrPtr, outSizePtr) {
        const size = 12;
        const out = this._malloc(size);
        this.HEAPU8.set([0x52, 0x49, 0x46, 0x46, width, height, 0x57, 0x45, 0x42, 0x50, 1, 1], out);
        this.HEAPU32[outPtrPtr >> 2] = out;
        this.HEAPU32[outSizePtr >> 2] = size;
        return 1;
    }

    _webp_free() {}
}

// builds an empty 2x2 cubemap on the real device; the export panel reads its
// faces through the engine, so this exercises the actual read path
const createCubemapTexture = (device) => {
    return new Texture(device, {
        cubemap: true,
        width: 2,
        height: 2,
        format: PIXELFORMAT_RGBA8,
        type: TEXTURETYPE_DEFAULT,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
};

const createTextureDocFor = (textureManager, texture, filename) => {
    const asset = new Asset(filename, 'texture', { filename, url: '' });
    asset.resource = texture;
    asset.loaded = true;
    textureManager.assets.add(asset);
    const doc = new TextureDoc(asset);
    textureManager.addTextureDoc(doc);
    return doc;
};

const distBase = () => new URL('../dist/', window.location.href).href;

const createRealPng = () => new PngExporter({ createWorker: () => PngExporter.createWorker(distBase()) });
const createRealWebp = () => new WebpExporter({ moduleDir: `${distBase()}lib/webp/`, cache: new ModuleCache() });

const main = async () => {
    // ---------------------------------------------------------------- setup
    const app = new Application(document.createElement('canvas'), {
        graphicsDeviceOptions: { alpha: true, preferWebgl2: true }
    });
    app.loader.getHandler('texture').crossOrigin = 'anonymous';

    const textureManager = new TextureManager(app.assets);

    const avatarDoc = await loadFixture(textureManager, 'avatar.png');
    const stripesDoc = await loadFixture(textureManager, 'stripes.png');

    const pngRouter = new RoutingExporter('png', createRealPng());
    const webpRouter = new RoutingExporter('webp', createRealWebp());

    const panel = new TextureExportPanel(
        textureManager,
        {},
        {
            pngExporter: pngRouter,
            webpExporter: webpRouter
        }
    );
    document.body.appendChild(panel.dom);

    const buttons = Array.from(panel.dom.querySelectorAll('.inspector-button'));
    const pngButton = buttons[0];
    const webpButton = buttons[1];

    const buttonState = (button) => ({
        text: button.textContent,
        busy: button.classList.contains('busy-anim'),
        disabled: button.classList.contains('pcui-disabled') || button.disabled === true
    });

    const waitIdle = (button, label) =>
        waitFor(() => {
            const state = buttonState(button);
            return !state.busy && state.text === label ? state : null;
        }, `button "${label}" to become idle`);

    const waitDownload = (count) => waitFor(() => downloads.length > count, 'download');

    // -------------------------------------------------- 1. normal PNG export
    try {
        textureManager.selectTextureDoc(avatarDoc);
        await waitFor(() => !pngButton.classList.contains('pcui-disabled'), 'PNG button enabled');

        const before = downloads.length;
        pngButton.click();

        await waitDownload(before);
        await waitIdle(pngButton, 'EXPORT TO PNG');

        const entry = downloads[downloads.length - 1];
        assert(entry.filename === 'avatar.png', `unexpected filename ${entry.filename}`);
        const bytes = await readBlob(entry.blob);
        assert(
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
            'downloaded data is not a PNG'
        );
        assert(buttonState(pngButton).disabled === false, 'button still disabled after export');
        record('normal PNG export downloads a PNG named after the selected texture');
    } catch (err) {
        record('normal PNG export downloads a PNG named after the selected texture', err);
    }

    // ------------------------------------------------ 2. normal WebP export
    try {
        const before = downloads.length;
        webpButton.click();
        await waitDownload(before);
        await waitIdle(webpButton, 'EXPORT TO WEBP');

        const entry = downloads[downloads.length - 1];
        assert(entry.filename === 'avatar.webp', `unexpected filename ${entry.filename}`);
        const bytes = await readBlob(entry.blob);
        assert(
            bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46,
            'downloaded data is not a RIFF/WEBP file'
        );
        record('normal WebP export downloads a WEBP named after the selected texture');
    } catch (err) {
        record('normal WebP export downloads a WEBP named after the selected texture', err);
    }

    // ------------------------- 3. switching selection mid-export must not retarget
    let gate = new Gate();
    try {
        pngRouter.mode = 'gate';
        pngRouter.gate = gate;
        pngRouter.calls = 0;

        textureManager.selectTextureDoc(avatarDoc);
        const before = downloads.length;

        pngButton.click();
        await waitFor(() => pngRouter.calls === 1, 'PNG encode started');
        await waitFor(() => buttonState(pngButton).busy, 'busy animation');

        // switch to the other texture while the export is in flight
        textureManager.selectTextureDoc(stripesDoc);
        await sleep(75);

        const during = buttonState(pngButton);
        assert(during.busy, 'button lost its busy style after selection changed');
        assert(during.text === 'BUSY...', 'button text was reset after selection changed');
        assert(during.disabled, 'button became clickable after selection changed');

        gate.release();
        await waitDownload(before);
        await waitIdle(pngButton, 'EXPORT TO PNG');

        assert(downloads.length === before + 1, `expected one download, got ${downloads.length - before}`);
        assert(downloads[downloads.length - 1].filename === 'avatar.png', 'export was retargeted');

        // the panel must accept the next export, now targeting the new selection
        pngRouter.mode = 'real';
        const beforeSecond = downloads.length;
        pngButton.click();
        await waitDownload(beforeSecond);
        await waitIdle(pngButton, 'EXPORT TO PNG');
        assert(downloads[downloads.length - 1].filename === 'stripes.png', 'second export used wrong texture');

        record('selection changes do not retarget or re-enable an in-flight export');
    } catch (err) {
        gate.release();
        record('selection changes do not retarget or re-enable an in-flight export', err);
    } finally {
        pngRouter.mode = 'real';
    }

    // ---------------------------------------- 4. repeated clicks while exporting
    gate = new Gate();
    try {
        pngRouter.mode = 'gate';
        pngRouter.gate = gate;
        pngRouter.calls = 0;

        textureManager.selectTextureDoc(avatarDoc);
        const before = downloads.length;

        pngButton.click();
        await waitFor(() => pngRouter.calls === 1, 'first encode started');

        // second and third clicks while the first export is running are ignored
        pngButton.click();
        pngButton.click();
        await sleep(100);
        assert(pngRouter.calls === 1, `encoder invoked ${pngRouter.calls} times for repeated clicks`);

        gate.release();
        await waitDownload(before);
        await waitIdle(pngButton, 'EXPORT TO PNG');
        assert(downloads.length === before + 1, 'repeated clicks produced more than one download');

        record('repeated clicks while busy are ignored (single export)');
    } catch (err) {
        gate.release();
        record('repeated clicks while busy are ignored (single export)', err);
    } finally {
        pngRouter.mode = 'real';
    }

    // ---------------------------------- 5. exporter-level concurrency settlement
    try {
        const png = createRealPng();
        const first = png.run(new Uint32Array(4), 2, 2);
        const second = png.run(new Uint32Array(4), 2, 2);
        const [firstResult, secondResult] = await withTimeout(
            Promise.allSettled([first, second]),
            'concurrent PNG runs to settle'
        );
        assert(firstResult.status === 'fulfilled', 'first PNG run should resolve');
        assert(secondResult.status === 'rejected', 'second concurrent PNG run should reject');
        assert(/already in progress/.test(secondResult.reason.message), 'unexpected rejection message');
        assert(firstResult.value.length > 0, 'first PNG run produced no data');

        const third = await withTimeout(png.run(new Uint32Array(4), 2, 2), 'PNG run after concurrency rejection');
        assert(third.length > 0, 'PNG exporter stuck after concurrent rejection');

        record('PNG exporter rejects concurrent runs and still settles every promise');
    } catch (err) {
        record('PNG exporter rejects concurrent runs and still settles every promise', err);
    }

    try {
        const webp = new WebpExporter({
            moduleDir: 'mock/',
            loader: () => Promise.resolve(new MockWebpModule()),
            cache: new ModuleCache()
        });

        const first = webp.run(new Uint32Array(4), 2, 2);
        const second = webp.run(new Uint32Array(4), 2, 2);
        const [firstResult, secondResult] = await withTimeout(
            Promise.allSettled([first, second]),
            'concurrent WebP runs to settle'
        );
        assert(firstResult.status === 'fulfilled', 'first WebP run should resolve');
        assert(secondResult.status === 'rejected', 'second concurrent WebP run should reject');
        assert(/already in progress/.test(secondResult.reason.message), 'unexpected rejection message');
        assert(firstResult.value.length > 0, 'first WebP run produced no data');

        const third = await withTimeout(webp.run(new Uint32Array(4), 2, 2), 'WebP run after concurrency rejection');
        assert(third.length > 0, 'WebP exporter stuck after concurrent rejection');

        record('WebP exporter rejects concurrent runs and still settles every promise');
    } catch (err) {
        record('WebP exporter rejects concurrent runs and still settles every promise', err);
    }

    // ------------------------------------------ 6. encoding failure recovery
    try {
        pngRouter.mode = 'fail';
        pngRouter.calls = 0;

        textureManager.selectTextureDoc(avatarDoc);
        const before = downloads.length;
        const errorsBefore = consoleErrors.length;

        pngButton.click();
        await waitFor(() => consoleErrors.length > errorsBefore, 'export error to be logged');
        const idle = await waitIdle(pngButton, 'EXPORT TO PNG');

        assert(!idle.busy, 'busy style was not removed after failure');
        assert(downloads.length === before, 'a download happened despite the encode failure');
        assert(!idle.disabled, 'button stayed disabled after failure');
        assert(panel.enabled, 'panel stayed disabled after failure');

        pngRouter.mode = 'real';
        pngButton.click();
        await waitDownload(before);
        await waitIdle(pngButton, 'EXPORT TO PNG');
        assert(downloads[downloads.length - 1].filename === 'avatar.png', 'retry exported the wrong texture');

        record('encoding failure restores button state/text and allows retry');
    } catch (err) {
        record('encoding failure restores button state/text and allows retry', err);
    } finally {
        pngRouter.mode = 'real';
    }

    // --------------------------------- 7. PNG worker failure replaces the worker
    try {
        const instances = [];
        const png = new PngExporter({
            createWorker: () => {
                const worker = new FakeWorker();
                instances.push(worker);
                return worker;
            }
        });

        // the first worker reports an uncaught error while handling the request
        instances[0].onPost = () => {
            setTimeout(() => instances[0].dispatch('error', { message: 'synthetic worker crash' }), 0);
        };
        let rejected = null;
        await png.run(new Uint32Array(4), 2, 2).catch((err) => {
            rejected = err;
        });
        assert(rejected && /synthetic worker crash/.test(rejected.message), 'worker error did not reject');

        // failure must replace the wedged worker; the replacement succeeds
        assert(instances.length === 2, `expected a replacement worker, got ${instances.length}`);
        assert(instances[0].terminated, 'failed worker was not terminated');
        instances[1].onPost = (data) => {
            setTimeout(
                () => instances[1].dispatch('message', { data: { id: data.id, result: new Uint8Array([7, 7]) } }),
                0
            );
        };
        const result = await png.run(new Uint32Array(4), 2, 2);
        assert(result.length === 2, 'replacement worker did not produce data');

        // an encode error reported by the worker must also settle and recover
        instances[1].onPost = (data) => {
            setTimeout(() => instances[1].dispatch('message', { data: { id: data.id, error: 'encode blew up' } }), 0);
        };
        rejected = null;
        await png.run(new Uint32Array(4), 2, 2).catch((err) => {
            rejected = err;
        });
        assert(rejected && /encode blew up/.test(rejected.message), 'encode error did not reject');
        assert(instances.length === 3, 'worker was not replaced after an encode error');

        instances[2].onPost = (data) => {
            setTimeout(
                () => instances[2].dispatch('message', { data: { id: data.id, result: new Uint8Array([9, 9]) } }),
                0
            );
        };
        const recovered = await png.run(new Uint32Array(4), 2, 2);
        assert(recovered.length === 2, 'exporter did not recover after an encode error');

        record('PNG worker settles on errors and recovers by replacing the worker');
    } catch (err) {
        record('PNG worker settles on errors and recovers by replacing the worker', err);
    }

    // ------------------------- 8. WebP wasm init failure is not cached (retryable)
    try {
        let loads = 0;
        const webp = new WebpExporter({
            moduleDir: 'mock/',
            loader: () => {
                loads += 1;
                if (loads === 1) {
                    return Promise.reject(new Error('synthetic wasm fetch failure'));
                }
                if (loads === 2) {
                    // half-initialized module: factory resolved but exports missing
                    return Promise.resolve({});
                }
                return Promise.resolve(new MockWebpModule());
            },
            cache: new ModuleCache()
        });

        await webp.run(new Uint32Array(4), 2, 2).then(
            () => assert(false, 'first run should fail'),
            (err) => assert(/synthetic wasm fetch failure/.test(err.message), `unexpected error ${err}`)
        );

        await webp.run(new Uint32Array(4), 2, 2).then(
            () => assert(false, 'second run should fail'),
            (err) => assert(/failed to initialize/.test(err.message), `unexpected error ${err}`)
        );

        const bytes = await webp.run(new Uint32Array(4), 2, 2);
        assert(bytes.length > 0, 'WebP did not recover after init failures');
        assert(loads === 3, `expected 3 load attempts, got ${loads}`);

        await webp.run(new Uint32Array(4), 2, 2);
        assert(loads === 3, 'successful module was not cached');

        record('WebP wasm init failures are retryable and never cached half-initialized');
    } catch (err) {
        record('WebP wasm init failures are retryable and never cached half-initialized', err);
    }

    // ------------------- 9. texture removed / unloaded mid-export rejects cleanly
    gate = new Gate();
    try {
        pngRouter.mode = 'gate';
        pngRouter.gate = gate;
        pngRouter.calls = 0;

        const doomedDoc = await loadFixture(textureManager, 'doomed.png');
        textureManager.selectTextureDoc(doomedDoc);
        const before = downloads.length;
        const errorsBefore = consoleErrors.length;

        pngButton.click();
        await waitFor(() => pngRouter.calls === 1, 'encode started on doomed texture');
        await waitFor(() => buttonState(pngButton).busy, 'busy state on doomed texture');

        // the texture disappears while the encode is in flight
        textureManager.removeTextureDoc(doomedDoc);

        gate.release();
        await waitFor(() => consoleErrors.length > errorsBefore, 'removal error to be logged');
        await sleep(100);

        assert(downloads.length === before, 'downloaded data for a removed texture');
        assert(
            consoleErrors.some((line) => /removed or unloaded/.test(line)),
            'export did not report a removed/unloaded texture'
        );
        const idle = await waitIdle(pngButton, 'EXPORT TO PNG');
        assert(!idle.disabled, 'button disabled after removal export failure');

        record('removing a texture mid-export ends the export with an error');
    } catch (err) {
        gate.release();
        record('removing a texture mid-export ends the export with an error', err);
    } finally {
        pngRouter.mode = 'real';
    }

    gate = new Gate();
    try {
        pngRouter.mode = 'gate';
        pngRouter.gate = gate;
        pngRouter.calls = 0;

        const unloadedDoc = await loadFixture(textureManager, 'unloaded.png');
        textureManager.selectTextureDoc(unloadedDoc);
        const before = downloads.length;
        const errorsBefore = consoleErrors.length;

        pngButton.click();
        await waitFor(() => pngRouter.calls === 1, 'encode started on unloaded texture');
        await waitFor(() => buttonState(pngButton).busy, 'busy state on unloaded texture');

        // unload the asset (destroys the texture) while the encode is in flight
        unloadedDoc.asset.unload();

        gate.release();
        await waitFor(() => consoleErrors.length > errorsBefore, 'unload error to be logged');
        await sleep(100);

        assert(downloads.length === before, 'downloaded data for an unloaded texture');
        assert(
            consoleErrors.some((line) => /removed or unloaded/.test(line)),
            'export did not report a removed/unloaded texture'
        );

        record('unloading an asset mid-export ends the export with an error');
    } catch (err) {
        gate.release();
        record('unloading an asset mid-export ends the export with an error', err);
    } finally {
        pngRouter.mode = 'real';
    }

    // ------------------------------------ 10. formats can export concurrently
    gate = new Gate();
    try {
        pngRouter.mode = 'gate';
        pngRouter.gate = gate;
        pngRouter.calls = 0;

        textureManager.selectTextureDoc(avatarDoc);
        const before = downloads.length;

        pngButton.click();
        await waitFor(() => pngRouter.calls === 1, 'PNG encode started');

        // while PNG is busy, WebP must still work independently
        webpButton.click();
        await waitDownload(before);
        await waitIdle(webpButton, 'EXPORT TO WEBP');
        assert(downloads[downloads.length - 1].filename === 'avatar.webp', 'WebP export used wrong filename');

        const during = buttonState(pngButton);
        assert(during.busy && during.disabled, 'PNG button state changed by a WebP export');

        gate.release();
        await waitFor(() => downloads.length > before + 1, 'PNG download after gate release');
        await waitIdle(pngButton, 'EXPORT TO PNG');

        record('each format exporter works independently');
    } catch (err) {
        gate.release();
        record('each format exporter works independently', err);
    } finally {
        pngRouter.mode = 'real';
    }

    // --------------------------- 11. cubemap faces are downloaded atomically
    try {
        // a cubemap whose second face fails must not leave partial downloads
        const faceGate = new Gate();
        let faceCalls = 0;
        const cubemapExporter = {
            extension: 'png',
            async run(words, width, height) {
                faceCalls += 1;
                if (faceCalls === 2) {
                    throw new Error('synthetic second-face failure');
                }
                await faceGate.promise;
                return createRealPng()
                    .run(words, width, height)
                    .catch(() => new Uint8Array([1, 2, 3]));
            }
        };

        const cubemapTexture = createCubemapTexture(app.graphicsDevice);
        const cubemapDoc = createTextureDocFor(textureManager, cubemapTexture, 'env.png');
        textureManager.selectTextureDoc(cubemapDoc);
        const before = downloads.length;
        const errorsBefore = consoleErrors.length;

        // the fake cubemap exporter is plugged in by constructing a dedicated panel
        const cubemapPanel = new TextureExportPanel(
            textureManager,
            {},
            { pngExporter: cubemapExporter, webpExporter: webpRouter, hdrExporter: panel.hdrExporter }
        );
        document.body.appendChild(cubemapPanel.dom);
        const cubemapButton = cubemapPanel.dom.querySelector('.inspector-button');
        await waitFor(() => !cubemapButton.classList.contains('pcui-disabled'), 'cubemap PNG button enabled');

        faceGate.release();
        cubemapButton.click();
        await waitFor(() => consoleErrors.length > errorsBefore, 'cubemap export failure to be logged');
        await waitIdle(cubemapButton, 'EXPORT TO PNG');

        assert(downloads.length === before, 'a partial cubemap download happened before the failure');
        assert(faceCalls === 2, `expected the export to stop after the failing face, got ${faceCalls} calls`);
        assert(!buttonState(cubemapButton).disabled, 'cubemap button stayed disabled after failure');

        record('cubemap export downloads all faces atomically (no partial set)');
    } catch (err) {
        record('cubemap export downloads all faces atomically (no partial set)', err);
    }

    // ---------------------- 12. repeated exports reuse one worker but recover
    try {
        let created = 0;
        const workers = [];
        const png = new PngExporter({
            createWorker: () => {
                created += 1;
                if (created === 1) {
                    throw new Error('synthetic worker creation failure');
                }
                const worker = new FakeWorker();
                worker.onPost = (data) => {
                    setTimeout(
                        () =>
                            worker.dispatch('message', {
                                data: { id: data.id, result: new Uint8Array([1, 2, 3, 4]) }
                            }),
                        0
                    );
                };
                workers.push(worker);
                return worker;
            }
        });

        // the constructor could not create a worker; the next run retries
        const result = await withTimeout(png.run(new Uint32Array(4), 2, 2), 'PNG run after creation failure');
        assert(result.length === 4, 'exporter did not recover from a worker creation failure');
        assert(created === 2, `expected the worker factory to be retried, got ${created} attempts`);

        // the recovered worker is reused for later exports
        await png.run(new Uint32Array(4), 2, 2);
        assert(created === 2, 'a healthy worker was needlessly recreated');

        record('PNG exporter retries worker creation and reuses a healthy worker');
    } catch (err) {
        record('PNG exporter retries worker creation and reuses a healthy worker', err);
    }

    const failed = results.filter((r) => !r.ok);
    const summary = {
        done: true,
        passed: results.length - failed.length,
        failed: failed.length,
        results
    };
    window.__EXPORT_TEST_RESULT__ = summary;
    log('', null);
    log(`DONE: ${summary.passed} passed, ${summary.failed} failed`, failed.length ? 'fail' : 'pass');

    // hand the result to the runner
    try {
        await fetch('/__result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(summary)
        });
    } catch (err) {
        originalConsoleError('failed to post results', err);
    }
};

main().catch((err) => {
    const summary = {
        done: true,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length + 1,
        fatal: `${err && err.stack ? err.stack : err}`,
        results
    };
    window.__EXPORT_TEST_RESULT__ = summary;
    log(`FATAL ${summary.fatal}`, 'fail');
    fetch('/__result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary)
    }).catch(() => {});
});
