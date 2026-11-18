import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TextureViewControls } from '../src/texture-view-controls.ts';
import { TextureViewState } from '../src/texture-view-state.ts';
import { create2DTexture, createCubemap } from './fixtures/texture-fixtures.ts';

type Fixture = ReturnType<typeof create2DTexture>;

// sample the centre of texel (u, v) in texture space (origin bottom-left). `controls.sample` takes
// screen coordinates (origin top-left), so the vertical axis is flipped here.
const sampleTexel = (controls: TextureViewControls, state: TextureViewState, u: number, v: number): string => {
    const device = state.texelToPixel(u + 0.5, v + 0.5);
    controls.sample(device.x, state.viewportH - device.y);
    return controls.cursorText;
};

const createControls = (fixture: Fixture, viewportW: number, viewportH: number, pixelRatio = 1) => {
    const state = new TextureViewState();
    state.setPixelRatio(pixelRatio);
    state.setViewport(viewportW, viewportH);
    state.setTexture(fixture.doc.width, fixture.doc.height, !!fixture.doc.cubemap);

    // count redraw requests so tests can assert the owner was told to repaint
    const redraws = { count: 0 };
    const controls = new TextureViewControls(state, () => redraws.count++);
    return { state, controls, redraws };
};

describe('preview controls', () => {
    const fixture = create2DTexture(64, 32);
    const viewportW = 400;
    const viewportH = 400;

    it('reports the texel under the cursor with a top-left origin', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH);

        // texture v is measured up from the bottom, so the top-left texel is at v = height - 1
        assert.equal(sampleTexel(controls, state, 0, 32 - 1), '0,0');
        assert.equal(sampleTexel(controls, state, 3, 32 - 4), '3,3');

        // the bottom-right texel
        assert.equal(sampleTexel(controls, state, 64 - 1, 0), '63,31');

        // just past the right edge
        const outside = state.texelToPixel(64.5, 16);
        controls.sample(outside.x, state.viewportH - outside.y);
        assert.equal(controls.cursorText, '-');
    });

    it('reports "-" outside the texture', () => {
        const { controls } = createControls(fixture, viewportW, viewportH);

        // above the fitted texture, in the blank space
        controls.sample(200, 10);
        assert.equal(controls.cursorText, '-');
        assert.equal(controls.state.cursorTexel, null);
    });

    it('notifies listeners whenever the readout changes', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH);
        const seen: string[] = [];
        const unbind = controls.onCursor((text) => seen.push(text));

        assert.equal(sampleTexel(controls, state, 2, 32 - 3), '2,2');
        controls.clearCursor();
        controls.sample(200, 10);

        assert.deepEqual(seen, ['2,2', '-', '-']);

        unbind();
        sampleTexel(controls, state, 2, 32 - 3);
        assert.equal(seen.length, 3);
    });

    it('wheel zoom keeps the texel under the cursor fixed', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH);
        state.zoomAt(16, 200, 200);

        const x = 240;
        const y = 180;
        controls.sample(x, y);
        const before = controls.cursorText;
        assert.notEqual(before, '-');

        for (const deltaY of [-100, -100, 100, -250, 300]) {
            controls.wheel(deltaY, x, y);
            assert.equal(controls.cursorText, before, `cursor texel changed for deltaY ${deltaY}`);
        }
    });

    it('wheel zooming out stops with the whole texture visible', () => {
        const { controls } = createControls(fixture, viewportW, viewportH);

        for (let i = 0; i < 40; ++i) {
            controls.wheel(500, 200, 200);
        }
        assert.equal(controls.state.scale, 6.25);
    });

    it('wheel zoom redraws', () => {
        const { controls, redraws } = createControls(fixture, viewportW, viewportH);
        const before = redraws.count;
        controls.wheel(-100, 200, 200);
        assert.equal(redraws.count, before + 1);
    });

    it('dragging moves the texture by the pointer delta', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH);
        state.zoomAt(16, 200, 200);

        const before = state.texelToPixel(0, 0);
        controls.dragStart(100, 100);
        controls.dragTo(130, 80);

        const after = state.texelToPixel(0, 0);
        assert.equal(after.x - before.x, 30);
        // screen y grows downwards, device y grows upwards
        assert.equal(after.y - before.y, 20);
    });

    it('dragging a fitted texture does not move it', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH);
        const offsetX = state.offsetX;
        const offsetY = state.offsetY;

        controls.dragStart(100, 100);
        controls.dragTo(180, 160);

        // the texture is exactly as wide as the viewport and shorter than it, so it stays put
        assert.equal(state.offsetX, offsetX);
        assert.equal(state.offsetY, offsetY);
    });

    it('fit and 1:1 update the view and the readout', () => {
        const { state, controls } = createControls(fixture, viewportW, viewportH, 2);

        controls.sample(200, 200);
        controls.actualSize();
        assert.equal(state.scale, 2);

        controls.fit();
        assert.equal(state.scale, 6.25);
        // the sample point is still over the texture, and the readout tracks the new transform
        assert.notEqual(controls.cursorText, '-');
    });

    it('reports coordinates in the resolution of the displayed mip level', () => {
        const mipFixture = create2DTexture(64, 32, { mipmaps: true });
        const { state, controls } = createControls(mipFixture, viewportW, viewportH);

        // at mip 1 the face is 32x16, so the texture coordinate 6,6 reads as texel 3,3
        controls.mipmap = 1;
        assert.equal(sampleTexel(controls, state, 6, 32 - 7), '3,3');

        // and back at mip 0 it reads as 6,6
        controls.mipmap = 0;
        assert.equal(sampleTexel(controls, state, 6, 32 - 7), '6,6');
    });

    it('clearing the pointer forgets the last position', () => {
        const { controls } = createControls(fixture, viewportW, viewportH);
        controls.sample(200, 200);
        assert.notEqual(controls.cursorText, '-');

        controls.resetPointer();
        assert.equal(controls.cursorText, '-');

        // a later refresh must not bring back a coordinate for a pointer that is no longer there
        controls.fit();
        assert.equal(controls.cursorText, '-');
    });
});

describe('preview controls for a cubemap', () => {
    const SIZE = 64;
    const viewportW = 320;
    const viewportH = 240;

    it('reports coordinates against the selected face', () => {
        const { state, controls } = createControls(createCubemap(SIZE), viewportW, viewportH);

        assert.equal(sampleTexel(controls, state, 3, SIZE - 4), '3,3');

        state.setFace(3);
        assert.equal(sampleTexel(controls, state, 3, SIZE - 4), '3,3');
    });
});
