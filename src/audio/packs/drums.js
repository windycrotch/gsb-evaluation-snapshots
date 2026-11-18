// DRUMS — the two kit presets map each pitch class to a different piece, so a
// scale hands you a drum kit rather than thirty tuned copies of one drum. The
// other four are single instruments that do track pitch.

import { crushCurve, envGain, filter, gain, noise, osc, shaper, startAll } from '../dsp.js';
import { blip, burst, ringVoice, rnd } from '../voice.js';

// Pitch class → [piece, semitone trim]. Chosen so that all eight scales land on
// a usable spread: every one of them gets a kick, a snare or clap, and a hat.
const KIT = [
  ['kick', 0],
  ['rim', 0],
  ['snare', 0],
  ['clap', 0],
  ['tom', -2],
  ['openhat', 0],
  ['cowbell', 0],
  ['hat', 0],
  ['ride', 0],
  ['snare', 3],
  ['tom', 5],
  ['hat', 7],
];

/** The 808's cymbal: six squares at fixed inharmonic ratios, filtered hard. */
function metal(ctx, out, t0, { level, tune, decay, hp = 7000, q = 0.8 }) {
  const bus = gain(ctx, 0);
  bus.gain.setValueAtTime(Math.max(0.0002, level), t0);
  bus.gain.exponentialRampToValueAtTime(0.0002, t0 + decay);
  const hpf = filter(ctx, 'highpass', hp, q);
  const bp = filter(ctx, 'bandpass', hp * 1.25, 0.6);
  bus.connect(hpf).connect(bp).connect(out);
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
    const o = osc(ctx, 'square', f * tune);
    o.connect(bus);
    o.start(t0);
    o.stop(t0 + decay + 0.03);
  }
  return decay;
}

const PIECES = {
  kick(ctx, out, t0, { vel, tune, hard }) {
    const decay = hard ? 0.26 : 0.52;
    blip(ctx, out, t0, {
      freq: (hard ? 200 : 120) * tune,
      bendTo: (hard ? 52 : 45) * tune,
      bendTime: hard ? 0.03 : 0.07,
      level: vel * 0.95,
      decay,
    });
    burst(ctx, out, t0, {
      level: vel * (hard ? 0.3 : 0.12),
      decay: hard ? 0.012 : 0.008,
      type: 'highpass',
      freq: hard ? 2600 : 1400,
    });
    return decay + 0.08;
  },
  snare(ctx, out, t0, { vel, tune, hard }) {
    const decay = hard ? 0.2 : 0.15;
    blip(ctx, out, t0, { type: 'triangle', freq: 186 * tune, level: vel * 0.4, decay: 0.09 });
    blip(ctx, out, t0, { type: 'triangle', freq: 331 * tune, level: vel * 0.26, decay: 0.06 });
    burst(ctx, out, t0, {
      level: vel * (hard ? 0.55 : 0.4),
      decay,
      type: hard ? 'bandpass' : 'highpass',
      freq: (hard ? 1900 : 1300) * tune,
      q: 0.7,
    });
    return decay + 0.08;
  },
  clap(ctx, out, t0, { vel, tune, hard }) {
    // Four flams and a tail. The gaps are what make it a room full of hands.
    for (let i = 0; i < 4; i++) {
      burst(ctx, out, t0 + i * 0.009 + rnd(0, 0.003), {
        level: vel * (0.42 - i * 0.05),
        decay: 0.014,
        freq: 1500 * tune,
        q: 1.1,
      });
    }
    const decay = hard ? 0.22 : 0.16;
    burst(ctx, out, t0 + 0.03, { level: vel * 0.24, decay, freq: 1350 * tune, q: 0.9 });
    return decay + 0.1;
  },
  rim(ctx, out, t0, { vel, tune }) {
    blip(ctx, out, t0, { type: 'square', freq: 1720 * tune, level: vel * 0.22, decay: 0.022 });
    burst(ctx, out, t0, { level: vel * 0.3, decay: 0.02, freq: 2400 * tune, q: 2 });
    return 0.09;
  },
  tom(ctx, out, t0, { vel, tune, hard }) {
    const decay = hard ? 0.3 : 0.4;
    blip(ctx, out, t0, {
      type: 'triangle',
      freq: 260 * tune,
      bendTo: 168 * tune,
      bendTime: decay * 0.7,
      level: vel * 0.7,
      decay,
    });
    burst(ctx, out, t0, { level: vel * 0.14, decay: 0.03, freq: 900 * tune, q: 0.9 });
    return decay + 0.08;
  },
  hat(ctx, out, t0, { vel, tune, hard }) {
    return metal(ctx, out, t0, { level: vel * 0.3, tune, decay: hard ? 0.05 : 0.042, hp: 8200 }) + 0.06;
  },
  openhat(ctx, out, t0, { vel, tune, hard }) {
    return metal(ctx, out, t0, { level: vel * 0.24, tune, decay: hard ? 0.34 : 0.28, hp: 7600 }) + 0.08;
  },
  ride(ctx, out, t0, { vel, tune }) {
    return metal(ctx, out, t0, { level: vel * 0.16, tune, decay: 0.8, hp: 5200, q: 0.5 }) + 0.1;
  },
  cowbell(ctx, out, t0, { vel, tune }) {
    // Two squares a fourth apart through one bandpass: the whole 808 cowbell.
    const bus = gain(ctx, 0);
    bus.gain.setValueAtTime(Math.max(0.0002, vel * 0.3), t0);
    bus.gain.exponentialRampToValueAtTime(0.0002, t0 + 0.32);
    bus.connect(filter(ctx, 'bandpass', 2640 * tune, 2.6)).connect(out);
    for (const f of [845, 562]) {
      const o = osc(ctx, 'square', f * tune);
      o.connect(bus);
      o.start(t0);
      o.stop(t0 + 0.36);
    }
    return 0.4;
  },
};

function kitPreset({ id, name, accent, hard, gain: level }) {
  return {
    id,
    name,
    accent,
    mood: 'wild',
    reverb: hard ? 0.16 : 0.2,
    delay: 0.1,
    gain: level,
    build(ctx, { midi, vel, t0, out }) {
      const [piece, trim] = KIT[((midi % 12) + 12) % 12];
      // Higher rows tighten and brighten, so a run up the keyboard still reads
      // as one kit rather than a chromatic drum machine.
      const tune = Math.pow(2, (midi - 45) / 36 + trim / 12);
      const tail = gain(ctx, 1);
      tail.connect(out);
      const length = PIECES[piece](ctx, tail, t0, { vel, tune, hard });
      return ringVoice([], tail, t0, length);
    },
  };
}

export const DRUMS = {
  id: 'drums',
  name: 'DRUMS',
  presets: [
    kitPreset({ id: 'kit808', name: '808 KIT', accent: '#c8ff4d', hard: false, gain: 0.7 }),
    kitPreset({ id: 'kit909', name: '909 KIT', accent: '#a6ff33', hard: true, gain: 0.72 }),
    {
      id: 'toms',
      name: 'TOMS',
      accent: '#7dff8a',
      mood: 'happy',
      reverb: 0.3,
      delay: 0.14,
      gain: 0.75,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.5 + 0.35 * (1 - Math.min(1, freq / 500));
        const tail = gain(ctx, 1);
        tail.connect(out);
        // Membrane: a pitch that falls a fifth over the whole decay, plus the
        // skin slap on top.
        const skin = osc(ctx, 'triangle', freq * 1.5);
        skin.frequency.setValueAtTime(freq * 1.6, t0);
        skin.frequency.exponentialRampToValueAtTime(freq, t0 + length * 0.8);
        const ring = osc(ctx, 'sine', freq * 2.98);
        const g0 = envGain(ctx, t0, { attack: 0.002, decay: length, sustain: 0, peak: vel * 0.85 });
        const g1 = envGain(ctx, t0, { attack: 0.001, decay: length * 0.15, sustain: 0, peak: vel * 0.18 });
        skin.connect(g0).connect(tail);
        ring.connect(g1).connect(tail);
        burst(ctx, tail, t0, { level: vel * 0.22, decay: 0.035, freq: freq * 5, q: 0.9, sweepTo: freq * 2 });

        const nodes = [skin, ring];
        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'metals',
      name: 'METAL',
      accent: '#d6ff6b',
      mood: 'wild',
      reverb: 0.38,
      delay: 0.12,
      gain: 0.9,
      build(ctx, { freq, vel, t0, out }) {
        const length = 1.1 + 0.9 * (1 - Math.min(1, freq / 700));
        const tail = gain(ctx, 1);
        tail.connect(out);
        // Six inharmonic squares: struck metal has no harmonic series worth
        // speaking of, and the ratios matter more than the waveform.
        const cluster = gain(ctx, 0);
        cluster.gain.setValueAtTime(Math.max(0.0002, vel * 0.14), t0);
        cluster.gain.exponentialRampToValueAtTime(0.0002, t0 + length);
        cluster
          .connect(filter(ctx, 'highpass', Math.min(9000, freq * 3 + 700), 0.6))
          .connect(filter(ctx, 'bandpass', Math.min(11000, freq * 6), 0.5))
          .connect(tail);
        const nodes = [1, 1.48, 1.93, 2.72, 3.31, 4.13].map((r) => {
          const o = osc(ctx, 'square', freq * r * 1.5);
          o.connect(cluster);
          return o;
        });
        // One clean bell mode so it stays playable as a pitch.
        const bell = osc(ctx, 'sine', freq * 2.4);
        bell.connect(envGain(ctx, t0, { attack: 0.002, decay: length * 0.6, sustain: 0, peak: vel * 0.16 })).connect(tail);
        nodes.push(bell);
        burst(ctx, tail, t0, { level: vel * 0.2, decay: 0.05, type: 'highpass', freq: 6000 });

        startAll(nodes, t0);
        return ringVoice(nodes, tail, t0, length + 0.1);
      },
    },
    {
      id: 'blocks',
      name: 'BLOCKS',
      accent: '#eaffb0',
      mood: 'happy',
      reverb: 0.24,
      delay: 0.22,
      gain: 1.0,
      build(ctx, { freq, vel, t0, out }) {
        const length = 0.16;
        const tail = gain(ctx, 1);
        tail.connect(out);
        // Wood is a very short tone inside a very narrow resonance.
        blip(ctx, tail, t0, { type: 'triangle', freq: freq * 2, level: vel * 0.5, decay: 0.05 });
        blip(ctx, tail, t0, { type: 'sine', freq: freq * 3.01, level: vel * 0.22, decay: 0.03 });
        burst(ctx, tail, t0, { level: vel * 0.6, decay: length, freq: freq * 4, q: 11 });
        burst(ctx, tail, t0, { level: vel * 0.18, decay: 0.01, type: 'highpass', freq: 4000 });
        return ringVoice([], tail, t0, length + 0.1);
      },
    },
    {
      id: 'glitch',
      name: 'GLITCH',
      accent: '#5cffa8',
      mood: 'wild',
      reverb: 0.26,
      delay: 0.36,
      gain: 0.6,
      build(ctx, { freq, vel, t0, out }) {
        const tail = gain(ctx, 1);
        // Drive the quantiser hard: anything below one step of the staircase
        // rounds to silence, so a quiet signal into a bitcrusher is no signal.
        const crush = gain(ctx, 2.2);
        crush.connect(shaper(ctx, crushCurve(4), 'none')).connect(tail);
        tail.connect(out);

        // One key press is a little burst of machine failure: two to five
        // stutters, each shorter and higher than the last.
        const hits = 2 + Math.floor(Math.random() * 4);
        let at = t0;
        for (let i = 0; i < hits; i++) {
          const up = Math.pow(2, i * rnd(0.1, 0.5));
          const decay = 0.05 / (1 + i * 0.5);
          burst(ctx, crush, at, {
            level: vel * (0.5 - i * 0.05),
            decay,
            freq: Math.min(11000, freq * 6 * up),
            q: 3,
            rate: rnd(0.6, 1.8),
          });
          blip(ctx, crush, at, {
            type: 'square',
            freq: Math.min(6000, freq * 2 * up),
            bendTo: Math.min(9000, freq * 3 * up),
            bendTime: decay,
            level: vel * 0.22,
            decay,
          });
          at += decay + rnd(0.01, 0.05);
        }
        return ringVoice([], tail, t0, at - t0 + 0.1);
      },
    },
  ],
};
