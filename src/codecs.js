// Codec strings, default bitrates and frame splitting. Pure functions, shared by the probe and the renderer.

// [level_idc, max frame size in macroblocks, max macroblocks per second, max bitrate in kbit/s for High profile]
const AVC_LEVELS = [
  [40, 8192, 245760, 25000], [41, 8192, 245760, 62500], [42, 8704, 522240, 62500],
  [50, 22080, 589824, 168750], [51, 36864, 983040, 300000], [52, 36864, 2073600, 300000],
  [60, 139264, 4177920, 300000], [61, 139264, 8355840, 600000], [62, 139264, 16711680, 1000000],
];
// [level_idc, max luma picture size, max luma sample rate, max bitrate in kbit/s for Main tier, same for High tier]
const HEVC_LEVELS = [
  [120, 2228224, 66846720, 12000, 30000], [123, 2228224, 133693440, 20000, 50000],
  [150, 8912896, 267386880, 25000, 100000], [153, 8912896, 534773760, 40000, 160000], [156, 8912896, 1069547520, 60000, 240000],
  [180, 35651584, 1069547520, 60000, 240000], [183, 35651584, 2139095040, 120000, 480000], [186, 35651584, 4278190080, 240000, 800000],
];

export function codecString(codec, width, height, fps, bitrate) {
  const kbps = bitrate / 1000;
  if (codec === 'h264') {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const level = AVC_LEVELS.find(([, fs, mbps, br]) => mbs <= fs && mbs * fps <= mbps && kbps <= br) || AVC_LEVELS.at(-1);
    return 'avc1.6400' + level[0].toString(16).padStart(2, '0');   // High profile
  }
  if (codec === 'hevc') {
    const px = width * height;
    const level = HEVC_LEVELS.find(([, ps, sr, , high]) => px <= ps && px * fps <= sr && kbps <= high) || HEVC_LEVELS.at(-1);
    return `hvc1.1.6.${kbps <= level[3] ? 'L' : 'H'}${level[0]}.B0`;   // Main profile, Main or High tier
  }
  throw new Error(`unknown codec ${codec}`);
}

// Default variable-bitrate target, for encoders without a constant QP mode. It also decides the level in the codec
// string. Chrome's software H.264 encoder stops spending bits well below this on flat motion graphics, so in
// practice it is a ceiling.
export function defaultBitrate(codec, width, height, fps) {
  const base = codec === 'hevc' ? 14e6 : 24e6;   // at 1920x1080, 30 fps
  const bps = base * Math.pow((width * height) / (1920 * 1080), 0.75) * Math.sqrt(fps / 30);
  return Math.round(bps / 1e5) * 1e5;
}

// Split frames [0, n) into contiguous ranges, one per worker.
export function splitFrames(n, workers) {
  const w = Math.max(1, Math.min(workers, n)), out = [];
  for (let i = 0; i < w; i++) out.push({ start: Math.floor((i * n) / w), end: Math.floor(((i + 1) * n) / w) });
  return out;
}

export const frameCount = (total, fps) => Math.round(total * fps);
