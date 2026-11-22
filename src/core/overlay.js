// src/core/overlay.js
//
// Shared geometry for the selection overlay.
//
// The overlay is drawn *from a viewport snapshot*, exactly like the scene, so
// the dashed frame and the eight handles can never be derived from a different
// pan/zoom than the shape they surround. All overlay drawing happens inside the
// snapshot's world transform; sizes that should stay constant on screen (line
// width, handle size, dash pattern) are converted from pixels to world units
// with the same snapshot.

class VexelOverlay {
    static HANDLE_SIZE_PX = 7;
    static FRAME_LINE_PX = 1.5;
    static DASH_PX = 4;
    static ROTATION_HANDLE_DISTANCE_PX = 30;
    static ROTATION_HANDLE_RADIUS_PX = 6;

    /**
     * Bounds of a shape exactly as it is drawn, honouring rotation and scale.
     * Shapes that implement getRenderBounds() provide the accurate answer;
     * everything else falls back to getBounds().
     */
    static getShapeBounds(shape) {
        if (!shape) return { x: 0, y: 0, width: 0, height: 0 };
        if (typeof shape.getRenderBounds === 'function') {
            return shape.getRenderBounds();
        }
        if (typeof shape.getBounds === 'function') {
            return shape.getBounds();
        }
        return {
            x: shape.x || 0,
            y: shape.y || 0,
            width: shape.width || 0,
            height: shape.height || 0
        };
    }

    static unionBounds(boundsList) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (const b of boundsList) {
            if (!b) continue;
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }

        if (!Number.isFinite(minX)) {
            return { x: 0, y: 0, width: 0, height: 0 };
        }

        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    static getSelectionBounds(shapes) {
        if (!shapes || shapes.length === 0) return null;
        return this.unionBounds(shapes.map(shape => this.getShapeBounds(shape)));
    }

    /**
     * The eight resize handles of a bounds rectangle, in world coordinates.
     */
    static getHandlePoints(bounds) {
        const { x, y, width, height } = bounds;
        const midX = x + width / 2;
        const midY = y + height / 2;
        const right = x + width;
        const bottom = y + height;

        return [
            { name: 'nw', x, y },
            { name: 'n', x: midX, y },
            { name: 'ne', x: right, y },
            { name: 'e', x: right, y: midY },
            { name: 'se', x: right, y: bottom },
            { name: 's', x: midX, y: bottom },
            { name: 'sw', x, y: bottom },
            { name: 'w', x, y: midY }
        ];
    }

    static getRotationHandlePoint(bounds, snapshot) {
        const px = snapshot.toWorldDistance(this.ROTATION_HANDLE_DISTANCE_PX);
        return {
            x: bounds.x + bounds.width / 2,
            y: bounds.y - px
        };
    }

    /**
     * Draw the dashed selection frames and handles for the given shapes.
     * `ctx` must be a clean, untransformed context: this method applies and
     * restores the snapshot transform itself.
     */
    static drawSelection(ctx, snapshot, shapes, options = {}) {
        if (!ctx || !snapshot || !shapes || shapes.length === 0) return;

        const handleSize = snapshot.toWorldDistance(this.HANDLE_SIZE_PX);
        const lineWidth = snapshot.toWorldDistance(this.FRAME_LINE_PX);
        const dash = snapshot.toWorldDistance(this.DASH_PX);

        ctx.save();
        snapshot.applyWorld(ctx);

        for (const shape of shapes) {
            const bounds = this.getShapeBounds(shape);

            ctx.strokeStyle = options.stroke || '#4A90D9';
            ctx.lineWidth = lineWidth;
            ctx.setLineDash([dash, dash]);
            ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
            ctx.setLineDash([]);

            for (const handle of this.getHandlePoints(bounds)) {
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = options.stroke || '#4A90D9';
                ctx.lineWidth = lineWidth;
                ctx.beginPath();
                ctx.rect(
                    handle.x - handleSize / 2,
                    handle.y - handleSize / 2,
                    handleSize,
                    handleSize
                );
                ctx.fill();
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    static drawMarquee(ctx, snapshot, start, end) {
        if (!ctx || !snapshot || !start || !end) return;

        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);

        ctx.save();
        snapshot.applyWorld(ctx);
        ctx.fillStyle = 'rgba(74, 144, 217, 0.1)';
        ctx.fillRect(x, y, width, height);
        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = snapshot.toWorldDistance(1);
        ctx.setLineDash([snapshot.toWorldDistance(4), snapshot.toWorldDistance(4)]);
        ctx.strokeRect(x, y, width, height);
        ctx.setLineDash([]);
        ctx.restore();
    }

    static drawRotationHandle(ctx, snapshot, bounds) {
        if (!ctx || !snapshot || !bounds) return;

        const handle = this.getRotationHandlePoint(bounds, snapshot);
        const radius = snapshot.toWorldDistance(this.ROTATION_HANDLE_RADIUS_PX);
        const lineWidth = snapshot.toWorldDistance(this.FRAME_LINE_PX);

        ctx.save();
        snapshot.applyWorld(ctx);

        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = lineWidth;
        ctx.setLineDash([snapshot.toWorldDistance(2), snapshot.toWorldDistance(2)]);
        ctx.beginPath();
        ctx.moveTo(bounds.x + bounds.width / 2, bounds.y);
        ctx.lineTo(handle.x, handle.y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#4A90D9';
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, radius / 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    /**
     * Grid lines derived from the snapshot so they pan/zoom in lock-step with
     * the scene.
     */
    static drawGrid(ctx, snapshot, options = {}) {
        if (!ctx || !snapshot) return;

        const gridSize = (options.size || 10) * snapshot.zoom;
        if (!(gridSize > 0)) return;

        const offsetX = snapshot.x % gridSize;
        const offsetY = snapshot.y % gridSize;

        ctx.save();
        snapshot.applyDevice(ctx);
        ctx.strokeStyle = options.color || 'rgba(128,128,128,0.15)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();

        for (let x = offsetX; x < snapshot.width; x += gridSize) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, snapshot.height);
        }
        for (let y = offsetY; y < snapshot.height; y += gridSize) {
            ctx.moveTo(0, y);
            ctx.lineTo(snapshot.width, y);
        }

        ctx.stroke();
        ctx.restore();
    }

    /**
     * Draw user guides (rulers are a separate concern).
     */
    static drawGuides(ctx, snapshot, guides) {
        if (!ctx || !snapshot || !guides || guides.length === 0) return;

        ctx.save();
        snapshot.applyWorld(ctx);

        for (const guide of guides) {
            ctx.strokeStyle = guide.color || '#FF5722';
            ctx.lineWidth = snapshot.toWorldDistance(1) * 1.5;
            ctx.setLineDash([snapshot.toWorldDistance(4), snapshot.toWorldDistance(4)]);

            if (guide.orientation === 'horizontal') {
                ctx.beginPath();
                ctx.moveTo(0, guide.position);
                ctx.lineTo(snapshot.toWorldDistance(snapshot.width - snapshot.x), guide.position);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(guide.position, 0);
                ctx.lineTo(guide.position, snapshot.toWorldDistance(snapshot.height - snapshot.y));
                ctx.stroke();
            }

            ctx.setLineDash([]);
        }

        ctx.restore();
    }
}

if (typeof window !== 'undefined') {
    window.VexelOverlay = VexelOverlay;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelOverlay;
}
