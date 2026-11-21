// Renders the scene in shared.js with motlab, Remotion and HyperFrames, RUNS times per setting, one after another,
// and writes results.json: wall time of the whole command as a user sees it (Chrome start-up, Remotion's bundling,
// muxing), plus SSIM of 10 frames against lossless PNG stills of the canvas page. Run `npm ci` in this folder first.
//   node run.mjs                  every setting, 3 runs each
//   RUNS=1 ONLY=motlab-sw node run.mjs
//   SCALE=2 node run.mjs           at 4K (results-4k.json)
//   CPU=1 node run.mjs             Chrome drawing in software (SwiftShader) and CPU encoders only (results-cpu.json)
//   IGPU=1 node run.mjs            motlab only, on Chrome's default (integrated) GPU like the other two (results-igpu.json)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome } from '../src/chrome.js';

const B = import.meta.dirname, OUT = join(B, 'out'), REF = join(B, 'ref'), RUNS = Number(process.env.RUNS || 3);
const SCALE = Number(process.env.SCALE || 1), CPU = process.env.CPU === '1', IGPU = process.env.IGPU === '1', SIZE = SCALE === 1 ? '' : `-${1080 * SCALE}p`;
const MODE = CPU ? '-cpu' : IGPU ? '-igpu' : '', TAG = MODE + SIZE, RESULTS = join(B, `results${MODE}${SCALE === 1 ? '' : '-4k'}.json`);
const MOTLAB = join(B, '..', 'bin', 'motlab.js'), MOTLAB_CPU = join(B, 'motlab-cpu.mjs'), MOTLAB_IGPU = join(B, 'motlab-igpu.mjs'), CHROME = findChrome(process.env.CHROME);
// Both other tools are pointed at the same Chrome as motlab, and their telemetry is off.
const env = { ...process.env, REMOTION_DISABLE_TELEMETRY: '1', HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_BROWSER_PATH: CHROME };
for (const d of ['dom', 'canvas']) {   // HyperFrames serves the composition folder only
  copyFileSync(join(B, 'shared.js'), join(B, 'hyperframes', d, 'shared.js'));
  copyFileSync(join(B, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), join(B, 'hyperframes', d, 'gsap.min.js'));
}

const motlab = (name, extra) => ({ name, cwd: join(B, 'motlab'), args: [CPU ? MOTLAB_CPU : IGPU ? MOTLAB_IGPU : MOTLAB, 'video', 'canvas.html', join(OUT, name + TAG + '.mp4'), '--fps', '30', '--scale', String(SCALE), '--chrome', CHROME, '--root', B, ...extra] });
const remotion = (name, comp, extra) => ({ name, cwd: join(B, 'remotion'), args: [join(B, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'render', 'src/index.jsx', comp, join(OUT, name + TAG + '.mp4'), `--browser-executable=${CHROME}`, `--scale=${SCALE}`, '--chrome-mode=chrome-for-testing', '--log=error', ...extra] });
const hf = (name, dir, extra) => ({ name, cwd: join(B, 'hyperframes'), args: [join(B, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'), 'render', dir, '-o', join(OUT, name + TAG + '.mp4'), '--quiet', ...(SCALE === 2 ? ['--resolution', 'landscape-4k'] : []), ...extra] });
// CPU=1: Remotion's --gl=swangle and HyperFrames' --no-browser-gpu (both ANGLE on SwiftShader), motlab-cpu.mjs gives
// motlab the same flags. Remotion and HyperFrames encode with ffmpeg libx264 by default; motlab gets --encoder sw.
const configs = CPU ? [
  motlab('motlab-sw', ['--encoder', 'sw']),
  motlab('motlab-sw-w4', ['--encoder', 'sw', '--workers', '4']),
  remotion('remotion-dom', 'Dom', ['--gl=swangle']),
  remotion('remotion-dom-c1', 'Dom', ['--gl=swangle', '--concurrency=1']),
  remotion('remotion-canvas', 'Canvas', ['--gl=swangle']),
  hf('hf-dom', 'dom', ['--no-browser-gpu']),
  hf('hf-dom-w1', 'dom', ['--no-browser-gpu', '--workers', '1']),
  hf('hf-canvas', 'canvas', ['--no-browser-gpu']),
] : IGPU ? [
  motlab('motlab-auto', []),
  motlab('motlab-sw', ['--encoder', 'sw']),
  motlab('motlab-auto-w4', ['--workers', '4']),
] : [
  motlab('motlab-auto', []),
  motlab('motlab-sw', ['--encoder', 'sw']),
  motlab('motlab-auto-w4', ['--workers', '4']),
  remotion('remotion-dom', 'Dom', []),
  remotion('remotion-dom-c1', 'Dom', ['--concurrency=1']),
  remotion('remotion-canvas', 'Canvas', []),
  hf('hf-dom', 'dom', []),
  hf('hf-dom-w1', 'dom', ['--workers', '1']),
  hf('hf-canvas', 'canvas', []),
];

const ts = Array.from({ length: 10 }, (_, i) => i + 0.5);
const ref = join(REF + SIZE);   // the GPU stills: what the frames should look like
const ssim = file => {
  if (!existsSync(join(ref, '9.50.png')))
    spawnSync(process.execPath, [MOTLAB, 'stills', 'canvas.html', ref, ...ts.map(String), '--scale', String(SCALE), '--chrome', CHROME, '--root', B], { cwd: join(B, 'motlab'), stdio: 'inherit' });
  const vals = ts.map(t => {
    const p = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-i', join(ref, t.toFixed(2) + '.png'), '-filter_complex',
      `[0:v]select=eq(n\\,${Math.round(t * 30)}),setpts=PTS-STARTPTS,format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim`, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    return Number(/All:([\d.]+)/.exec(p.stderr)?.[1]);
  });
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4);
};

const only = process.env.ONLY?.split(','), results = [];
for (const c of configs.filter(c => !only || only.includes(c.name))) {
  const times = [], file = join(OUT, c.name + TAG + '.mp4');
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, c.args, { cwd: c.cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 });
    const s = (performance.now() - t0) / 1000;
    if (r.status !== 0) { console.log(`${c.name} run ${i + 1} FAILED\n${(r.stdout || '').slice(-1500)}\n${(r.stderr || '').slice(-1500)}`); break; }
    times.push(+s.toFixed(2)); console.log(`${c.name} run ${i + 1}: ${s.toFixed(2)} s`);
  }
  if (!times.length) continue;
  const median = [...times].sort((a, b) => a - b)[(times.length - 1) >> 1];
  results.push({ name: c.name, times, median, fps: +(300 / median).toFixed(1), mb: +(statSync(file).size / 1e6).toFixed(1), ssim: ssim(file) });
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
}
console.table(results);
