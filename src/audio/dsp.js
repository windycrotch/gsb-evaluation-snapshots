// Small Web Audio helpers shared by the presets.

const waveCache = new WeakMap();

/** Band-limited pulse wave of a given duty cycle. */
export function pulseWave(ctx, duty = 0.25, partials = 40) {
  let perCtx = waveCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    waveCache.set(ctx, perCtx);
  }
  const key = `p${duty}:${partials}`;
  let w = perCtx.get(key);
  if (w) return w;
  const real = new Float32Array(partials + 1);
  const imag = new Float32Array(partials + 1);
  for (let n = 1; n <= partials; n++) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  perCtx.set(key, w);
  return w;
}

/** Additive organ-ish wave from a list of harmonic amplitudes. */
export function harmonicWave(ctx, amps, id) {
  let perCtx = waveCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    waveCache.set(ctx, perCtx);
  }
  let w = perCtx.get(id);
  if (w) return w;
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  for (let n = 0; n < amps.length; n++) imag[n + 1] = amps[n];
  w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  perCtx.set(id, w);
  return w;
}

const noiseCache = new WeakMap();

export function noiseBuffer(ctx, seconds = 1) {
  let buf = noiseCache.get(ctx);
  if (buf) return buf;
  const len = Math.floor(ctx.sampleRate * seconds);
  buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

export function osc(ctx, type, freq, detuneCents = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (detuneCents) o.detune.value = detuneCents;
  return o;
}

export function noise(ctx, { loop = true, rate = 1 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = loop;
  s.playbackRate.value = rate;
  return s;
}

/** DC source. Summed with an oscillator it becomes a pulse-width control. */
export function constant(ctx, value = 0) {
  const c = ctx.createConstantSource();
  c.offset.value = value;
  return c;
}

export function gain(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function filter(ctx, type, freq, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/**
 * LFO wired straight to one or more params. Returns the oscillator so the caller
 * can add it to the voice's node list. `shape` is an optional node between the
 * oscillator and the depth gain — a lowpass there rounds off a square LFO.
 */
export function modulate(ctx, param, { type = 'sine', rate = 5, depth = 1, shape = null } = {}) {
  const o = osc(ctx, type, rate);
  const g = gain(ctx, depth);
  if (shape) o.connect(shape).connect(g);
  else o.connect(g);
  for (const p of Array.isArray(param) ? param : [param]) g.connect(p);
  return o;
}

// ---------------------------------------------------------------------------
// Waveshaping. Curves are pure functions of their parameters, so they're cached
// globally rather than per context.
// ---------------------------------------------------------------------------

const CURVES = new Map();

function curveFor(key, fn, n = 2048) {
  let c = CURVES.get(key);
  if (c) return c;
  c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  CURVES.set(key, c);
  return c;
}

export function shaper(ctx, curve, oversample = '2x') {
  const w = ctx.createWaveShaper();
  w.curve = curve;
  w.oversample = oversample;
  return w;
}

/** Tanh saturation, normalised so that unity in stays unity out. */
export function driveCurve(amount = 3) {
  const k = Math.tanh(amount);
  return curveFor(`drive:${amount}`, (x) => Math.tanh(x * amount) / k);
}

/**
 * Sine wavefolder. Harmonics bloom with input level, so an envelope on the
 * gain feeding it becomes a timbre envelope — this is where the screaming
 * sync-style sweeps come from.
 */
export function foldCurve(depth = 2.5) {
  return curveFor(`fold:${depth}`, (x) => Math.sin(x * depth * Math.PI * 0.5));
}

/** Staircase quantiser. Needs `oversample: 'none'` or it stops sounding broken. */
export function crushCurve(steps = 8) {
  return curveFor(`crush:${steps}`, (x) => Math.round(x * steps) / steps, 4096);
}

/**
 * Feed-forward comb: the input plus a short delayed copy. Notches the spectrum
 * without a feedback loop, which Web Audio clamps to a whole render quantum
 * and so cannot be used for anything this short.
 */
export function comb(ctx, seconds, amount = -0.8) {
  const input = gain(ctx, 1);
  const out = gain(ctx, 1);
  const d = ctx.createDelay(0.2);
  d.delayTime.value = seconds;
  input.connect(out);
  input.connect(d).connect(gain(ctx, amount)).connect(out);
  return { input, out, delay: d };
}

// Formant centre frequencies and relative levels, roughly a male vocal tract.
export const VOWELS = {
  a: [[780, 1], [1150, 0.5], [2800, 0.22]],
  e: [[440, 1], [1700, 0.45], [2600, 0.24]],
  i: [[300, 1], [2100, 0.4], [3050, 0.3]],
  o: [[440, 1], [820, 0.45], [2830, 0.14]],
  u: [[330, 1], [700, 0.32], [2530, 0.1]],
};

/** Three resonant bandpasses in parallel: a cheap, cheerful vocal tract. */
export function formants(ctx, vowel, { q = 9, lift = 1 } = {}) {
  const input = gain(ctx, 1);
  const out = gain(ctx, 1);
  const bands = VOWELS[vowel].map(([f, level]) => {
    const bp = filter(ctx, 'bandpass', f * lift, q);
    input.connect(bp).connect(gain(ctx, level)).connect(out);
    return bp;
  });
  return { input, out, bands };
}

const PLUCKS = new Map();
const PLUCK_LIMIT = 64;

/**
 * Karplus-Strong string, rendered into a buffer by hand.
 *
 * A delay line short enough to be musically pitched cannot exist in the Web
 * Audio graph — feedback loops are clamped to 128 samples, which caps the
 * pitch around 375 Hz — so the string is plucked in JS and played back as a
 * buffer. Results are cached per pitch; a run costs well under a millisecond.
 */
export function pluckBuffer(ctx, freq, opts = {}) {
  const { seconds = 1.6, damp = 0.5, tone = 0.6, buzz = 0 } = opts;
  const rate = ctx.sampleRate;
  const key = `${Math.round(freq * 2)}:${rate}:${seconds}:${damp}:${tone}:${buzz}`;
  const cached = PLUCKS.get(key);
  if (cached) return cached;

  const period = Math.max(4, rate / Math.max(20, freq));
  const size = Math.ceil(period) + 2;
  const line = new Float32Array(size);
  // Excitation: noise, lowpassed towards `tone`, which is the pick softness.
  let pick = 0;
  for (let i = 0; i < size; i++) {
    pick += (Math.random() * 2 - 1 - pick) * tone;
    line[i] = pick;
  }

  const len = Math.ceil(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  const loss = Math.pow(0.0008, 1 / (rate * seconds));
  let lp = 0;
  let wp = 0;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    // Fractional read keeps the tuning honest at high pitches, where rounding
    // the delay length to whole samples would be tens of cents out.
    const rp = (wp - period + size) % size;
    const i0 = Math.floor(rp);
    const frac = rp - i0;
    const a = line[i0 % size];
    const b = line[(i0 + 1) % size];
    lp += (a + (b - a) * frac - lp) * damp;
    // Unity small-signal gain, compressing above it: adds the buzz of a
    // sitar's bridge without letting the loop run away.
    let v = buzz ? Math.tanh(lp * buzz) / buzz : lp;
    v *= loss;
    line[wp] = v;
    d[i] = v;
    wp = (wp + 1) % size;
    const mag = Math.abs(v);
    if (mag > peak) peak = mag;
  }
  if (peak > 0) {
    const norm = 0.9 / peak;
    for (let i = 0; i < len; i++) d[i] *= norm;
  }

  if (PLUCKS.size >= PLUCK_LIMIT) PLUCKS.delete(PLUCKS.keys().next().value);
  PLUCKS.set(key, buf);
  return buf;
}

const MIN = 0.00012;

/**
 * Attack / decay / sustain envelope on a gain node.
 * `sustain` of 0 means a one-shot that decays to silence.
 */
export function envGain(ctx, t0, { attack = 0.004, decay = 0.2, sustain = 0, peak = 1 }) {
  const g = ctx.createGain();
  const p = g.gain;
  const top = Math.max(MIN, peak);
  p.setValueAtTime(MIN, t0);
  p.linearRampToValueAtTime(top, t0 + attack);
  p.exponentialRampToValueAtTime(Math.max(MIN, top * sustain), t0 + attack + decay);
  return g;
}

/** Ramp a param down to silence; returns the time it finishes. */
export function fadeOut(param, t, seconds) {
  const now = Math.max(t, 0);
  try {
    param.cancelAndHoldAtTime(now);
  } catch {
    param.cancelScheduledValues(now);
  }
  // Anchor the ramp at `now`. Without an event here, an exponential ramp
  // interpolates from the time of the previous event — and for a tail gain that
  // has never been automated that means the start of the context, so the ramp
  // is already at silence and the note gets chopped instead of released.
  param.setValueAtTime(param.value, now);
  param.exponentialRampToValueAtTime(MIN, now + seconds);
  param.setValueAtTime(0, now + seconds + 0.005);
  return now + seconds + 0.01;
}

export function startAll(nodes, t0) {
  for (const n of nodes) n.start(t0);
}

export function stopAll(nodes, t) {
  for (const n of nodes) {
    try {
      n.stop(t);
    } catch {
      /* already stopped */
    }
  }
}

/** Cheap exponentially-decaying noise impulse response for the reverb. */
export function makeImpulse(ctx, seconds = 2.4, decay = 3.1) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // One-pole lowpass on the noise so the tail darkens as it fades.
      lp += (Math.random() * 2 - 1 - lp) * 0.36;
      const early = i < rate * 0.012 ? i / (rate * 0.012) : 1;
      d[i] = lp * Math.pow(1 - t, decay) * early;
    }
  }
  return buf;
}
