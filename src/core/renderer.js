// src/core/renderer.js

class VexelRenderer {
    constructor(vexel) {
        this.vexel = vexel;
        this.backend = 'canvas2d';
        this.pixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        this.antialias = true;
        this.fps = 0;
        this.frameCount = 0;
        this.lastFPSTime = typeof performance !== 'undefined' ? performance.now() : 0;
        this.dirty = true;
        this.dirtyRegions = [];
        this.useDirtyRegions = false;
        this.maxDirtyRegions = 10;
        this.lastSnapshot = null;
        this.renderingEnabled = true;
        this.stats = {
            drawCalls: 0,
            shapesRendered: 0,
            framesRendered: 0,
            lastFrameTime: 0,
            lastSequence: -1
        };
    }

    /**
     * Render one complete frame — scene and selection overlay — from a single
     * immutable viewport snapshot. Both canvases are cleared and drawn using
     * the exact same pan/zoom/rotation/DPR values, so they cannot disagree.
     */
    renderFrame(snapshot) {
        if (!snapshot) {
            snapshot = VexelViewportSnapshot.capture(this.vexel);
        }
        if (!this.renderingEnabled) return;

        const startTime = typeof performance !== 'undefined' ? performance.now() : 0;

        this.frameCount++;
        this.lastSnapshot = snapshot;
        this.pixelRatio = snapshot.pixelRatio;

        if (this.backend === 'webgl' || this.backend === 'webgl2') {
            this._renderWebGL(snapshot);
        } else {
            this._renderCanvas2D(snapshot);
        }

        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        this.stats.framesRendered++;
        this.stats.lastSequence = snapshot.sequence;
        this.stats.lastFrameTime = now - startTime;
        if (now - this.lastFPSTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFPSTime = now;
        }

        this.dirty = false;
        this.dirtyRegions = [];
    }

    /**
     * Backwards-compatible entry point. Captures a snapshot and renders a full
     * frame; callers that already have a snapshot should use renderFrame().
     */
    render() {
        this.renderFrame(VexelViewportSnapshot.capture(this.vexel));
    }

    _renderCanvas2D(snapshot) {
        const ctx = this.vexel.ctx;
        const overlayCtx = this.vexel.overlayCtx;
        if (!ctx) return;

        // Clear both surfaces in device pixels, then restore the DPR transform.
        snapshot.clearSurface(ctx, this.vexel.canvas);
        if (overlayCtx) snapshot.clearSurface(overlayCtx, this.vexel.overlayCanvas);

        if (this.vexel.canvasManager && this.vexel.canvasManager.gridVisible) {
            VexelOverlay.drawGrid(ctx, snapshot, {
                size: this.vexel.canvasManager.gridSize,
                color: this.vexel.canvasManager.gridColor
            });
        } else if (this.vexel.gridEnabled) {
            VexelOverlay.drawGrid(ctx, snapshot, { size: this.vexel.snapSize });
        }

        ctx.save();
        snapshot.applyWorld(ctx);

        if (this.antialias) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }

        let shapesRendered = 0;

        const layers = this.vexel.layers;
        if (layers && layers.layers && layers.layers.length > 0) {
            for (const layer of layers.getVisibleLayers()) {
                layer.draw(ctx);
                shapesRendered += layer.getShapeCount();
            }
        } else {
            for (const shape of this.vexel.shapes) {
                if (shape.visible !== false) {
                    shape.draw(ctx);
                    shapesRendered++;
                }
            }
        }

        ctx.restore();

        const manager = this.vexel.canvasManager;
        if (manager && manager.guidesVisible && manager.guides.length) {
            VexelOverlay.drawGuides(ctx, snapshot, manager.guides);
        }
        if (manager && manager.rulersVisible && typeof manager.drawRulers === 'function') {
            manager.drawRulers(ctx, snapshot);
        }

        if (overlayCtx) {
            this._renderOverlay(overlayCtx, snapshot);
        }

        this.stats.shapesRendered = shapesRendered;
        this.stats.drawCalls = shapesRendered;
    }

    _renderWebGL(snapshot) {
        if (!this.webglRenderer) return;

        const viewport = this.webglRenderer.vexel ? this.webglRenderer.vexel : this.vexel;
        this.webglRenderer.begin(snapshot);

        const visibleShapes = this.vexel.canvasManager
            ? this.vexel.canvasManager.getVisibleShapes(this.vexel.shapes)
            : this.vexel.shapes.filter(s => s.visible !== false);

        for (const shape of visibleShapes) {
            this._renderShapeWebGL(shape, viewport);
        }

        this.webglRenderer.end();
        this.stats.shapesRendered = visibleShapes.length;
        this.stats.drawCalls = this.webglRenderer.drawCalls;

        if (this.vexel.overlayCtx) {
            this._renderOverlay(this.vexel.overlayCtx, snapshot);
        }
    }

    _renderShapeWebGL(shape, viewport) {
        if (!this.webglRenderer) return;

        switch (shape.type) {
            case 'rectangle': {
                let color = 0xFF5722FF;
                if (shape.fill && shape.fill !== 'transparent' && typeof VexelColor !== 'undefined') {
                    const parsed = VexelColor.parse(shape.fill);
                    if (parsed) {
                        const a = Math.round((shape.opacity || 1) * 255);
                        color = (a << 24) | (parsed.b << 16) | (parsed.g << 8) | parsed.r;
                    }
                }
                this.webglRenderer.drawRect(
                    shape.x, shape.y,
                    shape.width * shape.scaleX,
                    shape.height * shape.scaleY,
                    color
                );
                break;
            }
            case 'ellipse': {
                let color = 0xFF5722FF;
                if (shape.fill && shape.fill !== 'transparent' && typeof VexelColor !== 'undefined') {
                    const parsed = VexelColor.parse(shape.fill);
                    if (parsed) {
                        const a = Math.round((shape.opacity || 1) * 255);
                        color = (a << 24) | (parsed.b << 16) | (parsed.g << 8) | parsed.r;
                    }
                }
                this.webglRenderer.drawEllipse(
                    shape.x, shape.y,
                    shape.radiusX, shape.radiusY,
                    color
                );
                break;
            }
            case 'line': {
                let color = 0x000000FF;
                if (shape.stroke && shape.stroke !== 'none' && typeof VexelColor !== 'undefined') {
                    const parsed = VexelColor.parse(shape.stroke);
                    if (parsed) {
                        const a = Math.round((shape.opacity || 1) * 255);
                        color = (a << 24) | (parsed.b << 16) | (parsed.g << 8) | parsed.r;
                    }
                }
                this.webglRenderer.drawLine(
                    shape.x1, shape.y1,
                    shape.x2, shape.y2,
                    color,
                    shape.strokeWidth || 1
                );
                break;
            }
            default:
                break;
        }
    }

    /**
     * Selection overlay. The passed context has already been cleared and reset
     * to the DPR transform by renderFrame; VexelOverlay applies the snapshot's
     * world transform itself.
     */
    _renderOverlay(ctx, snapshot) {
        const selected = this.vexel.selectedShapes;

        if (selected.length > 0) {
            VexelOverlay.drawSelection(ctx, snapshot, selected);

            if (selected.length === 1) {
                const bounds = VexelOverlay.getShapeBounds(selected[0]);
                VexelOverlay.drawRotationHandle(ctx, snapshot, bounds);
            }
        }

        // A live marquee is part of the frame too and must use the same
        // snapshot as everything else.
        const marquee = this.vexel._marquee;
        if (marquee && marquee.active && marquee.start && marquee.end) {
            VexelOverlay.drawMarquee(ctx, snapshot, marquee.start, marquee.end);
        }

        const selectTool = this.vexel.selectTool;
        if (selectTool && selectTool.marqueeActive && selectTool.marqueeStart && selectTool.marqueeEnd) {
            VexelOverlay.drawMarquee(ctx, snapshot, selectTool.marqueeStart, selectTool.marqueeEnd);
        }
    }

    /** Legacy: clear both surfaces without drawing. */
    clear() {
        const snapshot = VexelViewportSnapshot.capture(this.vexel);
        if (this.vexel.ctx) snapshot.clearSurface(this.vexel.ctx, this.vexel.canvas);
        if (this.vexel.overlayCtx) snapshot.clearSurface(this.vexel.overlayCtx, this.vexel.overlayCanvas);
    }

    /** Legacy: force an immediate full frame. */
    renderAll() {
        this.renderFrame(VexelViewportSnapshot.capture(this.vexel));
    }

    setAntialias(enabled) {
        this.antialias = enabled;
        this.dirty = true;
    }

    setDirtyRegions(enabled) {
        this.useDirtyRegions = enabled;
    }

    markDirty(x, y, width, height) {
        this.dirty = true;
        if (x !== undefined) {
            this.dirtyRegions.push({ x, y, width, height });
            if (this.dirtyRegions.length > this.maxDirtyRegions) {
                this.dirtyRegions.shift();
            }
        }
    }

    markAllDirty() {
        this.dirty = true;
        this.dirtyRegions = [];
    }

    setBackend(backend) {
        const backends = ['canvas2d', 'webgl', 'webgl2'];
        if (!backends.includes(backend)) {
            console.warn(`Backend "${backend}" not supported. Using canvas2d.`);
            return;
        }

        if (backend === 'webgl' || backend === 'webgl2') {
            if (!this.webglRenderer) {
                const VexelWebGLRenderer = typeof window !== 'undefined' ? window.VexelWebGLRenderer : null;
                if (!VexelWebGLRenderer) {
                    console.warn('WebGL renderer unavailable. Using canvas2d.');
                    return;
                }
                this.webglRenderer = new VexelWebGLRenderer(this.vexel);
                if (!this.webglRenderer.init()) {
                    this.webglRenderer = null;
                    return;
                }
            }
        }

        this.backend = backend;
        this.dirty = true;
    }

    getFPS() {
        return this.fps;
    }

    getStats() {
        return {
            ...this.stats,
            backend: this.backend,
            fps: this.fps,
            pixelRatio: this.pixelRatio,
            antialias: this.antialias,
            dirty: this.dirty,
            totalShapes: this.vexel.shapes.length,
            selectedShapes: this.vexel.selectedShapes.length,
            viewportZoom: this.lastSnapshot ? this.lastSnapshot.zoom : this.vexel.viewport.zoom,
            webgl: this.webglRenderer && this.webglRenderer.getStats ? this.webglRenderer.getStats() : null
        };
    }

    takeScreenshot(scale = 1, format = 'image/png') {
        return new Promise((resolve) => {
            const snapshot = this.lastSnapshot || VexelViewportSnapshot.capture(this.vexel);
            const w = Math.round(snapshot.width * scale);
            const h = Math.round(snapshot.height * scale);

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);

            ctx.save();
            ctx.scale(scale, scale);
            snapshot.applyWorld(ctx);

            for (const shape of this.vexel.shapes) {
                if (shape.visible !== false) {
                    shape.draw(ctx);
                }
            }

            ctx.restore();

            canvas.toBlob((blob) => resolve(blob), format);
        });
    }

    enable() {
        this.renderingEnabled = true;
    }

    disable() {
        this.renderingEnabled = false;
    }

    destroy() {
        if (this.webglRenderer) {
            if (this.webglRenderer.destroy) this.webglRenderer.destroy();
            this.webglRenderer = null;
        }
    }
}

if (typeof window !== 'undefined') {
    window.VexelRenderer = VexelRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelRenderer;
}
