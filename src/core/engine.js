// src/core/engine.js
//
// Render entry point.
//
// VexelRenderEngine exists for API compatibility, but it no longer owns a
// second rendering pipeline: it delegates to Vexel#renderNow(), which draws
// the scene and the selection overlay from one viewport snapshot per frame.

class VexelRenderEngine {
    constructor(vexel) {
        this.vexel = vexel;
        this.backend = 'canvas2d';
        this.pixelRatio = vexel ? vexel.pixelRatio : 1;
        this.antialias = true;
        this.fps = 0;
        this.frameCount = 0;
        this.lastFPSTime = typeof performance !== 'undefined' ? performance.now() : 0;
        this.dirtyRegions = [];
        this.useDirtyRegions = false;
        this.maxDirtyRegions = 10;
        this.lastSnapshot = null;
    }

    setBackend(backend) {
        const backends = ['canvas2d', 'webgl', 'webgl2', 'offscreen', 'svg'];
        if (!backends.includes(backend)) {
            throw new Error(`Unsupported backend: ${backend}. Use: ${backends.join(', ')}`);
        }
        this.backend = backend;

        if (this.vexel && this.vexel.renderer && typeof this.vexel.renderer.setBackend === 'function') {
            this.vexel.renderer.setBackend(backend);
        }
        if (this.vexel) this.vexel.requestRender();
    }

    /**
     * Render one frame from a single viewport snapshot (scene + overlay).
     * Falls back to capturing a fresh snapshot when none is supplied.
     */
    render(snapshot) {
        if (!this.vexel || this.vexel.destroyed) return null;

        const frameSnapshot = snapshot || this.vexel.getViewportSnapshot();
        this.lastSnapshot = frameSnapshot;
        this.pixelRatio = frameSnapshot.pixelRatio;

        // Delegate to the engine's single render path so the scene and the
        // overlay are always produced together.
        if (typeof this.vexel._renderWithSnapshot === 'function') {
            this.vexel._renderWithSnapshot(frameSnapshot);
        } else {
            this.vexel.renderNow();
        }

        this.frameCount++;
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now - this.lastFPSTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFPSTime = now;
        }

        this.dirtyRegions = [];
        return frameSnapshot;
    }

    renderGrid(ctx, snapshot) {
        const frameSnapshot = snapshot || this.vexel.getViewportSnapshot();
        VexelOverlay.drawGrid(ctx, frameSnapshot, { size: this.vexel.snapSize });
    }

    renderSelectionOverlay(ctx, snapshot) {
        const frameSnapshot = snapshot || this.vexel.getViewportSnapshot();
        if (!this.vexel.selectedShapes.length) return;
        VexelOverlay.drawSelection(ctx, frameSnapshot, this.vexel.selectedShapes);
    }

    getFPS() {
        return this.fps;
    }

    getMemoryUsage() {
        if (typeof performance !== 'undefined' && performance.memory) {
            return {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                limitJSHeapSize: performance.memory.jsHeapSizeLimit
            };
        }
        return null;
    }

    getStats() {
        return {
            backend: this.backend,
            fps: this.fps,
            shapeCount: this.vexel ? this.vexel.shapes.length : 0,
            selectedCount: this.vexel ? this.vexel.selectedShapes.length : 0,
            viewportZoom: this.lastSnapshot ? this.lastSnapshot.zoom : (this.vexel ? this.vexel.viewport.zoom : 1),
            memory: this.getMemoryUsage(),
            pixelRatio: this.pixelRatio,
            antialias: this.antialias
        };
    }

    setAntialias(enabled) {
        this.antialias = enabled;
        if (this.vexel) this.vexel.requestRender();
    }

    setDirtyRegions(enabled) {
        this.useDirtyRegions = enabled;
    }

    markDirty() {
        if (this.vexel) this.vexel.requestRender();
    }

    markAllDirty() {
        if (this.vexel) this.vexel.requestRender();
    }

    takeScreenshot(scale = 1) {
        if (!this.vexel) return Promise.resolve(null);
        return this.vexel.exportPNG(scale);
    }

    destroy() {
        this.vexel = null;
        this.lastSnapshot = null;
        this.dirtyRegions = [];
    }
}

if (typeof window !== 'undefined') {
    window.VexelRenderEngine = VexelRenderEngine;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelRenderEngine;
}
