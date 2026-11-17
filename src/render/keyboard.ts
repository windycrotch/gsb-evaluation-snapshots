import type { VideoStrings } from '../i18n';
import type { KeyId, KeyRect } from '../keyboard/layout';
import type { KeyboardState } from '../keyboard/sim';
import type { TypingState } from '../timeline';
import { KB_H, SCREEN_W, kbTop, keyRects } from './scene';
import type { Ctx2D } from './types';

const C = {
  bg: '#d1d4db',
  key: '#ffffff',
  special: '#abb1bb',
  pressed: '#abb1bb',
  pressedSpecial: '#ffffff',
  label: '#000000',
  shadow: '#898a8d',
};

/** How long (s) the highlight / key popup stays after a press. */
const FLASH = 0.12;

/** ⇧ and ⌫ are drawn as vectors: fonts often lack them, and they must look the same everywhere. */
const SPECIAL_LABEL: Partial<Record<KeyId, string>> = {
  'to-symbols': '123',
  'to-symbols2': '#+=',
  globe: '🌐',
  emoji: '🙂',
};

export function drawKeyboard(
  ctx: Ctx2D,
  s: TypingState,
  t: number,
  slide: number,
  strings: VideoStrings,
  font: string,
): void {
  const top = kbTop(slide);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, top, SCREEN_W, KB_H);

  const flash = s.lastPress && t - s.lastPress.t < FLASH ? s.lastPress : null;
  const rects = keyRects(s.kb, slide);
  let popup: KeyRect | null = null;

  for (const r of rects) {
    const isChar = r.id.startsWith('c:');
    const isSpecial = !isChar && r.id !== 'space' && r.id !== 'emoji';
    const pressed = flash?.key === r.id;
    if (pressed && isChar) popup = r;

    if (r.id !== 'emoji') {
      ctx.fillStyle = C.shadow;
      rr(ctx, r.x, r.y + 1, r.w, r.h, 5);
      ctx.fillStyle = pressed
        ? isSpecial ? C.pressedSpecial : C.pressed
        : isSpecial && !(r.id === 'shift' && s.kb.shift) ? C.special : C.key;
      rr(ctx, r.x, r.y, r.w, r.h, 5);
    }

    if (r.id === 'shift') {
      drawShift(ctx, r.x + r.w / 2, r.y + r.h / 2, s.kb.shift, s.kb.capsLock);
      continue;
    }
    if (r.id === 'backspace') {
      drawBackspace(ctx, r.x + r.w / 2, r.y + r.h / 2);
      continue;
    }

    ctx.fillStyle = C.label;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = keyLabel(r.id, s.kb, strings);
    const size = isChar ? 22 : r.id === 'emoji' ? 24 : label.length > 2 ? 15 : 20;
    ctx.font = `${size}px ${font}`;
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + (isChar ? -1 : 0));
  }

  if (popup && flash) drawPopup(ctx, popup, flash.inserted ?? '', font);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function keyLabel(id: KeyId, kb: KeyboardState, strings: VideoStrings): string {
  if (id.startsWith('c:')) {
    const c = id.slice(2);
    return kb.shift && kb.page === 'letters' ? c.toLocaleUpperCase() : c;
  }
  if (id === 'to-letters') return strings.lettersKey;
  if (id === 'space') return strings.spaceKey;
  if (id === 'return') return strings.returnKey;
  return SPECIAL_LABEL[id] ?? '';
}

/** Enlarged letter above the pressed key, like on iOS. */
function drawPopup(ctx: Ctx2D, r: KeyRect, ch: string, font: string): void {
  const w = r.w * 1.5;
  const x = r.x + r.w / 2 - w / 2;
  const h = r.h * 2.15;
  const y = r.y + r.h - h;
  ctx.fillStyle = C.shadow;
  rr(ctx, x, y + 1, w, h, 8);
  ctx.fillStyle = C.key;
  rr(ctx, x, y, w, h, 8);
  ctx.fillStyle = C.label;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `34px ${font}`;
  ctx.fillText(ch, x + w / 2, y + r.h * 0.6);
}

function drawShift(ctx: Ctx2D, x: number, y: number, on: boolean, locked: boolean): void {
  ctx.beginPath();
  ctx.moveTo(x, y - 9);
  ctx.lineTo(x + 9, y + 1);
  ctx.lineTo(x + 4, y + 1);
  ctx.lineTo(x + 4, y + 8);
  ctx.lineTo(x - 4, y + 8);
  ctx.lineTo(x - 4, y + 1);
  ctx.lineTo(x - 9, y + 1);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = C.label;
  ctx.fillStyle = C.label;
  if (on) ctx.fill();
  else ctx.stroke();
  if (locked) ctx.fillRect(x - 5, y + 11, 10, 2); // bar under the arrow = Caps Lock
}

function drawBackspace(ctx: Ctx2D, x: number, y: number): void {
  ctx.strokeStyle = C.label;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 12, y);
  ctx.lineTo(x - 5, y - 8);
  ctx.lineTo(x + 11, y - 8);
  ctx.lineTo(x + 11, y + 8);
  ctx.lineTo(x - 5, y + 8);
  ctx.closePath();
  ctx.moveTo(x - 1, y - 4);
  ctx.lineTo(x + 7, y + 4);
  ctx.moveTo(x + 7, y - 4);
  ctx.lineTo(x - 1, y + 4);
  ctx.stroke();
}

export function rr(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
