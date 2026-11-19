/**
 * Synthetic SSTV signal generation for tests.
 *
 * Produces real audio (a phase-continuous FM waveform) matching the Robot36
 * scan-line layout so that it can be fed through the full decode pipeline
 * (sync detection -> demodulation -> line decoding).
 */

import { SSTV_MODES, FREQ_SYNC, FREQ_BLACK, FREQ_WHITE } from '../constants';


export interface ToneSegment {
  /** Frequency in Hz */
  freq: number;
  /** Duration in milliseconds */
  ms: number;
}

/** Append a phase-continuous sine segment to a growing sample array. */
function appendTone(out: number[], freq: number, ms: number, sampleRate: number, phaseState: { phase: number }) {
  const count = Math.round((ms / 1000) * sampleRate);
  const delta = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < count; i++) {
    out.push(Math.sin(phaseState.phase));
    phaseState.phase += delta;
    if (phaseState.phase > 2 * Math.PI) phaseState.phase -= 2 * Math.PI;
  }
}

export interface Robot36LineOptions {
  /** Luminance frequency in Hz (1500 black .. 2300 white) */
  luminance: number;
  /** Chrominance frequency in Hz */
  chrominance: number;
  /**
   * Separator frequency. Robot36 uses the separator to signal even/odd lines:
   * a low (sync-side) frequency is an even line (R-Y), a high frequency an odd
   * line (B-Y).
   */
  separator: number;
}

export const ROBOT36_EVEN_LINE: Omit<Robot36LineOptions, 'luminance' | 'chrominance'> = {
  // 1500Hz -> normalized -1.0 -> even line (R-Y)
  separator: FREQ_BLACK,
};

export const ROBOT36_ODD_LINE: Omit<Robot36LineOptions, 'luminance' | 'chrominance'> = {
  // 2300Hz -> normalized +1.0 -> odd line (B-Y)
  separator: FREQ_WHITE,
};

/**
 * Build a PD-mode transmission of `lineCount` scan lines.
 *
 * Each scan line is: sync(20ms) + porch(2.08ms) + Y-even + V + U + Y-odd
 * (four equal channels). Works for PD120/PD160/PD180 by passing the mode name.
 */
export function generatePDSamples(
  modeName: 'PD120' | 'PD160' | 'PD180',
  lineCount: number,
  channelFreqs: { yEven: number; v: number; u: number; yOdd: number },
  sampleRate: number
): Float32Array {
  const mode = SSTV_MODES[modeName];
  const out: number[] = [];
  const phaseState = { phase: 0 };
  const channelMs = mode.colorScanTime;

  for (let line = 0; line < lineCount; line++) {
    appendTone(out, FREQ_SYNC, mode.syncPulse, sampleRate, phaseState);   // 20ms sync
    appendTone(out, mode.porchFreq, mode.syncPorch, sampleRate, phaseState); // 2.08ms porch
    appendTone(out, channelFreqs.yEven, channelMs, sampleRate, phaseState);
    appendTone(out, channelFreqs.v, channelMs, sampleRate, phaseState);
    appendTone(out, channelFreqs.u, channelMs, sampleRate, phaseState);
    appendTone(out, channelFreqs.yOdd, channelMs, sampleRate, phaseState);
  }

  return Float32Array.from(out);
}

/**
 * Build a Robot36 transmission of `lineCount` scan lines.
 *
 * Each scan line is: sync(9ms) + porch(3ms) + Y(88ms) + separator(4.5ms)
 * + porch(1.5ms) + chroma(44ms).
 */
export function generateRobot36Samples(
  lines: Robot36LineOptions[],
  sampleRate: number
): Float32Array {
  const mode = SSTV_MODES.ROBOT36;
  const out: number[] = [];
  const phaseState = { phase: 0 };

  for (const line of lines) {
    appendTone(out, FREQ_SYNC, mode.syncPulse, sampleRate, phaseState);          // 9ms sync
    appendTone(out, mode.porchFreq, mode.syncPorch, sampleRate, phaseState);     // 3ms porch
    appendTone(out, line.luminance, mode.colorScanTime, sampleRate, phaseState); // 88ms Y
    appendTone(out, line.separator, mode.separatorPulse, sampleRate, phaseState); // 4.5ms separator
    appendTone(out, mode.porchFreq, 1.5, sampleRate, phaseState);                // 1.5ms porch
    appendTone(out, line.chrominance, mode.colorScanTimes![1], sampleRate, phaseState); // 44ms chroma
  }

  return Float32Array.from(out);
}

/**
 * Feed a sample buffer through a decoder in realistic audio-callback sized
 * chunks, collecting the stats after every chunk.
 */
export function feedInChunks(
  decoder: { processSamples(samples: Float32Array): void; getStats(): any },
  samples: Float32Array,
  chunkSize = 4096
): any {
  let stats = decoder.getStats();
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    const chunk = samples.subarray(offset, Math.min(offset + chunkSize, samples.length));
    decoder.processSamples(chunk);
    stats = decoder.getStats();
  }
  return stats;
}
