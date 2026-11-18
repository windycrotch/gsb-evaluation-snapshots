// src/core/renderer.js

class VexelRenderer {
    constructor(vexel) {
        this.vexel = vexel;
        this.backend = 'canvas2d';
        this.pixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        this.antialias = true;
        this.fps = 0;
        this.frameCount = 0;
        this.lastFPSTime = performance.now();
        this.dirty = true;
        this.dirtyRegions = [];
        this.useDirtyRegions = false;
        this.maxDirtyRegions = 10;
        this.webglRenderer = null;
        this.renderingEnabled = true;
        this.stats = {
            drawCalls: 0,
            shapesRendered: 0,
            framesRendered: 0,
            lastFrameTime: 0
        };
    }

    setBackend(backend) {
        const backends = ['canvas2d', 'webgl', 'webgl2'];
        if (!backends.includes(backend)) {
            console.warn(`Backend "${backend}" not supported. Using canvas2d.`);
            backend = 'canvas2d';
        }

        if (backend === 'webgl' || backend === 'webgl2') {
            const initialized = this._initWebGL(backend);
            if (!initialized) {
                console.warn('WebGL initialization failed. Falling back to canvas2d.');
                this._activateCanvas2D();
                this.backend = 'canvas2d';
                this.dirty = true;
                return;
            }
            this.backend = backend;
        } else {
            this._activateCanvas2D();
            this.backend = 'canvas2d';
        }

        this.dirty = true;
    }

    _initWebGL(backend) {
        if (typeof window === 'undefined') return false;
        if (this.webglRenderer && this.webglRenderer.initialized) return true;

        const Ctor = window.VexelWebGLRenderer ||
            (typeof VexelWebGLRenderer !== 'undefined' ? VexelWebGLRenderer : null);
        if (!Ctor) return false;

        // Stash the 2D canvas/context so we can restore them on fallback.
        if (!this._canvas2d) {
            this._canvas2d = this.vexel.canvas;
            this._ctx2d = this.vexel.ctx;
        }

        let renderer;
        try {
            renderer = new Ctor(this.vexel);
            if (!renderer.init()) return false;
        } catch (err) {
            console.warn('WebGL initialization failed:', err);
            return false;
        }

        this.webglRenderer = renderer;

        // Swap the WebGL canvas into the DOM in place of the 2D canvas.
        const parent = this._canvas2d.parentNode;
        if (parent) {
            parent.insertBefore(renderer.canvas, this._canvas2d);
            parent.removeChild(this._canvas2d);
        }
        this.vexel.canvas = renderer.canvas;

        return true;
    }

    _activateCanvas2D() {
        if (this.webglRenderer) {
            const glCanvas = this.webglRenderer.canvas;
            const parent = glCanvas && glCanvas.parentNode;
            if (parent && this._canvas2d) {
                parent.insertBefore(this._canvas2d, glCanvas);
                parent.removeChild(glCanvas);
            }
            this.webglRenderer.destroy();
            this.webglRenderer = null;
        }
        if (this._canvas2d) {
            this.vexel.canvas = this._canvas2d;
            this.vexel.ctx = this._ctx2d;
        }
    }

    render() {
        if (!this.renderingEnabled) return;

        const startTime = performance.now();

        this.frameCount++;
        const now = performance.now();
        if (now - this.lastFPSTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFPSTime = now;
        }

        if ((this.backend === 'webgl' || this.backend === 'webgl2') && this.webglRenderer) {
            this._renderWebGL();
        } else {
            this._renderCanvas2D();
        }

        this.stats.framesRendered++;
        this.stats.lastFrameTime = performance.now() - startTime;
        this.dirty = false;
        this.dirtyRegions = [];
    }

    _renderCanvas2D() {
        const ctx = this.vexel.ctx;
        const overlayCtx = this.vexel.overlayCtx;
        const w = this.vexel.width;
        const h = this.vexel.height;

        ctx.clearRect(0, 0, w, h);
        overlayCtx.clearRect(0, 0, w, h);

        if (this.vexel.canvas && this.vexel.canvas.gridVisible) {
            this.vexel.canvas.drawGrid(ctx);
        }

        ctx.save();
        ctx.translate(this.vexel.viewport.x, this.vexel.viewport.y);
        ctx.scale(this.vexel.viewport.zoom, this.vexel.viewport.zoom);
        ctx.rotate(this.vexel.viewport.rotation);

        if (this.antialias) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }

        let shapesRendered = 0;

        if (this.vexel.layers && this.vexel.layers.layers && this.vexel.layers.layers.length > 0) {
            for (const layer of this.vexel.layers.getVisibleLayers()) {
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

        if (this.vexel.canvas && this.vexel.canvas.guidesVisible) {
            this.vexel.canvas.drawGuides(ctx);
        }

        if (this.vexel.canvas && this.vexel.canvas.rulersVisible) {
            this.vexel.canvas.drawRulers(ctx);
        }

        this._renderOverlay(overlayCtx);

        this.stats.shapesRendered = shapesRendered;
        this.stats.drawCalls = shapesRendered;
    }

    _renderWebGL() {
        if (!this.webglRenderer) {
            this._renderCanvas2D();
            return;
        }

        const overlayCtx = this.vexel.overlayCtx;
        if (overlayCtx) {
            overlayCtx.clearRect(0, 0, this.vexel.width, this.vexel.height);
        }

        this.webglRenderer.begin();

        const visibleShapes = (this.vexel.canvas && typeof this.vexel.canvas.getVisibleShapes === 'function')
            ? this.vexel.canvas.getVisibleShapes(this.vexel.shapes)
            : this.vexel.shapes.filter(s => s.visible !== false);

        for (const shape of visibleShapes) {
            this._renderShapeWebGL(shape);
        }

        this.webglRenderer.end();

        // The overlay is a separate 2D canvas stacked above the WebGL canvas,
        // so selection feedback keeps working under the WebGL backend.
        if (overlayCtx) {
            this._renderOverlay(overlayCtx);
        }

        this.stats.shapesRendered = visibleShapes.length;
        this.stats.drawCalls = this.webglRenderer.drawCalls;
    }

    _parseColor(color, opacity = 1) {
        if (!color || color === 'transparent' || color === 'none') return null;

        let parsed = null;
        if (typeof VexelColor !== 'undefined' && VexelColor && typeof VexelColor.parse === 'function') {
            parsed = VexelColor.parse(color);
        } else if (typeof color === 'string' && color.charAt(0) === '#') {
            let hex = color.slice(1);
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            const num = parseInt(hex, 16);
            if (hex.length === 6 && !isNaN(num)) {
                parsed = { r: (num >> 16) & 0xFF, g: (num >> 8) & 0xFF, b: num & 0xFF, a: 1 };
            }
        }
        if (!parsed) return null;

        const alpha = Math.max(0, Math.min(255,
            Math.round((parsed.a === undefined ? 1 : parsed.a) * opacity * 255)
        ));
        // Packed as 0xRRGGBBAA (matches VexelWebGLRenderer._unpackColor).
        return (((parsed.r & 0xFF) << 24) | ((parsed.g & 0xFF) << 16) |
                ((parsed.b & 0xFF) << 8) | alpha) >>> 0;
    }

    _renderShapeWebGL(shape) {
        if (!this.webglRenderer) return;

        const wr = this.webglRenderer;
        const opacity = shape.opacity !== undefined ? shape.opacity : 1;
        const fillColor = this._parseColor(shape.fill, opacity);
        const strokeColor = this._parseColor(shape.stroke, opacity);
        const strokeWidth = shape.strokeWidth || 1;

        switch (shape.type) {
            case 'rectangle': {
                // Matches VexelRectangle.draw(): rotate/scale about the center.
                const transform = {
                    scaleX: shape.scaleX === undefined ? 1 : shape.scaleX,
                    scaleY: shape.scaleY === undefined ? 1 : shape.scaleY,
                    rotation: ((shape.rotation || 0) * Math.PI) / 180
                };
                if (fillColor !== null) {
                    wr.drawRect(shape.x, shape.y, shape.width, shape.height, fillColor, transform);
                }
                if (strokeColor !== null && strokeWidth > 0) {
                    wr.drawRectOutline(shape.x, shape.y, shape.width, shape.height, strokeColor, strokeWidth, transform);
                }
                break;
            }
            case 'ellipse': {
                const rotation = ((shape.rotation || 0) * Math.PI) / 180;
                const rx = shape.radiusX * (shape.scaleX || 1);
                const ry = shape.radiusY * (shape.scaleY || 1);
                if (fillColor !== null) {
                    wr.drawEllipse(shape.x, shape.y, rx, ry, fillColor, 64, rotation);
                }
                if (strokeColor !== null && strokeWidth > 0) {
                    wr.drawEllipseOutline(shape.x, shape.y, rx, ry, strokeColor, strokeWidth, 64, rotation);
                }
                break;
            }
            case 'line': {
                const color = strokeColor !== null ? strokeColor : 0x000000FF;
                // strokeWidth is in world units; the view matrix scales it
                // with zoom exactly like Canvas2D lineWidth.
                wr.drawLine(shape.x1, shape.y1, shape.x2, shape.y2, color, strokeWidth);
                break;
            }
            default: {
                break;
            }
        }
    }

    _renderOverlay(ctx) {
        const selected = this.vexel.selectedShapes;
        if (selected.length === 0) return;

        ctx.save();
        ctx.translate(this.vexel.viewport.x, this.vexel.viewport.y);
        ctx.scale(this.vexel.viewport.zoom, this.vexel.viewport.zoom);
        ctx.rotate(this.vexel.viewport.rotation || 0);

        for (const shape of selected) {
            const bounds = shape.getBounds();
            const z = this.vexel.viewport.zoom;
            const handleSize = 7 / z;

            ctx.strokeStyle = '#4A90D9';
            ctx.lineWidth = 1.5 / z;
            ctx.setLineDash([6 / z, 3 / z]);
            ctx.strokeRect(
                bounds.x - 2 / z,
                bounds.y - 2 / z,
                bounds.width + 4 / z,
                bounds.height + 4 / z
            );
            ctx.setLineDash([]);

            const handles = [
                { x: bounds.x, y: bounds.y },
                { x: bounds.x + bounds.width, y: bounds.y },
                { x: bounds.x, y: bounds.y + bounds.height },
                { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
                { x: bounds.x + bounds.width / 2, y: bounds.y },
                { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
                { x: bounds.x, y: bounds.y + bounds.height / 2 },
                { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
            ];

            for (const h of handles) {
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#4A90D9';
                ctx.lineWidth = 1.5 / z;
                ctx.fillRect(
                    h.x - handleSize / 2,
                    h.y - handleSize / 2,
                    handleSize,
                    handleSize
                );
                ctx.strokeRect(
                    h.x - handleSize / 2,
                    h.y - handleSize / 2,
                    handleSize,
                    handleSize
                );
            }
        }

        ctx.restore();

        if (this.vexel.selectTool && this.vexel.selectTool.marquee) {
            this.vexel.selectTool.drawMarquee(ctx);
        }

        if (this.vexel.selectTool && selected.length === 1) {
            this.vexel.selectTool.drawRotationHandle(ctx);
        }
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
            viewportZoom: this.vexel.viewport.zoom,
            webgl: this.webglRenderer ? this.webglRenderer.getStats() : null
        };
    }

    takeScreenshot(scale = 1, format = 'image/png') {
        return new Promise((resolve) => {
            const w = Math.round(this.vexel.width * scale);
            const h = Math.round(this.vexel.height * scale);

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);

            ctx.save();
            ctx.scale(scale, scale);

            ctx.translate(this.vexel.viewport.x, this.vexel.viewport.y);
            ctx.scale(this.vexel.viewport.zoom, this.vexel.viewport.zoom);
            ctx.rotate(this.vexel.viewport.rotation);

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
        this._activateCanvas2D();
    }
}

if (typeof window !== 'undefined') {
    window.VexelRenderer = VexelRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelRenderer;
}