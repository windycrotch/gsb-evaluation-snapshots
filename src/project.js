// A project is a folder of scene pages plus a project.json:
//   { "fps": 30, "scenes": ["scenes/01.html", ...], "audio": [{ "file": "audio/music.wav", "start": 0, "volume": 0.8 }] }
// Scenes play back to back in list order. A scene may be { "file": ..., "transition": { "type": "crosswarp",
// "duration": 0.6, "ease": "inOutCubic", "params": {} } }: the previous scene turns into it over that time, so the two
// overlap and the video is that much shorter. Audio files are mixed at their start time (seconds) and volume (1 = as is).
// An audio entry may also be a video file (its sound is used), with optional "from" (seconds into the file) and "duration".
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { changedFiles, checkDeps, hashFile, loadDepRecord, saveDepRecord, sha256 } from './deps.js';
import { finalize, probeVideo, run } from './ffmpeg.js';
import { findTransition, isTransitionFile, parseTransition, transitionHead, transitionProgress, transitionTail } from './page/transitions.js';
import { cacheDir } from './probe.js';
import { renderVideo } from './render.js';

// How many parts render at once without --parallel: 3, fewer on a smaller machine. On the test laptop (16 threads) a
// project of 12 short scenes got faster up to 3 at once and no faster at 4, and 3 Chrome processes rendering 4K used
// about 2.5 GB together, so each part gets 4 threads and 1 GB of free memory. Each part is its own Chrome and encoder.
export const defaultParallel = () => Math.max(1, Math.min(3, Math.floor(availableParallelism() / 4), Math.floor(freemem() / 1e9)));

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// The scenes as { file, transition }, each transition with its length in frames (n): its duration on the frame grid,
// at least 1. The viewer applies the same rule. root: the project folder, where a transition's .glsl file or layer
// module is checked. A layer transition ({ layer, duration }) is drawn over a hard cut instead of mixing two scenes.
export function projectScenes(p, root) {
  return p.scenes.map((s, i) => {
    const scene = typeof s === 'string' ? { file: s } : { ...s };
    if (!scene.file) throw new Error(`scene ${i + 1} has no "file"`);
    const tr = scene.transition;
    if (tr && i === 0) throw new Error(`scene 1 (${scene.file}) has a transition, but there is no scene before it`);
    if (tr) {
      scene.transition = { ease: 'inOutCubic', params: {}, ...tr, n: Math.max(1, Math.round((Number(tr.duration) || 0) * p.fps)) };
      try {
        if (tr.layer !== undefined) {
          if (tr.type !== undefined) throw new Error('a transition has "type" (a shader that mixes the two scenes) or "layer" (a module drawn over the cut), not both');
          if (!/\.m?js$/i.test(String(tr.layer))) throw new Error(`the layer ${tr.layer} must be a .js module that exports draw(ctx, p, W, H)`);
          if (root && !existsSync(join(root, tr.layer))) throw new Error(`the layer file ${tr.layer} does not exist`);
        }
        else if (!isTransitionFile(tr.type)) scene.transition.type = findTransition(tr.type).name;
        else if (root) {   // its uniforms are read here; a GLSL mistake shows when Chrome compiles it, before the first frame
          if (!existsSync(join(root, tr.type))) throw new Error(`the transition file ${tr.type} does not exist`);
          parseTransition(readFileSync(join(root, tr.type), 'utf8'), tr.type);
        }
        transitionProgress(0, 1, scene.transition.ease);
      }
      catch (e) { throw new Error(`scene ${i + 1} (${scene.file}): ${e.message}`); }
    }
    return scene;
  });
}

// A project is named by its folder (which holds project.json) or by a .json file in it, such as storyboard.json.
// Paths inside the file are relative to that folder, and `name` is used for output files.
export function projectPaths(target) {
  const t = resolve(target), isFile = t.toLowerCase().endsWith('.json'), root = isFile ? dirname(t) : t;
  const file = isFile ? t : join(root, 'project.json'), stem = basename(file).replace(/\.json$/i, '');
  if (!existsSync(file)) throw new Error(`no project file at ${file}`);
  return { root, file, name: stem === 'project' ? basename(root) : `${basename(root)}-${stem.replace(/^project-/, '')}` };   // project-tiktok.json: <folder>-tiktok
}

// only: the 1-based scenes to re-render (for example [3], or [3, 5]). The rest come from the cache of scene parts
// in ~/.cache/motlab/parts on macOS and Linux, %LOCALAPPDATA%\motlab\parts on Windows (or MOTLAB_CACHE_DIR),
// which a full render leaves behind; a scene with no cached part is rendered, and the transitions touching a
// re-rendered scene are re-rendered too. The cache key holds the motlab version too, so parts made by an older
// version are rendered again after an update.
// The key also holds every local file the part loaded (deps.js): the page itself, a shared script, a stylesheet, a
// font, a picture, a clip. The renderer records that list on the first render and re-hashes it before any part is
// reused, so a shared file changing re-renders the scenes that load it and the transitions touching them, and a scene
// that does not load it still hits the cache. A part whose recorded dependency is now missing, or whose page fails to
// load one, stops the render with a readable error rather than reusing the old part.
// A finished render removes only the cached parts of this project that this render confirmed stale (it rendered or
// checked every part in the project): parts it did not use because the render stopped early stay for the next run.
// qp and codec: the file size against quality (docs/rendering.md#file-size). They come from the options, else from
// "qp" and "codec" in project.json, so the viewer's Export uses them too, else the encoder's defaults.
export async function renderProject({ dir, out, scale, only, parallel, qp, codec, log = console.log, signal, render = renderVideo }) {   // signal: an AbortSignal that stops the render; render: renderVideo, a seam for tests
  const { root, file, name } = projectPaths(dir);
  dir = root; out = resolve(out || join(dir, 'out', name + '.mp4'));
  const p = JSON.parse(readFileSync(file, 'utf8'));
  qp ??= p.qp; codec ??= p.codec;
  if (qp !== undefined && !(Number.isInteger(qp) && qp >= 0 && qp <= 51)) throw new Error(`qp must be a whole number from 0 to 51, not ${JSON.stringify(qp)}`);
  if (codec !== undefined && !['auto', 'h264', 'hevc'].includes(codec)) throw new Error(`codec must be auto, h264 or hevc, not ${JSON.stringify(codec)}`);
  const tmp = mkdtempSync(join(tmpdir(), 'motlab-project-')), partial = out + '.part';
  try {
    // One MP4 per scene. The first scene picks the encoder and the rest are forced to the same one, so the parts
    // can be joined without re-encoding.
    // A transition is a part of its own between the two scenes: their overlapping frames, mixed by
    // __motlab/transition.html, and left out of the scenes' own parts.
    const parts = [], scenes = projectScenes(p, dir), same = () => parts[0] && { encoder: parts[0].hw ? 'hw' : 'sw', codec: parts[0].codec };
    const used = new Set();   // the cache slots this render used, for pruning the ones it did not
    if (only && only.some(n => !Number.isInteger(n) || n < 1 || n > scenes.length))
      throw new Error(`--only takes scene numbers from 1 to ${scenes.length}`);
    const cacheRoot = join(cacheDir(), 'parts', createHash('sha256').update(file).digest('hex').slice(0, 16));
    const hash = hashFile;
    // A scene page that cannot be read stops the render with its number and file, before any part is rendered.
    const hashes = scenes.map((s, i) => {
      try { return hash(join(dir, s.file)); }
      catch (e) { throw new Error(`scene ${i + 1} (${s.file}) could not be read: ${e.message}`); }
    });
    const key = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
    // A part is reused only when its cached file still probes as the manifest says, its encoder and colour range match
    // the first part (a stream copy join needs the same codec, encoder and resolution), and each file it loaded the
    // last time still has the same contents. A changed, missing or newly failing dependency renders the part again.
    const getPart = async (k, forced, label, log, attempt) => {
      used.add(k);
      const mp4 = join(cacheRoot, k + '.mp4');
      let suffix = ' (no cached part, rendering it)';
      if (!forced) {
        let m = null, rec = null;
        try { m = JSON.parse(readFileSync(join(cacheRoot, k + '.json'), 'utf8')); } catch {}
        try { rec = loadDepRecord(cacheRoot, k); } catch {}
        if (m?.key === k && existsSync(mp4) && rec) {
          const { deps, missing } = checkDeps({ root: dir, deps: rec });
          const changed = missing.length ? [] : changedFiles(rec, deps);
          const list = a => `${a.slice(0, 3).join(', ')}${a.length > 3 ? ` and ${a.length - 3} more` : ''}`;
          if (missing.length) suffix = ` (${list(missing)} ${missing.length === 1 ? 'is' : 'are'} missing, rendering it)`;
          else if (changed.length) suffix = ` (${list(changed)} changed, rendering it)`;
          else {
            const v = await probeVideo(mp4).catch(() => null);
            if (v && v.frames === m.frames && Math.abs(v.duration - m.duration) <= 0.5 / p.fps && v.width === m.width && v.height === m.height
                && (!parts[0] || (m.hw === parts[0].hw && m.codec === parts[0].codec && m.fullRange === parts[0].fullRange))) {
              log(`${label} (cached)`);
              return { out: mp4, width: m.width, height: m.height, duration: m.duration, frames: m.frames, pageFrames: m.pageFrames, fullRange: m.fullRange, codec: m.codec, hw: m.hw };
            }
            suffix = ' (the cached file does not match its manifest, rendering it)';
          }
        }
      }
      log(label + suffix);
      const summary = await attempt();
      try {
        mkdirSync(cacheRoot, { recursive: true });
        writeFileSync(join(cacheRoot, k + '.json'), JSON.stringify({ key: k, codec: summary.codec, hw: summary.hw, fullRange: summary.fullRange,
          width: summary.width, height: summary.height, frames: summary.frames, pageFrames: summary.pageFrames, duration: summary.duration }));
        // The dependency list is saved after the part's own manifest. renderVideo throws instead of returning one
        // when the part's dependencies cannot be seen, so a saved part always has the list its reuse will check.
        saveDepRecord(cacheRoot, k, summary.deps);
      } catch (e) { log(`(could not save the cached part: ${e.message})`); }
      return summary;
    };
    // The parts in order: each scene, and after it the transition into the next one. Scene 1 renders first and
    // alone, because it picks the encoder (and times the encoders on a new machine). The rest render `parallel` at a
    // time, each in its own Chrome; a transition waits for the scene before it, which tells it where that scene ends.
    const jobs = scenes.flatMap((scene, i) => [{ kind: 'scene', i }, ...(scenes[i + 1]?.transition ? [{ kind: 'transition', i }] : [])]);
    const describe = j => {
      const { i, kind } = jobs[j], scene = scenes[i];
      return kind === 'scene' ? `Scene ${i + 1}/${scenes.length} (${scene.file})`
        : `Transition ${i + 1} to ${i + 2} (${scene.file} to ${scenes[i + 1].file}, ${scenes[i + 1].transition.layer ? `layer ${scenes[i + 1].transition.layer}` : scenes[i + 1].transition.type})`;
    };
    // A part's error names the part, so a render that fails says which scene or transition to fix. An error from the
    // dependency check already names it.
    const partError = (e, label) => e?.part ? e
      : Object.assign(new Error(`${label}: ${e?.message || e}`), { cause: e, final: e?.final });
    let progress = true;   // the frame counter on the terminal, off while parts render in parallel
    const renderJob = async (j, log, signal) => {
      const { i } = jobs[j], scene = scenes[i], into = scene.transition, next = scenes[i + 1]?.transition;
      signal.throwIfAborted();
      if (jobs[j].kind === 'scene') {
        const k = key({ kind: 'scene', file: scene.file, hash: hashes[i], fps: p.fps, scale, qp, codec, version: VERSION, head: transitionHead(into), tail: transitionTail(next) });
        const part = await getPart(k, !only || only.includes(i + 1), `\nScene ${i + 1}/${scenes.length}: ${scene.file}`, log, () => render({ page: join(dir, scene.file), root: dir,
          out: join(cacheRoot, k + '.mp4'), fps: p.fps, scale, qp, codec, log, signal, progress, head: transitionHead(into), tail: transitionTail(next),
          collectDeps: true, depWhere: `Scene ${i + 1}/${scenes.length} (${scene.file})`, ...same() }));
        // a stream copy join of parts with different sizes makes an MP4 that changes resolution partway through
        if (parts[0] && (part.width !== parts[0].width || part.height !== parts[0].height))
          throw Object.assign(new Error(`${scene.file} is ${part.width}x${part.height} but ${scenes[0].file} is ${parts[0].width}x${parts[0].height}. All scenes in a project must have the same canvas size`), { final: true });
        return part;
      }
      const from = parts[j - 1];
      const tk = key({ kind: 'transition', from: scene.file, to: scenes[i + 1].file, fromHash: hashes[i], toHash: hashes[i + 1],
        type: next.type, glsl: isTransitionFile(next.type) ? hash(join(dir, next.type)) : undefined, layer: next.layer, layerHash: next.layer ? hash(join(dir, next.layer)) : undefined, n: next.n, ease: next.ease, params: next.params, fps: p.fps, scale, qp, codec, version: VERSION });
      const query = new URLSearchParams({ from: scene.file, to: scenes[i + 1].file, offset: (from.pageFrames - transitionTail(next)) / p.fps, frames: next.n,
        fps: p.fps, ...(next.layer ? { layer: next.layer } : { type: next.type, ease: next.ease, params: JSON.stringify(next.params) }) });
      return getPart(tk, !only || only.includes(i + 1) || only.includes(i + 2), `\nTransition ${i + 1} to ${i + 2}: ${next.layer ? `layer ${next.layer}` : next.type}, ${next.n} frames`, log,
        () => render({ url: '__motlab/transition.html', query: String(query), root: dir, out: join(cacheRoot, tk + '.mp4'),
          fps: p.fps, scale, qp, codec, log, signal, progress, collectDeps: true, depWhere: describe(j), ...same() }));
    };
    // Runs the parts that have no result yet, `width` at a time. When one fails the others are stopped, and the parts
    // that finished stay in `parts` (and in the cache). A part's log is printed in one piece when it ends, so parallel
    // logs do not interleave. Every failing part's error names the part.
    const runAll = async width => {
      const ctrl = new AbortController(), stop = () => ctrl.abort(signal.reason);
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop);   // a render cancelled between the phases must not start one
      let free = width; const waiting = [];
      const slot = () => free > 0 ? (free--, Promise.resolve()) : new Promise(r => waiting.push(r));
      const release = () => waiting.length ? waiting.shift()() : free++;
      const promises = [];
      try {
        for (let j = 0; j < jobs.length; j++) {
          if (parts[j]) { promises.push(Promise.resolve(parts[j])); continue; }
          const before = jobs[j].kind === 'transition' ? promises[j - 1] : null;
          promises.push((async () => {
            if (before) await before;
            await slot();
            const lines = [], out = width > 1 ? l => lines.push(l) : log;
            try { return parts[j] = await renderJob(j, out, ctrl.signal); }
            catch (e) {
              const err = ctrl.signal.aborted ? e : partError(e, describe(j));   // a stopped part failed because of another one
              if (!ctrl.signal.aborted) ctrl.abort(err);
              throw err;
            }
            finally { lines.forEach(l => log(l)); release(); }
          })());
        }
        const failed = (await Promise.allSettled(promises)).find(r => r.status === 'rejected');
        if (failed) throw ctrl.signal.reason ?? failed.reason;   // the first failure, not the ones it caused by stopping the rest
      } finally { signal?.removeEventListener('abort', stop); }
    };
    parts[0] = await renderJob(0, log, signal ?? new AbortController().signal).catch(e => { throw signal?.aborted ? e : partError(e, describe(0)); });
    const width = Math.max(1, Math.min(parallel ?? defaultParallel(), jobs.length - 1));
    if (width > 1) { progress = false; log(`\nRendering ${jobs.length - 1} more parts, ${width} at a time`); }
    try { await runAll(width); }
    catch (e) {
      // Too many Chrome processes for the memory, or more hardware encoder sessions than the GPU allows, show up as a
      // failed part. The parts still missing are rendered one at a time; a part that fails then fails for real, and
      // only that part's error is reported. The parts that finished stay in the cache for the next run.
      if (width === 1 || e.final || signal?.aborted) throw e;
      log(`\nA part failed with ${width} at a time (${String(e?.message || e).split('\n')[0]}). Rendering the remaining parts one at a time.`);
      progress = true; await runAll(1);
    }
    const duration = parts.reduce((sum, s) => sum + s.duration, 0);

    let audio;
    if (p.audio?.length) {
      audio = join(tmp, 'mix.wav');
      // A mono file goes to both channels at full level, as the viewer (WebAudio) plays it. ffmpeg's own up-mix to
      // stereo would put it 3 dB lower.
      const mono = a => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', join(dir, a.file)], { encoding: 'utf8' }).stdout.trim() === '1';
      const chains = p.audio.map((a, i) => `[${i}:a]${mono(a) ? 'pan=stereo|c0=c0|c1=c0,' : ''}adelay=${Math.round((a.start || 0) * 1000)}:all=1,volume=${a.volume ?? 1}[a${i}]`);
      await run('ffmpeg', ['-y', '-loglevel', 'error', ...p.audio.flatMap(a => [...(a.from ? ['-ss', String(a.from)] : []), ...(a.duration ? ['-t', String(a.duration)] : []), '-i', join(dir, a.file)]), '-filter_complex',
        `${chains.join(';')};${p.audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${p.audio.length}:normalize=0[mix]`,
        '-map', '[mix]', '-ar', '48000', '-ac', '2', '-t', duration.toFixed(6), audio], signal);
    }

    // Written beside the output first and renamed when complete, so a stopped or failed render leaves no half file.
    signal?.throwIfAborted();
    mkdirSync(dirname(out), { recursive: true });
    if (parts.some(s => s.fullRange !== parts[0].fullRange)) throw new Error('the scenes were encoded with different colour ranges');
    await finalize({ inputs: parts.map(s => s.out), codec: parts[0].codec, fps: p.fps, audio, out: partial, duration, tmp, signal, fullRange: parts[0].fullRange });
    rmSync(out, { force: true }); renameSync(partial, out);
    // Parts from earlier edits that this render did not use would pile up: one scene edited three times leaves
    // three versions of its part. Once the whole render is done (every part present, joined and checked), the cache
    // keys of the parts this run did not use are the ones this project no longer needs. A failed or cancelled render
    // never gets here, so the parts already finished stay for the next run.
    let pruned = 0;
    try {
      const stale = [...new Set(readdirSync(cacheRoot).map(f => f.match(/^([0-9a-f]{64})\.(mp4|json)$/)?.[1]).filter(Boolean))].filter(k => !used.has(k));
      for (const k of stale) {
        rmSync(join(cacheRoot, k + '.mp4'), { force: true }); rmSync(join(cacheRoot, k + '.json'), { force: true });
        rmSync(join(cacheRoot, 'deps', sha256(k) + '.json'), { force: true });
        pruned++;
      }
    } catch {}
    if (pruned) log(`(removed ${pruned} unused cached part${pruned === 1 ? '' : 's'})`);
    log(`\nSAVED ${out} (${scenes.length} scenes${parts.length > scenes.length ? `, ${parts.length - scenes.length} transitions` : ''}, ${duration.toFixed(3)} s${audio ? `, ${p.audio.length} audio files` : ''})`);
  } finally { rmSync(partial, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}
