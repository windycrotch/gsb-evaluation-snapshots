// Join separately rendered pieces and the soundtrack into the finished film.
//   node tools/assemble.mjs <out.mp4> <soundtrack.wav> <part1.silent.mp4> [part2 ...] [--social 14]
// Video is stream-copied (the parts share one encoder configuration); audio is mastered to
// -14 LUFS integrated with a limiter ceiling near -1.5 dBTP. --social also writes a smaller
// upload copy re-encoded at the given CRF.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const si = argv.indexOf('--social');
const socialCrf = si >= 0 ? argv.splice(si, 2)[1] : null;
const [out, wav, ...parts] = argv;
if (!out || !wav || !parts.length) { console.error('usage: assemble.mjs out.mp4 soundtrack.wav part1 [part2 ...] [--social crf]'); process.exit(1); }
const run = (a, o = {}) => spawnSync('ffmpeg', a, { encoding: 'utf8', ...o });
const dir = path.dirname(out);
const list = path.join(dir, '_concat.txt');
fs.writeFileSync(list, parts.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'));
const video = path.join(dir, '_video.mp4');
let r = run(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0', '-movflags', '+faststart', video], { stdio: 'inherit' });
if (r.status !== 0) process.exit(1);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,r_frame_rate', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim();
const [rate, frames] = probe.split(',');
const fps = eval(rate), dur = +frames / fps;
const meas = run(['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128', '-f', 'null', '-']);
const m = /I:\s+(-?[\d.]+) LUFS/.exec((meas.stderr || '').split('Summary:').pop() || '');
const gain = m ? -13.7 - parseFloat(m[1]) : 0; // aim a touch hot: the limiter takes ~0.3 LU back
console.log(`video: ${frames} frames @ ${fps} fps (${dur.toFixed(3)} s) · audio: ${m ? m[1] : '?'} LUFS → ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`);
const af = `volume=${gain.toFixed(2)}dB,alimiter=limit=0.74:attack=3:release=60:level=false,afade=t=out:st=${Math.max(0, dur - 0.35).toFixed(3)}:d=0.35`;
r = run(['-y', '-loglevel', 'error', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-t', dur.toFixed(4), '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(1);
fs.rmSync(list); fs.rmSync(video);
console.log('→', out, (fs.statSync(out).size / 1e6).toFixed(1) + ' MB');
if (socialCrf) {
  const s = out.replace(/\.mp4$/, '.social.mp4');
  r = run(['-y', '-loglevel', 'error', '-i', out, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(socialCrf), '-maxrate', '20M', '-bufsize', '40M', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'copy', '-movflags', '+faststart', s], { stdio: 'inherit' });
  if (r.status === 0) console.log('→', s, (fs.statSync(s).size / 1e6).toFixed(1) + ' MB');
}
