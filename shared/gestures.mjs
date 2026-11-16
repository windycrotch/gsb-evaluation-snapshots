// Tap-vs-drag gesture state machine.
//
// The scene shares the canvas with OrbitControls (left-drag pans, right-drag
// orbits), so a press is not a click until the pointer comes back up without
// having travelled past TAP_THRESHOLD px. Frame rate must not change the
// verdict: at low FPS the camera can move a long way between pointerdown and
// pointerup, but the press/release *screen coordinates* are captured straight
// from the DOM events, so the decision is stable even when frames drop.
//
// Plain ESM with no dependencies so it runs unchanged in the browser and in
// the Node verification suite. Types live in ./gestures.d.ts.

/** screen-space travel (CSS px) that turns a press into a pan/orbit drag */
export const TAP_THRESHOLD = 8;

/**
 * Tracks one press at a time. Only the primary (left / touch) button owns a
 * tap — right-button orbits and middle-button dollies must never select.
 */
export class TapGesture {
  constructor(threshold = TAP_THRESHOLD) {
    this.threshold = threshold;
    this._press = null;
  }

  /** begin a press; returns false for non-primary buttons, which are ignored */
  begin(point, pointerId = 0) {
    if (!point || point.button !== 0) {
      this._press = null;
      return false;
    }
    // A second pointer joining (pinch / two-finger orbit) must not hijack the
    // gesture; the first pointer owns it until it is released or cancelled.
    if (this._press && this._press.id !== pointerId) return false;
    this._press = {
      id: pointerId,
      startX: point.clientX,
      startY: point.clientY,
      x: point.clientX,
      y: point.clientY,
      dragged: false,
    };
    return true;
  }

  /** feed every move; the drag flag latches once and never unlatches */
  move(point) {
    const p = this._press;
    if (!p || !point) return;
    p.x = point.clientX;
    p.y = point.clientY;
    if (Math.hypot(p.x - p.startX, p.y - p.startY) > this.threshold) {
      p.dragged = true;
    }
  }

  /**
   * Finish the press.
   * @returns release coordinates for a genuine tap, or null when the press
   *          was a drag, used a non-primary button, got cancelled, or never
   *          existed. The caller raycasts the returned point against the
   *          *current* camera, so a scene that shifted at low FPS still picks
   *          the tower under the release cursor rather than the press cursor.
   */
  end(point, pointerId = 0) {
    const p = this._press;
    this._press = null;
    if (!p || p.id !== pointerId || p.dragged) return null;
    const x = point ? point.clientX : p.x;
    const y = point ? point.clientY : p.y;
    if (Math.hypot(x - p.startX, y - p.startY) > this.threshold) return null;
    return { clientX: x, clientY: y, startX: p.startX, startY: p.startY };
  }

  /** a pointercancel / window blur must not leave a gesture half-open */
  cancel() {
    this._press = null;
  }

  get isDown() {
    return this._press !== null;
  }

  /** true once the current press has crossed the drag threshold */
  get isDragging() {
    return this._press !== null && this._press.dragged;
  }
}
