// Every coordinate below is in canvas-space logical pixels. The device artwork
// sits inside a PAD-wide margin that we use for the drop shadow and glow.
// Keep ART in sync with the ART constant in main.js.

export const PAD = 6;
export const DEVICE = { x: PAD, y: PAD, w: 184, h: 154 };
export const ART = { w: DEVICE.w + PAD * 2, h: DEVICE.h + PAD * 2 };

export const TOPBAR = { x: DEVICE.x, y: DEVICE.y, w: DEVICE.w, h: 13 };

export const SCREEN_FRAME = { x: 8, y: 19, w: 100, h: 66 };
export const SCREEN = { x: 10, y: 21, w: 96, h: 62 };

export const KNOB_R = 16;
export const KNOBS = [
  { id: 'scale', cx: 130, cy: 44, r: KNOB_R, label: 'SCALE' },
  { id: 'sound', cx: 166, cy: 44, r: KNOB_R, label: 'SOUND' },
];
export const KNOB_LABEL_Y = 63;
export const KNOB_VALUE_Y = 71;
// Second, finer row of position dots, for a knob that carries two values.
export const KNOB_SUB_Y = 74;
export const LEDS = { x: 113, y: 78, w: 70, h: 5, count: 10 };

export const INFO = { x: 8, y: 86, w: 180, h: 10 };

export const KEY = { w: 15, h: 15, gapX: 2, gapY: 2, cols: 10, rows: 3 };
export const KEYS_ORIGIN = { x: 14, y: 98 };

export const ICONS = {
  pin: { x: 170, y: 8, w: 8, h: 8 },
  close: { x: 181, y: 8, w: 8, h: 8 },
};

/** Rect of a key button. row 0 = top row (highest notes). */
export function keyRect(row, col) {
  return {
    x: KEYS_ORIGIN.x + col * (KEY.w + KEY.gapX),
    y: KEYS_ORIGIN.y + row * (KEY.h + KEY.gapY),
    w: KEY.w,
    h: KEY.h,
  };
}

export function hit(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function hitCircle(cx, cy, r, x, y) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
