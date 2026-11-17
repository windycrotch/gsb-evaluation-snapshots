// Frame-by-frame capture of the running dev server (or a built preview) into an MP4.
//
//   node tools/render-video.mjs --scene showcase --out out/film/merge-conflict.mp4 [--w 1920 --h 1080 --fps 60 --s 8]
//                               [--from 0 --to 600] [--png] [--sheet 12] [--query "k=v&k2=v2"]
//                               [--no-audio | --audio-only]
//
// The page advances its own deterministic clock one output frame per call, so render speed does
// not affect the result. --s is the number of motion-blur sub-frames accumulated per frame.
// Long films can be rendered in pieces (--from/--to --no-audio) and joined with tools/assemble.mjs;
// --audio-only renders just the soundtrack WAV for the whole run.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const W = +(args.w || 1920), H = +(args.h || 1080), FPS = +(args.fps || 60), S = +(args.s || 4);
const out = args.out || 'out/film.mp4';
const png = !!args.png;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.env.BASE || 'http://127.0.0.1:5183/';
const url = `${base}?mode=capture&scene=${args.scene || 'showcase'}&fps=${FPS}&s=${S}&q=${args.q || 'film'}${args.query ? '&' + args.query : ''}`;
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); else if (m.text().startsWith('[director]')) console.log('  ' + m.text()); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true || (window.__errors && window.__errors.length > 0)', { timeout: 120000 });
const errs = await page.evaluate(() => window.__errors);
if (errs && errs.length) { console.error('page errors:\n' + errs.join('\n')); await browser.close(); process.exit(1); }
const total = await page.evaluate(() => window.__cap.total);
const from = +(args.from || 0), to = Math.min(total, +(args.to || total));
const skipTo = async (n) => { for (let i = 0; i < n; i += 60) await page.evaluate((k) => window.__cap.skip(k), Math.min(60, n - i)); };
const wavPath = out.replace(/\.(mp4|wav)$/, '') + '.wav';
const writeAudio = async (dur) => {
  const wav = await page.evaluate((d) => window.__cap.audio(d), dur).catch((e) => { logs.push('[audio] ' + e.message); return null; });
  if (wav) fs.writeFileSync(wavPath, Buffer.from(wav, 'base64'));
  return !!wav;
};

if (args['audio-only']) {
  await skipTo(total);
  const ok = await writeAudio(total / FPS);
  await browser.close();
  console.log(ok ? `soundtrack → ${wavPath}` : 'no soundtrack produced');
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  process.exit(ok ? 0 : 1);
}

console.log(`scene=${args.scene || 'showcase'} ${W}x${H}@${FPS} s=${S} frames ${from}..${to} of ${total}`);
const silent = out.replace(/\.mp4$/, '.silent.mp4');
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', png ? 'png' : 'mjpeg', '-i', '-',
  '-vf', png ? 'scale=out_color_matrix=bt709:out_range=tv' : 'scale=in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv',
  '-c:v', 'libx264', '-preset', args.preset || 'slow', '-crf', String(args.crf || 15), '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', silent,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise((res) => ff.on('close', res));

const cdp = await page.createCDPSession();
const t0 = Date.now();
if (from > 0) {
  // fast-forward, then draw a few unrecorded lead-in frames so exposure adaptation has settled
  const lead = Math.min(4, from);
  await skipTo(from - lead);
  for (let i = 0; i < lead; i++) await page.evaluate(() => window.__cap.frame());
}
for (let i = from; i < to; i++) {
  await page.evaluate(() => window.__cap.frame());
  const shot = await cdp.send('Page.captureScreenshot', png ? { format: 'png', optimizeForSpeed: true } : { format: 'jpeg', quality: +(args.jq || 96), optimizeForSpeed: false });
  const buf = Buffer.from(shot.data, 'base64');
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if ((i - from) % 60 === 59) {
    const el = (Date.now() - t0) / 1000, done = i - from + 1;
    console.log(`  ${done}/${to - from} frames  ${(el / done * 1000).toFixed(0)} ms/frame  eta ${((to - from - done) * el / done).toFixed(0)}s`);
  }
}
ff.stdin.end();
await ffDone;

let muxed = false;
if (!args['no-audio'] && (await writeAudio(to / FPS))) {
  // master to -14 LUFS integrated with a true-peak ceiling around -1.5 dBTP
  const meas = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wavPath, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /I:\s+(-?[\d.]+) LUFS/.exec((meas.stderr || '').split('Summary:').pop() || '');
  const gain = m ? -14 - parseFloat(m[1]) : 0;
  console.log(`  audio: measured ${m ? m[1] : '?'} LUFS, applying ${gain.toFixed(2)} dB`);
  const dur = (to - from) / FPS;
  const af = `atrim=start=${(from / FPS).toFixed(4)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(2)}dB,alimiter=limit=0.82:attack=3:release=60:level=false,afade=t=out:st=${Math.max(0, dur - 0.35).toFixed(3)}:d=0.35`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-i', wavPath, '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
  muxed = r.status === 0;
}
if (!muxed && !args['no-audio']) fs.copyFileSync(silent, out);
await browser.close();

if (args.sheet) {
  const every = +args.sheet || 12;
  const sheet = out.replace(/\.mp4$/, '');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-vf', `select='not(mod(n,${every}))',scale=${args.sw || 480}:-1,tile=${args.tile || '5x4'}:padding=4:margin=4`, '-fps_mode', 'vfr', '-q:v', '3', `${sheet}.sheet%02d.jpg`], { stdio: 'inherit' });
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${args['no-audio'] ? silent : out}${muxed ? ' (with audio)' : ' (silent)'}`);
if (logs.length) console.log(logs.filter((l) => !l.includes('404')).slice(0, 20).join('\n'));
