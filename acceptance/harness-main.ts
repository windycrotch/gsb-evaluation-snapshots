// Acceptance harness: assembles the REAL ReprojectPanel with a REAL
// TextureManager and PlayCanvas application, then runs a sequence of
// session-semantics scenarios driven from run-tests.cjs over CDP.
import { Application, Asset, Texture } from 'playcanvas';
import { Container } from '@playcanvas/pcui';

import { ReprojectPanel } from '../src/reproject-panel';
import { setReprojectImpl } from '../src/reproject-impl';
import { TextureDoc } from '../src/texture-doc';
import { TextureManager } from '../src/texture-manager';

type TestResult = {
    name: string;
    ok: boolean;
    detail: string;
};

// controls are retained as PCUI instances so tests can drive them through the
// real component API (SelectInput is fully custom, not a native <select>)
type HarnessControls = {
    source: import('@playcanvas/pcui').SelectInput;
    target: import('@playcanvas/pcui').SelectInput;
    encoding: import('@playcanvas/pcui').SelectInput;
    width: import('@playcanvas/pcui').NumericInput;
    height: import('@playcanvas/pcui').NumericInput;
    button: import('@playcanvas/pcui').Button;
    errorLabel: import('@playcanvas/pcui').Label;
};

class Harness {
    app: Application;
    textureManager: TextureManager;
    panel: ReprojectPanel;
    controls: HarnessControls;
    results: TestResult[] = [];

    constructor() {
        const canvas = document.createElement('canvas');
        this.app = new Application(canvas, {
            graphicsDeviceOptions: {
                alpha: true,
                preferWebGl2: true
            }
        });
        this.app.systems.fire('initialize', this.app.root);
        this.app.systems.fire('postInitialize', this.app.root);

        this.textureManager = new TextureManager(this.app.assets);

        const root = new Container({
            dom: document.getElementById('root')!
        });
        this.panel = new ReprojectPanel(this.textureManager);
        root.append(this.panel);

        // the panel exposes its real PCUI components for harness driving
        this.controls = this.panel.controls;

        (window as unknown as { harness: Harness }).harness = this;
        document.title = 'HARNESS_READY';
    }

    // load a fixture file as an asset through the normal asset registry path
    async loadFixture(url: string, filename: string): Promise<TextureDoc> {
        return new Promise((resolve, reject) => {
            this.textureManager.addTextureDocByUrl(url, filename, (err, doc) => {
                if (err || !doc) {
                    reject(err || new Error('no doc'));
                } else {
                    resolve(doc);
                }
            });
        });
    }

    select(doc: TextureDoc): void {
        this.textureManager.selectTextureDoc(doc);
    }

    // --- control accessors into the real PCUI panel ---
    button(): HTMLButtonElement {
        return this.controls.button.dom as HTMLButtonElement;
    }

    errorLabel(): HTMLElement {
        return this.controls.errorLabel.dom;
    }

    isErrorVisible(): boolean {
        return !this.controls.errorLabel.hidden;
    }

    errorText(): string {
        return this.controls.errorLabel.text;
    }

    setSelect(name: 'source' | 'target' | 'encoding', optionText: string): void {
        const input = this.controls[name];
        const option = (input.options as { v: string; t: string }[]).find((o) => o.t === optionText);
        if (!option) {
            throw new Error(`option ${optionText} not found on ${name}`);
        }
        input.value = option.v;
    }

    setNumeric(name: 'width' | 'height', value: number): void {
        this.controls[name].value = value;
    }

    getNumeric(name: 'width' | 'height'): number {
        return this.controls[name].value as number;
    }

    selectValue(name: 'source' | 'target' | 'encoding'): string {
        const input = this.controls[name];
        const option = (input.options as { v: string; t: string }[]).find((o) => o.v === input.value);
        return option ? option.t : String(input.value);
    }

    isControlEnabled(name: keyof HarnessControls): boolean {
        return this.controls[name].enabled;
    }

    clickReproject(): void {
        this.controls.button.dom.click();
    }

    // click and resolve on the first animation frame of the busy window, so
    // callers can inspect control state while the session is genuinely active
    async clickReprojectAndSampleBusy(): Promise<Record<string, boolean>> {
        this.controls.button.dom.click();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        return {
            button: this.controls.button.enabled,
            source: this.controls.source.enabled,
            target: this.controls.target.enabled,
            encoding: this.controls.encoding.enabled,
            width: this.controls.width.enabled,
            height: this.controls.height.enabled
        };
    }

    wait(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // wait until the busy flag (observed via button state) settles
    async waitForIdle(timeoutMs = 8000): Promise<void> {
        const start = performance.now();
        while (!this.button().classList.contains('pcui-disabled')) {
            if (performance.now() - start > timeoutMs) {
                throw new Error('timed out waiting for busy state');
            }
            await this.wait(20);
        }
        // busy -> idle transition
        while (this.button().classList.contains('pcui-disabled')) {
            if (performance.now() - start > timeoutMs) {
                throw new Error('timed out waiting for idle state');
            }
            await this.wait(20);
        }
    }

    isBusy(): boolean {
        return this.button().classList.contains('pcui-disabled');
    }

    record(name: string, ok: boolean, detail: string): void {
        this.results.push({ name, ok, detail });
    }

    report(): TestResult[] {
        return this.results;
    }

    // wrap Texture.destroy on the device's texture constructor so tests can
    // assert that session-created intermediate textures were destroyed
    installDestroyTracker(): { created: Texture[]; destroyed: Texture[] } {
        const tracker = { created: [] as Texture[], destroyed: [] as Texture[] };
        const proto = Texture.prototype;
        const originalDestroy = proto.destroy;
        proto.destroy = function wrappedDestroy(this: Texture) {
            tracker.destroyed.push(this);
            return originalDestroy.call(this);
        };
        (this as unknown as { _destroyTracker: typeof tracker })._destroyTracker = tracker;
        return tracker;
    }

    tracker(): { created: Texture[]; destroyed: Texture[] } {
        return (this as unknown as { _destroyTracker: { created: Texture[]; destroyed: Texture[] } })
            ._destroyTracker;
    }

    // number of texture docs currently in the file list
    docCount(): number {
        return this.textureManager.textureDocs.size;
    }

    // force the next reproject call to fail, exercising the panel's real
    // catch/cleanup/error path; the engine implementation is restored afterwards
    injectReprojectFailure(message: string): void {
        setReprojectImpl(() => {
            throw new Error(message);
        });
    }

    restoreReproject(): void {
        setReprojectImpl(null);
    }

    selectedDocName(): string | null {
        const doc = this.textureManager.selectedTextureDoc;
        return doc?.asset ? doc.asset.name : null;
    }

    // build a cubemap texture directly (no network): 6 faces, RGBA8
    createCubemapDoc(name: string, size = 8): TextureDoc {
        const device = this.app.graphicsDevice;
        const tex = new Texture(device, {
            cubemap: true,
            width: size,
            height: size,
            mipmaps: false,
            projection: 'cube'
        });
        const levels: Uint8Array[] = [];
        for (let face = 0; face < 6; face++) {
            const data = new Uint8Array(size * size * 4);
            for (let i = 0; i < size * size; i++) {
                data[i * 4] = 40 * face;
                data[i * 4 + 1] = 120;
                data[i * 4 + 2] = 200;
                data[i * 4 + 3] = 255;
            }
            levels.push(data);
        }
        tex._levels = [levels];
        tex.upload();

        const asset = new Asset(name, 'cubemap', { filename: name, url: '' });
        asset.resource = tex;
        asset.loaded = true;
        this.app.assets.add(asset);
        const doc = new TextureDoc(asset);
        this.textureManager.addTextureDoc(doc);
        return doc;
    }
}

new Harness();
