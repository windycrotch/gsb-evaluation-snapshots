/**
 * Renders individual frames to PNG via @napi-rs/canvas (Skia) for quick visual checks
 * without a browser. Same renderFrame as in the browser (which also proves it runs outside the DOM).
 *
 *   npm run frames -- "Hey, how are you?" en normal 0.5,2,4,end
 *   npm run frames -- "Sorry, give me a sec" en breaks breaks 4 8
 *   → out/frames/frame-<t>.png
 *
 * `times` as `breaks` renders every break at t0 − 0.02, mid-break and t1 + 0.02.
 * The optional 6th argument is `maxDuration` (default 60) — lower it to see the squeezed timeline.
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

const [
  text = 'Hey! Anyway, let’s meet tomorrow at 5',
  lang = 'en',
  mode = 'normal',
  times = '0.5,1.5,3,end',
  seed = '1',
  maxDuration = '60',
] = process.argv.slice(2);
const tl = generateTimeline({
  text,
  lang: lang as Lang,
  mode: mode as Mode,
  seed: Number(seed),
  maxDuration: Number(maxDuration),
});
console.log(`duration ${tl.duration.toFixed(2)}s, events ${tl.events.length}, breaks ${JSON.stringify(tl.breaks)}`);

const size = 720;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');
mkdirSync('out/frames', { recursive: true });

const stamps =
  times === 'breaks'
    ? tl.breaks.flatMap((b) => [
        { t: b.t0 - 0.02, label: `${b.kind}-t0` },
        { t: (b.t0 + b.t1) / 2, label: `${b.kind}-mid` },
        { t: b.t1 + 0.02, label: `${b.kind}-t1` },
      ])
    : times.split(',').map((raw) => ({ t: raw === 'end' ? tl.duration - 0.01 : Number(raw), label: '' }));

for (const { t, label } of stamps) {
  renderFrame(ctx as unknown as CanvasRenderingContext2D, tl, t, { width: size, height: size, watermark: 'pleasejusttext.me' });
  const file = `out/frames/frame-${t.toFixed(2)}${label ? `-${label}` : ''}.png`;
  writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(file);
}
