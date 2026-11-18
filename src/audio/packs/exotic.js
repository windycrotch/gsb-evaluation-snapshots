// EXOTIC — instruments made of metal, wood and air. Mostly inharmonic partial
// banks and resonators, which is what separates a struck object from a synth
// playing a note.

import {
  envGain,
  filter,
  gain,
  harmonicWave,
  modulate,
  noise,
  osc,
  pluckBuffer,
  startAll,
} from '../dsp.js';
import { burst, click, heldVoice, ringVoice } from '../voice.js';

export const EXOTIC = {
  id: 'exotic',
  name: 'EXOTIC',
  presets: [
    {
      id: 'gamelan',
      name: 'GAMELAN',
      accent: '#ffd166',
      mood: 'zen',
      reverb: 0.6,
      delay: 0.14,
      gain: 0.24,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.6 + 1.6 * (1 - Math.min(1, freq / 900));
        // Measured-ish bar modes, and every one of them doubled a few cents off
        // so the bronze beats against itself.
        const modes = [[1, 1, length], [2.76, 0.5, length * 0.5], [5.4, 0.28, length * 0.22], [8.93, 0.14, 0.1]];
        const tail = gain(ctx, 0.9);
        const nodes = [];
        for (const [ratio, level, decay] of modes) {
          const env = envGain(ctx, t0, { attack: 0.002, decay, sustain: 0, peak: vel * level });
          env.connect(tail);
          for (const cents of [0, 7]) {
            const o = osc(ctx, 'sine', freq * ratio, cents);
            o.connect(env);
            nodes.push(o);
          }
        }
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.12, 4600);

        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.2);
      },
    },
    {
      id: 'sitar',
      name: 'SITAR',
      accent: '#e89a3c',
      mood: 'wild',
      reverb: 0.5,
      delay: 0.2,
      gain: 0.7,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.9;
        const src = ctx.createBufferSource();
        // `buzz` is a soft clipper inside the string's own feedback loop, which
        // is roughly what the sitar's curved bridge does to it.
        src.buffer = pluckBuffer(ctx, freq, { seconds: length, damp: 0.36, tone: 0.95, buzz: 3.4 });

        const bp = filter(ctx, 'lowpass', Math.min(6000, freq * 5), 2.4);
        const body = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.9 });

        // Sympathetic strings: a fifth and an octave that ring on their own.
        const tail = gain(ctx, 1);
        const drones = [1.5, 2].map((r, i) => {
          const o = osc(ctx, 'triangle', freq * r);
          const g = envGain(ctx, t0, { attack: 0.06, decay: length * 0.8, sustain: 0, peak: vel * (0.08 - i * 0.03) });
          o.connect(g).connect(tail);
          return o;
        });

        src.connect(bp).connect(body).connect(tail);
        tail.connect(out);
        click(ctx, tail, t0, vel * 0.1, 3200);

        const nodes = [src, ...drones];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length);
      },
    },
    {
      id: 'kalimba',
      name: 'KALIMBA',
      accent: '#ffe0a3',
      mood: 'happy',
      reverb: 0.42,
      delay: 0.18,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.7 + 0.7 * (1 - Math.min(1, freq / 800));
        const f0 = osc(ctx, 'sine', freq);
        const f1 = osc(ctx, 'sine', freq * 3.24);
        const g0 = envGain(ctx, t0, { attack: 0.003, decay: length, sustain: 0, peak: vel * 0.9 });
        const g1 = envGain(ctx, t0, { attack: 0.001, decay: length * 0.2, sustain: 0, peak: vel * 0.24 });
        f0.connect(g0);
        f1.connect(g1);

        const tail = gain(ctx, 1);
        g0.connect(tail);
        g1.connect(tail);
        tail.connect(out);
        // Thumbnail on tine, then the wooden box it's bolted to.
        click(ctx, tail, t0, vel * 0.12, 3600);
        burst(ctx, tail, t0, { level: vel * 0.16, decay: 0.05, freq: 260, q: 1.6, sweepTo: 130 });

        const nodes = [f0, f1];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'hang',
      name: 'HANG',
      accent: '#7bf7c9',
      mood: 'calm',
      reverb: 0.66,
      delay: 0.22,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.5 + 1.2 * (1 - Math.min(1, freq / 700));
        const tail = gain(ctx, 1);
        const nodes = [];
        // A steel pan is a fundamental with a strong octave and a twelfth, all
        // sharing one long dome resonance.
        for (const [ratio, level, decay] of [[1, 0.9, length], [2.01, 0.4, length * 0.7], [3.02, 0.18, length * 0.4]]) {
          const o = osc(ctx, 'sine', freq * ratio);
          const g = envGain(ctx, t0, { attack: 0.006, decay, sustain: 0, peak: vel * level });
          o.connect(g).connect(tail);
          nodes.push(o);
        }
        // The metallic bloom: noise held in a narrow resonance above the note.
        burst(ctx, tail, t0, { level: vel * 0.3, attack: 0.004, decay: 0.4, freq: Math.min(7000, freq * 4.2), q: 14 });
        tail.connect(out);

        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.2);
      },
    },
    {
      id: 'bowl',
      name: 'BOWL',
      accent: '#a8f0e0',
      mood: 'zen',
      reverb: 0.88,
      delay: 0.1,
      gain: 0.4,
      poly: 6,
      build(ctx, { freq, vel, t0, out }) {
        const length = 4.5 + 2 * (1 - Math.min(1, freq / 700));
        const tail = gain(ctx, 1);
        // Two sines about a beat apart. The slow throb between them is the
        // entire reason a singing bowl sounds alive.
        const pair = [freq, freq + 1.15].map((f, i) => {
          const o = osc(ctx, 'sine', f);
          const g = envGain(ctx, t0, { attack: 0.05, decay: length, sustain: 0, peak: vel * (0.7 - i * 0.12) });
          o.connect(g).connect(tail);
          return o;
        });
        const upper = osc(ctx, 'sine', freq * 2.72);
        const upperG = envGain(ctx, t0, { attack: 0.02, decay: length * 0.35, sustain: 0, peak: vel * 0.16 });
        upper.connect(upperG).connect(tail);

        tail.connect(out);
        burst(ctx, tail, t0, { level: vel * 0.12, decay: 0.12, freq: Math.min(6000, freq * 5), q: 3 });

        const nodes = [...pair, upper];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length);
      },
    },
    {
      id: 'shaku',
      name: 'SHAKU',
      accent: '#c9d98a',
      mood: 'zen',
      reverb: 0.7,
      delay: 0.16,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        // A blown pipe is mostly noise held in a resonance; the oscillator is
        // only there to keep the pitch honest.
        const air = noise(ctx);
        const pipe = filter(ctx, 'bandpass', freq, 18);
        const pipe2 = filter(ctx, 'bandpass', freq * 3, 12);
        const breathy = gain(ctx, 6);
        air.connect(pipe).connect(breathy);
        air.connect(pipe2).connect(gain(ctx, 2.4)).connect(breathy);

        const tone = ctx.createOscillator();
        tone.setPeriodicWave(harmonicWave(ctx, [1, 0.06, 0.3, 0.04, 0.12], 'pipe'));
        tone.frequency.value = freq;
        // The note never quite settles, which is most of the expression.
        const waver = modulate(ctx, tone.frequency, { rate: 4.6, depth: freq * 0.007 });
        const wander = modulate(ctx, pipe.frequency, { rate: 0.7, depth: freq * 0.02 });

        const body = envGain(ctx, t0, { attack: 0.09, decay: 0.5, sustain: 0.85, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        tone.connect(gain(ctx, 0.55)).connect(body);
        breathy.connect(gain(ctx, 0.09)).connect(body);
        body.connect(tail);
        tail.connect(out);
        burst(ctx, tail, t0, { level: vel * 0.12, attack: 0.02, decay: 0.14, type: 'highpass', freq: 2600 });

        const nodes = [air, tone, waver, wander];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.3);
      },
    },
  ],
};
