// CLASSIC — the six voices DeskSynth shipped with. Simple, playable, and the
// reason the thing feels like a toy instrument rather than a synthesizer.

import { envGain, filter, gain, harmonicWave, osc, pulseWave, startAll } from '../dsp.js';
import { click, heldVoice, ringVoice } from '../voice.js';

export const CLASSIC = {
  id: 'classic',
  name: 'CLASSIC',
  presets: [
    {
      id: 'bell',
      name: 'GLASSBELL',
      accent: '#7bf7c9',
      mood: 'calm',
      reverb: 0.5,
      delay: 0.22,
      gain: 0.62,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.7 + 1.9 * (1 - Math.min(1, freq / 900));
        const carrier = osc(ctx, 'sine', freq);
        const partial = osc(ctx, 'sine', freq * 2.004);
        const mod = osc(ctx, 'sine', freq * 3.5);

        const modAmt = envGain(ctx, t0, { attack: 0.002, decay: 0.22, sustain: 0, peak: freq * 2.4 * (0.4 + vel * 0.8) });
        mod.connect(modAmt);
        modAmt.connect(carrier.frequency);

        const body = envGain(ctx, t0, { attack: 0.003, decay: length, sustain: 0, peak: vel });
        const shimmer = envGain(ctx, t0, { attack: 0.002, decay: length * 0.35, sustain: 0, peak: vel * 0.3 });
        carrier.connect(body);
        partial.connect(shimmer);

        const tail = gain(ctx, 0.9);
        body.connect(tail);
        shimmer.connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.05, 5200);

        const nodes = [carrier, partial, mod];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.2);
      },
    },
    {
      id: 'pluck',
      name: 'PLUCK',
      accent: '#ffd166',
      mood: 'happy',
      reverb: 0.26,
      delay: 0.16,
      gain: 0.5,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.55 + 0.5 * (1 - Math.min(1, freq / 700));
        const a = osc(ctx, 'sawtooth', freq);
        const b = osc(ctx, 'sawtooth', freq, 9);
        const lp = filter(ctx, 'lowpass', 200, 7);
        lp.frequency.setValueAtTime(Math.min(11000, freq * 14 + 900), t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(180, freq * 1.6), t0 + length * 0.7);

        const body = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.85 });
        const tail = gain(ctx, 1);
        a.connect(lp);
        b.connect(lp);
        lp.connect(body).connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.12, 3000);

        const nodes = [a, b];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'marimba',
      name: 'MARIMBA',
      accent: '#ff9d5c',
      mood: 'happy',
      reverb: 0.32,
      delay: 0.1,
      gain: 0.68,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.75 + 0.85 * (1 - Math.min(1, freq / 800));
        const f0 = osc(ctx, 'sine', freq);
        const f4 = osc(ctx, 'sine', freq * 3.98);
        const f9 = osc(ctx, 'sine', freq * 9.2);

        const g0 = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel });
        const g4 = envGain(ctx, t0, { attack: 0.001, decay: length * 0.16, sustain: 0, peak: vel * 0.42 });
        const g9 = envGain(ctx, t0, { attack: 0.001, decay: 0.05, sustain: 0, peak: vel * 0.12 });
        f0.connect(g0);
        f4.connect(g4);
        f9.connect(g9);

        const tail = gain(ctx, 0.95);
        g0.connect(tail);
        g4.connect(tail);
        g9.connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.1, 1800);

        const nodes = [f0, f4, f9];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'chip',
      name: 'CHIPTUNE',
      accent: '#ffe66d',
      mood: 'wild',
      reverb: 0.14,
      delay: 0.3,
      gain: 0.34,
      build(ctx, { freq, vel, t0, out }) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(pulseWave(ctx, 0.25));
        // Classic blip: start a whole tone sharp and snap down.
        o.frequency.setValueAtTime(freq * 1.19, t0);
        o.frequency.setValueAtTime(freq, t0 + 0.028);

        const vib = osc(ctx, 'sine', 5.6);
        const vibAmt = gain(ctx, 0);
        vibAmt.gain.setValueAtTime(0, t0);
        vibAmt.gain.linearRampToValueAtTime(freq * 0.012, t0 + 0.28);
        vib.connect(vibAmt).connect(o.frequency);

        const body = envGain(ctx, t0, { attack: 0.001, decay: 0.16, sustain: 0.45, peak: vel * 0.85 });
        const tail = gain(ctx, 1);
        o.connect(body).connect(tail);
        tail.connect(out);

        const nodes = [o, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.09);
      },
    },
    {
      id: 'organ',
      name: 'ORGANIC',
      accent: '#63d5ff',
      mood: 'zen',
      reverb: 0.44,
      delay: 0.14,
      gain: 0.34,
      build(ctx, { freq, vel, t0, out }) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(harmonicWave(ctx, [1, 0.55, 0.32, 0.22, 0, 0.14, 0, 0.09], 'organ'));
        o.frequency.value = freq;
        const chorus = osc(ctx, 'sine', freq * 1.004);
        const chorusG = gain(ctx, 0.3);
        chorus.connect(chorusG);

        const lp = filter(ctx, 'lowpass', Math.min(7000, freq * 9 + 700), 0.7);
        const body = envGain(ctx, t0, { attack: 0.02, decay: 0.12, sustain: 0.9, peak: vel * 0.62 });
        const tail = gain(ctx, 1);
        o.connect(lp);
        chorusG.connect(lp);
        lp.connect(body).connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.06, 4200);

        const nodes = [o, chorus];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.14);
      },
    },
    {
      id: 'vapor',
      name: 'VAPOR',
      accent: '#5ef0ff',
      mood: 'dreamy',
      reverb: 0.9,
      delay: 0.5,
      gain: 0.4,
      delayTime: 0.36,
      build(ctx, { freq, vel, t0, out }) {
        const base = osc(ctx, 'triangle', freq);
        const up = osc(ctx, 'sine', freq * 2.01);
        const upG = envGain(ctx, t0, { attack: 0.5, decay: 1.2, sustain: 0.4, peak: vel * 0.28 });
        up.connect(upG);

        const trem = osc(ctx, 'sine', 4.1);
        const tremG = gain(ctx, 0.22);
        trem.connect(tremG);

        const lp = filter(ctx, 'lowpass', Math.min(5200, freq * 6 + 500), 1.4);
        const body = envGain(ctx, t0, { attack: 0.14, decay: 0.9, sustain: 0.55, peak: vel * 0.55 });
        tremG.connect(body.gain);

        const tail = gain(ctx, 1);
        base.connect(lp);
        lp.connect(body).connect(tail);
        upG.connect(tail);
        tail.connect(out);

        const nodes = [base, up, trem];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.4);
      },
    },
  ],
};
