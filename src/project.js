// A project is a folder of scene pages plus a project.json:
//   { "fps": 30, "scenes": ["scenes/01.html", ...], "audio": [{ "file": "audio/music.wav", "start": 0, "volume": 0.8 }] }
// Scenes play back to back in list order. A scene may be { "file": ..., "transition": { "type": "crosswarp",
// "duration": 0.6, "ease": "inOutCubic", "params": {} } }: the previous scene turns into it over that time, so the two
// overlap and the video is that much shorter. Audio files are mixed at their start time (seconds) and volume (1 = as is).
// An audio entry may also be a video file (its sound is used), with optional "from" (seconds into the file) and "duration".
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { finalize, run } from './ffmpeg.js';
import { findTransition, transitionProgress } from './page/transitions.js';
import { renderVideo } from './render.js';

// The scenes as { file, transition }, each transition with its length in frames (n): its duration on the frame grid,
// at least 1. The viewer applies the same rule.
export function projectScenes(p) {
  return p.scenes.map((s, i) => {
    const scene = typeof s === 'string' ? { file: s } : { ...s };
    if (!scene.file) throw new Error(`scene ${i + 1} has no "file"`);
    const tr = scene.transition;
    if (tr && i === 0) throw new Error(`scene 1 (${scene.file}) has a transition, but there is no scene before it`);
    if (tr) {
      scene.transition = { ease: 'inOutCubic', params: {}, ...tr, n: Math.max(1, Math.round((Number(tr.duration) || 0) * p.fps)) };
      try { scene.transition.type = findTransition(tr.type).name; transitionProgress(0, 1, scene.transition.ease); }
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

export async function renderProject({ dir, out, scale, log = console.log, signal }) {   // signal: an AbortSignal that stops the render
  const { root, file, name } = projectPaths(dir);
  dir = root; out = resolve(out || join(dir, 'out', name + '.mp4'));
  const p = JSON.parse(readFileSync(file, 'utf8')), tmp = mkdtempSync(join(tmpdir(), 'motlab-project-')), partial = out + '.part';
  try {
    // One MP4 per scene. The first scene picks the encoder and the rest are forced to the same one, so the parts
    // can be joined without re-encoding.
    // A transition is a part of its own between the two scenes: their overlapping frames, mixed by
    // __motlab/transition.html, and left out of the scenes' own parts.
    const parts = [], scenes = projectScenes(p), same = () => parts[0] && { encoder: parts[0].hw ? 'hw' : 'sw', codec: parts[0].codec };
    for (const [i, scene] of scenes.entries()) {
      const into = scene.transition, next = scenes[i + 1]?.transition;
      signal?.throwIfAborted();
      log(`\nScene ${i + 1}/${scenes.length}: ${scene.file}`);
      const part = await renderVideo({ page: join(dir, scene.file), root: dir, out: join(tmp, `${parts.length}.mp4`), fps: p.fps, scale, log, signal,
        head: into?.n, tail: next?.n, ...same() });
      // a stream copy join of parts with different sizes makes an MP4 that changes resolution partway through
      if (parts[0] && (part.width !== parts[0].width || part.height !== parts[0].height))
        throw new Error(`${scene.file} is ${part.width}x${part.height} but ${scenes[0].file} is ${parts[0].width}x${parts[0].height}. All scenes in a project must have the same canvas size`);
      parts.push(part);
      if (!next) continue;
      log(`\nTransition ${i + 1} to ${i + 2}: ${next.type}, ${next.n} frames`);
      const query = new URLSearchParams({ from: scene.file, to: scenes[i + 1].file, offset: (part.pageFrames - next.n) / p.fps, frames: next.n,
        fps: p.fps, type: next.type, ease: next.ease, params: JSON.stringify(next.params) });
      parts.push(await renderVideo({ url: '__motlab/transition.html', query: String(query), root: dir, out: join(tmp, `${parts.length}.mp4`),
        fps: p.fps, scale, log, signal, ...same() }));
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
    log(`\nSAVED ${out} (${scenes.length} scenes${parts.length > scenes.length ? `, ${parts.length - scenes.length} transitions` : ''}, ${duration.toFixed(3)} s${audio ? `, ${p.audio.length} audio files` : ''})`);
  } finally { rmSync(partial, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}
