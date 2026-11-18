/**
 * Deterministic synthetic SSTV audio for tests.
 *
 * Nothing here touches a microphone or Web Audio: signals are rendered as
 * phase-continuous sine tones, so every test feeds exact, repeatable samples
 * into the decoder.
 */

export const SYNC_FREQ = 1200; // Hz - sync pulse
export const BLACK_FREQ = 1500; // Hz - porch / black level
export const PORCH_FREQ = 1900; // Hz - mid-level porch
export const WHITE_FREQ = 2300; // Hz - white level

export interface Tone {
  /** Tone frequency in Hz. */
  freq: number;
  /** Duration in milliseconds. */
  ms: number;
}

/** Render tones into a contiguous float buffer with continuous phase. */
export function renderTones(tones: readonly Tone[], sampleRate: number): Float32Array {
  for (const tone of tones) {
    if (!Number.isFinite(tone.ms) || tone.ms < 0) {
      throw new Error(`Tone duration must be a non-negative number, got ${tone.ms}`);
    }
  }

  const total = tones.reduce((sum, tone) => sum + Math.round((tone.ms / 1000) * sampleRate), 0);
  const out = new Float32Array(total);

  let phase = 0;
  let write = 0;
  for (const tone of tones) {
    const count = Math.round((tone.ms / 1000) * sampleRate);
    const deltaPhase = (2 * Math.PI * tone.freq) / sampleRate;
    for (let i = 0; i < count; i++) {
      out[write++] = Math.sin(phase) * 0.5;
      phase += deltaPhase;
    }
  }
  return out;
}

/** A silent-ish lead-in so the detector's filters settle before the first sync. */
export function leadIn(ms = 100): Tone {
  return { freq: BLACK_FREQ, ms };
}

/**
 * One Robot72 scan line (300ms total): sync(9) porch(3) Y(138) sep(4.5)
 * porch(1.5) V(69) sep(4.5) porch(1.5) U(69).
 */
export function robot72Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 9 },
    { freq: BLACK_FREQ, ms: 3 },
    { freq: BLACK_FREQ, ms: 138 },
    { freq: BLACK_FREQ, ms: 4.5 },
    { freq: PORCH_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 69 },
    { freq: BLACK_FREQ, ms: 4.5 },
    { freq: PORCH_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 69 },
  ];
}

/**
 * One Robot36 scan line (150ms total): sync(9) porch(3) Y(88) separator(4.5)
 * porch(1.5) chroma(44). The separator frequency selects even/odd interlacing.
 */
export function robot36Line(separatorFreq: number, chromaFreq = BLACK_FREQ): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 9 },
    { freq: BLACK_FREQ, ms: 3 },
    { freq: BLACK_FREQ, ms: 88 },
    { freq: separatorFreq, ms: 4.5 },
    { freq: PORCH_FREQ, ms: 1.5 },
    { freq: chromaFreq, ms: 44 },
  ];
}

/**
 * One PD120 scan line (508.48ms total): sync(20) porch(2.08) followed by four
 * 121.6ms channels (Y-even, V-avg, U-avg, Y-odd).
 */
export function pd120Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 20 },
    { freq: BLACK_FREQ, ms: 2.08 },
    { freq: BLACK_FREQ, ms: 121.6 },
    { freq: BLACK_FREQ, ms: 121.6 },
    { freq: BLACK_FREQ, ms: 121.6 },
    { freq: BLACK_FREQ, ms: 121.6 },
  ];
}

/** One PD160 scan line (804.416ms): sync(20) + porch + four 195.584ms channels. */
export function pd160Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 20 },
    { freq: BLACK_FREQ, ms: 2.08 },
    { freq: BLACK_FREQ, ms: 195.584 },
    { freq: BLACK_FREQ, ms: 195.584 },
    { freq: BLACK_FREQ, ms: 195.584 },
    { freq: BLACK_FREQ, ms: 195.584 },
  ];
}

/** One PD180 scan line (751.68ms): sync(20) + porch + four 182.4ms channels. */
export function pd180Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 20 },
    { freq: BLACK_FREQ, ms: 2.08 },
    { freq: BLACK_FREQ, ms: 182.4 },
    { freq: BLACK_FREQ, ms: 182.4 },
    { freq: BLACK_FREQ, ms: 182.4 },
    { freq: BLACK_FREQ, ms: 182.4 },
  ];
}

/** One Scottie S1 line (428.22ms): sync(9) R(138.24) sep G(138.24) sep B(138.24). */
export function scottieS1Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 9 },
    { freq: BLACK_FREQ, ms: 138.24 },
    { freq: BLACK_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 138.24 },
    { freq: BLACK_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 138.24 },
  ];
}

/** One Scottie S2 line (277.692ms): sync(9) R(88.064) sep G(88.064) sep B(88.064). */
export function scottieS2Line(): Tone[] {
  return [
    { freq: SYNC_FREQ, ms: 9 },
    { freq: BLACK_FREQ, ms: 88.064 },
    { freq: BLACK_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 88.064 },
    { freq: BLACK_FREQ, ms: 1.5 },
    { freq: BLACK_FREQ, ms: 88.064 },
  ];
}

/** Concatenate several tone sequences. */
export function concatTones(...groups: readonly (readonly Tone[])[]): Tone[] {
  return groups.reduce<Tone[]>((acc, group) => acc.concat(group), []);
}

/** Split a buffer into chunks of `chunkSize` samples (the final one is short). */
export function chunkBuffer(samples: Float32Array, chunkSize: number): Float32Array[] {
  const chunks: Float32Array[] = [];
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    chunks.push(samples.subarray(offset, Math.min(offset + chunkSize, samples.length)));
  }
  return chunks;
}

/**
 * True sample indices at which each sync pulse ends, derived from the tone
 * script rather than from the detector under test.
 */
export function syncEndIndices(tones: readonly Tone[], sampleRate: number): number[] {
  const ends: number[] = [];
  let position = 0;
  let inSync = false;
  for (const tone of tones) {
    const count = Math.round((tone.ms / 1000) * sampleRate);
    const isSync = tone.freq === SYNC_FREQ;
    if (!isSync && inSync) ends.push(position);
    inSync = isSync;
    position += count;
  }
  return ends;
}
