type TexelCoord = {
    u: number;
    v: number;
};

type PixelCoord = {
    x: number;
    y: number;
};

// zoom limits, in device pixels per texel
const MAX_ZOOM_SCALE = 100;

/**
 * Pan/zoom state and math for the texture preview.
 *
 * Three coordinate spaces are used:
 *
 * - Texture space: texels, origin at the texture's bottom-left corner, `u` pointing right and `v`
 *   pointing up. This matches the texture coordinates sampled by the preview shader.
 * - Device space: pixels of the canvas backing store (i.e. CSS pixels multiplied by the device
 *   pixel ratio), also with a bottom-left origin. `offsetX`, `offsetY`, `scale` and the viewport
 *   size are all expressed in this space.
 * - Display space: texels reported to the user, origin at the texture's top-left corner, which is
 *   the convention used by image editing tools.
 */
class TextureViewState {
    // device pixels per texel
    scale = 1;

    // position of the texture's bottom-left corner in device space
    offsetX = 0;
    offsetY = 0;

    // size of the preview in device pixels
    viewportW = 300;
    viewportH = 150;

    // number of device pixels per CSS pixel
    pixelRatio = 1;

    // size of the texture currently being previewed
    width: number | null = null;
    height: number | null = null;
    cubemap = false;

    // cubemap face currently being previewed
    face = 0;

    // texel under the cursor in top-left-origin display space, or null when the cursor is outside
    // the texture (or when no coordinate has been sampled for the current view)
    cursorTexel: PixelCoord | null = null;

    get hasTexture(): boolean {
        return this.width !== null && this.height !== null && this.width > 0 && this.height > 0;
    }

    get contentWidth(): number {
        return this.hasTexture ? this.width! * this.scale : 0;
    }

    get contentHeight(): number {
        return this.hasTexture ? this.height! * this.scale : 0;
    }

    /**
     * The scale at which the whole texture just fits inside the viewport. One viewport dimension
     * is exactly covered and the other has slack.
     *
     * @returns The fit scale in device pixels per texel.
     */
    fitScale(): number {
        if (!this.hasTexture) {
            return 1;
        }
        return Math.min(this.viewportW / this.width!, this.viewportH / this.height!);
    }

    /**
     * The scale at which one texel covers one CSS pixel, i.e. one screen pixel on a 1x display.
     *
     * @returns The 1:1 scale in device pixels per texel.
     */
    actualSizeScale(): number {
        return this.pixelRatio > 0 && Number.isFinite(this.pixelRatio) ? this.pixelRatio : 1;
    }

    /**
     * Set the texture being previewed. Any change resets the view to the fit-window state and
     * clears the cursor coordinate.
     *
     * @param width - Texture width in texels, or null when there is no texture.
     * @param height - Texture height in texels, or null when there is no texture.
     * @param cubemap - Whether the texture is a cubemap.
     */
    setTexture(width: number | null, height: number | null, cubemap = false): void {
        this.width = width;
        this.height = height;
        this.cubemap = cubemap;
        this.face = 0;
        this.resetView();
    }

    /**
     * Set the selected cubemap face. Any change resets the view to the fit-window state and clears
     * the cursor coordinate, since the offsets were chosen while looking at a different face.
     *
     * @param face - The cubemap face index (0-5).
     * @returns True if the face changed.
     */
    setFace(face: number): boolean {
        if (face === this.face) {
            return false;
        }
        this.face = face;
        this.resetView();
        return true;
    }

    /**
     * Reset the scale and offset to the fit-window state and clear the cursor coordinate.
     */
    resetView(): void {
        this.cursorTexel = null;
        if (!this.hasTexture) {
            this.scale = 1;
            this.offsetX = 0;
            this.offsetY = 0;
            return;
        }
        this.fit();
    }

    /**
     * Set the preview size. If the view was fitted, it is re-fitted to the new size; otherwise the
     * offset is clamped so the texture cannot drift out of bounds.
     *
     * @param width - Viewport width in device pixels.
     * @param height - Viewport height in device pixels.
     */
    setViewport(width: number, height: number): void {
        if (width === this.viewportW && height === this.viewportH) {
            return;
        }

        const wasFitted = this.isFitted();
        this.viewportW = width;
        this.viewportH = height;

        // a cursor position sampled against the old viewport is no longer meaningful
        this.cursorTexel = null;

        if (wasFitted) {
            this.fit();
        } else {
            this.clampPan();
        }
    }

    /**
     * Set the device pixel ratio used by the 1:1 zoom level.
     *
     * @param pixelRatio - Number of device pixels per CSS pixel.
     */
    setPixelRatio(pixelRatio: number): void {
        this.pixelRatio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
    }

    /**
     * Whether the view is currently showing the whole texture fitted inside the viewport.
     *
     * @returns True when the scale matches the fit scale and the texture is centered.
     */
    isFitted(): boolean {
        if (!this.hasTexture) {
            return true;
        }
        const epsilon = Math.max(1e-9, this.fitScale() * 1e-9);
        return (
            Math.abs(this.scale - this.fitScale()) <= epsilon &&
            Math.abs(this.offsetX - (this.viewportW - this.contentWidth) * 0.5) <= 1e-6 &&
            Math.abs(this.offsetY - (this.viewportH - this.contentHeight) * 0.5) <= 1e-6
        );
    }

    /**
     * Fit the whole texture inside the viewport and center it.
     */
    fit(): void {
        if (!this.hasTexture) {
            this.resetView();
            return;
        }
        this.scale = this.fitScale();
        this.center();
    }

    /**
     * Zoom to 1:1, i.e. one texel maps to one CSS pixel (and therefore to `pixelRatio` device
     * pixels). The texture is centered in the viewport.
     */
    actualSize(): void {
        if (!this.hasTexture) {
            return;
        }
        this.scale = this.actualSizeScale();
        this.center();
    }

    /**
     * Zoom to the given scale, keeping the texel under the cursor fixed.
     *
     * The requested scale is clamped to the allowed zoom range, so zooming out always stops with the
     * whole texture visible. The cursor's texture position is then re-anchored at the new scale,
     * which preserves it exactly whenever the cursor is over the texture. The offset is only
     * clamped on axes where the texture is larger than the viewport (and there the anchoring
     * already keeps it covering the viewport), so an axis where the texture is smaller keeps the
     * anchor exact rather than snapping to center.
     *
     * @param scale - The requested scale in device pixels per texel.
     * @param x - Cursor x in device space.
     * @param y - Cursor y in device space.
     */
    zoomAt(scale: number, x: number, y: number): void {
        if (!this.hasTexture) {
            return;
        }

        const u = (x - this.offsetX) / this.scale;
        const v = (y - this.offsetY) / this.scale;

        this.scale = this.clampScale(scale);
        this.offsetX = x - u * this.scale;
        this.offsetY = y - v * this.scale;
        this.clampCover();
    }

    /**
     * Multiply the current scale by the given factor, keeping the texel under the cursor fixed.
     *
     * @param factor - Zoom factor (greater than 1 zooms in).
     * @param x - Cursor x in device space.
     * @param y - Cursor y in device space.
     */
    zoomBy(factor: number, x: number, y: number): void {
        if (!Number.isFinite(factor) || factor <= 0) {
            return;
        }
        this.zoomAt(this.scale * factor, x, y);
    }

    /**
     * Set the offset directly, clamped to the texture bounds.
     *
     * @param offsetX - Texture bottom-left x in device space.
     * @param offsetY - Texture bottom-left y in device space.
     */
    setOffset(offsetX: number, offsetY: number): void {
        this.offsetX = offsetX;
        this.offsetY = offsetY;
        this.clampPan();
    }

    /**
     * Translate the texture by the given amount, clamped to the texture bounds.
     *
     * @param dx - Horizontal delta in device pixels.
     * @param dy - Vertical delta in device pixels.
     */
    panBy(dx: number, dy: number): void {
        this.offsetX += dx;
        this.offsetY += dy;
        this.clampPan();
    }

    /**
     * Clamp the scale to the allowed zoom range.
     *
     * Zooming out stops at the fit scale, so the viewport is never left blank. The exception is a
     * view that is already below the fit scale, which happens when 1:1 is pressed on a large
     * texture: there the current scale is the floor, so zooming out does nothing and zooming back in
     * is smooth instead of jumping to the fit scale. The maximum is 100 device pixels per texel, or
     * the 1:1 scale on very high density displays, where that is larger.
     *
     * @param scale - The requested scale.
     * @returns The clamped scale.
     */
    clampScale(scale: number): number {
        if (!Number.isFinite(scale)) {
            return this.scale;
        }
        const minScale = Math.min(this.fitScale(), this.scale);
        const maxScale = Math.max(MAX_ZOOM_SCALE, this.actualSizeScale());
        return Math.max(minScale, Math.min(maxScale, scale));
    }

    /**
     * Clamp the offset: a texture smaller than the viewport on an axis is centered on that axis,
     * while a texture larger than the viewport cannot be moved past its edges.
     */
    clampPan(): void {
        if (!this.hasTexture) {
            this.center();
            return;
        }
        this.offsetX = this.clampAxis(this.offsetX, this.contentWidth, this.viewportW);
        this.offsetY = this.clampAxis(this.offsetY, this.contentHeight, this.viewportH);
    }

    /**
     * Clamp the offset so a texture larger than the viewport keeps covering it. An axis where the
     * texture is smaller than the viewport has no bounds, so the offset is left untouched. Used
     * after zooming, where the anchor must be honored on axes without bounds.
     */
    clampCover(): void {
        if (!this.hasTexture) {
            return;
        }
        if (this.contentWidth >= this.viewportW) {
            this.offsetX = Math.max(this.viewportW - this.contentWidth, Math.min(0, this.offsetX));
        }
        if (this.contentHeight >= this.viewportH) {
            this.offsetY = Math.max(this.viewportH - this.contentHeight, Math.min(0, this.offsetY));
        }
    }

    /**
     * Center the texture in the viewport without changing the scale.
     */
    center(): void {
        if (!this.hasTexture) {
            this.offsetX = 0;
            this.offsetY = 0;
            return;
        }
        this.offsetX = (this.viewportW - this.contentWidth) * 0.5;
        this.offsetY = (this.viewportH - this.contentHeight) * 0.5;
    }

    /**
     * Convert a device-space position to texture-space coordinates.
     *
     * @param x - Device x.
     * @param y - Device y (bottom-left origin).
     * @returns Texture coordinates in texels.
     */
    pixelToTexel(x: number, y: number): TexelCoord {
        return {
            u: (x - this.offsetX) / this.scale,
            v: (y - this.offsetY) / this.scale
        };
    }

    /**
     * Convert texture-space coordinates to a device-space position.
     *
     * @param u - Texture u in texels.
     * @param v - Texture v in texels (bottom-left origin).
     * @returns Device-space position.
     */
    texelToPixel(u: number, v: number): PixelCoord {
        return {
            x: u * this.scale + this.offsetX,
            y: v * this.scale + this.offsetY
        };
    }

    /**
     * Get the texel under a device-space position, in top-left-origin display space.
     *
     * For a cubemap the coordinate is relative to the currently selected face.
     *
     * @param x - Device x.
     * @param y - Device y (bottom-left origin).
     * @param mipmap - Mipmap level currently being displayed.
     * @returns The texel coordinate, or null when the position is outside the texture.
     */
    texelAt(x: number, y: number, mipmap = 0): PixelCoord | null {
        if (!this.hasTexture) {
            return null;
        }

        const { u, v } = this.pixelToTexel(x, y);
        if (!(u >= 0 && u < this.width! && v >= 0 && v < this.height!)) {
            return null;
        }

        // report the coordinate in the resolution of the mip level being displayed, which is what
        // the user is actually looking at
        const mip = Math.pow(2, Math.max(0, Math.floor(mipmap)));
        const mipWidth = Math.max(1, Math.floor(this.width! / mip));
        const mipHeight = Math.max(1, Math.floor(this.height! / mip));

        return {
            x: Math.min(mipWidth - 1, Math.floor(u / mip)),
            // texture space is bottom-up; display space is top-down
            y: mipHeight - 1 - Math.min(mipHeight - 1, Math.floor(v / mip))
        };
    }

    /**
     * Sample and store the texel under a device-space position. Storing null means the cursor is
     * outside the texture and the coordinate display shows '-'.
     *
     * @param x - Device x.
     * @param y - Device y (bottom-left origin).
     * @param mipmap - Mipmap level currently being displayed.
     * @returns The sampled texel, or null.
     */
    updateCursor(x: number, y: number, mipmap = 0): PixelCoord | null {
        this.cursorTexel = this.texelAt(x, y, mipmap);
        return this.cursorTexel;
    }

    /**
     * Clear the stored cursor coordinate.
     */
    clearCursor(): void {
        this.cursorTexel = null;
    }

    /**
     * Format a cursor coordinate for display.
     *
     * @param texel - The coordinate, or null when the cursor is outside the texture.
     * @returns The coordinate as `x,y` (origin top-left) or '-'.
     */
    static formatCursor(texel: PixelCoord | null): string {
        return texel ? `${texel.x},${texel.y}` : '-';
    }

    private clampAxis(offset: number, contentSize: number, viewportSize: number): number {
        if (contentSize <= viewportSize) {
            return (viewportSize - contentSize) * 0.5;
        }
        return Math.max(viewportSize - contentSize, Math.min(0, offset));
    }
}

export { TextureViewState };
export type { PixelCoord, TexelCoord };
