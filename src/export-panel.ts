import { Button, Panel, Container } from '@playcanvas/pcui';
import type { PanelArgs } from '@playcanvas/pcui';
import type { Texture, WebglGraphicsDevice } from 'playcanvas';
import { RenderTarget } from 'playcanvas';

import { HdrExporter } from './hdr-exporter';
import { removeExtension } from './helpers';
import { PngExporter } from './png-exporter';
import type { TextureDoc } from './texture-doc';
import type { TextureManager } from './texture-manager';
import { WebpExporter } from './webp-exporter';

type Exporter = {
    run(words: Uint32Array, width: number, height: number): Promise<Uint8Array> | Uint8Array;
    readonly extension: string;
};

type ExportPanelOptions = {
    pngExporter?: Exporter;
    webpExporter?: Exporter;
    hdrExporter?: Exporter;
};

type ExportTarget = {
    exporter: Exporter;
    button: Button;
    label: string;
    supports: (texture: Texture | null) => boolean;
};

const FACE_NAMES = ['posx', 'negx', 'posy', 'negy', 'posz', 'negz'];

const readPixels = (texture: Texture, face: number | null): Uint32Array => {
    const rt = new RenderTarget({ colorBuffer: texture, depth: false, face: face ?? undefined });
    const data = new Uint8ClampedArray(texture.width * texture.height * 4);
    const device = texture.device as WebglGraphicsDevice;
    const gl = device.gl;

    device.setFramebuffer(rt.impl._glFrameBuffer);
    device.initRenderTarget(rt);
    gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.UNSIGNED_BYTE, data);

    rt.destroy();

    return new Uint32Array(data.buffer);
};

// build a standalone blob so the encoder's backing buffer can be reused
const toBlob = (data: Uint8Array): Blob => {
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    return new Blob([bytes.buffer], { type: 'octet/stream' });
};

// download the data uri
const download = (filename: string, data: Uint8Array): void => {
    const url = window.URL.createObjectURL(toBlob(data));

    const lnk = document.createElement('a');
    lnk.download = filename;
    lnk.href = url;

    lnk.click();

    window.URL.revokeObjectURL(url);
};

// a texture can disappear while an export is in flight: its document can be
// removed from the manager or its asset unloaded (which destroys the texture)
const isTextureAlive = (textureDoc: TextureDoc, texture: Texture): boolean => {
    const asset = textureDoc.asset;
    return !!asset && asset.loaded === true && asset.resource === texture && !!texture.device;
};

class TextureExportPanel extends Panel {
    readonly pngExporter: Exporter;
    readonly webpExporter: Exporter;
    readonly hdrExporter: Exporter;

    private readonly textureManager: TextureManager;
    private readonly targets: ExportTarget[];
    private readonly busyExporters = new Set<Exporter>();

    constructor(textureManager: TextureManager, args: PanelArgs = {}, options: ExportPanelOptions = {}) {
        Object.assign(args, {
            id: 'texture-export-pane',
            headerText: 'Export',
            collapsible: true,
            flexGrow: '1'
        });

        super(args);

        this.textureManager = textureManager;
        this.pngExporter = options.pngExporter ?? new PngExporter();
        this.webpExporter = options.webpExporter ?? new WebpExporter();
        this.hdrExporter = options.hdrExporter ?? new HdrExporter();

        // png export
        const exportToPng = new Button({
            class: 'inspector-button',
            text: 'EXPORT TO PNG',
            icon: 'E228',
            enabled: false
        });

        const exportToPngContainer = new Container({
            class: 'inspector-button-container'
        });
        exportToPngContainer.append(exportToPng);

        // webp export
        const exportToWebp = new Button({
            class: 'inspector-button',
            text: 'EXPORT TO WEBP',
            icon: 'E228',
            enabled: false
        });

        const exportToWebpContainer = new Container({
            class: 'inspector-button-container'
        });
        exportToWebpContainer.append(exportToWebp);

        // hdr export
        const exportToHdr = new Button({
            class: 'inspector-button',
            text: 'EXPORT TO HDR',
            icon: 'E228',
            enabled: false
        });

        const exportToHdrContainer = new Container({
            class: 'inspector-button-container'
        });
        exportToHdrContainer.append(exportToHdr);

        this.append(exportToPngContainer);
        this.append(exportToWebpContainer);
        this.append(exportToHdrContainer);

        this.targets = [
            {
                exporter: this.pngExporter,
                button: exportToPng,
                label: 'EXPORT TO PNG',
                supports: (texture) => !!texture
            },
            {
                exporter: this.webpExporter,
                button: exportToWebp,
                label: 'EXPORT TO WEBP',
                supports: (texture) => !!texture
            },
            {
                exporter: this.hdrExporter,
                button: exportToHdr,
                label: 'EXPORT TO HDR',
                supports: (texture) => texture?.encoding === 'rgbe'
            }
        ];

        // handlers are registered once and always resolve the selection at
        // click time, so rebinding on selection changes can never re-target an
        // export that is already running
        this.targets.forEach((target) => {
            target.button.on('click', () => {
                void this.startExport(target);
            });
        });

        textureManager.on('textureDocSelected', () => this.updateButtonStates());
        textureManager.on('textureDocRemoved', () => this.updateButtonStates());

        this.updateButtonStates();
    }

    private updateButtonStates(): void {
        const texture = this.textureManager.selectedTextureDoc?.resource ?? null;

        this.enabled = !!texture;

        this.targets.forEach((target) => {
            const busy = this.busyExporters.has(target.exporter);
            target.button.enabled = !busy && target.supports(texture);
        });
    }

    private setButtonBusy(target: ExportTarget, busy: boolean): void {
        if (busy) {
            target.button.dom.classList.add('busy-anim');
            target.button.text = 'BUSY...';
            target.button.enabled = false;
        } else {
            target.button.dom.classList.remove('busy-anim');
            target.button.text = target.label;
        }
    }

    private async startExport(target: ExportTarget): Promise<void> {
        const textureDoc = this.textureManager.selectedTextureDoc;
        const texture = textureDoc?.resource ?? null;

        // ignore clicks while this exporter is already running
        if (!textureDoc || !texture || this.busyExporters.has(target.exporter)) {
            return;
        }

        // snapshot everything about the source texture at click time so later
        // selection changes cannot re-target this export
        const filename = textureDoc.filename;
        const cubemap = texture.cubemap;
        const width = texture.width;
        const height = texture.height;

        this.busyExporters.add(target.exporter);
        this.setButtonBusy(target, true);

        try {
            await this.runExport(target.exporter, textureDoc, texture, filename, cubemap, width, height);
        } catch (err) {
            console.error(`export to ${target.exporter.extension} failed`, err);
        } finally {
            this.busyExporters.delete(target.exporter);
            this.setButtonBusy(target, false);
            this.updateButtonStates();
        }
    }

    private async runExport(
        exporter: Exporter,
        textureDoc: TextureDoc,
        texture: Texture,
        filename: string,
        cubemap: boolean,
        width: number,
        height: number
    ): Promise<void> {
        const ensureAlive = () => {
            if (!isTextureAlive(textureDoc, texture)) {
                throw new Error(`texture "${filename}" was removed or unloaded during export`);
            }
        };

        ensureAlive();

        // encode every face first and only then download, so a failure part way
        // through never leaves a partial set of files behind
        const files: { filename: string; data: Uint8Array }[] = [];

        if (cubemap) {
            for (let face = 0; face < FACE_NAMES.length; ++face) {
                ensureAlive();
                const encoded = await exporter.run(readPixels(texture, face), width, height);
                files.push({
                    filename: `${removeExtension(filename)}_${FACE_NAMES[face]}.${exporter.extension}`,
                    data: encoded
                });
            }
        } else {
            const encoded = await exporter.run(readPixels(texture, null), width, height);
            files.push({
                filename: `${removeExtension(filename)}.${exporter.extension}`,
                data: encoded
            });
        }

        // reject rather than download pixels for a texture that is gone
        ensureAlive();
        files.forEach((file) => download(file.filename, file.data));
    }
}

export { TextureExportPanel };
export type { ExportPanelOptions, Exporter };
