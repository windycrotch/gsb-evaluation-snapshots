export const VIDEO_PRESETS = {
  "720p30": { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, level: "28", label: "720p / 30fps" },
  "720p60": { width: 1280, height: 720, fps: 60, bitrate: 6_000_000, level: "28", label: "720p / 60fps" },
  "1080p30": { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, level: "28", label: "1080p / 30fps" },
  "1080p60": { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, level: "2a", label: "1080p / 60fps" },
};
export function videoOptions(value = {}) {
  return { quality: Object.hasOwn(VIDEO_PRESETS, value.quality) ? value.quality : "720p30",
    region: ["player", "manual", "tab"].includes(value.region) ? value.region : "player" };
}
export function queueBudget(bitrate) {
  // MP4 native fragments may span seconds despite a 250ms timeslice. A single
  // healthy high-bitrate fragment is not a producer backlog. Bound both sides
  // to twelve seconds of encoded data, with the existing low-bitrate floors.
  // Current Chromium uses variable video bitrate with a peak budget up to
  // twice the target. Size the transfer queues for that peak, not the label.
  const twelveSeconds = Math.ceil((bitrate * 2 + 128_000) * 12 / 8);
  return { pending: Math.min(32 * 1024 * 1024, Math.max(8 * 1024 * 1024, twelveSeconds)),
    playback: Math.min(32 * 1024 * 1024, Math.max(16 * 1024 * 1024, twelveSeconds)) };
}
export function captureSize(preset, geometry) {
  // Request enough tab pixels for the region, bounded to 4K. Preserve viewport
  // aspect ratio so mapping CSS coordinates to captured pixels stays stable.
  if (!geometry?.rect) return { width: preset.width, height: preset.height };
  const { viewport, rect } = geometry;
  const targetScale = Math.min(preset.width / (rect.width * viewport.width), preset.height / (rect.height * viewport.height));
  // Preserve the page's native Retina pixels before the one final output scale.
  // Capturing the entire tab at output resolution would undersample the region.
  const scale = Math.min(Math.max(targetScale, viewport.devicePixelRatio || 1), 3840 / viewport.width, 2160 / viewport.height);
  return { width: Math.ceil(viewport.width * scale / 2) * 2, height: Math.ceil(viewport.height * scale / 2) * 2 };
}
export function cropPixels(frame, geometry) {
  const visible = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const r = geometry.rect;
  const even = value => Math.floor(value / 2) * 2;
  const x = Math.max(visible.x, even(visible.x + r.x * visible.width));
  const y = Math.max(visible.y, even(visible.y + r.y * visible.height));
  const width = Math.max(2, even(Math.min(r.width * visible.width, visible.x + visible.width - x)));
  const height = Math.max(2, even(Math.min(r.height * visible.height, visible.y + visible.height - y)));
  return { x, y, width, height };
}
export function outputSize(rect, preset, sourceAspect) {
  let aspect = rect.width / rect.height;
  if (sourceAspect > 0 && Math.abs(aspect / sourceAspect - 1) < 0.01) aspect = sourceAspect;
  // Allow only the few pixels lost by YUV alignment; never turn a small region
  // into an apparent HD capture. Keep the selected output dimensions constant.
  const fitsPreset = rect.width >= preset.width - 4 && rect.height >= preset.height - 4 &&
    Math.abs(aspect / (preset.width / preset.height) - 1) < 0.01;
  if (fitsPreset) return { width: preset.width, height: preset.height };
  const width = Math.max(2, Math.floor(Math.min(rect.width, preset.width, rect.height * aspect, preset.height * aspect) / 2) * 2);
  return { width, height: Math.max(2, Math.floor(width / aspect / 2) * 2) };
}
