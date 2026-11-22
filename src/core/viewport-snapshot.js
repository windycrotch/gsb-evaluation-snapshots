// src/core/viewport-snapshot.js
//
// A VexelViewportSnapshot is an immutable, frame-scoped copy of the viewport.
//
// Every piece of drawing for one frame — the main canvas scene, the overlay
// selection frame and handles, the grid and the rulers — must be derived from
// the *same* snapshot. Input handlers publish new viewport state through
// Vexel#setViewport (one atomic commit); they never mutate values halfway
// through a frame. This makes it impossible for a frame to draw shapes with an
// old zoom and the selection frame with a new zoom.

class VexelViewportSnapshot {
    constructor(x, y, zoom, rotation, width, height, pixelRatio, sequence) {
        this.x = Number.isFinite(x) ? x : 0;
        this.y = Number.isFinite(y) ? y : 0;
        this.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
        this.rotation = Number.isFinite(rotation) ? rotation : 0;
        this.width = Number.isFinite(width) ? width : 0;
        this.height = Number.isFinite(height) ? height : 0;
        this.pixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
        this.sequence = Number.isFinite(sequence) ? sequence : 0;
        this._freeze();
    }

    static capture(vexel) {
        const viewport = (vexel && vexel.viewport) || {};
        return new VexelViewportSnapshot(
            viewport.x,
            viewport.y,
            viewport.zoom,
            viewport.rotation,
            vexel ? vexel.width : 0,
            vexel ? vexel.height : 0,
            vexel ? vexel.pixelRatio : 1,
            vexel ? vexel._frameSeq : 0
        );
    }

    /** Identity snapshot, useful for exports and unit tests. */
    static identity(width = 0, height = 0, pixelRatio = 1) {
        return new VexelViewportSnapshot(0, 0, 1, 0, width, height, pixelRatio, 0);
    }

    _freeze() {
        // Prevent any consumer from writing back into a snapshot mid-frame.
        Object.freeze(this);
    }

    get rotationRadians() {
        return (this.rotation * Math.PI) / 180;
    }

    /** CSS/logical pixel size of the canvas. */
    get cssWidth() {
        return this.width;
    }

    get cssHeight() {
        return this.height;
    }

    /** Device pixel size of the backing store. */
    get deviceWidth() {
        return Math.max(1, Math.round(this.width * this.pixelRatio));
    }

    get deviceHeight() {
        return Math.max(1, Math.round(this.height * this.pixelRatio));
    }

    /** World -> canvas logical pixel (the coordinate space DOM events use). */
    worldToScreen(worldX, worldY) {
        const angle = this.rotationRadians;
        if (angle === 0) {
            return {
                x: worldX * this.zoom + this.x,
                y: worldY * this.zoom + this.y
            };
        }
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
            x: (worldX * cos - worldY * sin) * this.zoom + this.x,
            y: (worldX * sin + worldY * cos) * this.zoom + this.y
        };
    }

    /** Canvas logical pixel -> world. */
    screenToWorld(screenX, screenY) {
        const dx = (screenX - this.x) / this.zoom;
        const dy = (screenY - this.y) / this.zoom;
        const angle = this.rotationRadians;
        if (angle === 0) {
            return { x: dx, y: dy };
        }
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);
        return {
            x: dx * cos - dy * sin,
            y: dx * sin + dy * cos
        };
    }

    /** Convert a logical pixel length into world units. */
    toWorldDistance(pixels) {
        return pixels / this.zoom;
    }

    /** Convert a world length into logical pixels. */
    toScreenDistance(worldLength) {
        return worldLength * this.zoom;
    }

    /**
     * Reset to an absolute device-pixel transform, then apply pan/zoom/rotation.
     * Using setTransform (instead of scale) means repeated frames, resizes and
     * devicePixelRatio changes can never accumulate a stale transform.
     */
    applyDevice(ctx) {
        if (!ctx) return;
        ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    }

    /** Apply only the world transform (pan, zoom, rotation). */
    applyWorld(ctx) {
        if (!ctx) return;
        ctx.translate(this.x, this.y);
        ctx.scale(this.zoom, this.zoom);
        if (this.rotation) {
            ctx.rotate(this.rotationRadians);
        }
    }

    /** Full transform: device pixel ratio followed by the world transform. */
    applyTo(ctx) {
        this.applyDevice(ctx);
        this.applyWorld(ctx);
    }

    /** Clear the whole backing store, in device pixels, without leftovers. */
    clearSurface(ctx, canvas) {
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
            ctx.clearRect(0, 0, this.deviceWidth, this.deviceHeight);
        }
        this.applyDevice(ctx);
    }

    equals(other) {
        return !!other &&
            this.x === other.x &&
            this.y === other.y &&
            this.zoom === other.zoom &&
            this.rotation === other.rotation &&
            this.width === other.width &&
            this.height === other.height &&
            this.pixelRatio === other.pixelRatio;
    }

    toJSON() {
        return {
            x: this.x,
            y: this.y,
            zoom: this.zoom,
            rotation: this.rotation,
            width: this.width,
            height: this.height,
            pixelRatio: this.pixelRatio,
            sequence: this.sequence
        };
    }
}

if (typeof window !== 'undefined') {
    window.VexelViewportSnapshot = VexelViewportSnapshot;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelViewportSnapshot;
}
