import { TextureViewState } from './texture-view-state';

// mouse wheel delta to zoom factor. An exponential factor gives constant zoom speed at every zoom
// level, and matches the feel of a mouse wheel notch halving or doubling the scale.
const WHEEL_ZOOM_SPEED = 0.002;

type CursorListener = (label: string) => void;

/**
 * DOM-free input handling and cursor readout for the texture preview.
 *
 * This translates pointer input (in device pixels) into pan/zoom operations on a
 * {@link TextureViewState} and reports the texel under the cursor as a display string. Keeping it
 * free of the DOM means the behaviour of the preview controls can be tested without a browser.
 */
class TextureViewControls {
    state: TextureViewState;

    // mip level currently displayed, which the reported texel coordinates follow
    mipmap = 0;

    // last known pointer position in device pixels relative to the preview
    pointerX = 0;
    pointerY = 0;
    hasPointer = false;

    // called after every change to the view state, so the owner can schedule a redraw
    onChange: () => void;

    private listeners: CursorListener[] = [];

    constructor(state: TextureViewState, onChange?: () => void) {
        this.state = state;
        this.onChange =
            onChange ??
            (() => {
                // no redraw requested by default
            });
    }

    /**
     * The text shown for the cursor texel: `x,y` with the origin at the texture's top-left corner,
     * or '-' when the cursor is outside the texture.
     */
    get cursorText(): string {
        return TextureViewState.formatCursor(this.state.cursorTexel);
    }

    /**
     * Register a listener for changes to the cursor readout.
     *
     * @param listener - Called with the new readout text.
     * @returns A function that unregisters the listener.
     */
    onCursor(listener: CursorListener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    /**
     * Handle a mouse wheel event. The texel under the cursor is kept under the cursor.
     *
     * @param deltaY - Wheel delta in CSS pixels (negative zooms in).
     * @param x - Cursor x in device pixels.
     * @param y - Cursor y in device pixels (top-left origin).
     */
    wheel(deltaY: number, x: number, y: number): void {
        this.state.zoomBy(Math.pow(2, -deltaY * WHEEL_ZOOM_SPEED), x, this.state.viewportH - y);
        this.sample(x, y);
        this.onChange();
    }

    /**
     * Sample the texel under a pointer position and update the cursor readout.
     *
     * @param x - Cursor x in device pixels.
     * @param y - Cursor y in device pixels (top-left origin).
     */
    sample(x: number, y: number): void {
        this.pointerX = x;
        this.pointerY = y;
        this.hasPointer = true;
        this.state.updateCursor(x, this.state.viewportH - y, this.mipmap);
        this.emitCursor();
    }

    /**
     * Re-sample the texel at the last known pointer position, e.g. after a zoom button was pressed.
     */
    refresh(): void {
        if (!this.hasPointer) {
            return;
        }
        this.state.updateCursor(this.pointerX, this.state.viewportH - this.pointerY, this.mipmap);
        this.emitCursor();
    }

    /**
     * Start a drag at the given pointer position.
     *
     * @param x - Cursor x in device pixels.
     * @param y - Cursor y in device pixels (top-left origin).
     */
    dragStart(x: number, y: number): void {
        this.pointerX = x;
        this.pointerY = y;
        this.hasPointer = true;
    }

    /**
     * Continue a drag to the given pointer position. The texture follows the pointer by exactly the
     * distance the pointer moved, clamped to the texture bounds.
     *
     * @param x - Cursor x in device pixels.
     * @param y - Cursor y in device pixels (top-left origin).
     */
    dragTo(x: number, y: number): void {
        // screen y grows downwards while device space grows upwards
        this.state.panBy(x - this.pointerX, -(y - this.pointerY));
        this.sample(x, y);
        this.onChange();
    }

    /**
     * Zoom to 1:1, keeping the readout in sync.
     */
    actualSize(): void {
        this.state.actualSize();
        this.refresh();
        this.onChange();
    }

    /**
     * Fit the whole texture, keeping the readout in sync.
     */
    fit(): void {
        this.state.fit();
        this.refresh();
        this.onChange();
    }

    /**
     * Clear the cursor readout.
     */
    clearCursor(): void {
        this.state.clearCursor();
        this.emitCursor();
        this.onChange();
    }

    /**
     * Forget the last pointer position, so that a later refresh does not resurrect a stale readout.
     */
    resetPointer(): void {
        this.hasPointer = false;
        this.clearCursor();
    }

    private emitCursor(): void {
        const text = this.cursorText;
        this.listeners.forEach((listener) => listener(text));
    }
}

export { TextureViewControls };
