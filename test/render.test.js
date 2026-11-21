// End to end: needs Chrome, ffmpeg and ffprobe. Renders the fixture page and checks what came out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { probeVideo } from '../src/ffmpeg.js';
import { renderProject } from '../src/project.js';
import { dumpEvents, renderStills, renderVideo } from '../src/render.js';

const page = fileURLToPath(new URL('./fixtures/basic.html', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'motlab-test-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');   // keep test probes out of the real cache
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {} };

// Mean RGB of a region of a decoded frame (the first one by default).
function meanRgb(file, crop, frame = 0) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=${crop},scale=1:1:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  return [...r.stdout.subarray(0, 3)];
}
const near = (got, want, tol) => got.length === 3 && got.every((v, i) => Math.abs(v - want[i]) <= tol);

async function checkVideo(name, opts, frames) {
  const out = join(dir, name);
  const s = await renderVideo({ page, out, fps: 30, scale: 1, ...quiet, ...opts });
  const v = await probeVideo(out);
  assert.equal(v.frames, frames); assert.equal(Number(v.nb_frames), frames);
  assert.ok(Math.abs(v.duration - frames / 30) < 1e-3, `duration ${v.duration}`);
  assert.deepEqual([v.width, v.height], [640, 360]);
  // limited range when Chrome draws on a GPU, full range when it draws in software (CI runners have no GPU)
  assert.deepEqual([v.color_range, v.color_space, v.color_transfer, v.color_primaries], [s.fullRange ? 'pc' : 'tv', 'bt709', 'bt709', 'bt709']);
  const left = meanRgb(out, '200:200:60:80'), right = meanRgb(out, '100:60:340:20');
  assert.ok(near(left, [0x30, 0xE2, 0xA8], 4), `left field decoded as ${left}`);
  assert.ok(near(right, [0xF5, 0xD0, 0x4E], 4), `right field decoded as ${right}`);
  assert.ok(!existsSync(out + '.part'));
  return s;
}

test('video: default encoder, Mediabunny mux', async () => {
  const logs = [];   // the renderer says why it left Mediabunny for the raw path; the failure shows it
  const s = await checkVideo('auto.mp4', { log: m => logs.push(m) }, 30);
  assert.match(s.mux, /^Mediabunny/, logs.join('\n'));
});
test('video: software encoder', () => checkVideo('sw.mp4', { encoder: 'sw' }, 30));
test('video: raw bitstream mux', async () => {
  const s = await checkVideo('raw.mp4', { mux: 'raw', encoder: 'sw' }, 30);
  assert.match(s.mux, /^raw bitstream/);
});
test('video: three workers joined with concat', async () => {
  const s = await checkVideo('workers.mp4', { workers: 3, encoder: 'sw' }, 30);
  assert.equal(s.workers, 3);
});
test('video: audio is muxed and never extends the video', async () => {
  const wav = join(dir, 'tone.wav');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', wav]);
  await checkVideo('audio.mp4', { audio: wav, encoder: 'sw' }, 30);
  const a = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration', '-of', 'json', join(dir, 'audio.mp4')], { encoding: 'utf8' }).stdout).streams[0];
  assert.equal(a.codec_name, 'aac'); assert.ok(Math.abs(Number(a.duration) - 1) < 0.05, `audio duration ${a.duration}`);
});
test('stills: PNG at the scaled page size, exact colour', async () => {
  const files = await renderStills({ page, outDir: join(dir, 'stills'), times: [0, 0.5], scale: 2, ...quiet });
  assert.equal(files.length, 2); assert.match(files[1], /0\.50\.png$/);
  const p = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', files[1]], { encoding: 'utf8' }).stdout).streams[0];
  assert.deepEqual([p.width, p.height], [1280, 720]);
  assert.deepEqual(meanRgb(files[1], '200:200:60:80'), [0x30, 0xE2, 0xA8]);
});
test('events: window.EVENTS is written as JSON', async () => {
  const out = join(dir, 'events.json');
  await dumpEvents({ page, out, ...quiet });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [{ name: 'hit', t: 0.5 }]);
});
test('a page without the contract fails with a clear message', async () => {
  await assert.rejects(renderVideo({ page: fileURLToPath(new URL('../package.json', import.meta.url)), out: join(dir, 'x.mp4'), ...quiet }), /renderAt/);
});

test('footage: a WebM clip shows the right frame at every time, though Matroska rounds timestamps to the millisecond', async () => {
  const proj = join(dir, 'footage'), clip = join(proj, 'clip.webm');
  mkdirSync(proj);
  // VP9 at 30 fps, each frame a flat grey 6 levels lighter than the one before, so a frame tells which one it is
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:r=30:d=1,geq=lum=16+N*6:cb=128:cr=128', '-c:v', 'libvpx-vp9', '-b:v', '2M', '-pix_fmt', 'yuv420p', clip]);
  writeFileSync(join(proj, 'scene.html'), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
    const ctx = document.getElementById('c').getContext('2d'); let clip; window.TOTAL = 1;
    window.ready = (async () => { clip = await (await import('/__motlab/footage.js')).openFootage('clip.webm'); return true; })();
    window.renderAt = async t => { await window.ready; (await clip.frame(t)).draw(ctx, 0, 0, 64, 64); };</script>`);
  const out = join(dir, 'footage.mp4');
  await renderVideo({ page: join(proj, 'scene.html'), out, fps: 30, scale: 1, encoder: 'sw', ...quiet });
  const grey = (file, f) => meanRgb(file, '32:32:16:16', f)[1];
  const src = Array.from({ length: 30 }, (_, f) => grey(clip, f)), wrong = [];
  for (let f = 0; f < 30; f++) {
    const g = grey(out, f), shown = src.reduce((b, v, i) => Math.abs(v - g) < Math.abs(src[b] - g) ? i : b, 0);
    if (shown !== f) wrong.push(`frame ${f} showed source frame ${shown}`);
  }
  assert.deepEqual(wrong, [], `source greys ${src}`);
});

test('cut list sections: two scenes play their own parts of one recording, back to back, with TOTAL set in ready', async () => {
  const proj = join(dir, 'sections'), clip = join(proj, 'take.webm');
  mkdirSync(proj);
  // 3 s at 10 fps, each frame a grey 7 levels lighter than the one before
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:r=10:d=3,geq=lum=16+N*7:cb=128:cr=128', '-c:v', 'libvpx-vp9', '-b:v', '2M', '-pix_fmt', 'yuv420p', clip]);
  // three parts of 0.8 s; section "b" asks for 1.9 s, which moves it to the cut at 2.0 s
  writeFileSync(join(proj, 'cuts.json'), JSON.stringify({ segments: [{ from: 0, to: 0.8 }, { from: 1, to: 1.8 }, { from: 2, to: 2.8 }], sections: [{ name: 'a', from: 0 }, { name: 'b', from: 1.9 }] }));
  for (const name of ['a', 'b']) writeFileSync(join(proj, `${name}.html`), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
    const ctx = document.getElementById('c').getContext('2d'); let edit;
    window.ready = (async () => {
      const clip = await (await import('/__motlab/footage.js')).openFootage('take.webm'), { cutList } = await import('/__motlab/cuts.js');
      edit = cutList(await (await fetch('cuts.json')).json(), clip, { section: '${name}' }); window.TOTAL = edit.duration; return true;
    })();
    window.renderAt = async t => { await window.ready; await edit.draw(ctx, t, 0, 0, 64, 64); };</script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html', 'b.html'] }));
  const out = join(dir, 'sections.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  assert.equal((await probeVideo(out)).frames, 24);   // section a: 16 frames, section b: 8
  const grey = (file, f) => meanRgb(file, '32:32:16:16', f)[1];
  const src = Array.from({ length: 30 }, (_, f) => grey(clip, f)), wrong = [];
  const want = f => f < 8 ? f : f < 16 ? 10 + f - 8 : 20 + f - 16;   // the source frame each output frame should show
  for (let f = 0; f < 24; f++) {
    const g = grey(out, f), shown = src.reduce((b, v, i) => Math.abs(v - g) < Math.abs(src[b] - g) ? i : b, 0);
    if (shown !== want(f)) wrong.push(`frame ${f} showed source frame ${shown}, not ${want(f)}`);
  }
  assert.deepEqual(wrong, [], `source greys ${src}`);
});

test('project: a transition overlaps two scenes and mixes them on the frame grid', async () => {
  const proj = join(dir, 'proj'), flat = (name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj); flat('a.html', '#000'); flat('b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5, ease: 'linear' } }] }));
  const out = join(dir, 'proj.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  const v = await probeVideo(out);
  assert.equal(v.frames, 45);   // 30 + 30 frames, 15 of them shared
  const grey = f => meanRgb(out, '100:100:110:40', f)[0];
  // frames 0 to 14: scene a; 15 to 29: the transition; 30 to 44: the rest of scene b
  assert.ok(grey(14) < 8, `frame 14 is ${grey(14)}`);
  assert.ok(Math.abs(grey(22) - 128) < 8, `frame 22 is ${grey(22)}`);       // k = 7 of 15: progress 0.5
  assert.ok(grey(30) > 248, `frame 30 is ${grey(30)}`);
});

test('project: a layer transition is drawn over a hard cut, in the page pixels, without shortening the video', async () => {
  const proj = join(dir, 'layer'), flat = (name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c"></canvas><script>
    const s = +(new URLSearchParams(location.search).get('scale') || 1), cv = document.getElementById('c'), c = cv.getContext('2d');
    cv.width = 320 * s; cv.height = 180 * s; window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, cv.width, cv.height); };</script>`);
  mkdirSync(proj); flat('a.html', '#000'); flat('b.html', '#fff');
  // a red bar from the left edge, p of the page's 320 px wide
  writeFileSync(join(proj, 'bar.js'), 'export function draw(ctx, p, W, H) { ctx.fillStyle = "#f00"; ctx.fillRect(0, 0, p * W, H); }\n');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { layer: 'bar.js', duration: 0.5 } }] }));
  const out = join(dir, 'layer.mp4');
  await renderProject({ dir: proj, out, scale: 2, ...quiet });   // at scale 2 the bar must still be p of the width
  const v = await probeVideo(out);
  assert.equal(v.frames, 60);   // two scenes of 30 frames, nothing shared
  assert.deepEqual([v.width, v.height], [640, 360]);
  const rgb = (f, x) => meanRgb(out, `16:16:${x}:172`, f);
  // 15 frames: the last 7 of a (frames 23 to 29) and the first 8 of b (30 to 37); frame 26 is k = 3, p = 0.233
  assert.ok(near(rgb(20, 600), [0, 0, 0], 8), `frame 20 is ${rgb(20, 600)}`);
  assert.ok(near(rgb(26, 40), [255, 0, 0], 16), `frame 26 left is ${rgb(26, 40)}`);
  assert.ok(near(rgb(26, 400), [0, 0, 0], 8), `frame 26 right is ${rgb(26, 400)}`);
  assert.ok(near(rgb(33, 400), [255, 0, 0], 16), `frame 33 at 0.62 of the width is ${rgb(33, 400)}`);   // k = 10, p = 0.7
  assert.ok(near(rgb(33, 600), [255, 255, 255], 8), `frame 33 right is ${rgb(33, 600)}`);
  assert.ok(near(rgb(40, 40), [255, 255, 255], 8), `frame 40 is ${rgb(40, 40)}`);
});

test('project: a transition from a .glsl file in the project, with params over its defaults, and its compile errors', async () => {
  const proj = join(dir, 'glsl'), flat = (name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(join(proj, 'transitions'), { recursive: true }); flat('a.html', '#000'); flat('b.html', '#fff');
  // a fixed mix of the two scenes, the same on every frame, so the level shows which value the shader got
  writeFileSync(join(proj, 'transitions', 'hold.glsl'), `// a test transition
uniform float level; // = 0.25
uniform ivec2 grid; // = ivec2(2, 3)
vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), grid.x == 2 && grid.y == 3 ? level : 0.0); }
`);
  const write = transition => writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition }] }));
  const grey = (file, f) => meanRgb(file, '100:100:110:40', f)[0];
  write({ type: 'transitions/hold.glsl', duration: 0.5 });
  await renderProject({ dir: proj, out: join(dir, 'glsl1.mp4'), scale: 1, ...quiet });
  assert.equal((await probeVideo(join(dir, 'glsl1.mp4'))).frames, 45);
  assert.ok(Math.abs(grey(join(dir, 'glsl1.mp4'), 18) - 64) < 8, `the default 0.25 gave ${grey(join(dir, 'glsl1.mp4'), 18)}`);
  write({ type: 'transitions/hold.glsl', duration: 0.5, params: { level: 0.75 } });
  await renderProject({ dir: proj, out: join(dir, 'glsl2.mp4'), scale: 1, ...quiet });
  assert.ok(Math.abs(grey(join(dir, 'glsl2.mp4'), 18) - 191) < 8, `params 0.75 gave ${grey(join(dir, 'glsl2.mp4'), 18)}`);
  // a mistake on line 3 of the file is reported on line 3, with the file's name
  writeFileSync(join(proj, 'transitions', 'bad.glsl'), 'uniform float level; // = 0.5\nvec4 transition(vec2 uv) {\n  return mix(getFromColor(uv), getToColor(uv), lvl);\n}\n');
  write({ type: 'transitions/bad.glsl', duration: 0.5 });
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'glsl3.mp4'), scale: 1, ...quiet }), /transitions\/bad\.glsl: ERROR: 0:3: 'lvl'/);
});

test('project: --only re-renders one scene and the transition touching it, reuses the cached rest and prunes the parts it did not use', async () => {
  const proj = join(dir, 'only'), flat = (name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj); flat('a.html', '#000'); flat('b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5, ease: 'linear' } }] }));
  await renderProject({ dir: proj, out: join(dir, 'only1.mp4'), scale: 1, ...quiet });
  flat('b.html', '#f00');
  const logs = [];
  await renderProject({ dir: proj, out: join(dir, 'only2.mp4'), scale: 1, only: [2], log: m => logs.push(m) });
  const v = await probeVideo(join(dir, 'only2.mp4'));
  assert.equal(v.frames, 45);   // 30 + 30 frames, 15 of them shared
  const seen = logs.join('\n');
  assert.ok(seen.includes('Scene 1/2: a.html (cached)'), seen);
  assert.ok(!seen.includes('Transition 1 to 2: fade, 15 frames (cached)'), seen);   // scene 2 changed, so the transition is rendered again
  const red = f => meanRgb(join(dir, 'only2.mp4'), '100:100:110:40', f)[0];
  assert.ok(red(0) < 8, `frame 0 is ${red(0)}`);                     // scene a, from the cache
  assert.ok(Math.abs(red(22) - 128) < 8, `frame 22 is ${red(22)}`);  // the transition, black to red at progress 0.5
  assert.ok(red(40) > 200, `frame 40 is ${red(40)}`);                // scene b, re-rendered red
  // the old scene b and transition parts are gone, not left behind
  const partsDir = join(dir, 'cache', 'parts', createHash('sha256').update(join(proj, 'project.json')).digest('hex').slice(0, 16));
  assert.equal(readdirSync(partsDir).filter(f => f.endsWith('.mp4')).length, 3);   // scene a, scene b, the transition
  // --only on a project with no cached parts renders everything, and a scene number outside the project stops it
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'only3.mp4'), scale: 1, only: [3], ...quiet }), /--only takes scene numbers from 1 to 2/);
  const cold = join(dir, 'only-cold');
  mkdirSync(cold);
  const cflat = (name, colour) => writeFileSync(join(cold, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  cflat('a.html', '#000'); cflat('b.html', '#fff');
  writeFileSync(join(cold, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'] }));
  const coldLogs = [];
  await renderProject({ dir: cold, out: join(dir, 'only-cold.mp4'), scale: 1, only: [2], log: m => coldLogs.push(m) });
  assert.ok(coldLogs.join('\n').includes('Scene 1/2: a.html (no cached part, rendering it)'), coldLogs.join('\n'));
  assert.equal((await probeVideo(join(dir, 'only-cold.mp4'))).frames, 60);
});

test('project: parts render several at a time in order, and a failing part is tried again one at a time', async () => {
  const proj = join(dir, 'parallel'), flat = (name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj); flat('a.html', '#000'); flat('b.html', '#fff'); flat('c.html', '#f00'); flat('d.html', '#00f');
  const fade = { type: 'fade', duration: 0.5, ease: 'linear' };
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html', { file: 'd.html', transition: fade }] }));
  const out = join(dir, 'parallel.mp4'), logs = [];
  await renderProject({ dir: proj, out, scale: 1, parallel: 3, log: m => logs.push(m) });
  assert.ok(logs.includes('\nRendering 5 more parts, 3 at a time'), logs.join('\n'));
  const v = await probeVideo(out);
  assert.equal(v.frames, 90);   // four scenes of 30 frames, two transitions of 15 shared frames
  const rgb = f => meanRgb(out, '100:100:110:40', f);
  assert.ok(near(rgb(5), [0, 0, 0], 8), `frame 5 is ${rgb(5)}`);
  assert.ok(near(rgb(22), [128, 128, 128], 10), `frame 22 is ${rgb(22)}`);   // a to b at progress 0.5
  assert.ok(near(rgb(40), [255, 255, 255], 8), `frame 40 is ${rgb(40)}`);
  assert.ok(near(rgb(52), [255, 0, 0], 12), `frame 52 is ${rgb(52)}`);
  assert.ok(near(rgb(67), [128, 0, 128], 12), `frame 67 is ${rgb(67)}`);   // c to d at progress 0.5
  assert.ok(near(rgb(85), [0, 0, 255], 12), `frame 85 is ${rgb(85)}`);
  // A scene that fails fails again on its own, and that error is the one reported.
  writeFileSync(join(proj, 'c.html'), '<!doctype html><canvas id="c" width="320" height="180"></canvas><script>window.TOTAL = 1; window.renderAt = () => {}; window.ready = Promise.reject(new Error("c is broken"));</script>');
  const failLogs = [];
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'parallel2.mp4'), scale: 1, parallel: 3, log: m => failLogs.push(m) }), /c is broken/);
  assert.ok(failLogs.some(l => l.includes('Rendering the remaining parts one at a time')), failLogs.join('\n'));
  assert.ok(!existsSync(join(dir, 'parallel2.mp4')));
});

test('project: qp from project.json reaches the encoder, a wrong one is refused, and the cache keeps each qp apart', async () => {
  const proj = join(dir, 'qp');
  mkdirSync(proj);
  writeFileSync(join(proj, 'a.html'), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = t => { c.fillStyle = '#123'; c.fillRect(0, 0, 320, 180); c.fillStyle = '#fc6'; c.fillRect(20 + t * 200, 40, 80, 80); };</script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html'], qp: 60 }));
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'qp0.mp4'), scale: 1, ...quiet }), /qp must be a whole number from 0 to 51, not 60/);
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'qp0.mp4'), scale: 1, qp: 20, codec: 'av1', ...quiet }), /codec must be auto, h264 or hevc/);
  writeFileSync(join(proj, 'b.html'), readFileSync(join(proj, 'a.html'), 'utf8'));
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'], qp: 30 }));
  const logs = [];
  await renderProject({ dir: proj, out: join(dir, 'qp30.mp4'), scale: 1, log: m => logs.push(m) });
  const encoder = logs.find(l => l.startsWith('Encoder:'));
  // only the hardware encoders take a QP; a runner without a GPU encodes in software at a bitrate instead
  if (/constant QP/.test(encoder)) assert.match(encoder, /constant QP 30/);
  // the option overrides project.json, and a part made at another qp is not reused
  const again = [];
  await renderProject({ dir: proj, out: join(dir, 'qp20.mp4'), scale: 1, qp: 20, only: [2], log: m => again.push(m) });
  assert.ok(again.some(l => l.includes('Scene 1/2: a.html (no cached part, rendering it)')), again.join('\n'));
  if (/constant QP/.test(encoder)) assert.ok(again.some(l => /constant QP 20/.test(l)), again.join('\n'));
});

test('project: scenes of different sizes stop the render, and a mono file plays at full level on both channels', async () => {
  const proj = join(dir, 'proj2'), flat = (name, w, h) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="${w}" height="${h}"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '#000'; c.fillRect(0, 0, ${w}, ${h}); };</script>`);
  mkdirSync(proj); flat('a.html', 320, 180); flat('b.html', 180, 320);
  // a mono sine at 0.5: RMS -9.03 dBFS, which both channels of the result should keep (ffmpeg's own up-mix gives -12.04)
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000', '-af', 'volume=4', '-ac', '1', join(proj, 'tone.wav')]);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'] }));
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'proj2.mp4'), scale: 1, ...quiet }), /b\.html is 180x320 but a\.html is 320x180/);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html'], audio: [{ file: 'tone.wav', start: 0 }] }));
  const out = join(dir, 'proj3.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  const level = file => spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8' })
    .stderr.match(/RMS level dB: -?[\d.]+/g).map(s => parseFloat(s.split(': ')[1]));
  const [src] = level(join(proj, 'tone.wav')), [l, r] = level(out);
  assert.ok(Math.abs(l - src) < 0.5 && Math.abs(r - src) < 0.5, `source ${src} dB, render ${l} / ${r} dB`);
});
