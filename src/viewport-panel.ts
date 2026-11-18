import type { EventHandle } from '@playcanvas/observer';
import { Button, Container, Label } from '@playcanvas/pcui';
import type { ContainerArgs } from '@playcanvas/pcui';

import { InfoPanel } from './info-panel';
import { RenderCanvas } from './render-canvas';
import type { Renderer } from './renderer';
import type { TextureDoc } from './texture-doc';
import type { TextureManager } from './texture-manager';
import { TextureView } from './texture-view';
import { TextureViewControls } from './texture-view-controls';

class ViewportPanel extends Container {
    renderer: Renderer;
    canvas: RenderCanvas;
    view: TextureView;
    controls: TextureViewControls;
    texture: TextureDoc | null;
    toolbar: Container;
    fitButton: Button;
    actualSizeButton: Button;
    cursorLabel: Label;

    constructor(renderer: Renderer, textureManager: TextureManager, args: ContainerArgs = {}) {
        Object.assign(args, {
            class: 'texture-2d-panel',
            flex: true,
            flexGrow: '1',
            flexShrink: '1'
        });
        super(args);

        this.renderer = renderer;
        this.canvas = new RenderCanvas(renderer);
        this.view = new TextureView(this.canvas);
        this.controls = new TextureViewControls(this.view.state, () => this.view.requestRender());
        this.texture = null;

        // overlay toolbar and cursor readout, positioned over the top-left of the canvas
        this.toolbar = new Container({
            class: 'texture-view-toolbar',
            flex: true,
            flexDirection: 'row'
        });

        this.fitButton = new Button({
            class: 'texture-view-button',
            text: '适应窗口'
        });

        this.actualSizeButton = new Button({
            class: 'texture-view-button',
            text: '1:1'
        });

        this.cursorLabel = new Label({
            class: 'texture-view-cursor',
            text: '-'
        });

        this.toolbar.append(this.fitButton);
        this.toolbar.append(this.actualSizeButton);
        this.toolbar.append(this.cursorLabel);

        this.append(this.canvas);
        this.append(this.toolbar);
        this.append(new InfoPanel(textureManager));

        // keep the readout in sync with the controller
        this.controls.onCursor((text: string) => {
            this.cursorLabel.text = text;
        });

        // pointer position in device pixels, relative to the canvas
        const pointerPosition = (event: MouseEvent): { x: number; y: number } => {
            const rect = this.canvas.dom.getBoundingClientRect();
            const ratio = window.devicePixelRatio;
            return {
                x: (event.clientX - rect.left) * ratio,
                y: (event.clientY - rect.top) * ratio
            };
        };

        // zoom with the mouse wheel, anchoring the texel under the cursor
        this.canvas.dom.addEventListener(
            'wheel',
            (event: WheelEvent) => {
                event.preventDefault();

                if (!this.view.texture) {
                    return;
                }

                const { x, y } = pointerPosition(event);
                this.controls.wheel(event.deltaY, x, y);
            },
            { passive: false }
        );

        let dragging = false;

        this.canvas.dom.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            const { x, y } = pointerPosition(event);
            this.controls.dragStart(x, y);
            dragging = true;
            this.dom.classList.add('dragging');
        });

        // track the pointer over the canvas even when the button is not pressed
        this.canvas.dom.addEventListener('mousemove', (event: MouseEvent) => {
            if (dragging) {
                return;
            }
            const { x, y } = pointerPosition(event);
            this.controls.sample(x, y);
        });

        // the canvas is the only place where the cursor position means anything, so hide the
        // readout whenever the pointer leaves it
        this.canvas.dom.addEventListener('mouseleave', () => {
            this.controls.resetPointer();
        });

        // drags can continue outside the canvas, so listen on the window while dragging
        window.addEventListener('mousemove', (event: MouseEvent) => {
            if (!dragging) {
                return;
            }

            const rect = this.canvas.dom.getBoundingClientRect();
            const ratio = window.devicePixelRatio;
            this.controls.dragTo((event.clientX - rect.left) * ratio, (event.clientY - rect.top) * ratio);
        });

        window.addEventListener('mouseup', () => {
            dragging = false;
            this.dom.classList.remove('dragging');
        });

        this.fitButton.on('click', () => {
            this.controls.fit();
        });

        this.actualSizeButton.on('click', () => {
            this.controls.actualSize();
        });

        const events: EventHandle[] = [];
        textureManager.on('textureDocSelected', (texture: TextureDoc) => {
            events.forEach((ev) => ev.unbind());
            events.length = 0;

            events.push(
                texture.settings.on('view.filter:set', (value: boolean) => {
                    this.view.setFilter(value);
                })
            );
            events.push(
                texture.settings.on('view.face:set', (value: string) => {
                    // switching cubemap faces resets the view and clears the cursor readout
                    this.view.setFace(parseInt(value, 10));
                    this.controls.resetPointer();
                })
            );
            events.push(
                texture.settings.on('view.mipmap:set', (value: string) => {
                    this.view.setMipmap(parseInt(value, 10));
                    this.controls.mipmap = parseInt(value, 10);
                    this.controls.refresh();
                })
            );
            events.push(
                texture.settings.on('view.type:set', (value: string) => {
                    this.view.setTextureType(value);
                })
            );
            events.push(
                texture.settings.on('view.alpha:set', (value: boolean) => {
                    this.view.setAlpha(value);
                })
            );
            events.push(
                texture.settings.on('view.exposure:set', (value: string) => {
                    this.view.setExposure(Math.pow(2, parseInt(value, 10)));
                })
            );

            this.texture = texture;

            // selecting a texture resets the view to fit-window and clears the cursor readout
            this.view.setTexture(this.texture);
            this.controls.resetPointer();
        });

        textureManager.on('textureDocAdded', () => {
            // doc.settings.patch({
            //     viewport: {
            //     }
            // });
        });
    }
}

export { ViewportPanel };
