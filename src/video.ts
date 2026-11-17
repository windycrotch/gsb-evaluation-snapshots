import { encodeMp4 } from './encode/encode';
import { loadFonts } from './fonts';
import type { Lang } from './i18n';
import { generateTimeline, type Mode } from './timeline';

/**
 * Everything heavy for the video (timeline, renderer, Mediabunny) lives in this module.
 * main.ts imports it dynamically, keeping the initial page load light.
 */
const VIDEO = { width: 720, height: 720, fps: 30 } as const;
const WATERMARK = 'pleasejusttext.me';

export async function makeVideo(
  text: string,
  lang: Lang,
  mode: Mode,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; duration: number }> {
  const timeline = generateTimeline({ text, lang, mode, seed: (Math.random() * 2 ** 32) >>> 0 });
  await loadFonts();
  const blob = await encodeMp4(timeline, { ...VIDEO, watermark: WATERMARK, onProgress, signal });
  return { blob, duration: timeline.duration };
}
