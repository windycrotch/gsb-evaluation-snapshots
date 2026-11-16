/* The true-peak limiter's configurable parameters, parsed in ONE place for both the live graph and
   the WAV export (see buildLimiter in engine.js), so the two chains can never read different values.
   Units are the units a caller thinks in: dBTP for the ceiling, seconds for lookahead and release.
   The worklet receives samples/seconds (see parseLimiterParams) and keeps the clamping rules of its
   own (see limiter-worklet.js) as the audio-thread defence in depth. */

export const LIMITER_DEFAULTS = { ceiling: -1, lookahead: 0.005, release: 0.12 }; // dBTP, seconds, seconds
// The worklet aims 0.05 dB under the asked ceiling: its short interpolator reads a peak a few
// hundredths of a dB lower than a full-length true-peak meter (see limiter-worklet.js).
export const CEILING_MARGIN_DB = 0.05;
// The 4x interpolator spans HALF = 6 taps either side, so a window shorter than HALF + 1 samples
// cannot hold it. Anything smaller is clamped up to this and still has to produce audio.
export const MIN_LOOKAHEAD_SAMPLES = 7;

const isPosFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Rounds a lookahead in seconds to whole samples and keeps it at least MIN_LOOKAHEAD_SAMPLES.
export function lookaheadSamples(seconds, sampleRate) {
  const s = Number.isFinite(seconds) ? seconds : LIMITER_DEFAULTS.lookahead;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  return Math.max(MIN_LOOKAHEAD_SAMPLES, Math.round(s * rate));
}

// Normalizes one limiter setting. Anything missing, non-numeric or non-finite falls back to the
// default (no undefined/NaN ever reaches the worklet: a NaN gain would silence the whole mix).
// Returns { ceiling } in dBTP, { lookahead } already in whole samples, { release } in seconds.
export function parseLimiterParams(opts = {}, sampleRate) {
  const ceiling = Number.isFinite(opts.ceiling) ? opts.ceiling : LIMITER_DEFAULTS.ceiling;
  const lookahead = lookaheadSamples(opts.lookahead, sampleRate);
  // release has to be a positive finite number of seconds; 0, negatives and NaN get the default.
  const release = isPosFinite(opts.release) ? opts.release : LIMITER_DEFAULTS.release;
  return { ceiling, lookahead, release };
}
