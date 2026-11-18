// BASS — six ways to hold down the bottom. These all keep their energy under
// about 400 Hz, so they stay useful even on the low pentatonic scales where the
// keyboard starts at 55 Hz.

import {
  comb,
  crushCurve,
  driveCurve,
  envGain,
  filter,
  foldCurve,
  gain,
  modulate,
  osc,
  pluckBuffer,
  shaper,
  startAll,
} from '../dsp.js';
import { click, heldVoice, ringVoice } from '../voice.js';

export const BASS = {
  id: 'bass',
  name: 'BASS',
  presets: [
    {
      id: 'sub',
      name: 'SUB DROP',
      accent: '#8b7bff',
      mood: 'chill',
      reverb: 0.1,
      delay: 0.08,
      gain: 0.62,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.1 + 1.1 * (1 - Math.min(1, freq / 320));
        const o = osc(ctx, 'sine', freq);
        // The 808 trick: a fast drop into the note, then a slow droop through
        // the tail, which is what reads as "huge" rather than "low".
        o.frequency.setValueAtTime(freq * 3.4, t0);
        o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.06);
        o.frequency.exponentialRampToValueAtTime(freq * 0.94, t0 + length);

        const body = envGain(ctx, t0, { attack: 0.005, decay: length, sustain: 0, peak: vel * 0.95 });
        const tail = gain(ctx, 1);
        // A little saturation so the harmonics survive small speakers.
        o.connect(body).connect(shaper(ctx, driveCurve(1.7))).connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.07, 1700);

        const nodes = [o];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'reese',
      name: 'REESE',
      accent: '#6d5cff',
      mood: 'dark',
      reverb: 0.14,
      delay: 0.12,
      gain: 0.25,
      build(ctx, { freq, vel, t0, out }) {
        const oscs = [-26, 0, 26].map((d) => osc(ctx, 'sawtooth', freq, d));
        const stack = gain(ctx, 0.3);
        for (const o of oscs) o.connect(stack);
        const sub = osc(ctx, 'sine', freq / 2);
        sub.connect(gain(ctx, 0.5)).connect(stack);

        // A comb notch drifting across the detune beating: the sound is the
        // interference, not the oscillators.
        const notch = comb(ctx, 0.0012, -0.85);
        const sweep = modulate(ctx, notch.delay.delayTime, { rate: 0.29, depth: 0.0005 });

        const lp = filter(ctx, 'lowpass', Math.min(2600, freq * 7 + 260), 3.2);
        const body = envGain(ctx, t0, { attack: 0.022, decay: 0.4, sustain: 0.88, peak: vel * 0.8 });
        const tail = gain(ctx, 1);
        stack.connect(notch.input);
        notch.out.connect(lp).connect(shaper(ctx, driveCurve(2.2))).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [...oscs, sub, sweep];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.2);
      },
    },
    {
      id: 'acid',
      name: 'ACID',
      accent: '#a95cff',
      mood: 'wild',
      reverb: 0.16,
      delay: 0.28,
      gain: 0.45,
      build(ctx, { freq, vel, t0, out }) {
        const o = osc(ctx, 'sawtooth', freq);
        const o2 = osc(ctx, 'sawtooth', freq, 5);

        // One resonant sweep per note, harder the harder you hit it. Nearly all
        // of the 303's personality lives in this envelope and that Q.
        const lp = filter(ctx, 'lowpass', 400, 15);
        const open = Math.min(7000, freq * (7 + vel * 9) + 500);
        lp.frequency.setValueAtTime(open, t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 1.5), t0 + 0.26 + vel * 0.2);

        const body = envGain(ctx, t0, { attack: 0.004, decay: 0.3, sustain: 0.45, peak: vel * 0.6 });
        const tail = gain(ctx, 1);
        o.connect(lp);
        o2.connect(gain(ctx, 0.5)).connect(lp);
        lp.connect(shaper(ctx, driveCurve(3.4))).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [o, o2];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.1);
      },
    },
    {
      id: 'growl',
      name: 'GROWL',
      accent: '#c05cff',
      mood: 'wild',
      reverb: 0.18,
      delay: 0.2,
      gain: 0.31,
      build(ctx, { freq, vel, t0, out }) {
        const carrier = osc(ctx, 'triangle', freq);
        const mod = osc(ctx, 'sine', freq * 1.5);

        // FM index wobbling at 5 Hz. A moving index on a 3:2 ratio is what
        // makes it sound like a mouth rather than a filter.
        const idx = gain(ctx, freq * 1.6);
        const wobble = modulate(ctx, idx.gain, { rate: 5.2, depth: freq * 1.2 });
        mod.connect(idx);
        idx.connect(carrier.frequency);

        const drive = gain(ctx, 1.5);
        const lp = filter(ctx, 'lowpass', Math.min(3400, freq * 8 + 300), 2.4);
        const body = envGain(ctx, t0, { attack: 0.02, decay: 0.4, sustain: 0.85, peak: vel * 0.55 });
        const tail = gain(ctx, 1);
        carrier.connect(drive).connect(shaper(ctx, foldCurve(1.6))).connect(lp).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [carrier, mod, wobble];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.16);
      },
    },
    {
      id: 'slap',
      name: 'SLAP',
      accent: '#5c7dff',
      mood: 'happy',
      reverb: 0.12,
      delay: 0.1,
      gain: 0.7,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.15;
        const src = ctx.createBufferSource();
        src.buffer = pluckBuffer(ctx, freq, { seconds: length, damp: 0.55, tone: 0.9 });

        // Envelope filter: the string is real, the funk is the filter opening
        // and closing over the first 200 ms.
        const bp = filter(ctx, 'lowpass', 400, 6);
        bp.frequency.setValueAtTime(Math.max(200, freq * 3), t0);
        bp.frequency.exponentialRampToValueAtTime(Math.min(6500, freq * 22 + 700), t0 + 0.05);
        bp.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 4), t0 + 0.35);

        const sub = osc(ctx, 'sine', freq);
        const subG = envGain(ctx, t0, { attack: 0.004, decay: 0.5, sustain: 0, peak: vel * 0.42 });
        sub.connect(subG);

        const body = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.8 });
        const tail = gain(ctx, 1);
        src.connect(bp).connect(shaper(ctx, driveCurve(2))).connect(body).connect(tail);
        subG.connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.14, 1100);

        const nodes = [src, sub];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length);
      },
    },
    {
      id: 'donk',
      name: 'DONK',
      accent: '#7a6bff',
      mood: 'wild',
      reverb: 0.1,
      delay: 0.3,
      gain: 0.8,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.34;
        const carrier = osc(ctx, 'sine', freq * 2);
        carrier.frequency.setValueAtTime(freq * 3, t0);
        carrier.frequency.exponentialRampToValueAtTime(freq * 2, t0 + 0.05);
        const mod = osc(ctx, 'square', freq * 2);
        const idx = envGain(ctx, t0, { attack: 0.001, decay: 0.09, sustain: 0, peak: freq * 5 });
        mod.connect(idx);
        idx.connect(carrier.frequency);

        const body = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.7 });
        const lp = filter(ctx, 'lowpass', Math.min(4200, freq * 10 + 400), 1.4);
        const tail = gain(ctx, 1);
        carrier
          .connect(body)
          // No oversampling: the aliasing is the point.
          .connect(shaper(ctx, crushCurve(6), 'none'))
          .connect(lp)
          .connect(tail);
        tail.connect(out);

        const nodes = [carrier, mod];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.05);
      },
    },
  ],
};
