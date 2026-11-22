// src/core/viewport.js
//
// Programmatic viewport control (smooth zoom/pan, fitting, constraints).
//
// This class is a thin controller over Vexel#setViewport. It never stores a
// second copy of the pan/zoom values: the engine's viewport is the single
// source of truth, and every animation step commits atomically.

class VexelViewport {
    constructor(vexel) {
        this.vexel = vexel;
        this.minZoom = emblemSafeNumber(vexel && vexel.minZoom, 0.01);
        this.maxZoom = emblemSafeNumber(vexel && vexel.maxZoom, 100);
        this.zoomSensitivity = 0.001;
        this.scrollSensitivity = 1;
        this.homeX = 0;
        this.homeY = 0;
        this.homeZoom = 1;
        this.homeRotation = 0;
        this.smoothZoom = true;
        this.smoothPan = true;
        this.targetX = 0;
        this.targetY = 0;
        this.targetZoom = 1;
        this.targetRotation = 0;
        this.animating = false;
        this.animationSpeed = 0.2;
        this.animationId = null;
        this.constraints = null;
        this.padding = { top: 0, right: 0, bottom: 0, left: 0 };
    }

    get x() { return this.vexel.viewport.x; }
    get y() { return this.vexel.viewport.y; }
    get zoom() { return this.vexel.viewport.zoom; }
    get rotation() { return this.vexel.viewport.rotation; }

    _syncTargets() {
        this.targetX = this.vexel.viewport.x;
        this.targetY = this.vexel.viewport.y;
        this.targetZoom = this.vexel.viewport.zoom;
        this.targetRotation = this.vexel.viewport.rotation;
    }

    pan(dx, dy) {
        this._syncTargets();
        this.targetX += dx;
        this.targetY += dy;

        if (this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x: this.targetX, y: this.targetY });
        }
    }

    panTo(x, y) {
        this._syncTargets();
        this.targetX = x;
        this.targetY = y;

        if (this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x, y });
        }
    }

    zoomAt(factor, cx, cy) {
        this._syncTargets();

        const oldZoom = this.targetZoom;
        const nextZoom = clampNumber(this.targetZoom * factor, this.minZoom, this.maxZoom);

        if (cx !== undefined && cy !== undefined) {
            this.targetX = cx - (cx - this.targetX) * (nextZoom / oldZoom);
            this.targetY = cy - (cy - this.targetY) * (nextZoom / oldZoom);
        }
        this.targetZoom = nextZoom;

        if (this.smoothZoom) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x: this.targetX, y: this.targetY, zoom: this.targetZoom });
        }
    }

    zoomIn(factor = 1.2) {
        const cx = this.vexel.width / 2;
        const cy = this.vexel.height / 2;
        this.zoomAt(factor, cx, cy);
    }

    zoomOut(factor = 0.8) {
        this.zoomIn(factor);
    }

    zoomToFit(shapes, padding = 50) {
        if (!shapes || shapes.length === 0) {
            this.reset();
            return;
        }

        const bounds = this._union(shapes);
        const contentWidth = bounds.width + padding * 2;
        const contentHeight = bounds.height + padding * 2;
        const availableWidth = this.vexel.width - this.padding.left - this.padding.right;
        const availableHeight = this.vexel.height - this.padding.top - this.padding.bottom;
        const zoomX = availableWidth / Math.max(contentWidth, 1);
        const zoomY = availableHeight / Math.max(contentHeight, 1);
        const zoom = clampNumber(Math.min(zoomX, zoomY, 1), this.minZoom, this.maxZoom);

        this._syncTargets();
        this.targetZoom = zoom;
        this.targetX = (availableWidth - contentWidth * zoom) / 2 - bounds.x * zoom + padding * zoom + this.padding.left;
        this.targetY = (availableHeight - contentHeight * zoom) / 2 - bounds.y * zoom + padding * zoom + this.padding.top;

        if (this.smoothZoom || this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x: this.targetX, y: this.targetY, zoom: this.targetZoom });
        }
    }

    zoomToSelection() {
        if (this.vexel.selectedShapes.length > 0) {
            this.zoomToFit(this.vexel.selectedShapes, 30);
        }
    }

    zoomToPercent(percent) {
        this._syncTargets();
        this.targetZoom = clampNumber(percent / 100, this.minZoom, this.maxZoom);
        this.targetX = (this.vexel.width - this.vexel.width * this.targetZoom) / 2;
        this.targetY = (this.vexel.height - this.vexel.height * this.targetZoom) / 2;

        if (this.smoothZoom || this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x: this.targetX, y: this.targetY, zoom: this.targetZoom });
        }
    }

    rotate(angle) {
        this.vexel.setViewport({ rotation: this.vexel.viewport.rotation + angle });
    }

    rotateTo(angle) {
        this.vexel.setViewport({ rotation: angle });
    }

    reset() {
        this.setHome(false);
        this._syncTargets();
        this.targetX = this.homeX;
        this.targetY = this.homeY;
        this.targetZoom = this.homeZoom;
        this.targetRotation = this.homeRotation;

        if (this.smoothZoom || this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({
                x: this.homeX,
                y: this.homeY,
                zoom: this.homeZoom,
                rotation: this.homeRotation
            });
        }
    }

    setHome(capture = true) {
        if (capture) {
            this.homeX = this.vexel.viewport.x;
            this.homeY = this.vexel.viewport.y;
            this.homeZoom = this.vexel.viewport.zoom;
            this.homeRotation = this.vexel.viewport.rotation;
        }
    }

    goHome() {
        this.reset();
    }

    setConstraints(bounds) {
        this.constraints = bounds;
    }

    clearConstraints() {
        this.constraints = null;
    }

    _applyConstraints() {
        if (!this.constraints) return;

        const visibleWidth = this.vexel.width / this.targetZoom;
        const visibleHeight = this.vexel.height / this.targetZoom;

        if (visibleWidth < this.constraints.width) {
            const minX = this.constraints.x;
            const maxX = this.constraints.x + this.constraints.width - visibleWidth;
            this.targetX = clampNumber(this.targetX, minX, maxX);
        } else {
            this.targetX = this.constraints.x + (this.constraints.width - visibleWidth) / 2;
        }

        if (visibleHeight < this.constraints.height) {
            const minY = this.constraints.y;
            const maxY = this.constraints.y + this.constraints.height - visibleHeight;
            this.targetY = clampNumber(this.targetY, minY, maxY);
        } else {
            this.targetY = this.constraints.y + (this.constraints.height - visibleHeight) / 2;
        }
    }

    _startSmoothAnimation() {
        if (this.animating) return;
        if (!this.vexel || this.vexel.destroyed) return;
        this.animating = true;
        this._animateStep();
    }

    _animateStep() {
        this.animationId = null;

        if (!this.animating || !this.vexel || this.vexel.destroyed) {
            this.animating = false;
            return;
        }

        const current = this.vexel.viewport;
        const dx = this.targetX - current.x;
        const dy = this.targetY - current.y;
        const dz = this.targetZoom - current.zoom;
        const dr = this.targetRotation - current.rotation;

        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && Math.abs(dz) < 0.0001 && Math.abs(dr) < 0.01) {
            this.vexel.setViewport({
                x: this.targetX,
                y: this.targetY,
                zoom: this.targetZoom,
                rotation: this.targetRotation
            });
            this.animating = false;
            return;
        }

        this._applyConstraints();

        // Commit both pan and zoom in a single atomic setViewport call: no
        // frame can ever observe a new zoom with an old pan.
        this.vexel.setViewport({
            x: current.x + dx * this.animationSpeed,
            y: current.y + dy * this.animationSpeed,
            zoom: current.zoom + dz * this.animationSpeed,
            rotation: current.rotation + dr * this.animationSpeed
        });

        this.animationId = requestAnimationFrame(() => this._animateStep());
    }

    stopAnimation() {
        this.animating = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    screenToWorld(screenX, screenY) {
        return this.vexel.screenToWorld(screenX, screenY);
    }

    worldToScreen(worldX, worldY) {
        return this.vexel.worldToScreen(worldX, worldY);
    }

    getVisibleBounds() {
        return this.vexel.getVisibleBounds();
    }

    isShapeVisible(shape) {
        const bounds = this.getVisibleBounds();
        const shapeBounds = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
        const margin = 50;

        return !(
            shapeBounds.x + shapeBounds.width < bounds.x - margin ||
            shapeBounds.x > bounds.x + bounds.width + margin ||
            shapeBounds.y + shapeBounds.height < bounds.y - margin ||
            shapeBounds.y > bounds.y + bounds.height + margin
        );
    }

    getVisibleShapes(shapes) {
        return shapes ? shapes.filter(s => this.isShapeVisible(s)) : [];
    }

    setPadding(top, right, bottom, left) {
        this.padding = { top, right, bottom, left };
    }

    setZoomLimits(min, max) {
        this.minZoom = min;
        this.maxZoom = max;
        this.vexel.minZoom = min;
        this.vexel.maxZoom = max;
        this.targetZoom = clampNumber(this.targetZoom, min, max);
    }

    getZoomPercent() {
        return Math.round(this.vexel.viewport.zoom * 100);
    }

    getCenter() {
        const cx = this.vexel.width / 2;
        const cy = this.vexel.height / 2;
        return this.vexel.screenToWorld(cx, cy);
    }

    centerOn(x, y) {
        this._syncTargets();
        const zoom = this.targetZoom || this.vexel.viewport.zoom;
        this.targetX = this.vexel.width / 2 - x * zoom;
        this.targetY = this.vexel.height / 2 - y * zoom;

        if (this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.vexel.setViewport({ x: this.targetX, y: this.targetY });
        }
    }

    serialize() {
        return {
            x: this.vexel.viewport.x,
            y: this.vexel.viewport.y,
            zoom: this.vexel.viewport.zoom,
            rotation: this.vexel.viewport.rotation,
            homeX: this.homeX,
            homeY: this.homeY,
            homeZoom: this.homeZoom,
            homeRotation: this.homeRotation
        };
    }

    deserialize(data) {
        if (!data) return;
        this.homeX = data.homeX || 0;
        this.homeY = data.homeY || 0;
        this.homeZoom = data.homeZoom || 1;
        this.homeRotation = data.homeRotation || 0;

        this.vexel.setViewport({
            x: data.x || 0,
            y: data.y || 0,
            zoom: data.zoom || 1,
            rotation: data.rotation || 0
        });
    }

    _union(shapes) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of shapes) {
            const b = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    destroy() {
        this.stopAnimation();
    }
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function emblemSafeNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

if (typeof window !== 'undefined') {
    window.VexelViewport = VexelViewport;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelViewport;
}
