// ffmpeg is only used to stream-copy: join parallel segments, add audio, wrap a raw bitstream. It never re-encodes video.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function run(cmd, args, signal) {   // signal: an AbortSignal that kills the process
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => no(e.name === 'AbortError' ? signal.reason : new Error(`${cmd} could not start: ${e.message}`)));
    p.on('close', code => code === 0 ? ok(out) : no(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-6).join('\n')}`)));
  });
}

// BT.709 with the range the encoder used (limited when Chrome drew on a GPU, full when it drew in software), written
// into the bitstream itself (VUI) so the tag survives any later remux.
const vui = full => `colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=${full ? 1 : 0}`;

// inputs: MP4 segments (one or more) or one raw Annex B file. Output: a fast-start MP4, optionally with audio.
export async function finalize({ inputs, raw, codec, fps, audio, out, duration, tmp, signal, fullRange = false }) {
  const args = ['-y', '-loglevel', 'error'];
  if (raw) args.push('-f', codec === 'hevc' ? 'hevc' : 'h264', '-framerate', String(fps), '-i', inputs[0]);
  else if (inputs.length === 1) args.push('-i', inputs[0]);
  else {
    const list = join(tmp, 'concat.txt');
    writeFileSync(list, inputs.map(p => `file '${p.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n') + '\n');
    args.push('-f', 'concat', '-safe', '0', '-i', list);
  }
  if (audio) args.push('-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '320k', '-t', duration.toFixed(6));
  else args.push('-map', '0:v:0');
  args.push('-c:v', 'copy', '-bsf:v', `${codec === 'hevc' ? 'hevc' : 'h264'}_metadata=${vui(fullRange)}`,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', fullRange ? 'pc' : 'tv',
    ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', '-f', 'mp4', out);
  await run('ffmpeg', args, signal);
}

export async function probeVideo(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
    'stream=codec_name,profile,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,avg_frame_rate,nb_frames,nb_read_packets,duration:format=duration,size',
    '-of', 'json', file]);
  const j = JSON.parse(out), s = j.streams[0];
  return { ...s, frames: Number(s.nb_read_packets), duration: Number(s.duration), formatDuration: Number(j.format.duration), size: Number(j.format.size) };
}
