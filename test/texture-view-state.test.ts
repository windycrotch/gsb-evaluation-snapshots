import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TextureViewState } from '../src/texture-view-state.ts';
import { create2DTexture, createCubemap } from './fixtures/texture-fixtures.ts';

type Fixture = ReturnType<typeof create2DTexture>;

// build a view state that is already looking at the given texture, matching what
// `TextureView.setTexture` does for a TextureDoc
const createState = (fixture: Fixture, viewportW: number, viewportH: number, pixelRatio = 1): TextureViewState => {
    const state = new TextureViewState();
    state.setPixelRatio(pixelRatio);
    state.setViewport(viewportW, viewportH);
    state.setTexture(fixture.doc.width, fixture.doc.height, !!fixture.doc.cubemap);
    return state;
};

describe('2D texture preview', () => {
    // a non-square texture makes the fit scale unambiguous and catches swapped axes
    const fixture = create2DTexture(64, 32);
    const viewportW = 400;
    const viewportH = 400;

    it('fit-window shows the whole texture', () => {
        const state = createState(fixture, viewportW, viewportH);

        // 64x32 fits at 400/64 = 6.25, leaving vertical slack
        assert.equal(state.scale, 6.25);
        assert.equal(state.contentWidth, 400);
        assert.equal(state.contentHeight, 200);
        assert.equal(state.offsetX, 0);
        assert.equal(state.offsetY, 100);
        assert.equal(state.cursorTexel, null);
    });

    it('fit re-fits after panning and zooming', () => {
        const state = createState(fixture, viewportW, viewportH);

        state.zoomAt(20, 200, 200);
        state.panBy(-40, 25);
        assert.notEqual(state.scale, 6.25);

        state.fit();
        assert.equal(state.scale, 6.25);
        assert.equal(state.offsetX, 0);
        assert.equal(state.offsetY, 100);
    });

    it('1:1 maps one texel to one CSS pixel, honoring devicePixelRatio', () => {
        const state = createState(fixture, viewportW, viewportH, 2);
        state.actualSize();

        // scale is device pixels per texel, so 2 device px == 1 CSS px
        assert.equal(state.scale, 2);

        const a = state.texelToPixel(0, 0);
        const b = state.texelToPixel(1, 0);
        assert.equal(b.x - a.x, 2);

        // centered after the zoom
        assert.equal(state.offsetX, (viewportW - 64 * 2) * 0.5);
        assert.equal(state.offsetY, (viewportH - 32 * 2) * 0.5);
    });

    it('1:1 on a 1x display is one device pixel per texel', () => {
        const state = createState(fixture, viewportW, viewportH, 1);
        state.actualSize();
        assert.equal(state.scale, 1);
        assert.equal(state.texelToPixel(1, 0).x - state.texelToPixel(0, 0).x, 1);
    });

    it('wheel zoom keeps the texel under the cursor fixed', () => {
        const state = createState(fixture, viewportW, viewportH);

        // start zoomed in so the texture fills the viewport on both axes and the pointer is well
        // away from the edges, where there is room to anchor
        state.zoomAt(16, 200, 200);

        const cursorX = 200;
        const cursorY = 200;
        const before = state.texelAt(cursorX, cursorY);
        assert.ok(before);

        // several zoom steps in a row, in both directions
        for (const factor of [1.25, 0.8, 1.5, 0.6]) {
            state.zoomBy(factor, cursorX, cursorY);
            assert.deepEqual(
                state.texelAt(cursorX, cursorY),
                before,
                `texel under the cursor changed by factor ${factor}`
            );
        }
    });

    it('zoom keeps the exact texture point under the cursor fixed', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomAt(16, 200, 200);

        const cursorX = 260;
        const cursorY = 220;

        // the texture coordinate under the pointer before the zoom
        const before = state.pixelToTexel(cursorX, cursorY);

        state.zoomAt(24, cursorX, cursorY);

        const after = state.pixelToTexel(cursorX, cursorY);
        assert.ok(Math.abs(after.u - before.u) < 1e-9);
        assert.ok(Math.abs(after.v - before.v) < 1e-9);
    });

    it('zooming out stops once the whole texture is visible', () => {
        // a texture smaller than the viewport: the fit scale is well above 1:1
        const small = create2DTexture(32, 32);
        const smallState = createState(small, viewportW, viewportH);
        assert.equal(smallState.scale, 12.5);

        smallState.zoomAt(0.001, 200, 200);
        assert.equal(smallState.scale, 12.5);
        assert.equal(smallState.offsetX, 0);
        assert.equal(smallState.offsetY, 0);

        // a texture larger than the viewport: 1:1 is itself below the fit scale, so the wheel
        // cannot go there, but the dedicated 1:1 action can
        const large = create2DTexture(1024, 512);
        const largeState = createState(large, viewportW, viewportH);
        assert.equal(largeState.scale, 400 / 1024);

        largeState.zoomAt(0.001, 200, 200);
        assert.equal(largeState.scale, 400 / 1024);

        largeState.actualSize();
        assert.equal(largeState.scale, 1);
    });

    it('zoom is clamped at the high end', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomBy(1e6, 200, 200);
        assert.equal(state.scale, 100);
    });

    it('wheel zoom continues smoothly after pressing 1:1 on a small texture', () => {
        // for a texture smaller than the viewport, 1:1 is below the fit scale
        const small = create2DTexture(32, 32);
        const state = createState(small, viewportW, viewportH);
        assert.equal(state.scale, 12.5);

        state.actualSize();
        assert.equal(state.scale, 1);

        // zooming out cannot shrink below 1:1, since the whole texture already fits at that scale
        state.zoomBy(0.5, 200, 200);
        assert.equal(state.scale, 1);

        // and zooming in continues from there rather than jumping to the fit scale
        state.zoomBy(2, 200, 200);
        assert.equal(state.scale, 2);
    });

    it('wheel zooming out from 1:1 on a large texture stops at the fit scale', () => {
        // for a texture larger than the viewport, 1:1 is above the fit scale, so there is room to
        // zoom out from it until the whole texture is visible
        const large = create2DTexture(1024, 512);
        const state = createState(large, viewportW, viewportH);
        assert.equal(state.scale, 400 / 1024);

        state.actualSize();
        assert.equal(state.scale, 1);

        state.zoomBy(0.5, 200, 200);
        assert.equal(state.scale, 0.5);

        state.zoomBy(0.01, 200, 200);
        assert.equal(state.scale, 400 / 1024);
    });

    it('panning a texture larger than the viewport cannot drag it off screen', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomAt(20, 200, 200);

        // the anchoring at 20x leaves the texture covering the viewport on both axes
        assert.ok(state.contentWidth > viewportW);
        assert.ok(state.contentHeight > viewportH);

        state.panBy(10000, 10000);
        assert.equal(state.offsetX, 0);
        assert.equal(state.offsetY, 0);

        state.panBy(-10000, -10000);
        assert.equal(state.offsetX, viewportW - state.contentWidth);
        assert.equal(state.offsetY, viewportH - state.contentHeight);

        // partially scrolled states are left alone when they are already in bounds
        state.setOffset(-100, -50);
        assert.equal(state.offsetX, -100);
        assert.equal(state.offsetY, -50);
    });

    it('panning a texture smaller than the viewport keeps it centered', () => {
        const state = createState(fixture, viewportW, viewportH);

        // the fitted texture is exactly as wide as the viewport and shorter than it
        state.panBy(-100, 100);
        assert.equal(state.offsetX, (viewportW - state.contentWidth) * 0.5);
        assert.equal(state.offsetY, (viewportH - state.contentHeight) * 0.5);

        // and when it is smaller than the viewport on both axes, e.g. after pressing 1:1 on a small
        // texture
        const small = create2DTexture(16, 8);
        const smallState = createState(small, viewportW, viewportH);
        smallState.actualSize();
        assert.ok(smallState.contentWidth < viewportW);
        assert.ok(smallState.contentHeight < viewportH);

        smallState.setOffset(-1000, 1000);
        assert.equal(smallState.offsetX, (viewportW - smallState.contentWidth) * 0.5);
        assert.equal(smallState.offsetY, (viewportH - smallState.contentHeight) * 0.5);

        smallState.panBy(500, -500);
        assert.equal(smallState.offsetX, (viewportW - smallState.contentWidth) * 0.5);
        assert.equal(smallState.offsetY, (viewportH - smallState.contentHeight) * 0.5);
    });

    it('panning by a delta moves the texture by exactly that many device pixels', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomAt(16, 200, 200);

        const before = state.texelToPixel(0, 0);
        state.panBy(30, -20);
        const after = state.texelToPixel(0, 0);
        assert.equal(after.x - before.x, 30);
        assert.equal(after.y - before.y, -20);
    });

    it('cursor coordinates are reported from the texture top-left corner', () => {
        const state = createState(fixture, viewportW, viewportH);

        // the top-left corner of the texture
        const tl = state.texelToPixel(0, 32);
        assert.deepEqual(state.texelAt(tl.x + 0.5, tl.y - 0.5), { x: 0, y: 0 });

        // the bottom-right corner of the texture
        const br = state.texelToPixel(64, 0);
        assert.deepEqual(state.texelAt(br.x - 0.5, br.y + 0.5), { x: 63, y: 31 });

        // the texel just inside the centre. Texture space is bottom-up, so v == 16 is the first
        // texel of the upper half, which is row 15 counted from the top.
        const mid = state.texelToPixel(32, 16);
        assert.deepEqual(state.texelAt(mid.x + 0.5, mid.y + 0.5), { x: 32, y: 15 });
    });

    it('shows "-" when the cursor is outside the texture', () => {
        const state = createState(fixture, viewportW, viewportH);

        // the fitted, centered texture leaves blank space above and below it
        assert.equal(state.texelAt(200, 10), null);
        assert.equal(TextureViewState.formatCursor(state.updateCursor(200, 10)), '-');

        // zoom in so the width overflows the viewport but the height still leaves blank space
        state.zoomAt(8, 200, 200);
        assert.ok(state.contentWidth > viewportW);
        assert.ok(state.contentHeight < viewportH);
        assert.equal(state.texelAt(200, 10), null);

        // inside it, the readout is a real coordinate
        const inside = state.texelAt(200, 200);
        assert.ok(inside);
        assert.equal(TextureViewState.formatCursor(state.updateCursor(200, 200)), `${inside.x},${inside.y}`);
    });

    it('clears the cursor coordinate', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.updateCursor(200, 200);
        assert.ok(state.cursorTexel);

        state.clearCursor();
        assert.equal(state.cursorTexel, null);
        assert.equal(TextureViewState.formatCursor(state.cursorTexel), '-');
    });

    it('cursor coordinates follow the displayed mip level', () => {
        const mipFixture = create2DTexture(64, 32, { mipmaps: true });
        const state = createState(mipFixture, viewportW, viewportH);

        // at mip 1 the texture is 32x16
        const tl = state.texelToPixel(0, 32);
        assert.deepEqual(state.texelAt(tl.x + 0.5, tl.y - 0.5, 1), { x: 0, y: 0 });

        const br = state.texelToPixel(64, 0);
        assert.deepEqual(state.texelAt(br.x - 0.5, br.y + 0.5, 1), { x: 31, y: 15 });
    });

    it('selecting a texture resets the view and clears the cursor', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomAt(25, 100, 100);
        state.updateCursor(200, 200);
        assert.ok(state.cursorTexel);

        // switch to a different texture
        const other = create2DTexture(16, 16);
        state.setTexture(other.doc.width, other.doc.height, !!other.doc.cubemap);

        const fitScale = Math.min(viewportW / 16, viewportH / 16);
        assert.equal(state.scale, fitScale);
        assert.equal(state.offsetX, (viewportW - 16 * fitScale) * 0.5);
        assert.equal(state.offsetY, (viewportH - 16 * fitScale) * 0.5);
        assert.equal(state.cursorTexel, null);
        assert.equal(TextureViewState.formatCursor(state.cursorTexel), '-');
    });

    it('resizing the viewport keeps a fitted view fitted and a zoomed view in bounds', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.setViewport(800, 400);
        assert.equal(state.scale, 12.5);
        assert.equal(state.offsetX, 0);
        assert.equal(state.offsetY, 0);

        state.zoomAt(30, 400, 200);
        state.setViewport(200, 200);
        assert.equal(state.offsetX >= 200 - state.contentWidth, true);
        assert.equal(state.offsetX <= 0, true);
        assert.equal(state.offsetY >= 200 - state.contentHeight, true);
        assert.equal(state.offsetY <= 0, true);
    });
});

describe('cubemap preview', () => {
    const SIZE = 64;
    const viewportW = 320;
    const viewportH = 240;
    const fixture = createCubemap(SIZE);

    it('reports coordinates for the selected face', () => {
        const state = createState(fixture, viewportW, viewportH);
        assert.equal(state.face, 0);

        const tl = state.texelToPixel(0, SIZE);
        assert.deepEqual(state.texelAt(tl.x + 0.5, tl.y - 0.5), { x: 0, y: 0 });

        state.setFace(4);
        assert.equal(state.face, 4);
        assert.deepEqual(state.texelAt(tl.x + 0.5, tl.y - 0.5), { x: 0, y: 0 });
    });

    it('switching face resets zoom and offset and clears the cursor', () => {
        const state = createState(fixture, viewportW, viewportH);

        // zoom and pan the first face
        state.zoomAt(6, 40, 60);
        state.updateCursor(100, 100);
        assert.ok(state.cursorTexel);
        const fitScale = state.fitScale();
        assert.notEqual(state.scale, fitScale);

        state.setFace(2);

        assert.equal(state.face, 2);
        assert.equal(state.scale, Math.min(viewportW / SIZE, viewportH / SIZE));
        assert.equal(state.offsetX, (viewportW - SIZE * state.scale) * 0.5);
        assert.equal(state.offsetY, (viewportH - SIZE * state.scale) * 0.5);
        assert.equal(state.cursorTexel, null);
        assert.equal(TextureViewState.formatCursor(state.cursorTexel), '-');
    });

    it('re-selecting the same face leaves the view alone', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.zoomAt(6, 100, 100);
        const scale = state.scale;
        const offsetX = state.offsetX;
        const offsetY = state.offsetY;

        assert.equal(state.setFace(0), false);
        assert.equal(state.scale, scale);
        assert.equal(state.offsetX, offsetX);
        assert.equal(state.offsetY, offsetY);
    });

    it('resets when switching from a cubemap to a 2D texture', () => {
        const state = createState(fixture, viewportW, viewportH);
        state.setFace(3);
        state.zoomAt(8, 80, 80);
        state.updateCursor(120, 120);

        const flat = create2DTexture(128, 64);
        state.setTexture(flat.doc.width, flat.doc.height, !!flat.doc.cubemap);

        // a change of texture always returns to face 0 and to the fit-window state
        assert.equal(state.face, 0);
        assert.equal(state.cubemap, false);
        assert.equal(state.scale, Math.min(viewportW / 128, viewportH / 64));
        assert.equal(state.cursorTexel, null);
    });

    it('fit and 1:1 work per face', () => {
        const state = createState(fixture, viewportW, viewportH, 2);

        state.setFace(5);
        state.actualSize();
        assert.equal(state.scale, 2);
        assert.equal(state.offsetX, (viewportW - SIZE * 2) * 0.5);
        assert.equal(state.offsetY, (viewportH - SIZE * 2) * 0.5);

        state.zoomAt(6, 50, 50);
        state.fit();
        assert.equal(state.scale, Math.min(viewportW / SIZE, viewportH / SIZE));
    });
});
