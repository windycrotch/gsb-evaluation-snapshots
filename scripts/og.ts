/**
 * Generates the link-preview image and the touch icon with the same renderer as the video:
 *   public/og.jpg (1200×630) and public/apple-touch-icon.png (180×180).
 *   npm run og
 */
import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderFrame } from '../src/render/renderFrame';
import { generateTimeline, stateAt } from '../src/timeline';

const require = createRequire(import.meta.url);
for (const f of ['latin-400', 'latin-600', 'cyrillic-400', 'cyrillic-600']) {
  GlobalFonts.registerFromPath(require.resolve(`@fontsource/inter/files/inter-${f}-normal.woff2`), 'Inter');
}
const FONT = 'Inter, "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const BLUE = '#0b84fe';

// ——— og.jpg: headline on the left, a video frame on the right ———
const W = 1200;
const H = 630;
const og = createCanvas(W, H);
const ctx = og.getContext('2d');

// Frame: the moment roughly half of the text is typed
const tl = generateTimeline({ text: "Can't listen now, just text me pls 🙏", mode: 'normal', seed: 3, lang: 'en' });
const half = tl.events.find(
  (e) => e.type === 'press' && e.kb.page === 'letters' && e.key.startsWith('c:') && stateAt(tl, e.t).graphemes.length >= 20,
)!;
const frame = createCanvas(H, H);
renderFrame(frame.getContext('2d') as unknown as CanvasRenderingContext2D, tl, half.t + 0.03, {
  width: H,
  height: H,
  watermark: 'pleasejusttext.me',
  fontFamily: FONT,
});

ctx.fillStyle = '#0b0b0d';
ctx.fillRect(0, 0, W, H);
ctx.drawImage(frame, W - H, 0);
// Soft fade from the frame into the text side
const grad = ctx.createLinearGradient(W - H, 0, W - H + 120, 0);
grad.addColorStop(0, '#0b0b0d');
grad.addColorStop(1, 'rgba(11,11,13,0)');
ctx.fillStyle = grad;
ctx.fillRect(W - H, 0, 120, H);

const x = 64;
ctx.fillStyle = '#f2f2f7';
ctx.font = `600 64px ${FONT}`;
ctx.textBaseline = 'alphabetic';
ctx.fillText('Another voice', x, 190);
ctx.fillText('message?', x, 264);

ctx.fillStyle = '#a1a1a6';
ctx.font = `400 30px ${FONT}`;
ctx.fillText('Reply with a video of you', x, 340);
ctx.fillText('typing. Let them sit through it.', x, 380);

bubble(ctx, x, 450, 'pleasejusttext.me', 34);
// JPEG: loads faster in messenger previews, and the loss isn't visible on this image.
writeFileSync('public/og.jpg', og.toBuffer('image/jpeg', 86));
console.log('public/og.jpg');

// ——— apple-touch-icon.png: a “typing…” bubble ———
const S = 180;
const icon = createCanvas(S, S);
const ic = icon.getContext('2d');
ic.fillStyle = BLUE;
ic.fillRect(0, 0, S, S);
ic.fillStyle = '#ffffff';
for (const dx of [-38, 0, 38]) {
  ic.beginPath();
  ic.arc(S / 2 + dx, S / 2, 14, 0, Math.PI * 2);
  ic.fill();
}
writeFileSync('public/apple-touch-icon.png', icon.toBuffer('image/png'));
console.log('public/apple-touch-icon.png');

function bubble(c: SKRSContext2D, bx: number, by: number, text: string, size: number) {
  c.font = `600 ${size}px ${FONT}`;
  const w = c.measureText(text).width + size * 1.2;
  const h = size * 1.9;
  c.fillStyle = BLUE;
  c.beginPath();
  c.roundRect(bx, by, w, h, h / 2);
  c.fill();
  c.fillStyle = '#ffffff';
  c.textBaseline = 'middle';
  c.fillText(text, bx + size * 0.6, by + h / 2 + 1);
}
