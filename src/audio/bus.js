/**
 * The master mix bus: one shared soft limiter that every voice in the app
 * travels through, and the only place tanh soft limiting happens.
 *
 * The old pipeline limited each voice on its own inside `renderStrike`, before
 * voices were ever summed, and then fed the sum through a fixed gain into a
 * compressor whose knee nobody could evaluate off-line. That made the level
 * relationship between a single strike, a lone mode preview, and a burst of
 * overlapping taps a matter of guessing by ear. Everything here is plain
 * arithmetic instead, so the exact same chain runs in Node (the tests) and in
 * the browser (an equivalent Web Audio graph built by `buildMasterBus` in
 * main.js), with peaks that can be checked numerically.
 *
 * The transfer curve:
 *
 *   - |x| <= BUS_THRESHOLD (0.95): identity. An ordinary single strike is
 *     scaled to land near 0.72 before the per-voice gain, so nothing about a
 *     lone voice - including the fact that a rim strike is genuinely quieter
 *     than a centre strike - is touched by the bus at all.
 *   - |x| > 0.95: a scaled tanh soft knee, C1-continuous at the threshold,
 *     whose output approaches 1 asymptotically. Overlapping voices can pile up
 *     past full scale; this keeps the mixed peak inside [-1, 1] instead of
 *     letting the browser hard-clamp it.
 *
 * Nothing in this file knows a frequency. It cannot alter a pitch or a ratio.
 */

/** Above this input magnitude the bus begins to compress. */
export const BUS_THRESHOLD = 0.95;

/**
 * Fixed per-voice gain applied as each rendered voice enters the bus. This is
 * the gain node the old pipeline already had (out.gain.value = 0.85); it lives
 * here now so the off-line chain and the Web Audio graph share one number.
 */
export const VOICE_GAIN = 0.85;

/** At most this many voices may ring at once; the oldest is stopped. */
export const MAX_VOICES = 6;

/**
 * The master-bus transfer function, applied once to the summed signal.
 *
 * For x above the threshold, with u = (x - t) / (1 - t):
 *
 *     y = t + (1 - t) tanh(u)
 *
 * At u = 0 this is exactly t, and dy/dx there is (1 - t) / (1 - t) = 1, so the
 * knee joins the identity region with matching value and slope (C1). As u ->
 * infinity y -> t + (1 - t) = 1, so the whole curve is bounded by 1 in
 * magnitude: no mix, however hot, can cross full scale. tanh saturates to
 * within Float64 rounding of 1 for very large u; that is the asymptote working
 * as intended, and output still never exceeds 1. Realistic pile-ups (a handful
 * of overlapping voices, u of order a few) stay strictly below 1.
 */
export function busLimit(x) {
  if (Math.abs(x) <= BUS_THRESHOLD) return x;
  const sign = x < 0 ? -1 : 1;
  const u = (Math.abs(x) - BUS_THRESHOLD) / (1 - BUS_THRESHOLD);
  return sign * (BUS_THRESHOLD + (1 - BUS_THRESHOLD) * Math.tanh(u));
}

/** Largest absolute sample in a buffer. */
export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Runs one buffer through the bus: the per-voice gain is already folded into
 * `mix` by the caller, so this is the soft knee plus a couple of bookkeeping
 * facts the tests assert on. Returns a new Float32Array.
 *
 * `engaged` in the result is true when at least one mixed sample crossed the
 * compression threshold. A single ordinary strike must leave it false.
 */
export function processBus(mix) {
  const out = new Float32Array(mix.length);
  let engaged = false;
  let inputPeak = 0;
  for (let i = 0; i < mix.length; i++) {
    const x = mix[i];
    const ax = Math.abs(x);
    if (ax > inputPeak) inputPeak = ax;
    if (ax > BUS_THRESHOLD) engaged = true;
    out[i] = busLimit(x);
  }
  return { samples: out, engaged, inputPeak, outputPeak: peakOf(out) };
}

/**
 * Off-line counterpart of the browser's voice management and master bus.
 *
 * Voices are rendered per strike by `renderStrike` (which no longer limits) and
 * handed here with a start offset in samples. They are summed with the fixed
 * VOICE_GAIN, the voice count is capped at MAX_VOICES by dropping the oldest,
 * and the whole mix passes once through `busLimit`. No AudioContext is
 * involved, which is what makes the chain testable in Node.
 */
export class OfflineBus {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** { samples, start } in insertion order; index 0 is the oldest. */
    this.voices = [];
  }

  /**
   * Adds a rendered voice, scheduled `delaySeconds` after the previous one.
   * If the cap is exceeded the oldest voice is discarded, exactly as main.js
   * calls stop() on the oldest BufferSource.
   */
  addVoice(samples, delaySeconds = 0) {
    const start = this.voices.length
      ? this.voices[this.voices.length - 1].start +
        Math.round(delaySeconds * this.sampleRate)
      : 0;
    this.voices.push({ samples, start });
    while (this.voices.length > MAX_VOICES) this.voices.shift();
    return this;
  }

  /** Sums the surviving voices and runs them through the master bus once. */
  render() {
    const endAt = this.voices.reduce(
      (end, v) => Math.max(end, v.start + v.samples.length),
      0,
    );
    const mix = new Float64Array(endAt);
    for (const v of this.voices) {
      for (let n = 0; n < v.samples.length; n++) {
        mix[v.start + n] += v.samples[n] * VOICE_GAIN;
      }
    }
    return processBus(mix);
  }
}

/**
 * The WaveShaper curve that makes a browser Web Audio graph compute the same
 * transfer function as `busLimit`.
 *
 * A WaveShaper maps its own input range [-1, 1] linearly across the curve
 * table, so the graph scales the summed signal by `inputScale` before the
 * shaper and restores it with `1 / inputScale` afterwards (see buildMasterBus
 * in main.js). `inputMax` is the largest pre-shaper magnitude that table must
 * represent; with at most MAX_VOICES voices, each bounded by its own render
 * level, the mix cannot reach it, so the table's flat asymptote is the only
 * extrapolation region and it never overshoots.
 */
export function busCurve(points = 4096, inputMax = 4) {
  const curve = new Float32Array(points);
  const inputScale = 1 / inputMax;
  for (let i = 0; i < points; i++) {
    const shaperIn = -1 + (2 * i) / (points - 1); // -1 .. 1
    const x = shaperIn / inputScale; // back to real-world mix units
    curve[i] = busLimit(x) * inputScale;
  }
  return curve;
}

/** The scale pair used by the browser graph; exported so tests can pin it. */
export function busInputScale(inputMax = 4) {
  return 1 / inputMax;
}
