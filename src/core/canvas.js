// src/core/canvas.js
//
// Canvas-level presentation state (grid, guides, rulers, snapping).
//
// Pan/zoom/rotation live ONLY on Vexel#viewport. This manager never keeps its
// own copy of them; everything derives from a viewport snapshot so the grid,
// rulers and guides can never drift from the shapes.

class VexelCanvas {
    constructor(vexel) {
        this.vexel = vexel;
        this.gridVisible = false;
        this.gridSize = 20;
        this.gridColor = 'rgba(128,128,128,0.15)';
        this.gridThickColor = 'rgba(128,128,128,0.3)';
        this.gridThickEvery = 5;
        this.snapEnabled = false;
        this.snapSize = 10;
        this.snapThreshold = 5;
        this.guidesVisible = false;
        this.guides = [];
        this.rulersVisible = false;
        this.rulerSize = 20;
        this.background = '#ffffff';
        this.overscroll = 500;
        this.bounceEnabled = true;
        this.bounceDamping = 0.3;
        this.inertiaEnabled = true;
        this.inertiaDamping = 0.95;
        this.velocityX = 0;
        this.velocityY = 0;
        this.animating = false;
        this.animationId = null;
    }

    get width() {
        return this.vexel.width;
    }

    get height() {
        return this.vexel.height;
    }

    get zoom() {
        return this.vexel.viewport.zoom;
    }

    get panX() {
        return this.vexel.viewport.x;
    }

    get panY() {
        return this.vexel.viewport.y;
    }

    get rotation() {
        return this.vexel.viewport.rotation;
    }

    resize(width, height) {
        return this.vexel.resize(width, height);
    }

    setZoom(zoom, cx, cy) {
        this.vexel.setZoom(zoom, cx, cy);
    }

    zoomIn(factor = 1.2, cx, cy) {
        this.vexel.zoomIn(factor, cx, cy);
    }

    zoomOut(factor = 0.8, cx, cy) {
        this.vexel.zoomIn(factor, cx, cy);
    }

    zoomToFit(shapes, padding = 50) {
        this.vexel.zoomToFit(padding, shapes);
    }

    zoomToSelection() {
        this.vexel.zoomToSelection();
    }

    resetView() {
        this.vexel.resetView();
    }

    pan(dx, dy) {
        this.vexel.panBy(dx, dy);
    }

    startInertia(vx, vy) {
        if (!this.inertiaEnabled) return;
        this.velocityX = vx;
        this.velocityY = vy;
        if (!this.animating) {
            this._animateInertia();
        }
    }

    _animateInertia() {
        this.animating = true;

        const step = () => {
            this.animationId = null;
            if (!this.animating || (this.vexel && this.vexel.destroyed)) {
                this.animating = false;
                return;
            }

            this.velocityX *= this.inertiaDamping;
            this.velocityY *= this.inertiaDamping;

            if (Math.abs(this.velocityX) < 0.01 && Math.abs(this.velocityY) < 0.01) {
                this.animating = false;
                this.velocityX = 0;
                this.velocityY = 0;
                return;
            }

            this.pan(this.velocityX, this.velocityY);
            this.animationId = requestAnimationFrame(step);
        };

        this.animationId = requestAnimationFrame(step);
    }

    stopInertia() {
        this.animating = false;
        this.velocityX = 0;
        this.velocityY = 0;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    screenToCanvas(screenX, screenY) {
        return this.vexel.screenToWorld(screenX, screenY);
    }

    canvasToScreen(canvasX, canvasY) {
        return this.vexel.worldToScreen(canvasX, canvasY);
    }

    setGrid(visible, size, color, thickColor, thickEvery) {
        this.gridVisible = visible;
        if (size !== undefined) this.gridSize = size;
        if (color !== undefined) this.gridColor = color;
        if (thickColor !== undefined) this.gridThickColor = thickColor;
        if (thickEvery !== undefined) this.gridThickEvery = thickEvery;
        this.vexel.gridEnabled = visible;
        if (size !== undefined) this.vexel.snapSize = size;
        this.vexel.requestRender();
    }

    setSnap(enabled, size, threshold) {
        this.snapEnabled = enabled;
        if (size !== undefined) this.snapSize = size;
        if (threshold !== undefined) this.snapThreshold = threshold;
        this.vexel.snapEnabled = enabled;
        if (size !== undefined) this.vexel.snapSize = size;
    }

    snapPoint(x, y) {
        if (!this.snapEnabled) return { x, y };

        const snappedX = Math.round(x / this.snapSize) * this.snapSize;
        const snappedY = Math.round(y / this.snapSize) * this.snapSize;

        const distX = Math.abs(snappedX - x);
        const distY = Math.abs(snappedY - y);

        return {
            x: distX <= this.snapThreshold ? snappedX : x,
            y: distY <= this.snapThreshold ? snappedY : y
        };
    }

    addGuide(orientation, position, color = '#FF5722') {
        this.guides.push({ orientation, position, color });
        this.guidesVisible = true;
        this.vexel.requestRender();
        return this.guides.length - 1;
    }

    removeGuide(index) {
        if (index >= 0 && index < this.guides.length) {
            this.guides.splice(index, 1);
            this.vexel.requestRender();
        }
    }

    clearGuides() {
        this.guides = [];
        this.vexel.requestRender();
    }

    /**
     * Rulers are drawn in screen space but labelled from the snapshot, so the
     * tick positions and the shapes always agree.
     */
    drawRulers(ctx, snapshot) {
        if (!this.rulersVisible || !ctx || !snapshot) return;

        const rulerSize = this.rulerSize;

        ctx.save();
        snapshot.applyDevice(ctx);

        ctx.fillStyle = '#f5f5f4';
        ctx.fillRect(0, 0, snapshot.width, rulerSize);
        ctx.fillRect(0, 0, rulerSize, snapshot.height);

        ctx.strokeStyle = '#d6d3d1';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, snapshot.width - 1, rulerSize);
        ctx.strokeRect(0.5, 0.5, rulerSize, snapshot.height - 1);

        ctx.fillStyle = '#78716c';
        ctx.font = '9px -apple-system, sans-serif';

        let step = this.gridSize * snapshot.zoom;
        if (!(step > 0)) step = 20;
        while (step < 40) step *= 2;

        const startX = snapshot.x % step;
        const startY = snapshot.y % step;

        for (let x = startX; x < snapshot.width; x += step) {
            if (x < rulerSize) continue;
            const world = snapshot.screenToWorld(x, 0).x;
            ctx.fillText(Math.round(world), x + 2, 12);
        }

        for (let y = startY; y < snapshot.height; y += step) {
            if (y < rulerSize) continue;
            const world = snapshot.screenToWorld(0, y).y;
            ctx.save();
            ctx.translate(12, y + 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(Math.round(world), 0, 0);
            ctx.restore();
        }

        ctx.restore();
    }

    getVisibleBounds() {
        return this.vexel.getVisibleBounds();
    }

    getVisibleShapes(shapes) {
        const bounds = this.getVisibleBounds();
        const padding = 100;

        return shapes.filter(shape => {
            const sb = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
            return (
                sb.x + sb.width >= bounds.x - padding &&
                sb.x <= bounds.x + bounds.width + padding &&
                sb.y + sb.height >= bounds.y - padding &&
                sb.y <= bounds.y + bounds.height + padding
            );
        });
    }

    destroy() {
        this.stopInertia();
        this.guides = [];
        this.gridVisible = false;
        this.rulersVisible = false;
        this.guidesVisible = false;
        this.vexel = null;
    }
}

if (typeof window !== 'undefined') {
    window.VexelCanvas = VexelCanvas;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelCanvas;
}
