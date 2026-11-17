// A project is a folder of scene pages plus a project.json:
//   { "fps": 30, "scenes": ["scenes/01.html", ...], "audio": [{ "file": "audio/music.wav", "start": 0, "volume": 0.8 }] }
// Scenes play back to back in list order. A scene may be { "file": ..., "duration": 2.5, "transition": { "type": "crosswarp",
// "duration": 0.6, "ease": "inOutCubic", "params": {} } }: the previous scene turns into it over that time, so the two
// overlap and the video is that much shorter. A scene's own "duration" (seconds, its page's TOTAL) is optional; it lets
// the whole frame layout be checked before Chrome starts, instead of reading each page's TOTAL first.
// Audio files are mixed at their start time (seconds) and volume (1 = as is). An audio entry may also be a video file
// (its sound is used), with optional "from" (seconds into the file) and "duration".
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { frameCount } from './codecs.js';
import { finalize, probeVideo, run } from './ffmpeg.js';
import { findTransition, transitionProgress } from './page/transitions.js';
import { measureTotals, renderVideo } from './render.js';

// The scenes as { file, transition }, each transition with its length in frames (n): its duration on the frame grid,
// at least 1. The viewer applies the same rule. A scene may also declare its own length in seconds ("duration"), kept
// as declaredFrames and checked against the page's TOTAL when the scene renders.
export function projectScenes(p) {
  return p.scenes.map((s, i) => {
    const scene = typeof s === 'string' ? { file: s } : { ...s };
    if (!scene.file) throw new Error(`scene ${i + 1} has no "file"`);
    const tr = scene.transition;
    if (tr && i === 0) throw new Error(`scene 1 (${scene.file}) has a transition, but there is no scene before it`);
    if (scene.duration !== undefined) {
      const seconds = Number(scene.duration), n = frameCount(seconds, p.fps);
      if (!Number.isFinite(seconds) || seconds <= 0 || n < 1) throw new Error(`scene ${i + 1} (${scene.file}): "duration" must be a positive number of seconds`);
      scene.declaredFrames = n;
    }
    if (tr) {
      scene.transition = { ease: 'inOutCubic', params: {}, ...tr, n: Math.max(1, Math.round((Number(tr.duration) || 0) * p.fps)) };
      try { scene.transition.type = findTransition(tr.type).name; transitionProgress(0, 1, scene.transition.ease); }
      catch (e) { throw new Error(`scene ${i + 1} (${scene.file}): ${e.message}`); }
    }
    return scene;
  });
}

// A scene's own length in frames, read without a browser when the page can be: "duration" in project.json first, then
// a `window.TOTAL = <number>` literal in the page, or a name bound to one (`const END = 8; window.TOTAL = END;` as the
// skill's templates do). Anything else (a TOTAL computed at run time, as the example's `scene(total, ...)` helper does)
// is measured with a browser instead. Reading it from the file is what lets a project whose scenes are too short for
// their transitions fail before Chrome starts. Comments are ignored, and the value must stand alone (`TOTAL = 1.5 * fps`
// is not a literal the layout can trust). A wrong guess is caught by renderVideo, which compares the layout with the
// page's real TOTAL.
const NUM = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
export function readTotal(html) {
  const code = String(html).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = new RegExp(String.raw`window\s*\.\s*TOTAL\s*=\s*(-?${NUM}|[A-Za-z_$][\w$]*)\s*(?:[;<\n}]|$)`).exec(code);
  if (!m) return undefined;
  if (!/^[A-Za-z_$]/.test(m[1])) return Number(m[1]);
  // A name the page binds to a literal, as the skill's templates do (`const END = 8; window.TOTAL = END;`). A name bound
  // to anything else (the example's `scene(total, ...)` parameter) is left to the browser.
  const name = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*(-?${NUM})\s*(?:[;,\n}]|$)`, 'g');
  let last;
  for (let d; (d = decl.exec(code));) last = d[1];
  return last === undefined ? undefined : Number(last);
}

// One entry per scene: { frames, from }, where from is 'duration' (project.json), 'TOTAL' (a literal in the page),
// 'measure' (the page computes it; a browser reads it) or 'bad' (a TOTAL that is not a positive number).
export function sceneFrameCounts(p, scenes = projectScenes(p), readFile = f => readFileSync(f, 'utf8')) {
  return scenes.map((scene, i) => {
    if (scene.declaredFrames !== undefined) return { frames: scene.declaredFrames, from: 'duration' };
    let html; try { html = readFile(join(p.root, scene.file)); } catch (e) { throw new Error(`scene ${i + 1} (${scene.file}) could not be read: ${e.message}`); }
    const total = readTotal(html);
    return total > 0 ? { frames: frameCount(total, p.fps), from: 'TOTAL' } : { from: total === undefined ? 'measure' : 'bad', total };
  });
}

// The frame layout of the finished video, from the scenes and their own frame counts (what each page's TOTAL works out
// to). Every scene keeps its frames minus the transitions it takes part in, and each transition gets the frames the two
// scenes hand over. The result is a list of [start, end) ranges that covers the timeline in order, with no gap and no
// overlap: scenes in `scenes`, transitions in `transitions`, and `totalFrames` at the end. A scene left with no frame of
// its own stops the render here, naming the scene, before anything is encoded.
export function projectLayout(p, frames, scenes = projectScenes(p)) {
  if (!Array.isArray(frames) || frames.length !== scenes.length) throw new Error(`the layout needs one frame count per scene (${scenes.length})`);
  const layout = { fps: p.fps, totalFrames: 0, scenes: [], transitions: [] };
  let at = 0;
  for (const [i, scene] of scenes.entries()) {
    const page = frames[i];
    if (!Number.isInteger(page) || page < 1) throw new Error(`scene ${i + 1} (${scene.file}) has ${page} frames; a scene needs at least 1`);
    const into = scene.transition?.n || 0, out = scenes[i + 1]?.transition?.n || 0, own = page - into - out;
    if (own < 1) throw new Error(`scene ${i + 1} (${scene.file}) has ${page} frames, but its transitions take ${into + out} (${into} in, ${out} out), leaving ${own}. A scene must keep at least 1 frame of its own: shorten the transitions or make the scene longer`);
    layout.scenes.push({ file: scene.file, start: at, end: at + own, frames: own, pageFrames: page, transitionIn: into, transitionOut: out });
    at += own;
    const next = scenes[i + 1]?.transition;
    if (next) {
      layout.transitions.push({ type: next.type, from: scene.file, to: scenes[i + 1].file, start: at, end: at + next.n, frames: next.n, duration: next.duration, ease: next.ease });
      at += next.n;
    }
  }
  layout.totalFrames = at;
  // Built in one pass, so the ranges are contiguous by construction; this checks the arithmetic the render relies on.
  const all = [...layout.scenes, ...layout.transitions].sort((a, b) => a.start - b.start);
  let reach = 0;
  for (const item of all) {
    if (item.start !== reach || !(item.end > item.start)) throw new Error(`internal: the layout for ${item.type || item.file} is ${item.start}-${item.end}, which does not continue from ${reach}`);
    reach = item.end;
  }
  if (reach !== layout.totalFrames) throw new Error(`internal: the layout ends at ${reach} but counts ${layout.totalFrames} frames`);
  return layout;
}

// Where the layout of a render goes: beside the MP4, with the same name and .layout.json (out/promo.mp4 -> out/promo.layout.json).
export const layoutPath = out => join(dirname(out), `${basename(out).replace(/\.[^.\\/]+$/, '')}.layout.json`);

// A project is named by its folder (which holds project.json) or by a .json file in it, such as storyboard.json.
// Paths inside the file are relative to that folder, and `name` is used for output files.
export function projectPaths(target) {
  const t = resolve(target), isFile = t.toLowerCase().endsWith('.json'), root = isFile ? dirname(t) : t;
  const file = isFile ? t : join(root, 'project.json'), stem = basename(file).replace(/\.json$/i, '');
  if (!existsSync(file)) throw new Error(`no project file at ${file}`);
  return { root, file, name: stem === 'project' ? basename(root) : `${basename(root)}-${stem.replace(/^project-/, '')}` };   // project-tiktok.json: <folder>-tiktok
}

export async function renderProject({ dir, out, scale, log = console.log, signal, chrome }) {   // signal: an AbortSignal that stops the render
  const { root, file, name } = projectPaths(dir);
  dir = root; out = resolve(out || join(dir, 'out', name + '.mp4'));
  const p = JSON.parse(readFileSync(file, 'utf8')), tmp = mkdtempSync(join(tmpdir(), 'motlab-project-')), partial = out + '.part';
  try {
    // The whole timeline is laid out before anything renders. A scene that declares "duration", or whose page sets
    // window.TOTAL to a literal, needs no browser to know how long it is; the rest are measured with one Chrome that
    // only reads window.TOTAL. Either way every scene's own frames are known before the first frame is encoded, and a
    // project that can be laid out from its files fails before Chrome starts.
    const scenes = projectScenes(p), layoutFile = layoutPath(out), counts = sceneFrameCounts({ ...p, root: dir }, scenes);
    const bad = counts.map((c, i) => [c, i]).filter(([c]) => c.from === 'bad');
    if (bad.length) throw new Error(`scene ${bad[0][1] + 1} (${scenes[bad[0][1]].file}): window.TOTAL must be a positive number of seconds (it is ${bad[0][0].total})`);
    const measure = counts.map((c, i) => [c, i]).filter(([c]) => c.from === 'measure').map(([, i]) => scenes[i]);
    if (measure.length) log(`Measuring ${measure.length} scene${measure.length === 1 ? '' : 's'} (window.TOTAL) for the layout`);
    const measured = measure.length ? await measureTotals({ root: dir, pages: measure, chrome }) : [];
    const measuredBy = new Map(measure.map((s, i) => [s.file, measured[i]]));
    const layout = projectLayout(p, scenes.map((s, i) => counts[i].frames ?? frameCount(measuredBy.get(s.file), p.fps)), scenes);
    log(`Layout: ${layout.scenes.length} scenes, ${layout.transitions.length} transitions, ${layout.totalFrames} frames at ${p.fps} fps`);
    for (const s of layout.scenes) log(`  ${s.file}: frames ${s.start} to ${s.end} (${s.frames} of ${s.pageFrames}${s.transitionIn || s.transitionOut ? `, ${s.transitionIn} in and ${s.transitionOut} out handed to transitions` : ''})`);
    for (const t of layout.transitions) log(`  ${t.type}: frames ${t.start} to ${t.end} (${t.frames}, ${t.from} -> ${t.to})`);
    signal?.throwIfAborted();

    // One MP4 per scene. The first scene picks the encoder and the rest are forced to the same one, so the parts
    // can be joined without re-encoding.
    // A transition is a part of its own between the two scenes: their overlapping frames, mixed by
    // __motlab/transition.html, and left out of the scenes' own parts.
    const parts = [], same = () => parts[0] && { encoder: parts[0].hw ? 'hw' : 'sw', codec: parts[0].codec };
    for (const [i, scene] of scenes.entries()) {
      const into = scene.transition, next = scenes[i + 1]?.transition, slot = layout.scenes[i];
      signal?.throwIfAborted();
      log(`\nScene ${i + 1}/${scenes.length}: ${scene.file}`);
      const part = await renderVideo({ page: join(dir, scene.file), root: dir, out: join(tmp, `${parts.length}.mp4`), fps: p.fps, scale, log, signal,
        head: into?.n, tail: next?.n, expectFrames: slot.pageFrames, expectLabel: scene.file, ...same() });
      // a stream copy join of parts with different sizes makes an MP4 that changes resolution partway through
      if (parts[0] && (part.width !== parts[0].width || part.height !== parts[0].height))
        throw new Error(`${scene.file} is ${part.width}x${part.height} but ${scenes[0].file} is ${parts[0].width}x${parts[0].height}. All scenes in a project must have the same canvas size`);
      if (part.pageFrames !== slot.pageFrames)
        throw new Error(`${scene.file} has ${part.pageFrames} frames at ${p.fps} fps, but the layout was made for ${slot.pageFrames}. Its TOTAL changed while the project rendered`);
      if (part.frames !== slot.frames)
        throw new Error(`${scene.file} put ${part.frames} frames in its own part, but the layout gives it ${slot.frames}. Check its transitions`);
      parts.push(part);
      if (!next) continue;
      log(`\nTransition ${i + 1} to ${i + 2}: ${next.type}, ${next.n} frames`);
      const query = new URLSearchParams({ from: scene.file, to: scenes[i + 1].file, offset: (part.pageFrames - next.n) / p.fps, frames: next.n,
        fps: p.fps, type: next.type, ease: next.ease, params: JSON.stringify(next.params) });
      const transition = await renderVideo({ url: '__motlab/transition.html', query: String(query), root: dir, out: join(tmp, `${parts.length}.mp4`),
        fps: p.fps, scale, log, signal, ...same() });
      if (transition.frames !== next.n) throw new Error(`the transition from ${scene.file} to ${scenes[i + 1].file} rendered ${transition.frames} frames, but the layout gives it ${next.n}`);
      parts.push(transition);
    }
    // The layout, not the parts, decides the length: every part was checked against it above.
    const duration = layout.totalFrames / p.fps;

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
    // The finished file must be the layout: same frame count, same length. Checked on the .part, so a mismatch leaves
    // neither an MP4 nor a layout behind.
    const v = await probeVideo(partial);
    if (v.frames !== layout.totalFrames || Math.abs(v.duration - duration) > 0.5 / p.fps)
      throw new Error(`output check failed: ${v.frames} frames, ${v.duration} s; the layout says ${layout.totalFrames} frames, ${duration} s (${out})`);
    rmSync(out, { force: true }); renameSync(partial, out);
    // After the MP4 is in place: the layout describes a file that exists.
    writeFileSync(layoutFile, JSON.stringify(layout, null, 2) + '\n');
    log(`\nSAVED ${out} (${scenes.length} scenes${parts.length > scenes.length ? `, ${parts.length - scenes.length} transitions` : ''}, ${duration.toFixed(3)} s${audio ? `, ${p.audio.length} audio files` : ''}; layout in ${layoutFile})`);
  } finally { rmSync(partial, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}
