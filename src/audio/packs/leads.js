// LEADS — voices that want to be the loudest thing in the room. Every one of
// them is a different way of getting a bright, moving spectrum: unison, folding,
// pulse width, FM index, formants, portamento.

import {
  constant,
  driveCurve,
  envGain,
  filter,
  foldCurve,
  formants,
  gain,
  modulate,
  noise,
  osc,
  shaper,
  startAll,
  VOWELS,
} from '../dsp.js';
import { heldVoice } from '../voice.js';

export const LEADS = {
  id: 'leads',
  name: 'LEADS',
  presets: [
    {
      id: 'hypersaw',
      name: 'HYPERSAW',
      accent: '#ff5f8f',
      mood: 'wild',
      reverb: 0.3,
      delay: 0.34,
      gain: 0.46,
      poly: 8,
      build(ctx, { freq, vel, t0, out }) {
        const spread = [-19, -12, -6, 0, 6, 12, 19];
        const oscs = spread.map((d) => osc(ctx, 'sawtooth', freq, d));
        const stack = gain(ctx, 0.16);
        for (const o of oscs) o.connect(stack);

        const sub = osc(ctx, 'square', freq / 2);
        sub.connect(gain(ctx, 0.4)).connect(stack);

        // Two slow drifts pulling opposite halves of the stack apart, so the
        // beating never settles into a fixed pattern.
        const drifts = [
          [osc(ctx, 'sine', 0.17), gain(ctx, 8), [0, 2, 4]],
          [osc(ctx, 'sine', 0.23), gain(ctx, -7), [1, 3, 5]],
        ];
        for (const [lfo, amt, targets] of drifts) {
          lfo.connect(amt);
          for (const i of targets) amt.connect(oscs[i].detune);
        }

        const lp = filter(ctx, 'lowpass', 900, 6);
        lp.frequency.setValueAtTime(Math.min(11000, freq * 11 + 2200), t0);
        lp.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 4 + 800), t0 + 0.5);

        const body = envGain(ctx, t0, { attack: 0.008, decay: 0.42, sustain: 0.72, peak: vel * 0.8 });
        const tail = gain(ctx, 1);
        stack.connect(lp).connect(shaper(ctx, driveCurve(1.8))).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [...oscs, sub, drifts[0][0], drifts[1][0]];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.34);
      },
    },
    {
      id: 'syncsaw',
      name: 'SYNCSAW',
      accent: '#ff4fd8',
      mood: 'wild',
      reverb: 0.24,
      delay: 0.3,
      gain: 0.4,
      build(ctx, { freq, vel, t0, out }) {
        const root = osc(ctx, 'sawtooth', freq);
        const fifth = osc(ctx, 'sawtooth', freq * 1.5);

        // The fold depth is an envelope on the *input* level: quiet in means
        // saturation, loud in means the spectrum tears itself apart. That
        // sweep is the whole character of the sound.
        const drive = envGain(ctx, t0, { attack: 0.012, decay: 0.55, sustain: 0.34, peak: 2.4 + vel * 1.2 });
        root.connect(drive);
        fifth.connect(gain(ctx, 0.4)).connect(drive);

        const lp = filter(ctx, 'lowpass', Math.min(9500, freq * 9 + 1400), 1.1);
        const body = envGain(ctx, t0, { attack: 0.006, decay: 0.3, sustain: 0.7, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        drive.connect(shaper(ctx, foldCurve(3.2), '4x')).connect(lp).connect(body).connect(tail);
        tail.connect(out);

        const vib = modulate(ctx, root.frequency, { rate: 5.1, depth: freq * 0.005 });
        const nodes = [root, fifth, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.22);
      },
    },
    {
      id: 'pwm',
      name: 'PWM CRY',
      accent: '#ff8a5c',
      mood: 'cool',
      reverb: 0.34,
      delay: 0.36,
      gain: 0.24,
      build(ctx, { freq, vel, t0, out }) {
        // Real pulse-width modulation: offset a sawtooth with a moving DC level
        // and slice it at zero. A periodic wave can't do this — its duty is
        // fixed at build time.
        const saw = osc(ctx, 'sawtooth', freq);
        const bias = constant(ctx, -0.1);
        const sum = gain(ctx, 1);
        saw.connect(sum);
        bias.connect(sum);
        const width = modulate(ctx, bias.offset, { rate: 0.62, depth: 0.5 });

        const pulse = shaper(ctx, driveCurve(26), '4x');
        const sine = osc(ctx, 'sine', freq);

        const lp = filter(ctx, 'lowpass', Math.min(8200, freq * 8 + 900), 1.6);
        const body = envGain(ctx, t0, { attack: 0.03, decay: 0.35, sustain: 0.82, peak: vel * 0.5 });
        const tail = gain(ctx, 1);
        sum.connect(pulse).connect(lp);
        sine.connect(gain(ctx, 0.28)).connect(lp);
        lp.connect(body).connect(tail);
        tail.connect(out);

        const vib = modulate(ctx, saw.frequency, { rate: 4.7, depth: freq * 0.004 });
        const nodes = [saw, sine, bias, width, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.24);
      },
    },
    {
      id: 'brass',
      name: 'FM BRASS',
      accent: '#ffb3c7',
      mood: 'happy',
      reverb: 0.4,
      delay: 0.18,
      gain: 0.28,
      build(ctx, { freq, vel, t0, out }) {
        const carrier = osc(ctx, 'sine', freq);
        const m1 = osc(ctx, 'sine', freq);
        const m2 = osc(ctx, 'sine', freq * 2);

        // Three operators in series. The index envelopes are slower than the
        // amplitude envelope, which is exactly what makes a horn a horn.
        const idx2 = envGain(ctx, t0, { attack: 0.1, decay: 0.5, sustain: 0.45, peak: freq * 1.3 });
        m2.connect(idx2);
        idx2.connect(m1.frequency);
        const idx1 = envGain(ctx, t0, { attack: 0.08, decay: 0.45, sustain: 0.5, peak: freq * (2.4 + vel * 2.6) });
        m1.connect(idx1);
        idx1.connect(carrier.frequency);

        // A hair flat on the attack: the player finding the note.
        carrier.frequency.setValueAtTime(freq * 0.985, t0);
        carrier.frequency.linearRampToValueAtTime(freq, t0 + 0.05);

        const lp = filter(ctx, 'lowpass', Math.min(9000, freq * 10 + 1200), 0.9);
        const body = envGain(ctx, t0, { attack: 0.05, decay: 0.32, sustain: 0.85, peak: vel * 0.62 });
        const tail = gain(ctx, 1);
        carrier.connect(lp).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [carrier, m1, m2];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.2);
      },
    },
    {
      id: 'vowel',
      name: 'VOWEL',
      accent: '#d17bff',
      mood: 'zen',
      reverb: 0.46,
      delay: 0.24,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        const a = osc(ctx, 'sawtooth', freq);
        const b = osc(ctx, 'sawtooth', freq, -9);
        const src = gain(ctx, 0.5);
        a.connect(src);
        b.connect(src);

        // Push the tract up for high notes, or the fundamental ends up above
        // the first formant and the vowel disappears.
        const lift = 1 + Math.max(0, (freq - 320) / 1500);
        const tract = formants(ctx, 'a', { q: 11, lift });
        src.connect(tract.input);

        // One LFO morphing every band from 'a' towards 'i' and back: the
        // synth mouthing a word it doesn't know.
        const morph = osc(ctx, 'triangle', 0.72);
        tract.bands.forEach((bp, i) => {
          const from = VOWELS.a[i][0] * lift;
          const to = VOWELS.i[i][0] * lift;
          bp.frequency.value = (from + to) / 2;
          morph.connect(gain(ctx, (to - from) / 2)).connect(bp.frequency);
        });

        const breath = noise(ctx);
        breath.connect(filter(ctx, 'bandpass', 2400, 0.8)).connect(gain(ctx, 0.035)).connect(tract.input);

        const body = envGain(ctx, t0, { attack: 0.05, decay: 0.4, sustain: 0.8, peak: vel * 1.5 });
        const tail = gain(ctx, 1);
        tract.out.connect(body).connect(tail);
        src.connect(gain(ctx, 0.1)).connect(body);
        tail.connect(out);

        const vib = modulate(ctx, a.frequency, { rate: 5.3, depth: freq * 0.006 });
        const nodes = [a, b, morph, breath, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.26);
      },
    },
    {
      id: 'slide',
      name: 'SLIDE',
      accent: '#ff6f5c',
      mood: 'cool',
      reverb: 0.28,
      delay: 0.4,
      gain: 0.34,
      build(ctx, { freq, vel, t0, out }) {
        const from = freq * Math.pow(2, -5 / 12);
        const a = osc(ctx, 'sawtooth', freq);
        const b = osc(ctx, 'square', freq, 7);
        for (const o of [a, b]) {
          o.frequency.setValueAtTime(from, t0);
          o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.09);
        }

        const lp = filter(ctx, 'lowpass', 900, 9);
        lp.frequency.setValueAtTime(Math.max(300, freq * 2), t0);
        lp.frequency.exponentialRampToValueAtTime(Math.min(9000, freq * 7 + 700), t0 + 0.12);
        lp.frequency.exponentialRampToValueAtTime(Math.min(6000, freq * 4 + 400), t0 + 0.7);

        // Vibrato that arrives late, the way a player leans into a held note.
        const vib = osc(ctx, 'sine', 5.6);
        const vibAmt = gain(ctx, 0);
        vibAmt.gain.setValueAtTime(0, t0);
        vibAmt.gain.linearRampToValueAtTime(freq * 0.013, t0 + 0.85);
        vib.connect(vibAmt).connect(a.frequency);
        vibAmt.connect(b.frequency);

        const body = envGain(ctx, t0, { attack: 0.014, decay: 0.36, sustain: 0.74, peak: vel * 0.62 });
        const tail = gain(ctx, 1);
        a.connect(lp);
        b.connect(gain(ctx, 0.4)).connect(lp);
        lp.connect(shaper(ctx, driveCurve(1.6))).connect(body).connect(tail);
        tail.connect(out);

        const nodes = [a, b, vib];
        startAll(nodes, t0);
        return heldVoice(nodes, tail, 0.28);
      },
    },
  ],
};
