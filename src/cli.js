import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { doctor } from './doctor.js';
import { startEditor } from './editor.js';
import { renderProject } from './project.js';
import { dumpEvents, renderStills, renderVideo } from './render.js';
import { uninstall } from './uninstall.js';
import { update } from './update.js';
import { openInViewer, restartViewer, startViewer, stopViewer } from './viewer.js';

const USAGE = `motlab: render a canvas page (canvas #c, renderAt(t), TOTAL, ready, EVENTS) with headless Chrome and WebCodecs.

  motlab render <project> [out.mp4] [--scale 2]      all scenes and audio in project.json, as one MP4
  motlab start                                       the viewer in the background at http://127.0.0.1:4173, for every
                                                     project; the menu lists the projects in this folder
  motlab edit   [project]                            open a project in the viewer (starting it if needed) and print its
                                                     address. [project] is a folder with project.json, or a project
                                                     file in it (video/storyboard.json). Clicks go to selection.json
  motlab stop | restart                              end the viewer, or start it again from the same folder
  motlab stills <page.html> <outDir> <t1> <t2> ...  [--scale 1] [--format png|jpg]
  motlab video  <page.html> <out.mp4> [--fps 24] [--scale 2] [--audio file] [--encoder auto|hw|sw] [--workers N]
  motlab events <page.html> <out.json>
  motlab doctor                                      check Node, Chrome, ffmpeg and the skill's Python packages
  motlab update [--dry-run]                          the newest motlab from GitHub, its npm packages, and the skills
                                                     copied again to every agent folder they were installed in
  motlab uninstall [--dry-run] [--yes]               remove the command, the skills, ~/.motlab and the encoder cache
                                                     (it lists them and asks first; the clone folder is left)

  --fps       frames per second (default 24)
  --scale     passed to the page as ?scale=; 2 turns a 1920x1080 page into 4K (default 2 for video, 1 for stills)
  --audio     audio file to mux in (AAC 320k); the result is cut to the video length
  --encoder   auto = fastest encoder with constant quality in the saved probe for this machine and size,
              hw = fastest hardware encoder, sw = software (fastest at 1080p, but its quality has a ceiling)
  --codec     auto | h264 | hevc (default auto; H.264 is kept unless HEVC is clearly faster)
  --workers   split the frames over N Chrome processes and join the parts with ffmpeg concat (default 1)
  --qp        constant QP for encoders that support it (default 18 for H.264, 20 for HEVC; lower = better, larger)
  --bitrate   use variable bitrate at this many Mbit/s instead of constant QP
  --mux       auto | mediabunny | raw (auto tries Mediabunny, then raw bitstream + ffmpeg -c copy)
  --reprobe   time the encoders again instead of using the saved probe
  --root      folder to serve (default: the nearest folder above the page with a project.json, else the page's folder)
  --chrome    path to Chrome (default: autodetect, or the CHROME environment variable)

Chrome always runs with --enable-gpu --force_high_performance_gpu --enable-unsafe-swiftshader (--gpu is accepted and ignored, so older commands
that pass it keep working). Needs ffmpeg and ffprobe on PATH.

Engine folder: ${fileURLToPath(new URL('..', import.meta.url))}  (README.md, example/, src/page/footage.js)`;

const oneOf = (name, v, list) => { if (v !== undefined && !list.includes(v)) throw new Error(`--${name} must be one of: ${list.join(', ')}`); return v; };
const num = (name, v, { min = 0, int = false } = {}) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`--${name}: "${v}" is not a valid value`);
  return n;
};

export async function main(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    fps: { type: 'string' }, scale: { type: 'string' }, audio: { type: 'string' }, encoder: { type: 'string' }, codec: { type: 'string' },
    workers: { type: 'string' }, bitrate: { type: 'string' }, qp: { type: 'string' }, mux: { type: 'string' }, root: { type: 'string' }, chrome: { type: 'string' },
    format: { type: 'string' }, reprobe: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, foreground: { type: 'boolean' }, gpu: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [mode, page, out, ...rest] = positionals;
  if (v.help || !mode) { console.log(USAGE); return v.help ? 0 : 1; }
  if (mode === 'doctor') return doctor();
  if (mode === 'update') return update({ dryRun: v['dry-run'] });
  if (mode === 'uninstall') return uninstall({ dryRun: v['dry-run'], yes: v.yes });
  // --foreground is the server itself (what start runs in the background); it runs until it is stopped.
  if (mode === 'start') return v.foreground ? (await startEditor(page) === 'joined' ? 0 : new Promise(() => {})) : (await startViewer(), 0);
  if (mode === 'edit') { await openInViewer(page); return 0; }
  if (mode === 'stop') { await stopViewer(); return 0; }
  if (mode === 'restart') { await restartViewer(); return 0; }
  if (mode === 'render') {
    if (!page) throw new Error('render needs a project folder or project file');
    await renderProject({ dir: page, out, scale: num('scale', v.scale, { min: 0.01 }) });
    return 0;
  }
  if (!['stills', 'video', 'events'].includes(mode)) throw new Error(`unknown mode "${mode}" (render, start, edit, stop, restart, stills, video, events, doctor, update or uninstall)`);
  if (!page || !out) throw new Error(`${mode} needs a page and an output path`);
  const common = { page, root: v.root, chrome: v.chrome };

  if (mode === 'events') { await dumpEvents({ ...common, out }); return 0; }
  if (mode === 'stills') {
    const times = rest.map(t => num('time', t));
    if (!times.length) throw new Error('stills needs at least one time in seconds');
    await renderStills({ ...common, outDir: out, times, scale: num('scale', v.scale, { min: 0.01 }), format: oneOf('format', v.format, ['png', 'jpg']) });
    return 0;
  }
  if (rest.length) throw new Error(`unexpected arguments: ${rest.join(' ')}`);
  const bitrate = num('bitrate', v.bitrate, { min: 0.1 });
  await renderVideo({ ...common, out, audio: v.audio, fps: num('fps', v.fps, { min: 1 }), scale: num('scale', v.scale, { min: 0.01 }),
    workers: num('workers', v.workers, { min: 1, int: true }), bitrate: bitrate && bitrate * 1e6, qp: num('qp', v.qp, { min: 0, int: true }), reprobe: v.reprobe,
    encoder: oneOf('encoder', v.encoder, ['auto', 'hw', 'sw']), codec: oneOf('codec', v.codec, ['auto', 'h264', 'hevc']), mux: oneOf('mux', v.mux, ['auto', 'mediabunny', 'raw']) });
  return 0;
}
