/** The shape of a sound for the timeline: the loudest sample in every slice of it. Pure; decoding the file is the browser's job. */

/** Slices per second of sound that are kept (200 is enough to draw a bar every few pixels at any timeline zoom). */
const PEAKS_PER_SECOND = 200;

export interface Peaks {
  /** Loudness 0..1 of each slice. */
  values: Float32Array;
  /** Length of the sound in seconds. */
  duration: number;
}

/** The peaks of one or more channels of samples (the loudest of the channels counts), `PEAKS_PER_SECOND` slices a second. */
export function peaksOf(channels: readonly ArrayLike<number>[], sampleRate: number, perSecond = PEAKS_PER_SECOND): Peaks {
  const length = channels.reduce((n, c) => Math.max(n, c.length), 0);
  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const slice = Math.max(1, Math.floor(sampleRate / perSecond));
  const count = Math.max(0, Math.ceil(length / slice));
  const values = new Float32Array(count);
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      const at = Math.floor(i / slice);
      if (v > values[at]) values[at] = v;
    }
  }
  return { values, duration };
}

/** The loudness at a time in the sound (0 outside it). */
export function peakAt(p: Peaks, time: number): number {
  if (time < 0 || time >= p.duration || !p.values.length) return 0;
  return p.values[Math.min(p.values.length - 1, Math.floor((time / p.duration) * p.values.length))];
}
