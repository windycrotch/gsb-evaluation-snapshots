// MOTION — presets where one key press is an event rather than a note. Held
// voices can't schedule anything after they start, so every pattern here is
// written into the timeline at build time and then plays itself out.

import {
  comb,
  driveCurve,
  envGain,
  filter,
  gain,
  modulate,
  osc,
  shaper,
  startAll,
} from '../dsp.js';
import { blip, heldVoice, ringVoice, rnd } from '../voice.js';

/** One plucked note of a pattern, scheduled at `at`. Returns its oscillators. */
function stab(ctx, out, at, { freq, vel, decay = 0.3, bright = 12 }) {
  const a = osc(ctx, 'sawtooth', freq);
  const b = osc(ctx, 'square', freq, 7);
  const lp = filter(ctx, 'lowpass', 400, 6);
  lp.frequency.setValueAtTime(Math.min(9000, freq * bright), at);
  lp.frequency.exponentialRampToValueAtTime(Math.max(280, freq * 2), at + decay);
  const g = envGain(ctx, at, { attack: 0.004, decay, sustain: 0, peak: vel });
  a.connect(lp);
  b.connect(gain(ctx, 0.4)).connect(lp);
  lp.connect(g).connect(out);
  a.start(at);
  b.start(at);
  return [a, b];
}

export const MOTION = {
  id: 'motion',
  name: 'MOTION',
  presets: [
    {
      id: 'gate',
      name: 'GATE',
      accent: '#5ef0ff',
      mood: 'cool',
      reverb: 0.44,
      delay: 0.3,
      gain: 0.6,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const oscs = [-12, -5, 0, 6, 13].map((d) => osc(ctx, 'sawtooth', freq, d));
        const stack = gain(ctx, 0.2);
        for (const o of oscs) o.connect(stack);

        // A square LFO through a lowpass: the chop keeps its rhythm but loses
        // the click that a raw square gate would put on every edge.
        const gateG = gain(ctx, 0.5);
        const chop = modulate(ctx, gateG.gain, {
          type: 'square',
          rate: 8,
          depth: 0.46,
          shape: filter(ctx, 'lowpass', 45, 0.7),
        });

        const lp = filter(ctx, 'lowpass', Math.min(7000, freq * 7 + 1200), 3);
        const body = envGain(ctx, t0, { attack: 0.02, decay: 0.5, sustain: 0.85, peak: vel * 0.7 });
        const tail = gain(ctx, 1);
        stack.connect(lp).connect(gateG).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [...oscs, chop];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.3);
      },
    },
    {
      id: 'arp',
      name: 'ARP',
      accent: '#3fb8ff',
      mood: 'happy',
      reverb: 0.36,
      delay: 0.34,
      gain: 0.62,
      build(ctx, { freq, vel, t0, out }) {
        const step = 0.105;
        const tail = gain(ctx, 1);
        tail.connect(out);
        // Fifths and octaves only, so it lands in tune against whatever else is
        // being held down, in any scale.
        const nodes = [0, 7, 12, 19].flatMap((semis, i) =>
          stab(ctx, tail, t0 + i * step, {
            freq: freq * Math.pow(2, semis / 12),
            vel: vel * (0.55 - i * 0.05),
            decay: 0.26,
          }),
        );
        return ringVoice(nodes, tail, t0, 3 * step + 0.32);
      },
    },
    {
      id: 'echo',
      name: 'ECHO',
      accent: '#7f9dff',
      mood: 'dreamy',
      reverb: 0.56,
      delay: 0.4,
      gain: 0.9,
      delayTime: 0.33,
      build(ctx, { freq, vel, t0, out }) {
        const tail = gain(ctx, 1);
        tail.connect(out);
        // The stab, then three repeats climbing an octave each and thinning out
        // as they go — an echo that escapes upwards.
        const taps = [0, 12, 24, 36];
        const nodes = [];
        taps.forEach((semis, i) => {
          const at = t0 + i * 0.17;
          const f = Math.min(6000, freq * Math.pow(2, semis / 12));
          const carrier = osc(ctx, 'sine', f);
          const mod = osc(ctx, 'sine', f * 3.5);
          const idx = envGain(ctx, at, { attack: 0.002, decay: 0.16, sustain: 0, peak: f * 1.8 });
          mod.connect(idx);
          idx.connect(carrier.frequency);
          const g = envGain(ctx, at, { attack: 0.003, decay: 0.5 + i * 0.2, sustain: 0, peak: vel * (0.5 / (1 + i * 0.9)) });
          carrier.connect(g).connect(tail);
          carrier.start(at);
          mod.start(at);
          nodes.push(carrier, mod);
        });
        return ringVoice(nodes, tail, t0, 3 * 0.17 + 1.2);
      },
    },
    {
      id: 'spin',
      name: 'SPIN',
      accent: '#4affd0',
      mood: 'dreamy',
      reverb: 0.62,
      delay: 0.32,
      gain: 0.4,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const oscs = [-9, 0, 9].map((d) => osc(ctx, 'sawtooth', freq, d));
        const stack = gain(ctx, 0.3);
        for (const o of oscs) o.connect(stack);

        // Two combs sweeping at different rates. Where their notches cross, the
        // sound appears to rotate.
        const jets = [comb(ctx, 0.0022, -0.9), comb(ctx, 0.0047, 0.85)];
        const sweeps = jets.map((j, i) =>
          modulate(ctx, j.delay.delayTime, { rate: 0.13 + i * 0.21, depth: 0.0018 }),
        );
        stack.connect(jets[0].input);
        jets[0].out.connect(jets[1].input);

        const lp = filter(ctx, 'lowpass', Math.min(6000, freq * 6 + 900), 1.2);
        const body = envGain(ctx, t0, { attack: 0.35, decay: 0.9, sustain: 0.85, peak: vel * 0.55 });
        const tail = gain(ctx, 1);
        jets[1].out.connect(lp).connect(shaper(ctx, driveCurve(1.5))).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [...oscs, ...sweeps];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 1.1);
      },
    },
    {
      id: 'bubble',
      name: 'BUBBLE',
      accent: '#3ff0e8',
      mood: 'wild',
      reverb: 0.5,
      delay: 0.44,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.05;
        const o = osc(ctx, 'square', freq);
        const sub = osc(ctx, 'triangle', freq / 2);

        // Sample and hold: a new random cutoff and a new octave every 70 ms,
        // stepped rather than ramped, which is what makes it burble.
        const lp = filter(ctx, 'lowpass', freq * 4, 13);
        const jumps = [1, 1, 1, 2, 0.5, 1.5];
        for (let i = 0; i * 0.07 < length; i++) {
          const at = t0 + i * 0.07;
          lp.frequency.setValueAtTime(Math.min(9000, freq * rnd(2, 16)), at);
          o.frequency.setValueAtTime(freq * jumps[Math.floor(Math.random() * jumps.length)], at);
        }

        const body = envGain(ctx, t0, { attack: 0.01, decay: length, sustain: 0, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        o.connect(lp);
        sub.connect(gain(ctx, 0.3)).connect(lp);
        lp.connect(body).connect(tail);
        tail.connect(out);

        const nodes = [o, sub];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'ripple',
      name: 'RIPPLE',
      accent: '#a6f7ff',
      mood: 'calm',
      reverb: 0.86,
      delay: 0.5,
      gain: 0.7,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.6;
        const tail = gain(ctx, 1);
        tail.connect(out);

        // A cloud of grains climbing the harmonic series. Nothing sustains; the
        // note is the shape of the scatter.
        const partials = [1, 2, 3, 4, 5, 6, 8, 10];
        for (let i = 0; i < 16; i++) {
          const at = t0 + i * 0.082 + rnd(0, 0.035);
          const partial = partials[Math.min(partials.length - 1, Math.floor(i / 2 + rnd(0, 2)))];
          blip(ctx, tail, at, {
            type: i % 3 ? 'sine' : 'triangle',
            freq: Math.min(9000, freq * partial),
            level: vel * 0.26 * (1 - i / 22),
            attack: 0.012,
            decay: 0.34,
          });
        }
        const base = osc(ctx, 'sine', freq);
        const body = envGain(ctx, t0, { attack: 0.03, decay: length, sustain: 0, peak: vel * 0.45 });
        base.connect(body).connect(tail);

        const nodes = [base];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.2);
      },
    },
  ],
};
