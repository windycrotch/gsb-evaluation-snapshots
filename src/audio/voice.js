// What a preset's `build()` hands back, plus the two transient generators that
// nearly every preset opens with.
//
// A voice is `{ release(t) -> endTime, kill(t) -> endTime }`. Presets built with
// `ringVoice` ignore key release and let their own envelope finish, which makes
// hammering the keys feel like a real toy instrument.

import { filter, gain, fadeOut, noiseBuffer, osc, stopAll } from './dsp.js';

export function ringVoice(nodes, tail, t0, length) {
  const end = t0 + length;
  stopAll(nodes, end + 0.05);
  return {
    ring: true,
    endTime: end,
    release() {
      return end;
    },
    kill(t) {
      const e = fadeOut(tail.gain, t, 0.02);
      stopAll(nodes, e + 0.02);
      return e;
    },
  };
}

export function heldVoice(nodes, tail, releaseTime) {
  return {
    ring: false,
    release(t) {
      const end = fadeOut(tail.gain, t, releaseTime);
      stopAll(nodes, end + 0.05);
      return end;
    },
    kill(t) {
      const end = fadeOut(tail.gain, t, 0.02);
      stopAll(nodes, end + 0.02);
      return end;
    },
  };
}

/** Attack transient: the finger, the mallet, the hammer. */
export function click(ctx, out, t0, amount, tone = 2400) {
  if (amount <= 0) return;
  burst(ctx, out, t0, { level: amount, decay: 0.03, freq: tone, q: 1.2 });
}

/**
 * Filtered noise burst that starts and stops itself. The workhorse behind every
 * drum transient, breath attack and wooden thunk.
 */
export function burst(ctx, out, t0, opts = {}) {
  const {
    level = 0.5,
    attack = 0.001,
    decay = 0.08,
    type = 'bandpass',
    freq = 2000,
    q = 1,
    sweepTo = 0,
    rate = 1,
  } = opts;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = rate;
  const f = filter(ctx, type, freq, q);
  if (sweepTo) {
    f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + attack + decay);
  }
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0.0002, t0);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, level), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0002, t0 + attack + decay);
  const span = attack + decay + 0.02;
  // Start somewhere random in the noise buffer, but never so late that the
  // burst runs off the end of it.
  const offset = Math.random() * Math.max(0, 0.95 - span * rate);
  src.connect(f).connect(g).connect(out);
  src.start(t0, offset, span);
  src.stop(t0 + span + 0.02);
  return g;
}

/**
 * Pitched one-shot with an optional pitch drop. Every membrane in the drum
 * packs is one of these plus a `burst` for the skin.
 */
export function blip(ctx, out, t0, opts = {}) {
  const {
    type = 'sine',
    freq = 220,
    bendTo = 0,
    bendTime = 0.05,
    level = 0.5,
    attack = 0.002,
    decay = 0.2,
  } = opts;
  const o = osc(ctx, type, freq);
  if (bendTo) {
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, bendTo), t0 + bendTime);
  }
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0.0002, t0);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, level), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0002, t0 + attack + decay);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.03);
  return g;
}

export function rnd(a, b) {
  return a + Math.random() * (b - a);
}
