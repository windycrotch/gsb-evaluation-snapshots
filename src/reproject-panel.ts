import { Button, Panel, Container, SelectInput, LabelGroup, NumericInput, Label } from '@playcanvas/pcui';
import type { PanelArgs } from '@playcanvas/pcui';
import {
    Texture,
    Asset,
    PIXELFORMAT_R8_G8_B8_A8,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    TEXTURETYPE_DEFAULT,
    TEXTURETYPE_RGBM,
    TEXTURETYPE_RGBE,
    TEXTURETYPE_RGBP,
    FILTER_NEAREST,
    FILTER_LINEAR,
    FILTER_LINEAR_MIPMAP_LINEAR,
    ADDRESS_REPEAT,
    ADDRESS_CLAMP_TO_EDGE,
    EnvLighting
} from 'playcanvas';

import { removeExtension } from './helpers';
import { reproject } from './reproject-impl';
import { TextureDoc } from './texture-doc';
import type { TextureManager } from './texture-manager';

// snapshot of everything a reproject session needs, captured at click time
type ReprojectSessionParams = {
    sourceTexture: Texture;
    sourceProjection: string;
    targetProjection: string;
    targetEncoding: string;
    targetWidth: number;
    targetHeight: number;
    viewType: string;
    sourceName: string;
    sourceFilename: string;
};

const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

class ReprojectPanel extends Panel {
    // a reproject session currently owns the button; while set, further clicks are rejected
    private busy = false;

    // panel controls, exposed so external harnesses can drive the real components
    readonly controls: {
        source: SelectInput;
        target: SelectInput;
        encoding: SelectInput;
        width: NumericInput;
        height: NumericInput;
        button: Button;
        errorLabel: Label;
    };

    constructor(textureManager: TextureManager, args: PanelArgs = {}) {
        Object.assign(args, {
            id: 'texture-reproject-pane',
            headerText: 'Reproject',
            collapsible: true
        });

        super(args);

        const projections: Record<string, string> = {
            0: 'cube',
            1: 'equirect',
            2: 'octahedral',
            3: 'envAtlas'
        };

        const pindices: Record<string, string> = {
            cube: '0',
            equirect: '1',
            octahedral: '2',
            none: '1'
        };

        const encodings: Record<string, string> = {
            0: 'rgbm',
            1: 'rgbe',
            2: 'rgbp',
            3: 'linear',
            4: 'srgb'
        };

        const eindices: Record<string, string> = {
            rgbm: '0',
            rgbe: '1',
            rgbp: '2',
            linear: '3',
            srgb: '4'
        };

        const sourceCubemapProjections = [{ v: '0', t: 'cube' }];

        const sourceTextureProjections = [
            { v: '1', t: 'equirect' },
            { v: '2', t: 'octahedral' }
        ];

        const targetProjections = [
            { v: '0', t: 'cube' },
            { v: '1', t: 'equirect' },
            { v: '2', t: 'octahedral' },
            { v: '3', t: 'envAtlas' }
        ];

        // source
        const source = new SelectInput({
            value: '0',
            options: [],
            width: 100
        });

        // target
        const target = new SelectInput({
            value: '0',
            options: [],
            width: 100
        });

        // encoding
        const encoding = new SelectInput({
            value: '0',
            options: [
                { v: '0', t: 'rgbm' },
                { v: '1', t: 'rgbe' },
                { v: '2', t: 'rgbp' },
                { v: '3', t: 'linear' },
                { v: '4', t: 'srgb' }
            ],
            width: 100
        });

        // width
        const width = new NumericInput({
            min: 1,
            max: 16384,
            precision: 0
        });

        // height
        const height = new NumericInput({
            min: 1,
            max: 16384,
            precision: 0
        });

        // reproject
        const reprojectButton = new Button({
            class: 'inspector-button',
            text: 'Reproject'
        });

        // visible error message, hidden until a session fails
        const errorLabel = new Label({
            class: 'reproject-error-label',
            hidden: true
        });

        const buttonContainer = new Container({
            class: 'inspector-button-container',
            flex: true,
            flexDirection: 'row'
        });

        buttonContainer.append(reprojectButton);

        this.append(new LabelGroup({ text: 'source', field: source }));
        this.append(new LabelGroup({ text: 'target', field: target }));
        this.append(new LabelGroup({ text: 'encoding', field: encoding }));
        this.append(new LabelGroup({ text: 'width', field: width }));
        this.append(new LabelGroup({ text: 'height', field: height }));
        this.append(buttonContainer);
        this.append(errorLabel);

        this.controls = { source, target, encoding, width, height, button: reprojectButton, errorLabel };

        // recalculate the envAtlas width/encoding lock and the cube height lock
        // for the currently selected texture and current target projection
        const updateLocks = () => {
            const projection = projections[target.value];
            const isEnvAtlas = projection === 'envAtlas';
            if (isEnvAtlas) {
                encoding.value = '2';
                // envAtlas uses a fixed atlas layout defined by generateAtlas internally;
                // 512px ensures correct shader UV sampling and mip grid alignment
                width.value = 512;
            }
            // envAtlas width and encoding are locked to engine-defined atlas format
            width.enabled = !isEnvAtlas;
            encoding.enabled = !isEnvAtlas;
            height.enabled = !['cube', 'envAtlas'].includes(projection);
            if (!height.enabled) {
                height.value = width.value;
            }
        };

        // target projection only changes through its own control, so the lock
        // rules are bound once instead of being rebound on every selection
        target.on('change', updateLocks);

        // width changes re-apply the locks so a cube/envAtlas height tracks width
        width.on('change', updateLocks);

        // drive the busy state of every control from the single session flag
        const setBusy = (isBusy: boolean) => {
            this.busy = isBusy;
            reprojectButton.enabled = !isBusy;
            reprojectButton.text = isBusy ? 'Reprojecting…' : 'Reproject';
            reprojectButton.dom.classList.toggle('busy-anim', isBusy);
            source.enabled = !isBusy;
            target.enabled = !isBusy;
            encoding.enabled = !isBusy && projections[target.value] !== 'envAtlas';
            width.enabled = !isBusy && projections[target.value] !== 'envAtlas';
            height.enabled = !isBusy && !['cube', 'envAtlas'].includes(projections[target.value]);
        };

        // reset the panel controls to reflect the given (possibly different) texture.
        // bound once; selecting textures during a session only updates the controls,
        // it never touches the in-flight session's captured parameters.
        textureManager.on('textureDocSelected', (texture: TextureDoc) => {
            errorLabel.hidden = true;

            const t = texture.resource;

            if (!t) {
                source.options = [];
                target.options = [];
                width.value = 0;
                height.value = 0;
                this.enabled = false;
                return;
            }

            this.enabled = true;

            source.options = t.cubemap ? sourceCubemapProjections : sourceTextureProjections;
            source.value = t.cubemap ? pindices.cube : pindices[t.projection] || pindices.equirect;

            target.options = targetProjections;
            target.value = t.cubemap ? pindices.equirect : pindices.cube;

            encoding.value = eindices[t.encoding] || '0';

            width.value = t.width;
            height.value = t.height;
            updateLocks();

            // a session in progress keeps ownership of the controls
            if (this.busy) {
                setBusy(true);
            }
        });

        reprojectButton.on('click', async () => {
            // a session is already running: reject the duplicate trigger
            if (this.busy) {
                return;
            }

            const selected = textureManager.selectedTextureDoc;
            const sourceTexture = selected?.resource;
            if (!selected || !sourceTexture || !selected.asset) {
                return;
            }

            // capture the whole session at click time. later selection changes and
            // control edits must not influence this session's naming, output or target
            const params: ReprojectSessionParams = {
                sourceTexture,
                sourceProjection: projections[source.value],
                targetProjection: projections[target.value],
                targetEncoding: encodings[encoding.value],
                targetWidth: width.value as number,
                targetHeight: height.value as number,
                viewType: selected.settings.get('view.type') as string,
                sourceName: selected.asset.name,
                sourceFilename: selected.filename
            };

            errorLabel.hidden = true;
            setBusy(true);

            // let the busy state paint before the (synchronous, blocking) GPU work
            await nextFrame();

            // textures created by this session; all are destroyed unless handed over
            // to the asset registry on success
            let targetTexture: Texture | null = null;
            let tmp: Texture | null = null;
            let lighting: Texture | null = null;
            let success = false;

            try {
                const format: Record<string, number> = {
                    rgbm: PIXELFORMAT_R8_G8_B8_A8,
                    rgbe: PIXELFORMAT_R8_G8_B8_A8,
                    rgbp: PIXELFORMAT_R8_G8_B8_A8,
                    linear: PIXELFORMAT_RGBA16F,
                    srgb: PIXELFORMAT_R8_G8_B8_A8
                };

                const typeMap: Record<string, string> = {
                    rgbm: 'rgbm',
                    rgbe: 'rgbe',
                    rgbp: 'rgbp',
                    linear: 'default',
                    srgb: 'default'
                };

                const device = params.sourceTexture.device;

                // create target texture
                targetTexture = new Texture(device, {
                    cubemap: params.targetProjection === 'cube',
                    width: params.targetWidth,
                    height: params.targetHeight,
                    format: format[params.targetEncoding],
                    type: typeMap[params.targetEncoding],
                    mipmaps: false,
                    projection: params.targetProjection,
                    anisotropy: device.maxAnisotropy
                });

                // reprojectTexture function uses the texture's own setup so apply view settings to the texture
                const t = params.sourceTexture;
                t.projection = params.sourceProjection;
                t.magFilter = t.encoding === 'rgbe' ? FILTER_NEAREST : FILTER_LINEAR;
                t.minFilter = t.encoding === 'rgbe' ? FILTER_NEAREST : FILTER_LINEAR_MIPMAP_LINEAR;
                t.addressU = ADDRESS_REPEAT;
                t.addressV = params.sourceProjection === 'equirect' ? ADDRESS_CLAMP_TO_EDGE : ADDRESS_REPEAT;
                switch (params.viewType) {
                    case 'rgbm':
                        t.type = TEXTURETYPE_RGBM;
                        break;
                    case 'rgbe':
                        t.type = TEXTURETYPE_RGBE;
                        break;
                    case 'rgbp':
                        t.type = TEXTURETYPE_RGBP;
                        break;
                    default:
                        t.type = TEXTURETYPE_DEFAULT;
                        break;
                }
                t.anisotropy = device.maxAnisotropy;

                // check if dimensions and projection are the same
                const sameProjection = params.sourceProjection === params.targetProjection;
                const sameDims = params.targetWidth === t.width && params.targetHeight === t.height;

                // check if source texture is capable of reprojection as-is
                if (sameProjection && (sameDims || (t.encoding !== 'rgbe' && t.mipmaps && t._levels.length > 1))) {
                    if (!reproject(t, targetTexture, { numSamples: 1 })) {
                        throw new Error('reproject failed: invalid target dimensions');
                    }
                } else {
                    tmp = new Texture(device, {
                        cubemap: params.sourceProjection === 'cube',
                        width: t.width,
                        height: t.height,
                        format: PIXELFORMAT_RGBA32F,
                        type: TEXTURETYPE_DEFAULT,
                        projection: params.sourceProjection,
                        addressU: ADDRESS_REPEAT,
                        addressV: params.sourceProjection === 'equirect' ? ADDRESS_CLAMP_TO_EDGE : ADDRESS_REPEAT,
                        mipmaps: true,
                        anisotropy: device.maxAnisotropy
                    });

                    if (!reproject(t, tmp, { numSamples: 1 })) {
                        throw new Error('reproject failed: could not create intermediate texture');
                    }

                    if (params.targetProjection === 'envAtlas') {
                        lighting = EnvLighting.generateLightingSource(tmp, {
                            size: 256
                        });
                        lighting.anisotropy = device.maxAnisotropy;
                        EnvLighting.generateAtlas(lighting, {
                            target: targetTexture
                        });
                    } else if (!reproject(tmp, targetTexture, { numSamples: 1 })) {
                        throw new Error('reproject failed: invalid target dimensions');
                    }
                }

                // name and ownership come from the texture selected when the
                // session started, even if the selection changed meanwhile
                const asset = new Asset(
                    `${removeExtension(params.sourceName)}-${params.targetProjection}`,
                    params.targetProjection === 'cube' ? 'cubemap' : 'texture',
                    {
                        filename: `${removeExtension(params.sourceFilename)}-${params.targetProjection}`,
                        url: ''
                    }
                );
                asset.resource = targetTexture;
                asset.loaded = true;

                // create the new texture document
                const textureDoc = new TextureDoc(asset);
                textureManager.assets.add(asset);
                textureManager.addTextureDoc(textureDoc);
                textureManager.selectTextureDoc(textureDoc);

                success = true;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('reproject failed:', err);
                errorLabel.text = `Reproject failed: ${message}`;
                errorLabel.hidden = false;
            } finally {
                // intermediate float texture and envAtlas lighting texture are always
                // destroyed, regardless of success, failure or mid-session selection.
                // each destroy is isolated so one failure cannot strand the others or
                // leave the panel stuck in the busy state
                const destroyTexture = (texture: Texture | null, label: string) => {
                    if (!texture) {
                        return;
                    }
                    try {
                        texture.destroy();
                    } catch (cleanupErr) {
                        console.error(`reproject cleanup failed for ${label}:`, cleanupErr);
                    }
                };

                destroyTexture(lighting, 'lighting');
                destroyTexture(tmp, 'intermediate');
                if (!success) {
                    // the failed output must never reach the file list
                    destroyTexture(targetTexture, 'target');
                }

                setBusy(false);
            }
        });

        this.enabled = false;
    }
}

export { ReprojectPanel };
