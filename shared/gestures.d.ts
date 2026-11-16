/** screen-space travel (CSS px) that turns a press into a pan/orbit drag */
export const TAP_THRESHOLD: number;

export interface PointerPoint {
  clientX: number;
  clientY: number;
  /** DOM button index; 0 is the primary (left/touch) button */
  button?: number;
}

export interface TapRelease {
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
}

/**
 * Distinguishes a tap from a pan/orbit drag using only DOM press/release
 * coordinates, so the verdict is independent of rendered frame rate.
 */
export class TapGesture {
  constructor(threshold?: number);
  /** begin a press; non-primary buttons are ignored and return false */
  begin(point: PointerPoint, pointerId?: number): boolean;
  /** feed pointer moves; the drag flag latches once past the threshold */
  move(point: PointerPoint): void;
  /** release coordinates for a tap, or null for drags/cancels/non-primary */
  end(point: PointerPoint | null, pointerId?: number): TapRelease | null;
  /** abandon the current press (pointercancel / blur) */
  cancel(): void;
  readonly isDown: boolean;
  /** true once the current press has crossed the drag threshold */
  readonly isDragging: boolean;
}
