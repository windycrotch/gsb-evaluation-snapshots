import { keyboardGeometry, type KeyId, type KeyRect } from '../keyboard/layout';
import type { KeyboardState } from '../keyboard/sim';

/**
 * The whole scene is drawn in iPhone screen points (390×844 pt), as in iOS.
 * Conversion to frame pixels is a single ctx.scale in renderFrame.
 */
export const SCREEN_W = 390;
export const SCREEN_H = 844;
export const KB_H = 291;
/** Bottom inset for the home indicator when the keyboard is hidden. */
export const HOME_INDICATOR = 34;

export const FIELD_X = 10;
export const FIELD_W = SCREEN_W - FIELD_X * 2;
export const FIELD_MIN_H = 36;
export const SEND_R = 14;

/** Keyboard top; slide 0 = open, 1 = slid away. */
export const kbTop = (slide = 0) => SCREEN_H - KB_H + slide * KB_H;

/** Bottom of the input field (it grows upwards). */
export const fieldBottom = (slide = 0) => Math.min(kbTop(slide), SCREEN_H - HOME_INDICATOR) - 6;

export const sendCenter = (slide = 0) => ({
  x: FIELD_X + FIELD_W - 4 - SEND_R,
  y: fieldBottom(slide) - FIELD_MIN_H / 2,
});

const geomCache = new Map<string, KeyRect[]>();

/** Key rectangles in screen coordinates. */
export function keyRects(kb: KeyboardState, slide = 0): KeyRect[] {
  const k = `${kb.lang}:${kb.page}`;
  let rects = geomCache.get(k);
  if (!rects) {
    rects = keyboardGeometry(kb.lang, kb.page, SCREEN_W, KB_H);
    geomCache.set(k, rects);
  }
  const dy = kbTop(slide);
  return rects.map((r) => ({ ...r, y: r.y + dy }));
}

export function keyCenter(kb: KeyboardState, key: KeyId | 'send'): { x: number; y: number } {
  if (key === 'send') return sendCenter();
  const r = keyRects(kb).find((r) => r.id === key);
  if (!r) return { x: SCREEN_W / 2, y: kbTop() + KB_H / 2 };
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
