// RETRO — the sound of specific silicon. Each one leans on the limitation that
// gave the original chip its character: fixed duty cycles, ring modulation,
// two-operator FM, four-bit volume, integer frequency dividers.

import {
  crushCurve,
  constant,
  driveCurve,
  envGain,
  filter,
  gain,
  modulate,
  noise,
  osc,
  pulseWave,
  shaper,
  startAll,
} from '../dsp.js';
import { burst, heldVoice, ringVoice } from '../voice.js';

function pulse(ctx, freq, duty) {
  const o = ctx.createOscillator();
  o.setPeriodicWave(pulseWave(ctx, duty));
  o.frequency.value = freq;
  return o;
}

export const RETRO = {
  id: 'retro',
  name: 'RETRO',
  presets: [
    {
      id: 'nes',
      name: 'NES',
      accent: '#ffe66d',
      mood: 'happy',
      reverb: 0.12,
      delay: 0.3,
      gain: 0.8,
      build(ctx, { freq, vel, t0, out }) {
        // Two duty cycles crossfading: the 2A03 could only pick from four, and
        // switching between them mid-note was how you got movement.
        const thin = pulse(ctx, freq, 0.125);
        const fat = pulse(ctx, freq, 0.25);
        const thinG = envGain(ctx, t0, { attack: 0.001, decay: 0.18, sustain: 0, peak: 0.9 });
        const fatG = gain(ctx, 0);
        fatG.gain.setValueAtTime(0.0002, t0);
        fatG.gain.linearRampToValueAtTime(0.9, t0 + 0.2);
        thin.connect(thinG);
        fat.connect(fatG);

        for (const o of [thin, fat]) {
          o.frequency.setValueAtTime(freq * 1.19, t0);
          o.frequency.setValueAtTime(freq, t0 + 0.028);
        }
        // Stepped vibrato, because it was written a frame at a time.
        const vib = modulate(ctx, [thin.frequency, fat.frequency], {
          type: 'square',
          rate: 13,
          depth: freq * 0.006,
        });

        const body = envGain(ctx, t0, { attack: 0.001, decay: 0.2, sustain: 0.5, peak: vel * 0.55 });
        const tail = gain(ctx, 1);
        thinG.connect(body);
        fatG.connect(body);
        body.connect(tail);
        tail.connect(out);

        const nodes = [thin, fat, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.06);
      },
    },
    {
      id: 'sid',
      name: 'SID',
      accent: '#63d5ff',
      mood: 'cool',
      reverb: 0.2,
      delay: 0.34,
      gain: 0.32,
      build(ctx, { freq, vel, t0, out }) {
        // Sawtooth ring-modulated by a triangle a fifth up. Multiplying two
        // oscillators is the 6581's party trick and nothing else sounds like it.
        const carrier = osc(ctx, 'sawtooth', freq);
        const ringer = osc(ctx, 'triangle', freq * 1.5);
        const ring = gain(ctx, 0);
        carrier.connect(ring);
        ringer.connect(ring.gain);

        // Plus a pulse channel with the width sliding, as it always was.
        const saw = osc(ctx, 'sawtooth', freq);
        const bias = constant(ctx, -0.2);
        const sum = gain(ctx, 1);
        saw.connect(sum);
        bias.connect(sum);
        const width = modulate(ctx, bias.offset, { rate: 0.9, depth: 0.55 });

        const lp = filter(ctx, 'lowpass', 700, 11);
        lp.frequency.setValueAtTime(Math.min(7000, freq * 9 + 900), t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(260, freq * 2.2), t0 + 0.4);

        const body = envGain(ctx, t0, { attack: 0.004, decay: 0.28, sustain: 0.55, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        sum.connect(shaper(ctx, driveCurve(22), '4x')).connect(gain(ctx, 0.5)).connect(lp);
        ring.connect(gain(ctx, 0.6)).connect(lp);
        lp.connect(body).connect(tail);
        tail.connect(out);

        const nodes = [carrier, ringer, saw, bias, width];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.1);
      },
    },
    {
      id: 'opl',
      name: 'OPL',
      accent: '#ff9d5c',
      mood: 'wild',
      reverb: 0.26,
      delay: 0.2,
      gain: 0.46,
      build(ctx, { freq, vel, t0, out }) {
        // Two operators, and a third standing in for the operator feedback the
        // OPL2 could apply to itself. That feedback is the buzz in the tone.
        const carrier = osc(ctx, 'sine', freq);
        const mod = osc(ctx, 'sine', freq * 2);
        const fb = osc(ctx, 'sine', freq * 4);
        fb.connect(envGain(ctx, t0, { attack: 0.001, decay: 0.12, sustain: 0.2, peak: freq * 1.6 })).connect(mod.frequency);
        const idx = envGain(ctx, t0, { attack: 0.002, decay: 0.3, sustain: 0.3, peak: freq * (3 + vel * 3) });
        mod.connect(idx);
        idx.connect(carrier.frequency);

        const body = envGain(ctx, t0, { attack: 0.003, decay: 0.35, sustain: 0.6, peak: vel * 0.55 });
        const lp = filter(ctx, 'lowpass', Math.min(9500, freq * 12 + 1000), 0.8);
        const tail = gain(ctx, 1);
        carrier.connect(lp).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [carrier, mod, fb];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.12);
      },
    },
    {
      id: 'gameboy',
      name: 'GAMEBOY',
      accent: '#9bec4b',
      mood: 'happy',
      reverb: 0.1,
      delay: 0.26,
      gain: 0.9,
      build(ctx, { freq, vel, t0, out }) {
        const o = pulse(ctx, freq, 0.5);
        const thin = pulse(ctx, freq, 0.125);
        const sweep = envGain(ctx, t0, { attack: 0.001, decay: 0.1, sustain: 0, peak: 0.7 });
        thin.connect(sweep);

        const vib = modulate(ctx, [o.frequency, thin.frequency], {
          type: 'triangle',
          rate: 6.5,
          depth: freq * 0.009,
        });

        // Four-bit volume steps: the envelope itself is quantised.
        const body = envGain(ctx, t0, { attack: 0.001, decay: 0.24, sustain: 0.55, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        o.connect(gain(ctx, 0.7)).connect(body);
        sweep.connect(body);
        body.connect(shaper(ctx, crushCurve(7), 'none')).connect(tail);
        tail.connect(out);
        // The noise channel, used the way every handheld used it: as a snap.
        burst(ctx, tail, t0, { level: vel * 0.16, decay: 0.03, type: 'highpass', freq: 3000, rate: 0.4 });

        const nodes = [o, thin, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.05);
      },
    },
    {
      id: 'arcade',
      name: 'ARCADE',
      accent: '#ff7bd5',
      mood: 'wild',
      reverb: 0.18,
      delay: 0.32,
      gain: 0.9,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.36;
        const o = pulse(ctx, freq, 0.25);
        // A staircase, not a glide: the sound of a coin, a jump and a laser all
        // came out of stepping a period register once per frame.
        const steps = 7;
        for (let i = 0; i < steps; i++) {
          o.frequency.setValueAtTime(freq * Math.pow(2, i / 4), t0 + i * (length / steps));
        }
        const body = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        o.connect(body).connect(tail);
        tail.connect(out);
        burst(ctx, tail, t0, { level: vel * 0.2, decay: 0.06, freq: 4000, q: 1.4, sweepTo: 9000 });

        const nodes = [o];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.05);
      },
    },
    {
      id: 'atari',
      name: 'ATARI',
      accent: '#c3c9ff',
      mood: 'dark',
      reverb: 0.14,
      delay: 0.24,
      gain: 0.42,
      build(ctx, { freq, vel, t0, out }) {
        // The TIA could only divide its clock by whole numbers, so it was
        // permanently, famously out of tune. The lead here plays the note you
        // asked for and its partner takes the nearest divider, which is where
        // the sour beating comes from without ever playing a wrong note.
        const a = osc(ctx, 'square', freq);
        const b = osc(ctx, 'square', 15700 / Math.max(2, Math.round(15700 / freq)));

        const noisy = noise(ctx, { rate: 0.25 });
        const body = envGain(ctx, t0, { attack: 0.002, decay: 0.3, sustain: 0.7, peak: vel * 0.42 });
        const lp = filter(ctx, 'lowpass', Math.min(6000, freq * 8 + 600), 0.7);
        const tail = gain(ctx, 1);
        a.connect(gain(ctx, 0.6)).connect(lp);
        b.connect(gain(ctx, 0.45)).connect(lp);
        noisy.connect(filter(ctx, 'bandpass', freq * 2, 1.4)).connect(gain(ctx, 0.1)).connect(lp);
        lp.connect(body).connect(shaper(ctx, crushCurve(5), 'none')).connect(tail);
        tail.connect(out);

        const nodes = [a, b, noisy];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.07);
      },
    },
  ],
};
