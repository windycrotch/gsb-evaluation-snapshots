// src/core/shapes.js

/**
 * Shared transform helpers for the built-in shape classes.
 *
 * Every shape draws in this order: translate(origin) -> rotate(rotation)
 * -> scale(scaleX, scaleY). The helpers here invert exactly that, so hit
 * testing and bounding boxes always match what is on screen.
 */
const VexelShapeMath = {
    toLocal(shape, worldX, worldY) {
        const origin = shape._transformOrigin();
        const dx = worldX - origin.x;
        const dy = worldY - origin.y;
        const angle = -((shape.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        return {
            x: (dx * cos - dy * sin) / (shape.scaleX || 1) + origin.x,
            y: (dx * sin + dy * cos) / (shape.scaleY || 1) + origin.y
        };
    },

    rotatedCorners(bounds, rotation, originX, originY) {
        if (!rotation) return [
            { x: bounds.x, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
            { x: bounds.x, y: bounds.y + bounds.height }
        ];

        const cx = Number.isFinite(originX) ? originX : bounds.x + bounds.width / 2;
        const cy = Number.isFinite(originY) ? originY : bounds.y + bounds.height / 2;
        const angle = (rotation * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        return [
            { x: bounds.x, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
            { x: bounds.x, y: bounds.y + bounds.height }
        ].map(corner => {
            const dx = corner.x - cx;
            const dy = corner.y - cy;
            return {
                x: cx + dx * cos - dy * sin,
                y: cy + dx * sin + dy * cos
            };
        });
    },

    boundsOfPoints(points) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    unionRects(rects) {
        return this.boundsOfPoints(
            rects.flatMap(r => ([
                { x: r.x, y: r.y },
                { x: r.x + r.width, y: r.y + r.height }
            ]))
        );
    },

    pointInRect(x, y, rect, tolerance = 0) {
        return (
            x >= rect.x - tolerance &&
            x <= rect.x + rect.width + tolerance &&
            y >= rect.y - tolerance &&
            y <= rect.y + rect.height + tolerance
        );
    },

    pointSegmentDistance(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    },

    pointInPolygon(x, y, points) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = points[i].x, yi = points[i].y;
            const xj = points[j].x, yj = points[j].y;
            const crosses = (yi > y) !== (yj > y) &&
                x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
            if (crosses) inside = !inside;
        }
        return inside;
    },

    /** Scale a shape's render bounds by an extra factor about a pivot. */
    expandBounds(bounds, amount) {
        return {
            x: bounds.x - amount,
            y: bounds.y - amount,
            width: bounds.width + amount * 2,
            height: bounds.height + amount * 2
        };
    }
};

class VexelRectangle {
    constructor(x, y, width, height, options = {}) {
        this.type = 'rectangle';
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.cornerRadius = options.cornerRadius || 0;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.id = options.id || `rect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
    }

    _localBounds() {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        const x = -this.width / 2;
        const y = -this.height / 2;
        ctx.beginPath();
        if (this.cornerRadius > 0 && typeof ctx.roundRect === 'function') {
            ctx.roundRect(x, y, this.width, this.height, this.cornerRadius);
        } else {
            ctx.rect(x, y, this.width, this.height);
        }
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.width * (this.scaleX || 1),
            height: this.height * (this.scaleY || 1)
        };
    }

    getRenderBounds() {
        const bounds = this.getBounds();
        if (!this.rotation) return bounds;
        const origin = this._transformOrigin();
        return VexelShapeMath.boundsOfPoints(
            VexelShapeMath.rotatedCorners(bounds, this.rotation, origin.x, origin.y)
        );
    }

    containsPoint(px, py, tolerance = 0) {
        const local = VexelShapeMath.toLocal(this, px, py);
        return VexelShapeMath.pointInRect(local.x, local.y, this._localBounds(), tolerance);
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            width: this.width, height: this.height,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, cornerRadius: this.cornerRadius,
            opacity: this.opacity, visible: this.visible,
            rotation: this.rotation, scaleX: this.scaleX, scaleY: this.scaleY,
            locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelRectangle(data.x, data.y, data.width, data.height, data);
    }

    toSVG() {
        return `<rect x="${this.x}" y="${this.y}" width="${this.width}" height="${this.height}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" rx="${this.cornerRadius}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x + this.width / 2} ${this.y + this.height / 2})"/>`;
    }
}

class VexelEllipse {
    constructor(x, y, radiusX, radiusY, options = {}) {
        this.type = 'ellipse';
        this.x = x;
        this.y = y;
        this.radiusX = radiusX;
        this.radiusY = radiusY;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.id = options.id || `ellipse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: this.x, y: this.y };
    }

    _localBounds() {
        return {
            x: this.x - this.radiusX,
            y: this.y - this.radiusY,
            width: this.radiusX * 2,
            height: this.radiusY * 2
        };
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        ctx.beginPath();
        ctx.ellipse(0, 0, this.radiusX, this.radiusY, 0, 0, Math.PI * 2);
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x - this.radiusX * (this.scaleX || 1),
            y: this.y - this.radiusY * (this.scaleY || 1),
            width: this.radiusX * 2 * (this.scaleX || 1),
            height: this.radiusY * 2 * (this.scaleY || 1)
        };
    }

    getRenderBounds() {
        const rx = this.radiusX * (this.scaleX || 1);
        const ry = this.radiusY * (this.scaleY || 1);
        if (!this.rotation) {
            return { x: this.x - rx, y: this.y - ry, width: rx * 2, height: ry * 2 };
        }
        const angle = (this.rotation * Math.PI) / 180;
        const halfWidth = Math.hypot(rx * Math.cos(angle), ry * Math.sin(angle));
        const halfHeight = Math.hypot(rx * Math.sin(angle), ry * Math.cos(angle));
        return {
            x: this.x - halfWidth,
            y: this.y - halfHeight,
            width: halfWidth * 2,
            height: halfHeight * 2
        };
    }

    containsPoint(px, py, tolerance = 0) {
        const local = VexelShapeMath.toLocal(this, px, py);
        const nx = (local.x - this.x) / Math.max(this.radiusX, 1e-6);
        const ny = (local.y - this.y) / Math.max(this.radiusY, 1e-6);
        const padding = tolerance / Math.max(Math.min(this.radiusX, this.radiusY), 1e-6);
        return nx * nx + ny * ny <= 1 + Math.max(padding, 0);
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            radiusX: this.radiusX, radiusY: this.radiusY,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            scaleX: this.scaleX, scaleY: this.scaleY,
            locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelEllipse(data.x, data.y, data.radiusX, data.radiusY, data);
    }

    toSVG() {
        return `<ellipse cx="${this.x}" cy="${this.y}" rx="${this.radiusX}" ry="${this.radiusY}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x} ${this.y})"/>`;
    }
}

class VexelPolygon {
    constructor(x, y, sides, radius, options = {}) {
        this.type = 'polygon';
        this.x = x;
        this.y = y;
        this.sides = sides;
        this.radius = radius;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.id = options.id || `polygon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: this.x, y: this.y };
    }

    _localBounds() {
        return {
            x: this.x - this.radius,
            y: this.y - this.radius,
            width: this.radius * 2,
            height: this.radius * 2
        };
    }

    /** Polygon vertices in unscaled local space, centred on the origin. */
    _rawPoints() {
        const points = [];
        for (let i = 0; i < this.sides; i++) {
            const angle = (i * 2 * Math.PI) / this.sides - Math.PI / 2;
            points.push({
                x: Math.cos(angle) * this.radius,
                y: Math.sin(angle) * this.radius
            });
        }
        return points;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        const points = this._rawPoints();
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            if (i === 0) ctx.moveTo(points[i].x, points[i].y);
            else ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        const sx = this.scaleX || 1;
        const sy = this.scaleY || 1;
        return {
            x: this.x - this.radius * sx,
            y: this.y - this.radius * sy,
            width: this.radius * 2 * sx,
            height: this.radius * 2 * sy
        };
    }

    getRenderBounds() {
        const bounds = this.getBounds();
        if (!this.rotation) return bounds;
        return VexelShapeMath.boundsOfPoints(
            VexelShapeMath.rotatedCorners(bounds, this.rotation, this.x, this.y)
        );
    }

    containsPoint(px, py, tolerance = 0) {
        const local = VexelShapeMath.toLocal(this, px, py);
        const dx = local.x - this.x;
        const dy = local.y - this.y;
        const limit = this.radius + tolerance;
        if (dx * dx + dy * dy > limit * limit) return false;

        const points = this._rawPoints();
        if (VexelShapeMath.pointInPolygon(dx, dy, points)) return true;

        if (tolerance > 0) {
            for (let i = 0; i < points.length; i++) {
                const a = points[i];
                const b = points[(i + 1) % points.length];
                if (VexelShapeMath.pointSegmentDistance(dx, dy, a.x, a.y, b.x, b.y) <= tolerance) {
                    return true;
                }
            }
        }
        return false;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            sides: this.sides, radius: this.radius,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            scaleX: this.scaleX, scaleY: this.scaleY,
            locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelPolygon(data.x, data.y, data.sides, data.radius, data);
    }

    toSVG() {
        let points = '';
        for (let i = 0; i < this.sides; i++) {
            const angle = (i * 2 * Math.PI) / this.sides - Math.PI / 2;
            points += `${this.x + Math.cos(angle) * this.radius * (this.scaleX || 1)},${this.y + Math.sin(angle) * this.radius * (this.scaleY || 1)} `;
        }
        return `<polygon points="${points.trim()}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x} ${this.y})"/>`;
    }
}

class VexelLine {
    constructor(x1, y1, x2, y2, options = {}) {
        this.type = 'line';
        this.x1 = x1;
        this.y1 = y1;
        this.x2 = x2;
        this.y2 = y2;
        this.stroke = options.stroke || options.strokeColor || '#000000';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.lineCap = options.lineCap || 'butt';
        this.lineDash = options.lineDash || options.strokeDash || [];
        this.rotation = 0;
        this.scaleX = 1;
        this.scaleY = 1;
        this.locked = options.locked || false;
        this.id = options.id || `line_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: (this.x1 + this.x2) / 2, y: (this.y1 + this.y2) / 2 };
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth = this.strokeWidth;
        ctx.lineCap = this.lineCap;
        ctx.setLineDash(this.lineDash);
        ctx.beginPath();
        ctx.moveTo(this.x1, this.y1);
        ctx.lineTo(this.x2, this.y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    getBounds() {
        return {
            x: Math.min(this.x1, this.x2),
            y: Math.min(this.y1, this.y2),
            width: Math.abs(this.x2 - this.x1),
            height: Math.abs(this.y2 - this.y1)
        };
    }

    getRenderBounds() {
        return VexelShapeMath.expandBounds(this.getBounds(), (this.strokeWidth || 1) / 2);
    }

    containsPoint(px, py, tolerance = 0) {
        const reach = (this.strokeWidth || 1) / 2 + tolerance + 2;
        return VexelShapeMath.pointSegmentDistance(px, py, this.x1, this.y1, this.x2, this.y2) <= reach;
    }

    translate(dx, dy) {
        this.x1 += dx;
        this.y1 += dy;
        this.x2 += dx;
        this.y2 += dy;
    }

    serialize() {
        return {
            type: this.type,
            x1: this.x1, y1: this.y1,
            x2: this.x2, y2: this.y2,
            stroke: this.stroke, strokeWidth: this.strokeWidth,
            opacity: this.opacity, visible: this.visible,
            lineCap: this.lineCap, lineDash: this.lineDash,
            locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelLine(data.x1, data.y1, data.x2, data.y2, data);
    }

    toSVG() {
        return `<line x1="${this.x1}" y1="${this.y1}" x2="${this.x2}" y2="${this.y2}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}"/>`;
    }
}

class VexelPath {
    constructor(points, options = {}) {
        this.type = 'path';
        this.points = points || [];
        this.closed = options.closed || false;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || '#000000';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = 0;
        this.scaleX = 1;
        this.scaleY = 1;
        this.locked = options.locked || false;
        this.id = options.id || `path_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        const bounds = this.getBounds();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }

    draw(ctx) {
        if (!this.visible || this.points.length < 2) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);
        for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
        }
        if (this.closed) ctx.closePath();
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        if (this.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
        return VexelShapeMath.boundsOfPoints(this.points);
    }

    getRenderBounds() {
        return VexelShapeMath.expandBounds(this.getBounds(), (this.strokeWidth || 1) / 2);
    }

    containsPoint(px, py, tolerance = 0) {
        if (this.points.length === 0) return false;
        const reach = (this.strokeWidth || 1) / 2 + tolerance + 2;

        for (let i = 1; i < this.points.length; i++) {
            const a = this.points[i - 1];
            const b = this.points[i];
            if (VexelShapeMath.pointSegmentDistance(px, py, a.x, a.y, b.x, b.y) <= reach) {
                return true;
            }
        }

        if (this.closed && this.points.length > 2) {
            const first = this.points[0];
            const last = this.points[this.points.length - 1];
            if (VexelShapeMath.pointSegmentDistance(px, py, last.x, last.y, first.x, first.y) <= reach) {
                return true;
            }
        }

        if (this.fill !== 'transparent' && this.closed) {
            if (VexelShapeMath.pointInPolygon(px, py, this.points)) return true;
        }

        return false;
    }

    translate(dx, dy) {
        for (const point of this.points) {
            point.x += dx;
            point.y += dy;
        }
    }

    serialize() {
        return {
            type: this.type,
            points: this.points,
            closed: this.closed,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelPath(data.points, data);
    }

    toSVG() {
        if (this.points.length === 0) return '';
        let d = `M ${this.points[0].x} ${this.points[0].y}`;
        for (let i = 1; i < this.points.length; i++) {
            d += ` L ${this.points[i].x} ${this.points[i].y}`;
        }
        if (this.closed) d += ' Z';
        return `<path d="${d}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}"/>`;
    }
}

class VexelText {
    constructor(x, y, content, options = {}) {
        this.type = 'text';
        this.x = x;
        this.y = y;
        this.content = content;
        this.fontSize = options.fontSize || 16;
        this.fontFamily = options.fontFamily || 'sans-serif';
        this.fontWeight = options.fontWeight || 'normal';
        this.fontStyle = options.fontStyle || 'normal';
        this.fill = options.fill || '#000000';
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.align = options.align || 'left';
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.id = options.id || `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this._measuredWidth = 0;
    }

    _lines() {
        return String(this.content).split('\n');
    }

    _fontString() {
        return `${this.fontStyle} ${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
    }

    /** Measure with the real font when a context exists (called during draw). */
    _measure(ctx) {
        if (ctx && typeof ctx.measureText === 'function') {
            const previousFont = ctx.font;
            ctx.font = this._fontString();
            let width = 0;
            for (const line of this._lines()) {
                width = Math.max(width, ctx.measureText(line).width);
            }
            ctx.font = previousFont;
            if (width > 0) this._measuredWidth = width;
        }
        return this._measuredWidth;
    }

    _width() {
        if (this._measuredWidth > 0) return this._measuredWidth;
        const longest = this._lines().reduce((max, line) => Math.max(max, line.length), 0);
        return longest * this.fontSize * 0.6;
    }

    _transformOrigin() {
        return { x: this.x, y: this.y };
    }

    /** Local bounds in unscaled shape space (before scale/rotation). */
    _localBounds() {
        const lines = this._lines();
        const width = this._width();
        const height = lines.length * this.fontSize * 1.4;
        let x = this.x;
        if (this.align === 'center') x -= width / 2;
        else if (this.align === 'right') x -= width;
        return { x, y: this.y, width, height };
    }

    draw(ctx) {
        if (!this.visible) return;
        this._measure(ctx);
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        ctx.font = this._fontString();
        ctx.fillStyle = this.fill;
        ctx.textAlign = this.align;
        ctx.textBaseline = 'top';
        const lines = this._lines();
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 0, i * this.fontSize * 1.4);
        }
        ctx.restore();
    }

    getBounds() {
        const local = this._localBounds();
        return {
            x: local.x,
            y: local.y,
            width: local.width * (this.scaleX || 1),
            height: local.height * (this.scaleY || 1)
        };
    }

    getRenderBounds() {
        const bounds = this.getBounds();
        if (!this.rotation) return bounds;
        return VexelShapeMath.boundsOfPoints(
            VexelShapeMath.rotatedCorners(bounds, this.rotation, this.x, this.y)
        );
    }

    containsPoint(px, py, tolerance = 0) {
        const local = VexelShapeMath.toLocal(this, px, py);
        return VexelShapeMath.pointInRect(local.x, local.y, this._localBounds(), tolerance);
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            content: this.content,
            fontSize: this.fontSize, fontFamily: this.fontFamily,
            fontWeight: this.fontWeight, fontStyle: this.fontStyle,
            fill: this.fill, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            align: this.align, locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelText(data.x, data.y, data.content, data);
    }

    toSVG() {
        return `<text x="${this.x}" y="${this.y}" font-size="${this.fontSize}" font-family="${this.fontFamily}" font-weight="${this.fontWeight}" font-style="${this.fontStyle}" fill="${this.fill}" opacity="${this.opacity}" text-anchor="${this.align}" transform="rotate(${this.rotation} ${this.x} ${this.y})">${this.content}</text>`;
    }
}

class VexelImage {
    constructor(x, y, src, options = {}) {
        this.type = 'image';
        this.x = x;
        this.y = y;
        this.src = src;
        this.width = options.width || 100;
        this.height = options.height || 100;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.loaded = false;
        this.img = new Image();
        this.img.src = src;
        this.img.onload = () => { this.loaded = true; };
        this.id = options.id || `image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
    }

    _localBounds() {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }

    draw(ctx) {
        if (!this.visible || !this.loaded) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        ctx.drawImage(this.img, -this.width / 2, -this.height / 2, this.width, this.height);
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.width * (this.scaleX || 1),
            height: this.height * (this.scaleY || 1)
        };
    }

    getRenderBounds() {
        const bounds = this.getBounds();
        if (!this.rotation) return bounds;
        const origin = this._transformOrigin();
        return VexelShapeMath.boundsOfPoints(
            VexelShapeMath.rotatedCorners(bounds, this.rotation, origin.x, origin.y)
        );
    }

    containsPoint(px, py, tolerance = 0) {
        const local = VexelShapeMath.toLocal(this, px, py);
        return VexelShapeMath.pointInRect(local.x, local.y, this._localBounds(), tolerance);
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            src: this.src, width: this.width, height: this.height,
            opacity: this.opacity, visible: this.visible,
            rotation: this.rotation, locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelImage(data.x, data.y, data.src, data);
    }

    toSVG() {
        return `<image href="${this.src}" x="${this.x}" y="${this.y}" width="${this.width}" height="${this.height}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x + this.width / 2} ${this.y + this.height / 2})"/>`;
    }
}

class VexelGroup {
    constructor(shapes = [], options = {}) {
        this.type = 'group';
        this.shapes = shapes;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.visible = options.visible !== false;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.locked = options.locked || false;
        this.id = options.id || `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _transformOrigin() {
        return { x: this.x, y: this.y };
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        for (const shape of this.shapes) {
            shape.draw(ctx);
        }
        ctx.restore();
    }

    add(shape) {
        this.shapes.push(shape);
    }

    remove(shape) {
        const index = this.shapes.indexOf(shape);
        if (index > -1) this.shapes.splice(index, 1);
    }

    _childRects(getter) {
        return this.shapes.map(shape => {
            const b = typeof shape[getter] === 'function' ? shape[getter]() : shape.getBounds();
            return { x: b.x + this.x, y: b.y + this.y, width: b.width, height: b.height };
        });
    }

    getBounds() {
        if (this.shapes.length === 0) {
            return { x: this.x, y: this.y, width: 0, height: 0 };
        }
        return VexelShapeMath.unionRects(this._childRects('getBounds'));
    }

    getRenderBounds() {
        if (this.shapes.length === 0) {
            return { x: this.x, y: this.y, width: 0, height: 0 };
        }
        const union = VexelShapeMath.unionRects(this._childRects('getRenderBounds'));
        if (!this.rotation) return union;
        return VexelShapeMath.boundsOfPoints(
            VexelShapeMath.rotatedCorners(union, this.rotation, this.x, this.y)
        );
    }

    containsPoint(px, py, tolerance = 0) {
        const angle = -((this.rotation || 0) * Math.PI) / 180;
        const dx = px - this.x;
        const dy = py - this.y;
        const localX = dx * Math.cos(angle) - dy * Math.sin(angle) + this.x;
        const localY = dx * Math.sin(angle) + dy * Math.cos(angle) + this.y;

        for (const shape of this.shapes) {
            if (shape.containsPoint && shape.containsPoint(localX, localY, tolerance)) {
                return true;
            }
        }
        return false;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            shapes: this.shapes.map(s => s.serialize()),
            visible: this.visible, opacity: this.opacity,
            rotation: this.rotation, locked: this.locked, id: this.id
        };
    }

    static deserialize(data) {
        const shapes = data.shapes.map(s => {
            const ctors = {
                rectangle: VexelRectangle, ellipse: VexelEllipse, polygon: VexelPolygon,
                line: VexelLine, path: VexelPath, text: VexelText, image: VexelImage
            };
            const Ctor = ctors[s.type];
            return Ctor ? Ctor.deserialize(s) : null;
        }).filter(Boolean);
        return new VexelGroup(shapes, data);
    }

    toSVG() {
        let svg = `<g transform="translate(${this.x} ${this.y}) rotate(${this.rotation})" opacity="${this.opacity}">`;
        for (const shape of this.shapes) {
            svg += shape.toSVG();
        }
        svg += '</g>';
        return svg;
    }
}

if (typeof window !== 'undefined') {
    window.VexelRectangle = VexelRectangle;
    window.VexelEllipse = VexelEllipse;
    window.VexelPolygon = VexelPolygon;
    window.VexelLine = VexelLine;
    window.VexelPath = VexelPath;
    window.VexelText = VexelText;
    window.VexelImage = VexelImage;
    window.VexelGroup = VexelGroup;
    window.VexelShapeMath = VexelShapeMath;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VexelRectangle, VexelEllipse, VexelPolygon,
        VexelLine, VexelPath, VexelText, VexelImage, VexelGroup, VexelShapeMath
    };
}
