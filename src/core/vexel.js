// src/core/vexel.js
//
// Vexel engine core.
//
// Rendering contract: every frame draws the scene canvas and the overlay
// canvas from ONE immutable VexelViewportSnapshot. Viewport changes are
// committed atomically via setViewport(), and the requestAnimationFrame loop
// is the only scheduler. destroy() stops that loop and detaches every DOM
// listener before clearing the canvas references.

// src/core/vexel.js

/**
 * Built-in shape classes live in `src/core/shapes.js` and are resolved once,
 * either from the module system (Node) or from the globals registered by that
 * file when it is loaded as a classic browser script before this one.
 */
const VexelShapeClasses = (() => {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
        return require('./shapes.js');
    }
    if (typeof window !== 'undefined') {
        return {
            VexelRectangle: window.VexelRectangle,
            VexelEllipse: window.VexelEllipse,
            VexelPolygon: window.VexelPolygon,
            VexelLine: window.VexelLine,
            VexelPath: window.VexelPath,
            VexelText: window.VexelText,
            VexelImage: window.VexelImage,
            VexelGroup: window.VexelGroup
        };
    }
    return {};
})();

const Shapes = VexelShapeClasses;

class Vexel {
    constructor(config = {}) {
        this.container = typeof config.container === 'string'
            ? document.querySelector(config.container)
            : config.container || document.body;

        if (!this.container) {
            throw new Error('Vexel: container element not found.');
        }

        this.config = config;
        this.responsive = config.responsive === true;
        this.width = Math.max(1, config.width || (this.responsive ? this._measureContainer().width : 800));
        this.height = Math.max(1, config.height || (this.responsive ? this._measureContainer().height : 600));
        this.pixelRatio = this._currentPixelRatio();

        this.zoomEnabled = config.zoom !== false;
        this.panEnabled = config.pan !== false;
        this.gridEnabled = config.grid || false;
        this.snapEnabled = config.snap || false;
        this.snapSize = config.snapSize || 10;
        this.theme = config.theme || 'dark';
        this.locale = config.locale || 'en';
        this.minZoom = config.minZoom || 0.01;
        this.maxZoom = config.maxZoom || 100;

        this.plugins = [];
        this.layers = [];
        this.shapes = [];
        this.selectedShapes = [];
        this.clipboard = [];
        this.history = { undo: [], redo: [], maxSteps: config.maxHistory || 100 };

        // Single source of truth for pan/zoom/rotation. Only setViewport()
        // mutates these values, and it does so atomically.
        this.viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

        this.tool = 'select';
        this.renderer = null;
        this.engine = null;
        this.canvasManager = null;
        this.viewportManager = null;
        this.selectTool = null;

        this.canvas = null;
        this.ctx = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;

        this.frameId = null;
        this._frameSeq = 0;
        this._viewportVersion = 0;
        this.lastSnapshot = null;
        this.dirty = true;
        this.destroyed = false;

        this._events = new Map();
        this._domListeners = [];
        this._resizeObserver = null;
        this._dprMediaQuery = null;
        this._dprMediaHandler = null;

        this._interaction = null;
        this._marquee = { active: false, start: null, end: null };
        this._dragThreshold = 2;

        this._init();
    }

    /* ------------------------------------------------------------------ */
    /* Initialisation                                                      */
    /* ------------------------------------------------------------------ */

    _init() {
        this._createCanvas();
        this._setupRenderer();
        this._setupManagers();
        this._attachEvents();
        this._setupResponsive();
        this._startLoop();
        this._fireEvent('ready', { target: this });
    }

    _measureContainer() {
        const el = this.container;
        return {
            width: Math.max(1, Math.round(el.clientWidth || el.offsetWidth || 0)),
            height: Math.max(1, Math.round(el.clientHeight || el.offsetHeight || 0))
        };
    }

    _currentPixelRatio() {
        if (typeof window === 'undefined') return 1;
        const ratio = window.devicePixelRatio || 1;
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }

    _createCanvas() {
        // Only impose positioning when the container is statically laid out.
        // Overwriting a stylesheet's `position: absolute; inset: 0` collapses
        // flex panels to zero height.
        const computedPosition = typeof getComputedStyle === 'function'
            ? getComputedStyle(this.container).position
            : (this.container.style.position || 'static');
        if (!computedPosition || computedPosition === 'static') {
            this.container.style.position = 'relative';
        }
        this.container.style.overflow = 'hidden';

        if (!this.responsive) {
            this.container.style.width = this.width + 'px';
            this.container.style.height = this.height + 'px';
        }

        this.canvas = this._createCanvasElement('vexel-main');
        this.canvas.style.zIndex = '0';
        this.ctx = this.canvas.getContext('2d');

        this.overlayCanvas = this._createCanvasElement('vexel-overlay');
        this.overlayCanvas.style.zIndex = '1';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCtx = this.overlayCanvas.getContext('2d');

        this.container.appendChild(this.canvas);
        this.container.appendChild(this.overlayCanvas);

        this._syncCanvasSize();
    }

    _createCanvasElement(className) {
        const canvas = document.createElement('canvas');
        canvas.className = className;
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.display = 'block';
        return canvas;
    }

    /**
     * Size both backing stores and both CSS boxes from the same logical size
     * and the same devicePixelRatio. Transforms are reset absolutely with
     * setTransform so repeated resizes and DPR changes never accumulate.
     */
    _syncCanvasSize() {
        this._applyCanvasMetrics(this.canvas, this.ctx, this.width, this.height, this.pixelRatio);
        this._applyCanvasMetrics(this.overlayCanvas, this.overlayCtx, this.width, this.height, this.pixelRatio);
    }

    _applyCanvasMetrics(canvas, ctx, width, height, pixelRatio) {
        if (!canvas) return;

        const deviceWidth = Math.max(1, Math.round(width * pixelRatio));
        const deviceHeight = Math.max(1, Math.round(height * pixelRatio));

        if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
        if (canvas.height !== deviceHeight) canvas.height = deviceHeight;

        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        if (ctx && typeof ctx.setTransform === 'function') {
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }
    }

    _setupRenderer() {
        if (typeof VexelRenderer !== 'undefined') {
            this.renderer = new VexelRenderer(this);
        } else {
            // Minimal fallback so the engine still renders if the renderer
            // module was not loaded.
            this.renderer = {
                dirty: true,
                clear: () => this._clearSurfaces(),
                renderAll: () => this.renderNow(),
                renderFrame: (snapshot) => this._renderFallback(snapshot),
                markDirty: () => { this.dirty = true; },
                markAllDirty: () => { this.dirty = true; },
                destroy: () => {}
            };
        }
    }

    _setupManagers() {
        if (typeof VexelRenderEngine !== 'undefined') {
            this.engine = new VexelRenderEngine(this);
        } else {
            this.engine = null;
        }
        if (typeof VexelCanvas !== 'undefined') {
            this.canvasManager = new VexelCanvas(this);
            this.gridEnabled = this.canvasManager.gridVisible;
            this.snapSize = this.canvasManager.snapSize;
        }
        if (typeof VexelViewport !== 'undefined') {
            this.viewportManager = new VexelViewport(this);
        }
        // An externally supplied select tool is supported, but selection is
        // handled by the engine itself so every shape type behaves uniformly.
        this.selectTool = null;
    }

    /* ------------------------------------------------------------------ */
    /* Viewport                                                            */
    /* ------------------------------------------------------------------ */

    /** Immutable snapshot of the current viewport. */
    getViewportSnapshot() {
        return VexelViewportSnapshot.capture(this);
    }

    /**
     * Atomically commit a viewport change. All values are validated and
     * clamped first, then applied in one go, so no consumer can observe a
     * half-updated pan/zoom pair.
     */
    setViewport(next = {}) {
        if (this.destroyed) return this.viewport;

        const viewport = this.viewport;
        let changed = false;

        if (Number.isFinite(next.x) && next.x !== viewport.x) {
            viewport.x = next.x;
            changed = true;
        }
        if (Number.isFinite(next.y) && next.y !== viewport.y) {
            viewport.y = next.y;
            changed = true;
        }
        if (Number.isFinite(next.zoom)) {
            const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, next.zoom));
            if (zoom !== viewport.zoom) {
                viewport.zoom = zoom;
                changed = true;
            }
        }
        if (Number.isFinite(next.rotation) && next.rotation !== viewport.rotation) {
            viewport.rotation = next.rotation;
            changed = true;
        }

        if (changed) {
            this._viewportVersion++;
            this.dirty = true;
            if (this.renderer) this.renderer.dirty = true;
            this._fireEvent('viewportchange', this.getViewportSnapshot());
        }

        return viewport;
    }

    /** Pan by a logical-pixel delta. */
    panBy(dx, dy) {
        if (!Number.isFinite(dx) && !Number.isFinite(dy)) return;
        return this.setViewport({
            x: this.viewport.x + (Number.isFinite(dx) ? dx : 0),
            y: this.viewport.y + (Number.isFinite(dy) ? dy : 0)
        });
    }

    /** Absolute zoom, keeping the point (cx, cy) in logical pixels fixed. */
    setZoom(zoom, cx, cy) {
        const current = this.viewport.zoom;
        const target = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        if (!Number.isFinite(target) || target === current) return;

        const anchorX = Number.isFinite(cx) ? cx : this.width / 2;
        const anchorY = Number.isFinite(cy) ? cy : this.height / 2;
        const ratio = target / current;

        this.setViewport({
            x: anchorX - (anchorX - this.viewport.x) * ratio,
            y: anchorY - (anchorY - this.viewport.y) * ratio,
            zoom: target
        });
    }

    /** Multiply the zoom by a factor, keeping (cx, cy) fixed. */
    zoomAt(factor, cx, cy) {
        if (!Number.isFinite(factor) || factor <= 0) return;
        this.setZoom(this.viewport.zoom * factor, cx, cy);
    }

    zoomIn(factor = 1.1, cx, cy) {
        this.zoomAt(factor, cx, cy);
    }

    zoomOut(factor = 0.9, cx, cy) {
        this.zoomAt(factor, cx, cy);
    }

    zoomToFit(padding = 50, shapes) {
        const list = shapes || this.shapes;
        if (!list || list.length === 0) {
            this.resetView();
            return;
        }

        const bounds = VexelOverlay
            ? VexelOverlay.unionBounds(list.map(s => VexelOverlay.getShapeBounds(s)))
            : this._unionBounds(list);

        if (!(bounds.width > 0) && !(bounds.height > 0)) return;

        const contentWidth = bounds.width + padding * 2;
        const contentHeight = bounds.height + padding * 2;
        const zoomX = this.width / Math.max(contentWidth, 1);
        const zoomY = this.height / Math.max(contentHeight, 1);
        const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(zoomX, zoomY)));

        this.setViewport({
            zoom,
            x: (this.width - contentWidth * zoom) / 2 - bounds.x * zoom + padding * zoom,
            y: (this.height - contentHeight * zoom) / 2 - bounds.y * zoom + padding * zoom
        });
    }

    zoomToSelection(padding = 30) {
        if (this.selectedShapes.length > 0) {
            this.zoomToFit(padding, this.selectedShapes);
        }
    }

    resetView() {
        this.setViewport({ x: 0, y: 0, zoom: 1, rotation: 0 });
    }

    screenToWorld(screenX, screenY) {
        return this.getViewportSnapshot().screenToWorld(screenX, screenY);
    }

    worldToScreen(worldX, worldY) {
        return this.getViewportSnapshot().worldToScreen(worldX, worldY);
    }

    getVisibleBounds() {
        const snapshot = this.getViewportSnapshot();
        const topLeft = snapshot.screenToWorld(0, 0);
        const bottomRight = snapshot.screenToWorld(snapshot.width, snapshot.height);
        return {
            x: Math.min(topLeft.x, bottomRight.x),
            y: Math.min(topLeft.y, bottomRight.y),
            width: Math.abs(bottomRight.x - topLeft.x),
            height: Math.abs(bottomRight.y - topLeft.y)
        };
    }

    /* ------------------------------------------------------------------ */
    /* Render loop                                                         */
    /* ------------------------------------------------------------------ */

    _startLoop() {
        if (this.frameId !== null) return;

        const loop = () => {
            // Clear the stored id first: destroy() may run between scheduling
            // and this callback, and we must never render or reschedule then.
            this.frameId = null;
            if (this.destroyed) return;

            if (this._currentPixelRatio() !== this.pixelRatio) {
                this.resize(this.width, this.height, { force: true });
            }

            if (this.dirty) {
                this.renderNow();
            }

            if (this.destroyed) return;
            this.frameId = requestAnimationFrame(loop);
        };

        this.frameId = requestAnimationFrame(loop);
    }

    _stopLoop() {
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
    }

    requestRender() {
        if (this.destroyed) return;
        this.dirty = true;
        if (this.renderer) this.renderer.dirty = true;
    }

    /**
     * Draw exactly one frame: scene and selection overlay from a single
     * viewport snapshot. Safe to call directly (pen tool) and idempotent.
     */
    renderNow() {
        if (this.destroyed || !this.ctx) return null;

        this._frameSeq++;
        const snapshot = VexelViewportSnapshot.capture(this);
        this._renderWithSnapshot(snapshot);
        return snapshot;
    }

    /**
     * The single rendering path. Scene and overlay are drawn from the SAME
     * snapshot argument, never from live mutable viewport state.
     */
    _renderWithSnapshot(snapshot) {
        if (this.destroyed || !this.ctx) return;

        this.lastSnapshot = snapshot;

        if (this.renderer && typeof this.renderer.renderFrame === 'function') {
            this.renderer.renderFrame(snapshot);
        } else {
            this._renderFallback(snapshot);
        }

        if (this.engine) {
            this.engine.lastSnapshot = snapshot;
            this.engine.pixelRatio = snapshot.pixelRatio;
        }

        this.dirty = false;
        if (this.renderer) this.renderer.dirty = false;
    }

    _clearSurfaces() {
        if (!this.ctx) return;
        const snapshot = VexelViewportSnapshot.capture(this);
        snapshot.clearSurface(this.ctx, this.canvas);
        if (this.overlayCtx) {
            snapshot.clearSurface(this.overlayCtx, this.overlayCanvas);
        }
    }

    _renderFallback(snapshot) {
        snapshot.clearSurface(this.ctx, this.canvas);
        if (this.overlayCtx) {
            snapshot.clearSurface(this.overlayCtx, this.overlayCanvas);
        }

        this.ctx.save();
        snapshot.applyWorld(this.ctx);
        for (const shape of this.shapes) {
            if (shape.visible !== false) shape.draw(this.ctx);
        }
        this.ctx.restore();

        if (this.overlayCtx && typeof VexelOverlay !== 'undefined') {
            if (this.selectedShapes.length) {
                VexelOverlay.drawSelection(this.overlayCtx, snapshot, this.selectedShapes);
            }
            if (this._marquee.active) {
                VexelOverlay.drawMarquee(this.overlayCtx, snapshot, this._marquee.start, this._marquee.end);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Resize                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Resize the canvas surfaces. With no arguments (or when responsive) the
     * current container size is measured, which is what window resizes and
     * panel switches need.
     */
    resize(width, height, options = {}) {
        if (this.destroyed) return this;

        if (!Number.isFinite(width) || !Number.isFinite(height)) {
            const measured = this._measureContainer();
            width = Number.isFinite(width) ? width : measured.width;
            height = Number.isFinite(height) ? height : measured.height;
        }

        width = Math.max(1, Math.round(width));
        height = Math.max(1, Math.round(height));
        const pixelRatio = this._currentPixelRatio();

        const unchanged = width === this.width && height === this.height && pixelRatio === this.pixelRatio;
        if (unchanged && !options.force) {
            return this;
        }

        this.width = width;
        this.height = height;
        this.pixelRatio = pixelRatio;

        if (!this.responsive) {
            this.container.style.width = width + 'px';
            this.container.style.height = height + 'px';
        }

        this._syncCanvasSize();
        this.requestRender();
        this._fireEvent('resize', { width, height, pixelRatio });
        return this;
    }

    resizeToContainer() {
        const measured = this._measureContainer();
        // A hidden panel reports 0x0; keep the last good size until it is
        // visible again instead of collapsing the backing store.
        if (measured.width < 2 || measured.height < 2) return this;
        return this.resize(measured.width, measured.height, { force: true });
    }

    _setupResponsive() {
        if (!this.responsive) return;

        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                if (this.destroyed) return;
                this.resizeToContainer();
            });
            this._resizeObserver.observe(this.container);
        }

        this._addDomListener(window, 'resize', () => {
            if (this.destroyed) return;
            this.resizeToContainer();
        });

        // devicePixelRatio can change without a window resize (moving between
        // monitors, browser zoom). Watch the resolution media query.
        this._watchPixelRatio();
    }

    _watchPixelRatio() {
        if (typeof window === 'undefined' || !window.matchMedia) return;

        this._removePixelRatioWatcher();

        const ratio = this._currentPixelRatio();
        const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
        const handler = () => {
            if (this.destroyed) return;
            this.resize(this.width, this.height, { force: true });
            this._watchPixelRatio();
        };

        if (typeof query.addEventListener === 'function') {
            query.addEventListener('change', handler);
            this._dprMediaQuery = query;
            this._dprMediaHandler = handler;
        } else if (typeof query.addListener === 'function') {
            query.addListener(handler);
            this._dprMediaQuery = query;
            this._dprMediaHandler = handler;
        }
    }

    _removePixelRatioWatcher() {
        const query = this._dprMediaQuery;
        const handler = this._dprMediaHandler;
        if (!query || !handler) return;

        if (typeof query.removeEventListener === 'function') {
            query.removeEventListener('change', handler);
        } else if (typeof query.removeListener === 'function') {
            query.removeListener(handler);
        }
        this._dprMediaQuery = null;
        this._dprMediaHandler = null;
    }

    /* ------------------------------------------------------------------ */
    /* Events                                                              */
    /* ------------------------------------------------------------------ */

    _addDomListener(target, type, handler, options) {
        if (!target || !handler) return;
        target.addEventListener(type, handler, options);
        this._domListeners.push({ target, type, handler, options });
    }

    _removeDomListeners() {
        for (const entry of this._domListeners) {
            entry.target.removeEventListener(entry.type, entry.handler, entry.options);
        }
        this._domListeners = [];
    }

    _attachEvents() {
        this._onWheelBound = this._onWheel.bind(this);
        this._onMouseDownBound = this._onMouseDown.bind(this);
        this._onMouseMoveBound = this._onMouseMove.bind(this);
        this._onMouseUpBound = this._onMouseUp.bind(this);
        this._onBlurBound = this._onWindowBlur.bind(this);

        this._addDomListener(this.container, 'wheel', this._onWheelBound, { passive: false });
        this._addDomListener(this.container, 'mousedown', this._onMouseDownBound);
        this._addDomListener(window, 'mousemove', this._onMouseMoveBound);
        this._addDomListener(window, 'mouseup', this._onMouseUpBound);
        this._addDomListener(window, 'blur', this._onBlurBound);
    }

    _isCanvasEvent(e) {
        const target = e.target;
        return target === this.canvas || target === this.overlayCanvas || target === this.container;
    }

    _eventToWorld(e) {
        const rect = this.container.getBoundingClientRect();
        return this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    }

    _eventToLocal(e) {
        const rect = this.container.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onWheel(e) {
        if (!this.zoomEnabled || this.destroyed) return;
        if (!this._isCanvasEvent(e)) return;

        e.preventDefault();

        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        else if (e.deltaMode === 2) delta *= 100;

        if (!Number.isFinite(delta) || delta === 0) return;

        // Continuous, multiplicative zoom: rapid wheel bursts compose
        // smoothly, and the anchor point stays fixed.
        const factor = Math.exp(-delta * (e.ctrlKey ? 0.0035 : 0.0015));
        const local = this._eventToLocal(e);
        this.zoomAt(factor, local.x, local.y);

        if (this.canvasManager) this.canvasManager.stopInertia();
        this._fireEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            zoom: this.viewport.zoom,
            originalEvent: e
        });
    }

    _onMouseDown(e) {
        if (this.destroyed || !this._isCanvasEvent(e)) return;

        if (e.button === 1 || (e.button === 0 && e.altKey && this.panEnabled)) {
            e.preventDefault();
            this._interaction = {
                mode: 'pan',
                startClientX: e.clientX,
                startClientY: e.clientY,
                startX: this.viewport.x,
                startY: this.viewport.y
            };
            this._setCursor('grabbing');
            return;
        }

        if (e.button !== 0) return;

        const point = this._eventToWorld(e);
        const hit = this._hitTest(point.x, point.y);

        if (hit) {
            if (e.shiftKey) {
                if (this.selectedShapes.includes(hit)) {
                    this.deselect(hit);
                    return;
                }
                this.select(hit);
            } else if (!this.selectedShapes.includes(hit)) {
                this.deselectAll();
                this.select(hit);
            }

            this._interaction = {
                mode: 'drag',
                start: point,
                last: point,
                moved: false,
                shapes: [...this.selectedShapes]
            };
            return;
        }

        if (!e.shiftKey) {
            this.deselectAll();
        }

        this._interaction = {
            mode: 'marquee',
            start: point,
            additive: e.shiftKey
        };
        this._marquee = { active: true, start: point, end: point };
        this.requestRender();
    }

    _onMouseMove(e) {
        if (this.destroyed || !this._interaction) return;

        const interaction = this._interaction;

        if (interaction.mode === 'pan') {
            this.setViewport({
                x: interaction.startX + (e.clientX - interaction.startClientX),
                y: interaction.startY + (e.clientY - interaction.startClientY)
            });
            return;
        }

        const point = this._eventToWorld(e);

        if (interaction.mode === 'drag') {
            if (!interaction.moved) {
                const local = this._eventToLocal(e);
                const rect = this.container.getBoundingClientRect();
                const startLocal = this.worldToScreen(interaction.start.x, interaction.start.y);
                if (Math.hypot(local.x - startLocal.x, local.y - startLocal.y) < this._dragThreshold) {
                    return;
                }
                interaction.moved = true;
            }

            const dx = point.x - interaction.last.x;
            const dy = point.y - interaction.last.y;
            this._translateShapes(interaction.shapes, dx, dy);
            interaction.last = point;
            this.requestRender();
            return;
        }

        if (interaction.mode === 'marquee') {
            this._marquee.end = point;
            this.requestRender();
        }
    }

    _onMouseUp() {
        if (this.destroyed) return;

        const interaction = this._interaction;
        this._interaction = null;

        if (interaction && interaction.mode === 'marquee') {
            this._finishMarquee(interaction.additive);
        }

        if (interaction && interaction.mode === 'pan') {
            this._setCursor('default');
        }

        this._marquee = { active: false, start: null, end: null };
        this.requestRender();
    }

    _onWindowBlur() {
        if (this.destroyed) return;
        this._interaction = null;
        this._marquee = { active: false, start: null, end: null };
        this._setCursor('default');
    }

    _setCursor(cursor) {
        if (this.destroyed || !this.container || !this.container.style) return;
        this.container.style.cursor = cursor;
    }

    _finishMarquee(additive) {
        const start = this._marquee.start;
        const end = this._marquee.end;
        if (!start || !end) return;

        const marquee = {
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y)
        };

        if (marquee.width < 0.5 && marquee.height < 0.5) return;

        if (!additive) this.deselectAll();

        for (const shape of this.shapes) {
            if (shape.visible === false || shape.locked) continue;
            const bounds = VexelOverlay
                ? VexelOverlay.getShapeBounds(shape)
                : shape.getBounds();
            const intersects =
                bounds.x + bounds.width >= marquee.x &&
                bounds.x <= marquee.x + marquee.width &&
                bounds.y + bounds.height >= marquee.y &&
                bounds.y <= marquee.y + marquee.height;
            if (intersects) this.select(shape);
        }
    }

    _translateShapes(shapes, dx, dy) {
        if ((!Number.isFinite(dx) || dx === 0) && (!Number.isFinite(dy) || dy === 0)) return;

        for (const shape of shapes) {
            if (!shape || shape.locked) continue;
            if (typeof shape.translate === 'function') {
                shape.translate(dx, dy);
            } else {
                if (Number.isFinite(shape.x)) shape.x += dx;
                if (Number.isFinite(shape.y)) shape.y += dy;
            }
        }

        if (this.snapEnabled) {
            this._snapShapes(shapes);
        }
    }

    _snapShapes(shapes) {
        for (const shape of shapes) {
            if (!shape || typeof shape.getRenderBounds !== 'function') continue;
            const bounds = shape.getRenderBounds();
            const snappedX = Math.round(bounds.x / this.snapSize) * this.snapSize;
            const snappedY = Math.round(bounds.y / this.snapSize) * this.snapSize;
            const dx = snappedX - bounds.x;
            const dy = snappedY - bounds.y;
            if (typeof shape.translate === 'function') shape.translate(dx, dy);
        }
    }

    _hitTest(worldX, worldY) {
        const snapshot = this.getViewportSnapshot();
        const tolerance = snapshot.toWorldDistance(3);

        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const shape = this.shapes[i];
            if (!shape || shape.visible === false || shape.locked) continue;

            if (typeof shape.containsPoint === 'function') {
                if (shape.containsPoint(worldX, worldY, tolerance)) return shape;
            } else {
                const bounds = VexelOverlay
                    ? VexelOverlay.getShapeBounds(shape)
                    : shape.getBounds();
                if (
                    worldX >= bounds.x - tolerance &&
                    worldX <= bounds.x + bounds.width + tolerance &&
                    worldY >= bounds.y - tolerance &&
                    worldY <= bounds.y + bounds.height + tolerance
                ) {
                    return shape;
                }
            }
        }

        return null;
    }

    _unionBounds(shapes) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    /* ------------------------------------------------------------------ */
    /* Public event API                                                    */
    /* ------------------------------------------------------------------ */

    on(event, callback) {
        if (typeof callback !== 'function') return () => {};
        if (!this._events.has(event)) this._events.set(event, new Set());
        this._events.get(event).add(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const listeners = this._events.get(event);
        if (listeners) listeners.delete(callback);
    }

    _fireEvent(name, data) {
        if (this.destroyed) return;

        const listeners = this._events.get(name);
        if (listeners) {
            for (const callback of [...listeners]) {
                try {
                    callback(data);
                } catch (error) {
                    if (typeof console !== 'undefined') console.error(error);
                }
            }
        }

        if (this.container && typeof this.container.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
            try {
                this.container.dispatchEvent(new CustomEvent(`vexel:${name}`, { detail: data }));
            } catch (error) {
                // Detached containers are allowed to throw here; ignore.
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Shape lifecycle                                                     */
    /* ------------------------------------------------------------------ */

    _addShape(shape) {
        this.shapes.push(shape);
        this.requestRender();
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    rectangle(x, y, width, height, options = {}) {
        return this._addShape(new Shapes.VexelRectangle(x, y, width, height, options));
    }

    ellipse(x, y, radiusX, radiusY, options = {}) {
        return this._addShape(new Shapes.VexelEllipse(x, y, radiusX, radiusY, options));
    }

    polygon(x, y, sides, radius, options = {}) {
        return this._addShape(new Shapes.VexelPolygon(x, y, sides, radius, options));
    }

    line(x1, y1, x2, y2, options = {}) {
        return this._addShape(new Shapes.VexelLine(x1, y1, x2, y2, options));
    }

    path(points, options = {}) {
        return this._addShape(new Shapes.VexelPath(points, options));
    }

    text(x, y, content, options = {}) {
        return this._addShape(new Shapes.VexelText(x, y, content, options));
    }

    image(x, y, src, options = {}) {
        return this._addShape(new Shapes.VexelImage(x, y, src, options));
    }

    group(shapes, options = {}) {
        return this._addShape(new Shapes.VexelGroup(shapes, options));
    }

    remove(shape) {
        const index = this.shapes.indexOf(shape);
        if (index > -1) {
            this.shapes.splice(index, 1);
            this.deselect(shape);
            this.requestRender();
            this._pushHistory({ type: 'remove', shape, index });
        }
    }

    clear() {
        this.shapes = [];
        this.selectedShapes = [];
        this._marquee = { active: false, start: null, end: null };
        this.requestRender();
        this._pushHistory({ type: 'clear', shapes: [] });
    }

    select(shape) {
        if (!shape || this.selectedShapes.includes(shape)) return;
        this.selectedShapes.push(shape);
        this.requestRender();
        this._fireEvent('selectionchange', { selected: [...this.selectedShapes] });
    }

    deselect(shape) {
        const index = this.selectedShapes.indexOf(shape);
        if (index > -1) {
            this.selectedShapes.splice(index, 1);
            this.requestRender();
            this._fireEvent('selectionchange', { selected: [...this.selectedShapes] });
        }
    }

    selectAll() {
        this.selectedShapes = this.shapes.filter(s => s.visible !== false && !s.locked);
        this.requestRender();
        this._fireEvent('selectionchange', { selected: [...this.selectedShapes] });
    }

    deselectAll() {
        if (this.selectedShapes.length === 0) return;
        this.selectedShapes = [];
        this.requestRender();
        this._fireEvent('selectionchange', { selected: [] });
    }

    deleteSelected() {
        for (const shape of [...this.selectedShapes]) {
            this.remove(shape);
        }
        this.selectedShapes = [];
        this.requestRender();
    }

    /* ------------------------------------------------------------------ */
    /* History                                                             */
    /* ------------------------------------------------------------------ */

    undo() {
        if (this.history.undo.length === 0) return;
        const action = this.history.undo.pop();
        this.history.redo.push(action);
        this._applyUndo(action);
        this.requestRender();
    }

    redo() {
        if (this.history.redo.length === 0) return;
        const action = this.history.redo.pop();
        this.history.undo.push(action);
        this._applyRedo(action);
        this.requestRender();
    }

    _pushHistory(action) {
        this.history.undo.push(action);
        if (this.history.undo.length > this.history.maxSteps) {
            this.history.undo.shift();
        }
        this.history.redo = [];
    }

    _applyUndo(action) {
        if (action.type === 'add') {
            const index = this.shapes.indexOf(action.shape);
            if (index > -1) this.shapes.splice(index, 1);
        } else if (action.type === 'remove') {
            this.shapes.splice(action.index, 0, action.shape);
        } else if (action.type === 'clear') {
            this.shapes = [...action.shapes];
        }
    }

    _applyRedo(action) {
        if (action.type === 'add') {
            this.shapes.push(action.shape);
        } else if (action.type === 'remove') {
            const index = this.shapes.indexOf(action.shape);
            if (index > -1) this.shapes.splice(index, 1);
        } else if (action.type === 'clear') {
            this.shapes = [];
        }
    }

    /* ------------------------------------------------------------------ */
    /* Serialization / export                                              */
    /* ------------------------------------------------------------------ */

    save() {
        return {
            version: '1.0.0',
            viewport: { ...this.viewport },
            shapes: this.shapes.map(s => s.serialize()),
            layers: this.layers.map(l => l.serialize()),
            exportedAt: new Date().toISOString()
        };
    }

    load(data) {
        if (!data || !data.shapes) return;
        this.clear();

        if (data.viewport) {
            this.setViewport({
                x: data.viewport.x,
                y: data.viewport.y,
                zoom: data.viewport.zoom,
                rotation: data.viewport.rotation
            });
        }

        for (const shapeData of data.shapes) {
            const shape = this._deserializeShape(shapeData);
            if (shape) this.shapes.push(shape);
        }
        this.requestRender();
    }

    _deserializeShape(data) {
        const constructors = {
            rectangle: Shapes.VexelRectangle,
            ellipse: Shapes.VexelEllipse,
            polygon: Shapes.VexelPolygon,
            line: Shapes.VexelLine,
            path: Shapes.VexelPath,
            text: Shapes.VexelText,
            image: Shapes.VexelImage,
            group: Shapes.VexelGroup
        };
        const Ctor = constructors[data.type];
        if (!Ctor) return null;
        return Ctor.deserialize(data);
    }

    getShapeClasses() {
        return Shapes;
    }

    exportJSON() {
        return JSON.stringify(this.save(), null, 2);
    }

    exportSVG() {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">`;
        for (const shape of this.shapes) {
            svg += shape.toSVG();
        }
        svg += '</svg>';
        return svg;
    }

    exportPNG(scale = 1) {
        return new Promise((resolve) => {
            if (!this.canvas || this.destroyed) {
                resolve(null);
                return;
            }

            const snapshot = this.lastSnapshot || this.getViewportSnapshot();
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = Math.max(1, Math.round(snapshot.width * scale));
            exportCanvas.height = Math.max(1, Math.round(snapshot.height * scale));
            const exportCtx = exportCanvas.getContext('2d');

            exportCtx.fillStyle = '#ffffff';
            exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

            exportCtx.save();
            exportCtx.scale(scale, scale);
            snapshot.applyWorld(exportCtx);
            for (const shape of this.shapes) {
                if (shape.visible !== false) shape.draw(exportCtx);
            }
            exportCtx.restore();

            exportCanvas.toBlob((blob) => resolve(blob), 'image/png');
        });
    }

    /* ------------------------------------------------------------------ */
    /* Plugins                                                             */
    /* ------------------------------------------------------------------ */

    addPlugin(plugin) {
        this.plugins.push(plugin);
        if (plugin.install) plugin.install(this);
    }

    removePlugin(plugin) {
        const index = this.plugins.indexOf(plugin);
        if (index > -1) {
            if (plugin.uninstall) plugin.uninstall(this);
            this.plugins.splice(index, 1);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Destruction                                                         */
    /* ------------------------------------------------------------------ */

    destroy() {
        if (this.destroyed) return;

        this.destroyed = true;

        // 1. Stop the render loop first: nothing else may schedule frames.
        this._stopLoop();

        // 2. Stop any helper animations that own their own rAF loops.
        if (this.canvasManager && typeof this.canvasManager.destroy === 'function') {
            this.canvasManager.destroy();
        }
        if (this.viewportManager && typeof this.viewportManager.destroy === 'function') {
            this.viewportManager.destroy();
        }
        if (this.selectTool && typeof this.selectTool.destroy === 'function') {
            this.selectTool.destroy();
        }

        // 3. Detach every DOM listener, including window-level ones.
        this._removeDomListeners();
        this._removePixelRatioWatcher();
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // 4. Release the renderer.
        if (this.renderer && typeof this.renderer.destroy === 'function') {
            this.renderer.destroy();
        }
        if (this.engine && typeof this.engine.destroy === 'function') {
            this.engine.destroy();
        }

        // 5. Remove the canvases safely (they may already be detached).
        for (const canvas of [this.canvas, this.overlayCanvas]) {
            if (canvas && canvas.parentNode === this.container) {
                this.container.removeChild(canvas);
            }
        }

        // 6. Drop references so no callback can touch a removed canvas.
        this.canvas = null;
        this.ctx = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.lastSnapshot = null;
        this._interaction = null;
        this._marquee = { active: false, start: null, end: null };

        this.shapes = [];
        this.selectedShapes = [];
        this.layers = [];
        this.plugins = [];
        this._events.clear();
        this.history = { undo: [], redo: [], maxSteps: 100 };
    }
}

if (typeof window !== 'undefined') {
    window.Vexel = Vexel;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Vexel,
        VexelRectangle: Shapes.VexelRectangle,
        VexelEllipse: Shapes.VexelEllipse,
        VexelPolygon: Shapes.VexelPolygon,
        VexelLine: Shapes.VexelLine,
        VexelPath: Shapes.VexelPath,
        VexelText: Shapes.VexelText,
        VexelImage: Shapes.VexelImage,
        VexelGroup: Shapes.VexelGroup,
        VexelShapeMath: Shapes.VexelShapeMath
    };
}
