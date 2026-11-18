// PADS — long, slow, and never static. Each of these has at least two things
// moving at different rates, because a pad that holds still stops sounding like
// air and starts sounding like a test tone.

import {
  crushCurve,
  envGain,
  filter,
  formants,
  gain,
  harmonicWave,
  modulate,
  noise,
  osc,
  shaper,
  startAll,
} from '../dsp.js';
import { blip, heldVoice } from '../voice.js';

/** Two short modulated delays either side of the dry signal. */
function chorus(ctx, input, out, { depth = 0.0022, mix = 0.4 } = {}) {
  const lfos = [];
  input.connect(out);
  [[0.0115, 0.21], [0.0173, 0.33]].forEach(([time, rate], i) => {
    const d = ctx.createDelay(0.2);
    d.delayTime.value = time;
    lfos.push(modulate(ctx, d.delayTime, { rate, depth: i ? -depth : depth }));
    input.connect(d).connect(gain(ctx, mix)).connect(out);
  });
  return lfos;
}

export const PADS_PACK = {
  id: 'pads',
  name: 'PADS',
  presets: [
    {
      id: 'warmth',
      name: 'WARMTH',
      accent: '#b6a8ff',
      mood: 'chill',
      reverb: 0.76,
      delay: 0.26,
      gain: 0.62,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const voices = [-11, -5, -2, 3, 7, 12];
        const oscs = voices.map((d, i) => osc(ctx, i % 2 ? 'sawtooth' : 'triangle', freq, d));
        const stack = gain(ctx, 0.17);
        for (const o of oscs) o.connect(stack);

        const lp = filter(ctx, 'lowpass', 700, 1.1);
        lp.frequency.setValueAtTime(Math.min(1300, freq * 2.2 + 320), t0);
        lp.frequency.linearRampToValueAtTime(Math.min(4600, freq * 5 + 1000), t0 + 1.8);
        const breathe = modulate(ctx, lp.frequency, { rate: 0.19, depth: 300 });

        const wide = gain(ctx, 1);
        const lfos = chorus(ctx, lp, wide, { mix: 0.42 });

        const body = envGain(ctx, t0, { attack: 0.4, decay: 0.8, sustain: 0.82, peak: vel * 0.55 });
        const tail = gain(ctx, 1);
        stack.connect(lp);
        wide.connect(body).connect(tail);
        tail.connect(out);

        const nodes = [...oscs, breathe, ...lfos];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.3);
      },
    },
    {
      id: 'choir',
      name: 'CHOIR',
      accent: '#8fd3ff',
      mood: 'zen',
      reverb: 0.86,
      delay: 0.2,
      gain: 0.5,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const lift = 1 + Math.max(0, (freq - 300) / 1400);
        const singers = [0, -7, 6].map((d, i) => {
          const o = osc(ctx, 'sawtooth', freq, d);
          // Each singer has their own vibrato rate, which is the difference
          // between a choir and one loud person.
          const vib = modulate(ctx, o.frequency, { rate: 4.3 + i * 0.7, depth: freq * 0.004 });
          return [o, vib];
        });
        const src = gain(ctx, 0.3);
        for (const [o] of singers) o.connect(src);

        const ah = formants(ctx, 'o', { q: 7, lift });
        const oh = formants(ctx, 'a', { q: 6, lift });
        src.connect(ah.input);
        src.connect(oh.input);

        const breath = noise(ctx);
        breath.connect(filter(ctx, 'bandpass', 2600, 0.7)).connect(gain(ctx, 0.05)).connect(ah.input);

        const body = envGain(ctx, t0, { attack: 0.32, decay: 0.9, sustain: 0.85, peak: vel * 1.1 });
        const tail = gain(ctx, 1);
        ah.out.connect(body);
        oh.out.connect(gain(ctx, 0.55)).connect(body);
        src.connect(gain(ctx, 0.12)).connect(body);
        body.connect(tail);
        tail.connect(out);

        const nodes = [...singers.flat(), breath];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.1);
      },
    },
    {
      id: 'glacier',
      name: 'GLACIER',
      accent: '#7fe3e0',
      mood: 'calm',
      reverb: 0.94,
      delay: 0.3,
      gain: 1.0,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        // No oscillators at all: noise poured through a bank of very narrow
        // resonators, which pitches it without ever quite settling.
        const air = noise(ctx);
        const bank = gain(ctx, 1);
        const lfos = [1, 2, 3.01, 4.7, 6.2].map((ratio, i) => {
          const bp = filter(ctx, 'bandpass', Math.min(11000, freq * ratio), 26 + i * 6);
          const g = gain(ctx, 1 / (1 + i * 0.8));
          air.connect(bp).connect(g).connect(bank);
          return modulate(ctx, g.gain, { rate: 0.07 + i * 0.05, depth: 0.35 / (1 + i) });
        });

        const hp = filter(ctx, 'highpass', 120, 0.7);
        const body = envGain(ctx, t0, { attack: 0.9, decay: 1.4, sustain: 0.9, peak: vel * 2.6 });
        const tail = gain(ctx, 1);
        bank.connect(hp).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [air, ...lfos];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 2.2);
      },
    },
    {
      id: 'drone',
      name: 'DRONE',
      accent: '#cbb6ff',
      mood: 'dreamy',
      reverb: 0.9,
      delay: 0.24,
      gain: 0.48,
      poly: 6,
      build(ctx, { freq, vel, t0, out }) {
        // Deliberately out-of-tune partials. The cluster never repeats, so the
        // longer you hold it the less it sounds like a chord.
        const ratios = [1, 2.01, 2.98, 4.03, 5.42, 6.97];
        const cluster = gain(ctx, 1);
        const nodes = [];
        for (const [i, r] of ratios.entries()) {
          const o = osc(ctx, i > 3 ? 'sine' : 'triangle', freq * r);
          const g = gain(ctx, 0.3 / (1 + i * 0.7));
          o.connect(g).connect(cluster);
          nodes.push(o, modulate(ctx, g.gain, { rate: 0.11 + i * 0.09, depth: 0.16 / (1 + i * 0.5) }));
        }

        const lp = filter(ctx, 'lowpass', Math.min(6000, freq * 9 + 600), 0.8);
        const body = envGain(ctx, t0, { attack: 1.1, decay: 1.6, sustain: 0.9, peak: vel * 0.75 });
        const tail = gain(ctx, 1);
        cluster.connect(lp).connect(body).connect(tail);
        tail.connect(out);

        startAll(nodes, t0);
        return heldVoice(nodes, tail, 2.4);
      },
    },
    {
      id: 'shimmer',
      name: 'SHIMMER',
      accent: '#9fb8ff',
      mood: 'dreamy',
      reverb: 0.92,
      delay: 0.46,
      gain: 0.44,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const base = osc(ctx, 'triangle', freq);
        const fifth = osc(ctx, 'sine', freq * 3.005);
        const octave = osc(ctx, 'sine', freq * 4.01);
        const stack = gain(ctx, 1);
        const lfos = [];
        for (const [o, level, rate] of [[base, 0.5, 0.13], [fifth, 0.16, 0.21], [octave, 0.11, 0.29]]) {
          const g = gain(ctx, level);
          o.connect(g).connect(stack);
          lfos.push(modulate(ctx, g.gain, { rate, depth: level * 0.7 }));
        }

        // Twinkles seeded ahead of time across the first few seconds. Held
        // notes can't schedule anything new once they're running, so the sparkle
        // has to be written in advance.
        const tail = gain(ctx, 1);
        for (let i = 0; i < 9; i++) {
          const at = t0 + 0.2 + i * 0.42 + Math.random() * 0.2;
          const partial = [4, 6, 8, 12][Math.floor(Math.random() * 4)];
          blip(ctx, tail, at, {
            freq: Math.min(9000, freq * partial),
            level: vel * 0.05,
            attack: 0.004,
            decay: 0.5,
          });
        }

        const lp = filter(ctx, 'lowpass', Math.min(7000, freq * 8 + 900), 0.7);
        const body = envGain(ctx, t0, { attack: 0.55, decay: 1.2, sustain: 0.8, peak: vel * 0.6 });
        stack.connect(lp).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [base, fifth, octave, ...lfos];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.6);
      },
    },
    {
      id: 'tape',
      name: 'TAPE',
      accent: '#a9c7d8',
      mood: 'chill',
      reverb: 0.6,
      delay: 0.4,
      gain: 0.34,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(harmonicWave(ctx, [1, 0.42, 0.3, 0.12, 0.1, 0.05, 0.04], 'tape'));
        o.frequency.value = freq;
        const pair = osc(ctx, 'triangle', freq, 8);

        // Wow and flutter: a slow drift plus a faster wobble, both on pitch.
        const wow = modulate(ctx, o.frequency, { rate: 0.43, depth: freq * 0.008 });
        const flutter = modulate(ctx, o.frequency, { rate: 4.9, depth: freq * 0.0018 });
        const drift = modulate(ctx, pair.frequency, { rate: 0.31, depth: freq * 0.01 });

        const hiss = noise(ctx);
        const lp = filter(ctx, 'lowpass', Math.min(3400, freq * 6 + 500), 1.1);
        const body = envGain(ctx, t0, { attack: 0.25, decay: 0.9, sustain: 0.8, peak: vel * 0.6 });
        const tail = gain(ctx, 1);
        o.connect(lp);
        pair.connect(gain(ctx, 0.4)).connect(lp);
        hiss.connect(filter(ctx, 'highpass', 1800, 0.7)).connect(gain(ctx, 0.012)).connect(lp);
        lp.connect(shaper(ctx, crushCurve(28), 'none')).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [o, pair, wow, flutter, drift, hiss];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.2);
      },
    },
  ],
};
