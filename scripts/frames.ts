/**
 * Renders individual frames to PNG via @napi-rs/canvas (Skia) for quick visual checks
 * without a browser. Same renderFrame as in the browser (which also proves it runs outside the DOM).
 *
 *   npm run frames -- "Hey, how are you?" en normal 0.5,2,4,end
 *   → out/frames/frame-<t>.png
 */
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderFrame } from '../src/render/renderFrame';
import { generateTimeline, type Mode } from '../src/timeline';
import type { Lang } from '../src/i18n';

const require = createRequire(import.meta.url);
for (const f of ['latin-400', 'latin-600', 'cyrillic-400', 'cyrillic-600']) {
  GlobalFonts.registerFromPath(require.resolve(`@fontsource/inter/files/inter-${f}-normal.woff2`), 'Inter');
}

const [text = 'Hey! Anyway, let’s meet tomorrow at 5', lang = 'en', mode = 'normal', times = '0.5,1.5,3,end', seed = '1'] =
  process.argv.slice(2);
const tl = generateTimeline({ text, lang: lang as Lang, mode: mode as Mode, seed: Number(seed) });
console.log(`duration ${tl.duration.toFixed(2)}s, events ${tl.events.length}`);

const size = 720;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');
mkdirSync('out/frames', { recursive: true });

for (const raw of times.split(',')) {
  const t = raw === 'end' ? tl.duration - 0.01 : Number(raw);
  renderFrame(ctx as unknown as CanvasRenderingContext2D, tl, t, { width: size, height: size, watermark: 'pleasejusttext.me' });
  const file = `out/frames/frame-${t.toFixed(2)}.png`;
  writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(file);
}
