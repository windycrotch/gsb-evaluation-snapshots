// Picks the encoder for this machine and resolution by timing each candidate once, then remembers the answer.
// Nothing is assumed: on the reference laptop the software encoder is the fastest, and the hardware one is the only
// one that can hold a constant QP.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { codecString, defaultBitrate } from './codecs.js';

const CANDIDATES = [{ codec: 'h264', hw: true }, { codec: 'h264', hw: false }, { codec: 'hevc', hw: true }, { codec: 'hevc', hw: false }];
// Constant QP values that keep SSIM against a lossless reference near 0.999 on the skill's 2D and 3D templates.
export const DEFAULT_QP = { h264: 18, hevc: 20 };
export const label = c => `${c.codec === 'hevc' ? 'HEVC' : 'H.264'} ${c.hw ? 'hardware' : 'software'}`;
export const rate = c => c.rc === 'quantizer' ? `constant QP ${c.qp}` : `${(c.bitrate / 1e6).toFixed(1)} Mbit/s VBR`;

export function cacheFile() {
  const dir = process.env.MOTLAB_CACHE_DIR || (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'motlab') : join(homedir(), '.cache', 'motlab'));
  return join(dir, 'encoder-probe.json');
}
const load = () => { try { return JSON.parse(readFileSync(cacheFile(), 'utf8')); } catch { return {}; } };

// auto: the fastest encoder that can hold a constant QP, because Chrome's software H.264 encoder ignores the bitrate
// above a quality ceiling (SSIM about 0.994 on fine 1080p line art). Without such an encoder: the fastest overall.
// hw / sw: the fastest of that kind. H.264 is kept unless HEVC is at least 25% faster: it plays everywhere, and a
// smaller margin would let probe noise flip the codec between runs.
export function pick(results, { mode = 'auto', codec = 'auto' } = {}) {
  let ok = results.filter(r => r.supported && (mode === 'auto' || r.hw === (mode === 'hw')) && (codec === 'auto' || r.codec === codec)).sort((a, b) => b.fps - a.fps);
  if (mode === 'auto' && ok.some(r => r.rc === 'quantizer')) ok = ok.filter(r => r.rc === 'quantizer');
  if (!ok.length) return null;
  const h264 = ok.find(r => r.codec === 'h264');
  return h264 && h264.fps >= ok[0].fps * 0.8 ? h264 : ok[0];
}

// pages: the already open render pages, one per worker. Probing on all of them at once measures what a parallel
// render will really get (encoders share the CPU and the GPU).
export async function selectEncoder({ pages, machine, width, height, fps, mode, codec, bitrate, qp, reprobe, log }) {
  const machineKey = ['v2', machine.chrome, machine.gpu, cpus()[0]?.model, process.platform].join(' | ');
  const key = `${width}x${height}@${Math.round(fps)} x${pages.length}`;
  const cache = load();
  let entry = !reprobe && cache.machine === machineKey ? cache.entries?.[key] : null, source = 'cache';

  if (!entry) {
    source = 'probed now';
    const frames = Math.max(24, Math.min(90, Math.round((90 * 1920 * 1080) / (width * height) * 2)));
    const results = [];
    for (const c of CANDIDATES) {
      const br = defaultBitrate(c.codec, width, height, fps);
      const base = { ...c, width, height, fps, frames, bitrate: br, qp: DEFAULT_QP[c.codec], codecString: codecString(c.codec, width, height, fps, br) };
      let rc, per;
      for (rc of ['quantizer', 'variable']) {   // constant QP first; variable bitrate when the encoder has no QP mode
        per = await Promise.all(pages.map(p => p.evaluate(`window.__motlab.probeEncoder(${JSON.stringify({ ...base, rc })})`)));
        if (per.every(r => r.supported)) break;
      }
      const supported = per.every(r => r.supported);
      results.push({ ...c, supported, ...(supported ? { rc, fps: +per.reduce((s, r) => s + r.fps, 0).toFixed(1) } : { fps: 0, error: per.find(r => r.error)?.error }) });
      log(`  probe ${label(c).padEnd(16)} ${supported ? `${String(results.at(-1).fps).padStart(6)} fps  ${rc === 'quantizer' ? 'constant QP' : 'variable bitrate'}` : 'not supported'}`);
    }
    await Promise.all(pages.map(p => p.evaluate('window.__motlab.probeDone()')));
    entry = { at: new Date().toISOString(), results };
    const next = cache.machine === machineKey ? cache : { machine: machineKey, entries: {} };
    next.entries[key] = entry;
    try { mkdirSync(join(cacheFile(), '..'), { recursive: true }); writeFileSync(cacheFile(), JSON.stringify(next, null, 2)); } catch (e) { log(`  (could not save probe cache: ${e.message})`); }
  }

  const best = pick(entry.results, { mode, codec });
  if (!best) throw new Error(`no usable encoder for ${width}x${height} with --encoder ${mode} --codec ${codec}`);
  const br = bitrate || defaultBitrate(best.codec, width, height, fps);
  const rc = bitrate ? 'variable' : best.rc;   // an explicit --bitrate asks for variable bitrate
  return { codec: best.codec, hw: best.hw, rc, qp: qp ?? DEFAULT_QP[best.codec], bitrate: br, codecString: codecString(best.codec, width, height, fps, br), probedFps: best.fps, source, results: entry.results };
}
