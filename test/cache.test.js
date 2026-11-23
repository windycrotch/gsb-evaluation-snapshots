// The project cache around a part: a part notices a shared file changing (deps.js), a parallel failure falls back to
// one part at a time, a real failure names its part and leaves no output, a cancelled render leaves nothing behind,
// and the prune removes only the parts this render confirmed stale. Most tests use a fake `render` so they run without
// Chrome; the last two render real pages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { checkDeps, changedFiles, hashFile, loadDepRecord, loadedFiles, saveDepRecord, sha256 } from '../src/deps.js';
import { renderProject } from '../src/project.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-cache-test-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');   // keep these out of the real cache
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {} };
const projectCache = proj => join(dir, 'cache', 'parts', createHash('sha256').update(join(proj, 'project.json')).digest('hex').slice(0, 16));
const partFiles = proj => { try { return readdirSync(projectCache(proj)).filter(f => f.endsWith('.mp4')).map(f => f.slice(0, 64)).sort(); } catch { return []; } };

// A project of flat-colour scenes: each loads the shared lib.js and its own page file.
let n = 0;
const scene = colour => `<!doctype html><canvas id="c" width="64" height="64"></canvas><script src="lib.js"></script><script>
  const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
  window.renderAt = () => { c.fillStyle = ${JSON.stringify(colour)}; c.fillRect(0, 0, 64, 64); };</script>`;
function project(scenes = 2, { transition = null } = {}) {
  const proj = join(dir, `p${++n}`), list = [];
  mkdirSync(proj);
  writeFileSync(join(proj, 'lib.js'), 'window.SHARED = "#000";\n');
  for (let i = 0; i < scenes; i++) {
    const file = `s${i + 1}.html`;
    writeFileSync(join(proj, file), scene(`#${(i + 1).toString(16).repeat(3)}`));
    list.push(i && transition ? { file, transition } : file);
  }
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: list }));
  return proj;
}

// A fake renderer: records the pages it drew, fails the ones the test names, and writes a real (tiny) MP4 at the
// part's path, so the project's stream-copy join and the cache's probe both work without Chrome. Its dependency list
// is the pages it says it loaded: the page file and lib.js for a scene, both scene pages for a transition.
const template = join(dir, 'part-template.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', template]);
function fakeRender({ fail = () => false, loads = null } = {}) {
  const calls = [];
  const render = async o => {
    const kind = o.page ? o.page.split(/[\\/]/).pop() : 'transition';
    calls.push(kind);
    if (fail(kind)) throw new Error(`${kind} is broken`);
    if (o.signal?.aborted) o.signal.throwIfAborted();
    mkdirSync(dirname(o.out), { recursive: true });
    copyFileSync(template, o.out);
    const pages = loads ? loads(kind, o) : o.page ? [kind, 'lib.js'] : ['s1.html', 's2.html', 'lib.js'];
    return { out: o.out, width: 64, height: 64, duration: 1, frames: 30, pageFrames: 30, fullRange: false, codec: 'h264', hw: false,
      deps: o.collectDeps ? pages.map(p => ({ path: p, hash: hashFile(join(o.root, p)) })) : undefined };
  };
  return { render, calls };
}

// --- deps.js on its own ---

test('deps: the page requests become the local files it loaded, and the engine\'s own files are left out', () => {
  const proj = project(1), origin = 'http://127.0.0.1:1234', base = origin + '/__motlab/abc123';
  mkdirSync(join(proj, 'assets'));
  writeFileSync(join(proj, 'assets', 'pic.png'), 'not really a png');
  const requests = [
    { url: `${origin}/s1.html`, method: 'GET', status: 200 },
    { url: `${origin}/lib.js`, method: 'GET', status: 200 },
    { url: `${origin}/assets/pic.png`, method: 'GET', status: 200 },
    { url: `${origin}/assets/pic.png`, method: 'GET', status: 206 },             // a range read: still one file
    { url: `${origin}/__motlab/transitions.js`, method: 'GET', status: 200 },    // the engine's own
    { url: `${base}/write?id=1`, method: 'POST', status: 204 },                  // an upload to the private prefix
    { url: 'https://example.com/x.js', method: 'GET', status: 200 },             // not local
  ];
  const deps = loadedFiles({ requests, origin, base, root: proj, where: 'Scene 1' });
  assert.deepEqual(deps.map(d => d.path), ['assets/pic.png', 'lib.js', 's1.html']);
  assert.equal(deps.find(d => d.path === 'lib.js').hash, hashFile(join(proj, 'lib.js')));
});

test('deps: a file that 404s, lies outside the project, or is unreadable fails with the part and the file named', () => {
  const proj = project(1), origin = 'http://127.0.0.1:1234', base = origin + '/__motlab/abc';
  assert.throws(() => loadedFiles({ requests: [{ url: `${origin}/missing.js`, method: 'GET', status: 404 }], origin, base, root: proj, where: 'Scene 2 (s2.html)' }),
    /Scene 2 \(s2\.html\) loads missing\.js, which did not load \(missing from the project folder\)/);
  assert.throws(() => loadedFiles({ requests: [{ url: `${origin}/..%2Foutside.js`, method: 'GET', status: 200 }], origin, base, root: proj, where: 'Scene 2' }),
    /outside the project folder/);
  const e = (() => { try { loadedFiles({ requests: [{ url: `${origin}/gone.js`, method: 'GET', status: 200 }], origin, base, root: proj, where: 'Scene 2' }); } catch (x) { return x; } })();
  assert.match(e.message, /Scene 2 loads gone\.js, which is missing/);
  assert.equal(e.part, true);   // the message already names the part, so it is reported as it is
  assert.equal(e.final, true);  // and a retry alone cannot make a missing file appear
});

test('deps: a re-hashed list reports the changed and missing files', () => {
  const proj = project(1);
  const before = [{ path: 'lib.js', hash: hashFile(join(proj, 'lib.js')) }, { path: 's1.html', hash: hashFile(join(proj, 's1.html')) }];
  assert.deepEqual(changedFiles(before, checkDeps({ root: proj, deps: before }).deps), []);
  writeFileSync(join(proj, 'lib.js'), 'changed\n');
  assert.deepEqual(changedFiles(before, checkDeps({ root: proj, deps: before }).deps), ['lib.js']);
  rmSync(join(proj, 's1.html'));
  assert.deepEqual(checkDeps({ root: proj, deps: before }).missing, ['s1.html']);
});

test('deps: a record saved beside a part is read back, and a table with a bad entry returns nothing to trust', () => {
  const root = join(dir, 'recs'), slot = 'f'.repeat(64);
  saveDepRecord(root, slot, [{ path: 'a.js', hash: 'abc' }]);
  assert.deepEqual(loadDepRecord(root, slot), [{ path: 'a.js', hash: 'abc' }]);
  writeFileSync(join(root, 'deps', sha256(slot) + '.json'), JSON.stringify({ deps: [{ path: 3 }] }));
  assert.deepEqual(loadDepRecord(root, slot), []);
  rmSync(join(root, 'deps', sha256(slot) + '.json'));
  assert.equal(loadDepRecord(root, slot), null);
});

// --- renderProject with a fake renderer ---

test('cache: --only hits the cache, and a changed shared script re-renders the scenes that load it and not the others', async () => {
  const proj = project(3), { render } = fakeRender({ loads: kind => kind === 's3.html' ? [kind] : [kind, 'lib.js'] });
  const logs = [], run = o => renderProject({ dir: proj, scale: 1, render, log: l => logs.push(String(l)), ...o });
  await run({ out: join(proj, 'out', '1.mp4') });
  logs.length = 0;
  await run({ out: join(proj, 'out', '2.mp4'), only: [2] });
  let seen = logs.join('\n');
  assert.match(seen, /Scene 1\/3: s1\.html \(cached\)/, seen);
  assert.match(seen, /Scene 3\/3: s3\.html \(cached\)/, seen);
  assert.match(seen, /Scene 2\/3: s2\.html \(no cached part, rendering it\)/, seen);
  // lib.js changes: the two scenes that load it are rendered again, the third still hits the cache
  logs.length = 0;
  writeFileSync(join(proj, 'lib.js'), 'window.SHARED = "#111";\n');
  await run({ out: join(proj, 'out', '3.mp4'), only: [2] });
  seen = logs.join('\n');
  assert.match(seen, /Scene 1\/3: s1\.html \(lib\.js changed, rendering it\)/, seen);
  assert.match(seen, /Scene 3\/3: s3\.html \(cached\)/, seen);
});

test('cache: a changed shared file re-renders only the scenes that load it and the transitions touching them', async () => {
  const proj = project(3, { transition: { type: 'fade', duration: 0.5 } });
  // own.js is loaded by scene 3 only, so a change to it must not touch scenes 1 and 2 or the transition between them
  writeFileSync(join(proj, 'own.js'), 'const own = 1;\n');
  writeFileSync(join(proj, 's3.html'), readFileSync(join(proj, 's3.html'), 'utf8').replace('<script src="lib.js"', '<script src="own.js"></script><script src="lib.js"'));
  const loads = kind => kind === 'transition' ? ['s2.html', 's3.html', 'own.js', 'lib.js'] : kind === 's3.html' ? ['s3.html', 'own.js', 'lib.js'] : [kind, 'lib.js'];
  const { render, calls } = fakeRender({ loads });
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, parallel: 2, render, ...quiet });
  writeFileSync(join(proj, 'own.js'), 'const own = 2;\n');
  const first = calls.length;
  const logs = [];
  // --only is what reads the cache; scene 1 (named) and the transition into it are rendered by that rule
  await renderProject({ dir: proj, out: join(proj, 'out', '2.mp4'), scale: 1, parallel: 2, only: [1], render, log: l => logs.push(String(l)) });
  const seen = logs.join('\n');
  assert.match(seen, /Scene 1\/3: s1\.html \(no cached part, rendering it\)/, seen);   // named by --only, so rendered
  assert.match(seen, /Scene 2\/3: s2\.html \(cached\)/, seen);
  assert.match(seen, /Scene 3\/3: s3\.html \(own\.js changed, rendering it\)/, seen);
  assert.match(seen, /Transition 1 to 2: fade, 15 frames \(no cached part, rendering it\)/, seen);
  assert.match(seen, /Transition 2 to 3: fade, 15 frames \(own\.js changed, rendering it\)/, seen);
  assert.equal(calls.length - first, 4, `rendered: ${calls.slice(first).join(', ')}`);
});

test('cache: a dependency that disappears renders the part again, and a part that still loads it fails with no output', async () => {
  const proj = project(1), calls = [];
  const render = async o => {
    calls.push(o.page);
    if (!existsSync(join(proj, 'lib.js')))   // what the real render does when the page's <script src> is gone
      throw Object.assign(new Error(`Scene 1/1 (s1.html) loads lib.js, which is missing`), { part: true });
    mkdirSync(dirname(o.out), { recursive: true });
    copyFileSync(template, o.out);
    return { out: o.out, width: 64, height: 64, duration: 1, frames: 30, pageFrames: 30, fullRange: false, codec: 'h264', hw: false,
      deps: o.collectDeps ? [{ path: 's1.html', hash: hashFile(join(proj, 's1.html')) }, { path: 'lib.js', hash: hashFile(join(proj, 'lib.js')) }] : undefined };
  };
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, render, ...quiet });
  assert.equal(calls.length, 1);
  rmSync(join(proj, 'lib.js'));
  await assert.rejects(renderProject({ dir: proj, out: join(proj, 'out', '2.mp4'), scale: 1, only: [1], render, ...quiet }),
    /Scene 1\/1 \(s1\.html\) loads lib\.js, which is missing/);
  assert.equal(calls.length, 2, 'it was rendered again, not served from the cache');
  assert.ok(!existsSync(join(proj, 'out', '2.mp4')));
});

test('cache: a finished render removes the parts under old keys, and a failed one leaves every finished part', async () => {
  const proj = project(2), { render } = fakeRender();
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, render, ...quiet });
  assert.equal(partFiles(proj).length, 2);
  const old = partFiles(proj);
  writeFileSync(join(proj, 's1.html'), scene('#abc'));
  // a render that writes scene 1's new part and then fails: the old parts must stay for the next run
  await assert.rejects(renderProject({ dir: proj, out: join(proj, 'out', '2.mp4'), scale: 1, only: [1],
    render: async o => { await render(o); throw new Error('stopped after the part was written'); }, ...quiet }), /stopped after the part was written/);
  assert.equal(partFiles(proj).length, 3, 'the failed render kept the parts it had');
  assert.deepEqual(old.filter(k => !partFiles(proj).includes(k)), []);
  await renderProject({ dir: proj, out: join(proj, 'out', '3.mp4'), scale: 1, render, ...quiet });
  assert.equal(partFiles(proj).length, 2, 'the finished render removed the part under the old key');
  assert.ok(!old.includes(partFiles(proj).find(k => !old.includes(k))), 'a new key, not an old one');
});

test('cache: the dependency record of a pruned part is removed with it', async () => {
  const proj = project(1), { render } = fakeRender();
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, render, ...quiet });
  const [old] = partFiles(proj);
  assert.ok(existsSync(join(projectCache(proj), 'deps', sha256(old) + '.json')));
  writeFileSync(join(proj, 's1.html'), scene('#def'));
  await renderProject({ dir: proj, out: join(proj, 'out', '2.mp4'), scale: 1, render, ...quiet });
  assert.ok(!existsSync(join(projectCache(proj), 'deps', sha256(old) + '.json')));
});

test('parallel: a part that fails with several at once is retried alone and succeeds, and the finished parts stay', async () => {
  const proj = project(4);
  let concurrent = 0, peak = 0;
  // s2 fails only while it runs beside another part: the memory / encoder-session case, gone once it is alone
  const { render: bad } = fakeRender({ fail: page => page === 's2.html' && concurrent > 1 });
  const render = async o => { concurrent++; peak = Math.max(peak, concurrent); try { await new Promise(r => setTimeout(r, 20)); return await bad(o); } finally { concurrent--; } };
  const logs = [];
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, parallel: 3, render, log: l => logs.push(String(l)) });
  const seen = logs.join('\n');
  assert.ok(peak >= 2, `peak concurrency ${peak}`);
  assert.match(seen, /Rendering the remaining parts one at a time/, seen);
  assert.match(seen, /Scene 2\/4: s2\.html \(no cached part, rendering it\)[\s\S]*Scene 2\/4: s2\.html \(no cached part, rendering it\)/, seen);   // rendered twice
  assert.equal(partFiles(proj).length, 4);
});

test('parallel: a part that fails alone names itself, makes no output, and leaves the finished parts cached', async () => {
  const proj = project(4, { transition: { type: 'fade', duration: 0.5 } });
  const { render } = fakeRender({ fail: page => page === 's3.html' });
  let message = '';
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, parallel: 2, render, ...quiet }).catch(e => { message = e.message; });
  assert.match(message, /Scene 3\/4 \(s3\.html\): s3\.html is broken/, message);
  assert.ok(!existsSync(join(proj, 'out', '1.mp4')), 'no output on a real failure');
  assert.ok(partFiles(proj).length >= 2, `cached parts: ${partFiles(proj).length}`);
});

test('cancel: an abort leaves no .part, no temp folder and no output, and keeps the parts already cached', async () => {
  const proj = project(3), ctrl = new AbortController();
  const temps = () => readdirSync(tmpdir()).filter(f => f.startsWith('motlab-project-')).length;
  const before = temps();
  const { render } = fakeRender();
  const cancelling = async o => { if (o.page?.endsWith('s2.html')) ctrl.abort(new Error('the user cancelled')); return render(o); };
  await assert.rejects(renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, render: cancelling, signal: ctrl.signal, ...quiet }), /cancelled/);
  assert.ok(!existsSync(join(proj, 'out', '1.mp4')));
  assert.ok(!existsSync(join(proj, 'out', '1.mp4.part')));
  assert.equal(partFiles(proj).length, 1, 'scene 1 finished before the abort and stays');
  assert.equal(temps(), before, 'no project temp folder left behind');
});

// --- real pages: what a shared file does to the pixels in the final MP4 ---

test('real: editing a shared script re-renders the scenes that load it and leaves the one that does not on the cache', async () => {
  const { probeVideo } = await import('../src/ffmpeg.js');
  const proj = join(dir, 'real-shared');
  mkdirSync(proj);
  // three scenes load shared.js; the fourth draws on its own and does not load it
  writeFileSync(join(proj, 'shared.js'), `const c = document.getElementById('c').getContext('2d');
    window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = window.SHARED || '#000'; c.fillRect(0, 0, 320, 180); };`);
  for (const [file, colour] of [['a.html', '#101'], ['b.html', '#00f'], ['c.html', '#0cc']]) writeFileSync(join(proj, file),
    `<!doctype html><canvas id="c" width="320" height="180"></canvas><script src="shared.js"></script><script>window.SHARED = '${colour}';</script>`);
  writeFileSync(join(proj, 'solo.html'), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '#0f0'; c.fillRect(0, 0, 320, 180); };</script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html', 'c.html', 'solo.html'] }));
  const logs = [], run = o => renderProject({ dir: proj, scale: 1, log: l => logs.push(String(l)), ...o });
  await run({ out: join(proj, 'out', '1.mp4'), parallel: 2 });
  // the shared script now paints red, so the three scenes that load it change; solo.html stays green
  writeFileSync(join(proj, 'shared.js'), readFileSync(join(proj, 'shared.js'), 'utf8').replace("window.SHARED || '#000'", "'#f00'"));
  logs.length = 0;
  // --only 1: scene 1 is rendered by that rule, and the rest are checked against the cache, which is where the
  // dependency list does its work for scenes 2 and 3, and where solo.html must still hit it
  await run({ out: join(proj, 'out', '2.mp4'), parallel: 2, only: [1] });
  const seen = logs.join('\n');
  assert.match(seen, /Scene 2\/4: b\.html \(shared\.js changed, rendering it\)/, seen);
  assert.match(seen, /Scene 3\/4: c\.html \(shared\.js changed, rendering it\)/, seen);
  assert.match(seen, /Scene 4\/4: solo\.html \(cached\)/, seen);
  // and the file really shows the new colour, not the old cached frames
  assert.equal((await probeVideo(join(proj, 'out', '2.mp4'))).frames, 120);
  const mean = (file, frame) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),crop=64:64:64:40,scale=1:1:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']); return [...r.stdout.subarray(0, 3)]; };
  const px = mean(join(proj, 'out', '2.mp4'), 45);   // frame 45 is inside scene 2, re-rendered from the dependency list
  assert.ok(px[0] > 200 && px[1] < 60 && px[2] < 60, `frame 45 is ${px}`);
});

test('real: a script the page loads that is gone fails with the file named, and does not reuse the old cached part', async () => {
  const proj = join(dir, 'real-missing');
  mkdirSync(proj);
  writeFileSync(join(proj, 'extra.js'), 'window.EXTRA = 1;');
  writeFileSync(join(proj, 'a.html'), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script src="extra.js"></script><script>
    const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
    window.renderAt = () => { c.fillStyle = '#123'; c.fillRect(0, 0, 320, 180); };</script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html'] }));
  await renderProject({ dir: proj, out: join(proj, 'out', '1.mp4'), scale: 1, ...quiet });
  assert.equal(partFiles(proj).length, 1);
  rmSync(join(proj, 'extra.js'));   // the page is unchanged, so only the dependency list can notice this
  let message = '';
  await renderProject({ dir: proj, out: join(proj, 'out', '2.mp4'), scale: 1, ...quiet }).catch(e => { message = e.message; });
  assert.match(message, /Scene 1\/1 \(a\.html\).*extra\.js/, message);
  assert.match(message, /did not load|missing/, message);
  assert.ok(!existsSync(join(proj, 'out', '2.mp4')));
});
