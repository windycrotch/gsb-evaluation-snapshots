// End to end: needs Chrome, ffmpeg and ffprobe. Renders the fixture page and checks what came out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const s = await checkVideo('auto.mp4', {}, 30);
  assert.match(s.mux, /^Mediabunny/);
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

test('project: three scenes with two transitions write a layout that matches the video frame for frame', async () => {
  const proj = join(dir, 'proj-layout'), flat = (name, colour, total) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = ${total}; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj);
  // 2 s (60 frames), 1.5 s (45) and 1 s (30); the transitions round to 15 and 3 frames
  flat('a.html', '#000', 2); flat('b.html', '#777', 1.5); flat('c.html', '#fff', 1);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html',
    { file: 'b.html', transition: { type: 'fade', duration: 0.5, ease: 'linear' } },
    { file: 'c.html', transition: { type: 'fade', duration: 0.1, ease: 'linear' } }] }));
  const out = join(dir, 'layout.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });

  const file = join(dir, 'layout.layout.json'), layout = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(layout.fps, 30);
  assert.equal(layout.totalFrames, 60 + 45 + 30 - 15 - 3);
  assert.deepEqual(layout.scenes.map(s => [s.file, s.start, s.end]), [['a.html', 0, 45], ['b.html', 60, 87], ['c.html', 90, 117]]);
  assert.deepEqual(layout.transitions.map(t => [t.type, t.from, t.to, t.start, t.end]), [['fade', 'a.html', 'b.html', 45, 60], ['fade', 'b.html', 'c.html', 87, 90]]);
  // [start, end) ranges, contiguous in one order, with no gap and no overlap
  const all = [...layout.scenes, ...layout.transitions].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const r of all) { assert.equal(r.start, at); assert.ok(r.end > r.start); at = r.end; }
  assert.equal(at, layout.totalFrames);
  // the real file has exactly the layout's frames and length
  const v = await probeVideo(out);
  assert.equal(v.frames, layout.totalFrames);
  assert.ok(Math.abs(v.duration - layout.totalFrames / 30) < 1e-3, `duration ${v.duration}`);
  assert.ok(!existsSync(out + '.part'));
  // the ranges describe what is on screen: the black scene, then a fade, then the grey one, then a fade, then white
  const grey = f => meanRgb(out, '100:100:110:40', f)[0];
  assert.ok(grey(44) < 8, `frame 44 is ${grey(44)}`);
  assert.ok(Math.abs(grey(52) - 60) < 10, `frame 52 is ${grey(52)}`);   // middle of a 15-frame fade, black to #777
  assert.ok(Math.abs(grey(70) - 119) < 8, `frame 70 is ${grey(70)}`);
  assert.ok(grey(90) > 248, `frame 90 is ${grey(90)}`);      // scene c starts at 90, after the 3-frame fade
  assert.ok(grey(116) > 248, `frame 116 is ${grey(116)}`);
});

test('project: declared durations lay the timeline out, and a page that disagrees stops the render', async () => {
  const proj = join(dir, 'proj-declared'), flat = (name, colour, total) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = ${total}; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: [{ file: 'a.html', duration: 1 },
    { file: 'b.html', duration: 1, transition: { type: 'fade', duration: 0.5 } }] }));
  // A page whose TOTAL is not what its scene declares is caught at its own render, and the layout's frames win.
  flat('a.html', '#000', 99); flat('b.html', '#fff', 1);
  await assert.rejects(renderProject({ dir: proj, out: join(dir, 'declared.mp4'), scale: 1, ...quiet }),
    /a\.html has 2970 frames at 30 fps, but the project layout was made for 30/);
  assert.ok(!existsSync(join(dir, 'declared.layout.json')));
  assert.ok(!existsSync(join(dir, 'declared.mp4.part')));
  assert.ok(!existsSync(join(dir, 'declared.mp4')));

  flat('a.html', '#000', 1);   // the layout's frames now match the page
  const out = join(dir, 'declared.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  const layout = JSON.parse(readFileSync(join(dir, 'declared.layout.json'), 'utf8'));
  assert.equal(layout.totalFrames, 45);   // 30 + 30 frames, 15 shared
  assert.equal((await probeVideo(out)).frames, 45);
});

test('project: a scene left with no frames of its own fails before Chrome starts and leaves no file', async () => {
  const proj = join(dir, 'proj-tooshort'), flat = (name, total) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = ${total}; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '#000'; c.fillRect(0, 0, 320, 180); };</script>`);
  mkdirSync(proj);
  flat('a.html', 1); flat('b.html', 0.5); flat('c.html', 1);
  // b.html is 15 frames and hands 15 to the transition into it and 15 to the one out of it: nothing is left.
  // Every scene declares its duration, so the layout is known without a page and Chrome is never started.
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: [{ file: 'a.html', duration: 1 },
    { file: 'b.html', duration: 0.5, transition: { type: 'fade', duration: 0.5 } },
    { file: 'c.html', duration: 1, transition: { type: 'fade', duration: 0.5 } }] }));
  const out = join(dir, 'out', 'tooshort.mp4');
  const log = [];
  await assert.rejects(renderProject({ dir: proj, out, scale: 1, log: line => log.push(line) }),
    /scene 2 \(b\.html\) has 15 frames, but its transitions take 30 \(15 in, 15 out\), leaving -15/);
  // nothing on disk: no MP4, no .part, no layout, and the output folder was not even made
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(out + '.part'));
  assert.ok(!existsSync(join(dir, 'out', 'tooshort.layout.json')));
  assert.ok(!existsSync(join(dir, 'out')), 'the output folder should not be created by a failed layout');
  // and it failed before any render log, so before Chrome
  assert.ok(!log.some(line => /^Scene \d|^GPU:|^Encoder:/.test(line)), `render started before the layout check: ${log.join(' | ')}`);

  // the same project with a scene long enough for its transitions renders and writes the layout beside the MP4
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: [{ file: 'a.html', duration: 1 },
    { file: 'b.html', duration: 1.5, transition: { type: 'fade', duration: 0.5 } },
    { file: 'c.html', duration: 1, transition: { type: 'fade', duration: 0.5 } }] }));
  flat('b.html', 1.5);   // the page agrees with its declared duration
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  const layout = JSON.parse(readFileSync(join(dir, 'out', 'tooshort.layout.json'), 'utf8'));
  assert.deepEqual(layout.scenes.map(s => [s.file, s.start, s.end]), [['a.html', 0, 15], ['b.html', 30, 45], ['c.html', 60, 75]]);
  assert.deepEqual(layout.transitions.map(t => [t.start, t.end]), [[15, 30], [45, 60]]);
  assert.equal(layout.totalFrames, 75);
  assert.equal((await probeVideo(out)).frames, 75);
});

test('project: scenes of different sizes stop the render, and a mono file plays at full level on both channels', async () => {  const proj = join(dir, 'proj2'), flat = (name, w, h) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="${w}" height="${h}"></canvas><script>
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
