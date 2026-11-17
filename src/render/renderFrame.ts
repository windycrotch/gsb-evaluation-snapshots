import { VIDEO_STRINGS } from '../i18n';
import { END_CARD, stateAt, type Timeline } from '../timeline';
import { drawExhale } from './breaks';
import { drawHands } from './hands';
import { drawKeyboard, rr } from './keyboard';
import { FIELD_MIN_H, FIELD_W, FIELD_X, SCREEN_H, SCREEN_W, SEND_R, fieldBottom, sendCenter } from './scene';
import type { Ctx2D } from './types';

/**
 * DOM-free renderer: draws only into the 2D context it is given.
 * The same code is meant to run server-side later (skia-canvas / @napi-rs/canvas).
 */
export type { Ctx2D } from './types';

export interface RenderOptions {
  width: number;
  height: number;
  watermark: string;
  fontFamily?: string;
}

export const DEFAULT_FONT = 'Inter, system-ui, -apple-system, Roboto, "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const C = {
  table: '#3a2f27',
  phone: '#111111',
  screen: '#ffffff',
  outBubble: '#0b84fe',
  outText: '#ffffff',
  inBubble: '#e9e9eb',
  text: '#000000',
  muted: '#8e8e93',
  field: '#ffffff',
  fieldBorder: '#c7c7cc',
  caret: '#0b84fe',
};

const MSG_FONT = 17;
const LINE_H = 22;
const MAX_FIELD_LINES = 6;
const BUBBLE_MAX_W = SCREEN_W * 0.75;
const BUBBLE_PAD_X = 12;
const BUBBLE_PAD_Y = 7;

export function renderFrame(ctx: Ctx2D, tl: Timeline, t: number, opts: RenderOptions): void {
  const { width: W, height: H } = opts;
  const font = opts.fontFamily ?? DEFAULT_FONT;
  const strings = VIDEO_STRINGS[tl.lang];
  const s = stateAt(tl, t);

  // Close-up: the screen spans almost the full frame width, phone bottom near the frame edge.
  const S = (W * 0.86) / SCREEN_W;
  const ox = (W - SCREEN_W * S) / 2;
  const oy = H * 0.955 - SCREEN_H * S;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.table;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(S, S);

  // Body and screen
  ctx.fillStyle = C.phone;
  rr(ctx, -13, -13, SCREEN_W + 26, SCREEN_H + 26, 58);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, SCREEN_W, SCREEN_H, 46);
  ctx.clip();
  ctx.fillStyle = C.screen;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // After sending, the keyboard slides down
  const slide = s.sentAt === null ? 0 : easeOut(clamp01((t - s.sentAt - 0.25) / 0.35));
  ctx.font = `${MSG_FONT}px ${font}`;

  // Input field (grows upwards, shows the last lines)
  const typing = s.sentAt === null ? s.graphemes : [];
  const fieldTextW = FIELD_W - 24 - SEND_R * 2;
  const allLines = typing.length ? wrap(ctx, typing, fieldTextW) : [];
  const lines = allLines.slice(-MAX_FIELD_LINES);
  const fieldH = Math.max(FIELD_MIN_H, lines.length * LINE_H + 14);
  const fBottom = fieldBottom(slide);
  const fTop = fBottom - fieldH;
  ctx.fillStyle = C.fieldBorder;
  rr(ctx, FIELD_X - 1, fTop - 1, FIELD_W + 2, fieldH + 2, 19);
  ctx.fillStyle = C.field;
  rr(ctx, FIELD_X, fTop, FIELD_W, fieldH, 18);

  ctx.textBaseline = 'middle';
  const textX = FIELD_X + 12;
  const lineY = (i: number) => fTop + 7 + LINE_H * i + LINE_H / 2;
  if (lines.length) {
    ctx.fillStyle = C.text;
    lines.forEach((l, i) => ctx.fillText(l, textX, lineY(i)));
  } else {
    ctx.fillStyle = C.muted;
    ctx.fillText(strings.placeholder, textX + 4, lineY(0));
  }

  // Caret: solid while typing, blinks during pauses
  const sinceKey = s.lastPress ? t - s.lastPress.t : Infinity;
  if (s.sentAt === null && (sinceKey < 0.5 || Math.floor(t * 1.8) % 2 === 0)) {
    const last = lines[lines.length - 1] ?? '';
    const cx = textX + (last ? ctx.measureText(last).width + 1 : 2);
    const cy = lineY(Math.max(0, lines.length - 1));
    ctx.fillStyle = C.caret;
    ctx.fillRect(cx, cy - 11, 2, 22);
  }

  // Send button
  if (typing.length) {
    const sc = sendCenter(slide);
    ctx.fillStyle = C.outBubble;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, SEND_R, 0, Math.PI * 2);
    ctx.fill();
    drawArrowUp(ctx, sc.x, sc.y);
  }

  // Chat: laid out bottom-up from the input field
  let y = fTop - 12;
  if (s.sentAt !== null) {
    ctx.font = `600 11px ${font}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'right';
    ctx.fillText(strings.delivered, SCREEN_W - 32, y - 6);
    ctx.textAlign = 'left';
    drawChecks(ctx, SCREEN_W - 27, y - 6);
    y -= 18;

    ctx.font = `${MSG_FONT}px ${font}`;
    const bl = wrap(ctx, s.graphemes, BUBBLE_MAX_W - BUBBLE_PAD_X * 2);
    const bw = Math.max(...bl.map((l) => ctx.measureText(l).width)) + BUBBLE_PAD_X * 2;
    const bh = bl.length * LINE_H + BUBBLE_PAD_Y * 2;
    const bx = SCREEN_W - 10 - bw;
    y -= bh;
    ctx.fillStyle = C.outBubble;
    rr(ctx, bx, y, bw, bh, 18);
    ctx.fillStyle = C.outText;
    bl.forEach((l, i) => ctx.fillText(l, bx + BUBBLE_PAD_X, y + BUBBLE_PAD_Y + LINE_H * i + LINE_H / 2));
    y -= 10;
  }
  drawVoiceBubble(ctx, y, tl.voiceSeconds, font);

  // Keyboard
  if (slide < 1) drawKeyboard(ctx, s, t, slide, strings, font);

  ctx.restore(); // drop the screen clip

  drawHands(ctx, tl, t, S);
  drawExhale(ctx, tl, t, (H - oy) / S);
  ctx.restore();

  // Watermark
  const wmSize = Math.round(W * 0.03);
  ctx.font = `600 ${wmSize}px ${font}`;
  ctx.textBaseline = 'middle';
  const wmW = ctx.measureText(opts.watermark).width;
  const pad = wmSize * 0.6;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  rr(ctx, W * 0.025, W * 0.025, wmW + pad * 2, wmSize * 1.8, wmSize * 0.9);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(opts.watermark, W * 0.025 + pad, W * 0.025 + wmSize * 0.9);
  ctx.textBaseline = 'alphabetic';

  drawEndCard(ctx, tl, t, opts, strings.cta, font);
}

/** End card: the frame dims, with a call to action and the site address in the centre. */
function drawEndCard(ctx: Ctx2D, tl: Timeline, t: number, opts: RenderOptions, cta: string, font: string): void {
  const start = tl.duration - END_CARD;
  if (t < start) return;
  const a = easeOut(clamp01((t - start) / 0.25));
  const { width: W, height: H } = opts;

  ctx.fillStyle = `rgba(0,0,0,${0.62 * a})`;
  ctx.fillRect(0, 0, W, H);

  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lift = (1 - a) * H * 0.02; // slight rise as it appears

  const ctaSize = Math.round(W * 0.042);
  ctx.font = `600 ${ctaSize}px ${font}`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(cta, W / 2, H * 0.43 + lift);

  const urlSize = Math.round(W * 0.058);
  ctx.font = `600 ${urlSize}px ${font}`;
  const pillW = ctx.measureText(opts.watermark).width + urlSize * 1.3;
  const pillH = urlSize * 1.9;
  ctx.fillStyle = C.outBubble;
  rr(ctx, W / 2 - pillW / 2, H * 0.53 - pillH / 2 + lift, pillW, pillH, pillH / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(opts.watermark, W / 2, H * 0.53 + lift + 1);

  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** The other person's voice message — what we are replying to. `bottom` is the bubble's bottom edge. */
function drawVoiceBubble(ctx: Ctx2D, bottom: number, seconds: number, font: string): void {
  const w = 230;
  const h = 44;
  const x = 10;
  const y = bottom - h;
  ctx.fillStyle = C.inBubble;
  rr(ctx, x, y, w, h, 18);

  // ▶
  ctx.fillStyle = C.text;
  ctx.beginPath();
  ctx.moveTo(x + 16, y + 14);
  ctx.lineTo(x + 30, y + 22);
  ctx.lineTo(x + 16, y + 30);
  ctx.closePath();
  ctx.fill();

  // Waveform (deterministic)
  ctx.fillStyle = '#7c7c80';
  for (let i = 0; i < 30; i++) {
    const a = Math.abs(Math.sin(i * 1.7 + seconds * 0.37) * Math.sin(i * 0.53 + 1));
    const bh = 4 + 20 * a;
    ctx.fillRect(x + 40 + i * 4.6, y + h / 2 - bh / 2, 2.4, bh);
  }

  ctx.font = `13px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(formatDuration(seconds), x + w - 38, y + h / 2);
}

/** ✓✓ drawn as vectors — many fonts lack check marks. */
function drawChecks(ctx: Ctx2D, x: number, y: number): void {
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const dx of [0, 5]) {
    ctx.moveTo(x + dx, y);
    ctx.lineTo(x + dx + 3, y + 3);
    ctx.lineTo(x + dx + 9, y - 4);
  }
  ctx.stroke();
}

function drawArrowUp(ctx: Ctx2D, x: number, y: number): void {
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + 7);
  ctx.lineTo(x, y - 7);
  ctx.moveTo(x - 6, y - 1);
  ctx.lineTo(x, y - 7);
  ctx.lineTo(x + 6, y - 1);
  ctx.stroke();
}

const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (p: number) => 1 - (1 - p) ** 3;

const wrapCache = new Map<string, string[]>();

/** Grapheme-aware wrapping that prefers breaking at spaces. Cached: text only changes on key presses. */
function wrap(ctx: Ctx2D, graphemes: string[], maxWidth: number): string[] {
  const key = `${ctx.font}|${maxWidth}|${graphemes.join('')}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const lines: string[] = [];
  let line: string[] = [];
  for (const g of graphemes) {
    line.push(g);
    if (line.length > 1 && ctx.measureText(line.join('')).width > maxWidth) {
      const lastSpace = line.lastIndexOf(' ');
      const cut = lastSpace > 0 ? lastSpace + 1 : line.length - 1;
      lines.push(line.slice(0, cut).join('').trimEnd());
      line = line.slice(cut);
    }
  }
  if (line.length) lines.push(line.join(''));

  if (wrapCache.size > 256) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
