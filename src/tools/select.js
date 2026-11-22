// src/tools/select.js
//
// Selection tool. Hit testing, resizing and rotation all convert through the
// current viewport snapshot, and drawing is delegated to VexelOverlay so the
// frame, handles and marquee are always derived from the same snapshot as the
// shapes.

class VexelSelectTool {
    constructor(vexel) {
        this.vexel = vexel;
        this.active = false;
        this.dragging = false;
        this.resizing = false;
        this.rotating = false;
        this.marqueeActive = false;
        this.marqueeStart = null;
        this.marqueeEnd = null;
        this.dragStart = null;
        this.dragOffset = new Map();
        this.resizeHandle = null;
        this.resizeStartBounds = null;
        this.resizeStartPoint = null;
        this.rotateCenter = null;
        this.rotateStartAngle = 0;
        this.rotateStartRotation = 0;
        this.handleHitRadius = 9;
        this.hoveredHandle = null;
        this._bound = {};
    }

    activate() {
        if (this.active) return;
        this.active = true;

        this._bound.down = this._handleMouseDown.bind(this);
        this._bound.move = this._handleMouseMove.bind(this);
        this._bound.up = this._handleMouseUp.bind(this);
        this._bound.key = this._handleKeyDown.bind(this);

        this.vexel.container.addEventListener('mousedown', this._bound.down);
        window.addEventListener('mousemove', this._bound.move);
        window.addEventListener('mouseup', this._bound.up);
        window.addEventListener('keydown', this._bound.key);
    }

    deactivate() {
        if (!this.active) return;
        this.active = false;

        this.vexel.container.removeEventListener('mousedown', this._bound.down);
        window.removeEventListener('mousemove', this._bound.move);
        window.removeEventListener('mouseup', this._bound.up);
        window.removeEventListener('keydown', this._bound.key);

        this._bound = {};
        this.resetInteraction();
    }

    resetInteraction() {
        this.dragging = false;
        this.resizing = false;
        this.rotating = false;
        this.marqueeActive = false;
        this.marqueeStart = null;
        this.marqueeEnd = null;
        this.dragStart = null;
        this.dragOffset = new Map();
        this.resizeHandle = null;
        this.resizeStartBounds = null;
        this.resizeStartPoint = null;
        this.rotateCenter = null;
        this.hoveredHandle = null;
    }

    _snapshot() {
        return this.vexel.getViewportSnapshot();
    }

    _toWorld(e) {
        const rect = this.vexel.container.getBoundingClientRect();
        return this._snapshot().screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    }

    _selectionBounds() {
        if (typeof VexelOverlay !== 'undefined') {
            return VexelOverlay.getSelectionBounds(this.vexel.selectedShapes);
        }
        return null;
    }

    _handleAt(point) {
        if (this.vexel.selectedShapes.length !== 1) return null;
        const bounds = this._selectionBounds();
        if (!bounds) return null;

        // Compare in screen space so the hit radius is DPR/zoom independent.
        const snapshot = this._snapshot();
        const target = snapshot.worldToScreen(point.x, point.y);
        const radius = this.handleHitRadius;

        let best = null;
        let bestDistance = Infinity;

        for (const handle of VexelOverlay.getHandlePoints(bounds)) {
            const screen = snapshot.worldToScreen(handle.x, handle.y);
            const distance = Math.hypot(screen.x - target.x, screen.y - target.y);
            if (distance <= radius && distance < bestDistance) {
                best = handle.name;
                bestDistance = distance;
            }
        }

        return best;
    }

    _rotationHandleHit(point) {
        if (this.vexel.selectedShapes.length !== 1) return false;
        const bounds = this._selectionBounds();
        if (!bounds) return false;

        const snapshot = this._snapshot();
        const handle = VexelOverlay.getRotationHandlePoint(bounds, snapshot);
        const target = snapshot.worldToScreen(point.x, point.y);
        const screen = snapshot.worldToScreen(handle.x, handle.y);
        return Math.hypot(screen.x - target.x, screen.y - target.y) <= this.handleHitRadius + 2;
    }

    _handleMouseDown(e) {
        if (!this.active || e.button !== 0) return;

        const point = this._toWorld(e);

        const handle = this._handleAt(point);
        if (handle) {
            this._startResize(handle, point);
            e.preventDefault();
            return;
        }

        if (this._rotationHandleHit(point)) {
            this._startRotate(point);
            e.preventDefault();
            return;
        }

        const hit = this.vexel._hitTest(point.x, point.y);

        if (hit) {
            if (e.shiftKey) {
                if (this.vexel.selectedShapes.includes(hit)) {
                    this.vexel.deselect(hit);
                    return;
                }
                this.vexel.select(hit);
            } else if (!this.vexel.selectedShapes.includes(hit)) {
                this.vexel.deselectAll();
                this.vexel.select(hit);
            }
            this._startDrag(point);
        } else {
            if (!e.shiftKey) this.vexel.deselectAll();
            this.marqueeActive = true;
            this.marqueeStart = point;
            this.marqueeEnd = point;
            this.vexel._marquee = { active: true, start: point, end: point };
            this.vexel.requestRender();
        }
    }

    _handleMouseMove(e) {
        if (!this.active) return;

        const point = this._toWorld(e);

        if (this.dragging) {
            const dx = point.x - this.dragStart.x;
            const dy = point.y - this.dragStart.y;
            for (const shape of this.vexel.selectedShapes) {
                const offset = this.dragOffset.get(shape.id);
                if (!offset || shape.locked) continue;
                if (typeof shape.translate === 'function') {
                    const current = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
                    shape.translate(offset.x + dx - current.x, offset.y + dy - current.y);
                }
            }
            this.vexel.requestRender();
            return;
        }

        if (this.resizing) {
            this._updateResize(point);
            return;
        }

        if (this.rotating) {
            this._updateRotate(point);
            return;
        }

        if (this.marqueeActive) {
            this.marqueeEnd = point;
            this.vexel._marquee = { active: true, start: this.marqueeStart, end: point };
            this.vexel.requestRender();
            return;
        }

        this.hoveredHandle = this._handleAt(point);
    }

    _handleMouseUp() {
        if (!this.active) return;

        if (this.marqueeActive) {
            this._finishMarquee();
        }

        this.resetInteraction();
        this.vexel._marquee = { active: false, start: null, end: null };
        this.vexel.requestRender();
    }

    _handleKeyDown(e) {
        if (!this.active) return;

        const step = e.shiftKey ? 10 : 1;

        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                this.vexel.deleteSelected();
                break;
            case 'Escape':
                this.vexel.deselectAll();
                break;
            case 'ArrowLeft':
                this._nudge(-step, 0);
                break;
            case 'ArrowRight':
                this._nudge(step, 0);
                break;
            case 'ArrowUp':
                this._nudge(0, -step);
                break;
            case 'ArrowDown':
                this._nudge(0, step);
                break;
            default:
                break;
        }
    }

    _nudge(dx, dy) {
        for (const shape of this.vexel.selectedShapes) {
            if (shape.locked) continue;
            if (typeof shape.translate === 'function') shape.translate(dx, dy);
        }
        this.vexel.requestRender();
    }

    _startDrag(point) {
        this.dragging = true;
        this.dragStart = point;
        this.dragOffset = new Map();
        for (const shape of this.vexel.selectedShapes) {
            const bounds = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
            this.dragOffset.set(shape.id, { x: bounds.x, y: bounds.y });
        }
    }

    _startResize(handle, point) {
        const shape = this.vexel.selectedShapes[0];
        this.resizing = true;
        this.resizeHandle = handle;
        this.resizeStartBounds = this._selectionBounds();
        this.resizeStartPoint = point;
        this._resizeShape = shape;
    }

    _updateResize(point) {
        const shape = this._resizeShape;
        const bounds = this.resizeStartBounds;
        if (!shape || !bounds) return;

        const dx = point.x - this.resizeStartPoint.x;
        const dy = point.y - this.resizeStartPoint.y;

        let x = bounds.x;
        let y = bounds.y;
        let width = bounds.width;
        let height = bounds.height;

        switch (this.resizeHandle) {
            case 'nw':
                x = bounds.x + dx;
                y = bounds.y + dy;
                width = bounds.width - dx;
                height = bounds.height - dy;
                break;
            case 'ne':
                y = bounds.y + dy;
                width = bounds.width + dx;
                height = bounds.height - dy;
                break;
            case 'sw':
                x = bounds.x + dx;
                width = bounds.width - dx;
                height = bounds.height + dy;
                break;
            case 'se':
                width = bounds.width + dx;
                height = bounds.height + dy;
                break;
            case 'n':
                y = bounds.y + dy;
                height = bounds.height - dy;
                break;
            case 's':
                height = bounds.height + dy;
                break;
            case 'w':
                x = bounds.x + dx;
                width = bounds.width - dx;
                break;
            case 'e':
                width = bounds.width + dx;
                break;
            default:
                break;
        }

        width = Math.max(1, width);
        height = Math.max(1, height);

        if (typeof shape.resizeTo === 'function') {
            shape.resizeTo({ x, y, width, height });
        } else {
            if (Number.isFinite(shape.x)) shape.x = x;
            if (Number.isFinite(shape.y)) shape.y = y;
            if (Number.isFinite(shape.width)) shape.width = width;
            if (Number.isFinite(shape.height)) shape.height = height;
            if (Number.isFinite(shape.radiusX)) {
                shape.radiusX = width / 2;
                shape.radiusY = height / 2;
                shape.x = x + width / 2;
                shape.y = y + height / 2;
            }
        }

        this.vexel.requestRender();
    }

    _startRotate(point) {
        const bounds = this._selectionBounds();
        if (!bounds) return;

        this.rotating = true;
        this.rotateCenter = {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2
        };
        this.rotateStartAngle = Math.atan2(
            point.y - this.rotateCenter.y,
            point.x - this.rotateCenter.x
        );
        this.rotateStartRotation = this.vexel.selectedShapes[0].rotation || 0;
    }

    _updateRotate(point) {
        const shape = this.vexel.selectedShapes[0];
        if (!shape) return;

        const angle = Math.atan2(
            point.y - this.rotateCenter.y,
            point.x - this.rotateCenter.x
        );
        let rotation = this.rotateStartRotation + (angle - this.rotateStartAngle) * (180 / Math.PI);

        if (this.vexel.snapEnabled) {
            rotation = Math.round(rotation / 15) * 15;
        }

        shape.rotation = ((rotation % 360) + 360) % 360;
        this.vexel.requestRender();
    }

    _finishMarquee() {
        const start = this.marqueeStart;
        const end = this.marqueeEnd;
        if (!start || !end) return;

        const marquee = {
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y)
        };

        if (marquee.width < 0.5 && marquee.height < 0.5) return;

        const selected = [];
        for (const shape of this.vexel.shapes) {
            if (shape.visible === false || shape.locked) continue;
            const bounds = shape.getRenderBounds ? shape.getRenderBounds() : shape.getBounds();
            if (
                bounds.x + bounds.width >= marquee.x &&
                bounds.x <= marquee.x + marquee.width &&
                bounds.y + bounds.height >= marquee.y &&
                bounds.y <= marquee.y + marquee.height
            ) {
                selected.push(shape);
            }
        }

        this.vexel.deselectAll();
        for (const shape of selected) this.vexel.select(shape);
    }

    /** Draw into the overlay using the frame's snapshot. */
    draw(ctx, snapshot) {
        if (!ctx || !snapshot) return;
        if (this.marqueeActive && this.marqueeStart && this.marqueeEnd) {
            VexelOverlay.drawMarquee(ctx, snapshot, this.marqueeStart, this.marqueeEnd);
        }
    }

    destroy() {
        this.deactivate();
        this.vexel = null;
    }
}

if (typeof window !== 'undefined') {
    window.VexelSelectTool = VexelSelectTool;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelSelectTool;
}
