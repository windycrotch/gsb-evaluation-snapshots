import { RNG } from '../core/math.js';

// Everything you hear is synthesized here with plain Web Audio nodes, scheduled at absolute
// times. The same functions run on a live AudioContext (the game) and an OfflineAudioContext
// (the showcase render), so the film's soundtrack is the game's own audio engine.

const Z = 0.0001;

export function makeBus(ctx, seed = 5) {
  const rng = new RNG(seed);
  const len = ctx.sampleRate * 2;
  const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) nd[i] = rng.next() * 2 - 1;
  // reverb impulse: decaying noise, darker over time
  const irLen = Math.floor(ctx.sampleRate * 2.4);
  const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < irLen; i++) {
      const t = i / irLen;
      const k = 0.25 + 0.7 * t; // one-pole lowpass that closes as the tail decays
      lp += ((rng.next() * 2 - 1) - lp) * (1 - k);
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 400 ? i / 400 : 1);
    }
  }
  const pre = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.2;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.0;
  const clip = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) { const x = (i / 1023.5 - 1) * 1.15; curve[i] = Math.tanh(x) / Math.tanh(1.15) * 0.89; }
  clip.curve = curve;
  clip.oversample = '2x';
  const master = ctx.createGain();
  pre.connect(comp); comp.connect(makeup); makeup.connect(clip); clip.connect(master); master.connect(ctx.destination);
  const sfx = ctx.createGain(), music = ctx.createGain();
  sfx.gain.value = 0.5; music.gain.value = 0.3;
  sfx.connect(pre); music.connect(pre);
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.34;
  const verb = ctx.createGain(); // send input
  verb.connect(conv); conv.connect(wet); wet.connect(pre);
  // tempo delay for the arp
  const delay = ctx.createDelay(1), fb = ctx.createGain(), dl = ctx.createGain();
  delay.delayTime.value = 0.3; fb.gain.value = 0.36; dl.gain.value = 0.5;
  dl.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(music);
  // sidechain-ish duck for the music under big hits
  return { ctx, noiseBuf, pre, master, sfx, music, verb, delaySend: dl, rng: new RNG(seed + 1) };
}

// ---- tiny node helpers ---------------------------------------------------------------------------
function out(A, node, p, dest) {
  const g = A.ctx.createGain();
  g.gain.value = p.gain ?? 1;
  node.connect(g);
  if (p.pan && A.ctx.createStereoPanner) {
    const pn = A.ctx.createStereoPanner();
    pn.pan.value = Math.max(-1, Math.min(1, p.pan));
    g.connect(pn);
    pn.connect(dest || A.sfx);
    if (p.verb) { const s = A.ctx.createGain(); s.gain.value = p.verb; pn.connect(s); s.connect(A.verb); }
  } else {
    g.connect(dest || A.sfx);
    if (p.verb) { const s = A.ctx.createGain(); s.gain.value = p.verb; g.connect(s); s.connect(A.verb); }
  }
  return g;
}
function osc(A, type, t, dur, f0, f1, fTime) {
  const o = A.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, f0), t);
  if (f1 !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + (fTime ?? dur));
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}
function noise(A, t, dur, rate = 1) {
  const s = A.ctx.createBufferSource();
  s.buffer = A.noiseBuf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(t, A.rng.range(0, 1.5));
  s.stop(t + dur + 0.05);
  return s;
}
function filt(A, type, f, q = 0.7) {
  const b = A.ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q;
  return b;
}
// attack/decay envelope gain node
function ad(A, t, a, peak, d, src) {
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(Z, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(Z, t + a + d);
  if (src) src.connect(g);
  return g;
}
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---- one-shot sound effects ------------------------------------------------------------------------
export const SFX = {
  whoosh(A, t, p) {
    const k = p.size ?? 1, d = 0.16 + 0.08 * k;
    const bp = filt(A, 'bandpass', 500, 1.1);
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(1500 + 900 * k, t + d * 0.45);
    bp.frequency.exponentialRampToValueAtTime(520, t + d);
    out(A, ad(A, t, d * 0.4, 0.34 * k, d * 0.7, chain(noise(A, t, d + 0.1), bp)), p);
  },
  hit(A, t, p) {
    const k = p.size ?? 1;
    const body = ad(A, t, 0.002, 0.95, 0.1 + 0.1 * k, osc(A, 'sine', t, 0.3 + 0.2 * k, 190 / Math.sqrt(k), 42, 0.08 + 0.05 * k));
    const mid = ad(A, t, 0.001, 0.5, 0.06, osc(A, 'triangle', t, 0.12, 380, 120, 0.05));
    const crack = ad(A, t, 0.001, 0.55 + 0.2 * k, 0.045 + 0.02 * k, chain(noise(A, t, 0.12), filt(A, 'highpass', 1700)));
    const mix = A.ctx.createGain();
    body.connect(mix); mid.connect(mix); crack.connect(mix);
    if (k > 0.8) ad(A, t, 0.004, 0.8, 0.35 * k, osc(A, 'sine', t, 0.6 * k, 62, 30, 0.3)).connect(mix);
    out(A, mix, { ...p, gain: (p.gain ?? 1) * (0.55 + 0.25 * k), verb: 0.12 + 0.12 * k });
  },
  block(A, t, p) {
    const mix = A.ctx.createGain();
    for (const f of [612, 931, 1470]) ad(A, t, 0.001, 0.22, 0.07, osc(A, 'square', t, 0.12, f)).connect(mix);
    ad(A, t, 0.001, 0.4, 0.03, chain(noise(A, t, 0.08), filt(A, 'bandpass', 2600, 1.5))).connect(mix);
    ad(A, t, 0.002, 0.5, 0.08, osc(A, 'sine', t, 0.15, 150, 70, 0.07)).connect(mix);
    out(A, chain(mix, filt(A, 'lowpass', 5200)), { ...p, gain: (p.gain ?? 1) * 0.6, verb: 0.1 });
  },
  parry(A, t, p) {
    const mix = A.ctx.createGain();
    [1760, 2637, 3520, 5274].forEach((f, i) => ad(A, t, 0.001, 0.3 / (i + 1), 0.75 - i * 0.12, osc(A, 'sine', t, 0.9, f)).connect(mix));
    ad(A, t, 0.001, 0.5, 0.025, chain(noise(A, t, 0.06), filt(A, 'highpass', 5000))).connect(mix);
    ad(A, t, 0.003, 0.7, 0.2, osc(A, 'sine', t, 0.3, 140, 50, 0.15)).connect(mix);
    out(A, mix, { ...p, gain: (p.gain ?? 1) * 0.75, verb: 0.5 });
  },
  clang(A, t, p) {
    SFX.parry(A, t, { ...p, gain: 0.6 });
    SFX.hit(A, t, { ...p, size: 1.5 });
    const mix = A.ctx.createGain();
    for (const f of [311, 466, 740, 1108]) ad(A, t, 0.001, 0.18, 0.5, osc(A, 'sawtooth', t, 0.6, f)).connect(mix);
    out(A, chain(mix, filt(A, 'bandpass', 1400, 0.8)), { ...p, gain: 0.5, verb: 0.4 });
  },
  dash(A, t, p) {
    const bp = filt(A, 'bandpass', 300, 0.9);
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(3400, t + 0.1);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.22);
    out(A, ad(A, t, 0.03, 0.4, 0.2, chain(noise(A, t, 0.3), bp)), p);
    out(A, ad(A, t, 0.004, 0.35, 0.1, osc(A, 'sine', t, 0.15, 130, 60, 0.1)), p);
  },
  jump(A, t, p) { out(A, ad(A, t, 0.01, 0.18, 0.1, osc(A, 'sine', t, 0.15, 210, 430, 0.1)), p); },
  land(A, t, p) {
    const k = p.size ?? 1;
    out(A, ad(A, t, 0.002, 0.6 * k, 0.12, osc(A, 'sine', t, 0.2, 120, 46, 0.1)), p);
    out(A, ad(A, t, 0.002, 0.25 * k, 0.08, chain(noise(A, t, 0.15), filt(A, 'lowpass', 500))), p);
  },
  fire(A, t, p) {
    const k = p.size ?? 1, d = 0.45 + 0.35 * k;
    const lp = filt(A, 'lowpass', 1600, 0.6);
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + d);
    out(A, ad(A, t, 0.012, 0.6 * k, d, chain(noise(A, t, d + 0.1, 0.7), lp)), { ...p, verb: 0.25 });
    out(A, ad(A, t, 0.01, 0.6 * k, d * 0.8, osc(A, 'sine', t, d, 82, 34, d * 0.7)), p);
    for (let i = 0; i < 5; i++) {
      const tt = t + A.rng.range(0.02, d * 0.8);
      out(A, ad(A, tt, 0.001, 0.2 * k, 0.02, chain(noise(A, tt, 0.05), filt(A, 'highpass', 2800))), p);
    }
  },
  zap(A, t, p) {
    const k = p.size ?? 1, d = 0.14 + 0.1 * k;
    const o = A.ctx.createOscillator();
    o.type = 'sawtooth';
    const n = 16, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = A.rng.range(260, 2600) * (1 - (i / n) * 0.6);
    o.frequency.setValueCurveAtTime(curve, t, d);
    o.start(t); o.stop(t + d + 0.05);
    out(A, ad(A, t, 0.002, 0.26 * k, d, chain(o, filt(A, 'bandpass', 1900, 1.6))), { ...p, verb: 0.2 });
    out(A, ad(A, t, 0.001, 0.4 * k, 0.05, chain(noise(A, t, 0.1), filt(A, 'highpass', 4200))), p);
    out(A, ad(A, t, 0.002, 0.3 * k, d * 0.8, chain(osc(A, 'square', t, d, 96, 70), filt(A, 'lowpass', 900))), p);
  },
  thunder(A, t, p) {
    const k = p.size ?? 1;
    out(A, ad(A, t, 0.001, 0.9, 0.05, chain(noise(A, t, 0.1), filt(A, 'highpass', 1800))), { ...p, verb: 0.5 });
    const lp = filt(A, 'lowpass', 2600, 0.5);
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.5 * k);
    out(A, ad(A, t, 0.004, 0.85, 1.5 * k, chain(noise(A, t, 1.7 * k, 0.6), lp)), { ...p, verb: 0.5 });
    out(A, ad(A, t, 0.005, 0.9, 1.0 * k, osc(A, 'sine', t, 1.3 * k, 58, 28, 0.9)), p);
    SFX.zap(A, t, { ...p, size: 1.4 });
  },
  boom(A, t, p) {
    const k = p.size ?? 1;
    out(A, ad(A, t, 0.004, 1.0, 0.75 * k, osc(A, 'sine', t, 1.0 * k, 92, 25, 0.6 * k)), p);
    const lp = filt(A, 'lowpass', 2000, 0.5);
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(70, t + 1.0 * k);
    out(A, ad(A, t, 0.003, 0.9, 1.0 * k, chain(noise(A, t, 1.2 * k, 0.5), lp)), { ...p, verb: 0.55 });
    out(A, ad(A, t, 0.001, 0.7, 0.06, chain(noise(A, t, 0.1), filt(A, 'highpass', 1500))), p);
    SFX.debris(A, t + 0.12, { ...p, gain: 0.5 * k });
  },
  debris(A, t, p) {
    for (let i = 0; i < 9; i++) {
      const tt = t + A.rng.range(0, 0.7);
      out(A, ad(A, tt, 0.001, A.rng.range(0.06, 0.2), 0.03, chain(noise(A, tt, 0.06), filt(A, 'bandpass', A.rng.range(700, 3200), 3))), { ...p, pan: (p.pan ?? 0) + A.rng.range(-0.4, 0.4) });
    }
  },
  crack(A, t, p) {
    const k = p.size ?? 1;
    out(A, ad(A, t, 0.003, 0.8 * k, 0.3, osc(A, 'sine', t, 0.4, 100, 34, 0.25)), { ...p, verb: 0.2 });
    out(A, ad(A, t, 0.002, 0.5 * k, 0.2, chain(noise(A, t, 0.3, 0.5), filt(A, 'lowpass', 700))), p);
    SFX.debris(A, t + 0.05, { ...p, gain: 0.45 * k });
  },
  shatter(A, t, p) {
    out(A, ad(A, t, 0.001, 0.55, 0.25, chain(noise(A, t, 0.3), filt(A, 'highpass', 3200))), { ...p, verb: 0.3 });
    out(A, ad(A, t, 0.002, 0.35, 0.35, osc(A, 'sine', t, 0.4, 1900, 260, 0.35)), p);
    SFX.hit(A, t, { ...p, size: 1.2 });
  },
  charge(A, t, p) {
    const d = p.dur ?? 0.9, volt = p.ramp === 1;
    const o = osc(A, volt ? 'sawtooth' : 'triangle', t, d, 70, volt ? 880 : 420, d);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(Z, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + d);
    g.gain.setValueAtTime(Z, t + d + 0.02);
    const trem = A.ctx.createGain(), lfo = osc(A, 'sine', t, d, 12, 46, d), lg = A.ctx.createGain();
    lg.gain.value = 0.5; trem.gain.value = 0.6;
    lfo.connect(lg); lg.connect(trem.gain);
    chain(o, filt(A, 'lowpass', volt ? 3200 : 1500), trem, g);
    out(A, g, { ...p, verb: 0.3 });
    const bp = filt(A, 'bandpass', 300, 1.4);
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + d);
    const ng = A.ctx.createGain();
    ng.gain.setValueAtTime(Z, t);
    ng.gain.exponentialRampToValueAtTime(0.45, t + d);
    ng.gain.setValueAtTime(Z, t + d + 0.02);
    chain(noise(A, t, d), bp, ng);
    out(A, ng, p);
  },
  ready(A, t, p) {
    [0, 0.07, 0.14].forEach((dt, i) => out(A, ad(A, t + dt, 0.003, 0.2, 0.2, osc(A, 'sine', t + dt, 0.25, mtof(74 + i * 5))), { ...p, verb: 0.4 }));
  },
  ui(A, t, p) { out(A, ad(A, t, 0.002, 0.16, 0.05, osc(A, 'sine', t, 0.08, p.f ?? 880)), p); },
  uiok(A, t, p) {
    out(A, ad(A, t, 0.002, 0.2, 0.08, osc(A, 'triangle', t, 0.1, 660)), { ...p, verb: 0.2 });
    out(A, ad(A, t + 0.06, 0.002, 0.2, 0.16, osc(A, 'triangle', t + 0.06, 0.2, 990)), { ...p, verb: 0.3 });
  },
  drum(A, t, p) {
    out(A, ad(A, t, 0.003, 1.0, 0.5, osc(A, 'sine', t, 0.6, 150, 44, 0.3)), { ...p, verb: 0.6 });
    out(A, ad(A, t, 0.002, 0.5, 0.18, chain(noise(A, t, 0.25), filt(A, 'lowpass', 1100))), { ...p, verb: 0.5 });
  },
  sting(A, t, p) {
    SFX.drum(A, t, p);
    const mix = A.ctx.createGain();
    for (const m of [50, 57, 62, 65, 69]) for (const det of [-7, 7]) {
      const o = osc(A, 'sawtooth', t, 0.9, mtof(m));
      o.detune.value = det;
      ad(A, t, 0.004, 0.09, 0.8, o).connect(mix);
    }
    const lp = filt(A, 'lowpass', 4200, 0.7);
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.8);
    out(A, chain(mix, lp), { ...p, verb: 0.5 });
  },
};

// ---- sustained sounds: start now, stop(t) later ----------------------------------------------------
export const HOLD = {
  beam(A, t, p) {
    const volt = p.ramp === 1;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(Z, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.04);
    const srcs = [];
    const mk = (type, f, det = 0) => { const o = A.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.start(t); srcs.push(o); return o; };
    const n = A.ctx.createBufferSource();
    n.buffer = A.noiseBuf; n.loop = true; n.start(t); srcs.push(n);
    const am = A.ctx.createGain();
    am.gain.value = 0.7;
    const lfo = mk('sawtooth', volt ? 31 : 13), lg = A.ctx.createGain();
    lg.gain.value = volt ? 0.3 : 0.18;
    lfo.connect(lg); lg.connect(am.gain);
    if (volt) {
      const tone = A.ctx.createGain();
      mk('sawtooth', 110, -9).connect(tone); mk('sawtooth', 110, 9).connect(tone); mk('square', 220).connect(tone); mk('sawtooth', 55).connect(tone);
      tone.gain.value = 0.25;
      chain(tone, filt(A, 'bandpass', 1300, 0.7), am);
      const ng = A.ctx.createGain(); ng.gain.value = 0.35;
      chain(n, filt(A, 'highpass', 3800), ng, am);
    } else {
      const tone = A.ctx.createGain();
      mk('sawtooth', 55, -6).connect(tone); mk('sawtooth', 82.4, 6).connect(tone); mk('sine', 41).connect(tone);
      tone.gain.value = 0.3;
      chain(tone, filt(A, 'lowpass', 520, 1.2), am);
      const ng = A.ctx.createGain(); ng.gain.value = 0.85;
      chain(n, filt(A, 'bandpass', 420, 0.5), ng, am);
    }
    am.connect(g);
    out(A, g, { ...p, verb: 0.3 });
    return { stop(te) { g.gain.cancelScheduledValues(te); g.gain.setValueAtTime(0.34, te); g.gain.exponentialRampToValueAtTime(Z, te + 0.3); for (const s of srcs) s.stop(te + 0.35); } };
  },
  clash(A, t, p) {
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(Z, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.1);
    const srcs = [];
    const mix = A.ctx.createGain();
    // a slowly rising, beating cluster: tension that keeps climbing while the struggle lasts
    [98, 147, 196, 293].forEach((f, i) => {
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 6);
      o.detune.value = i % 2 ? 11 : -11; o.start(t); srcs.push(o);
      const og = A.ctx.createGain(); og.gain.value = 0.16; o.connect(og); og.connect(mix);
    });
    const n = A.ctx.createBufferSource();
    n.buffer = A.noiseBuf; n.loop = true; n.start(t); srcs.push(n);
    const ng = A.ctx.createGain(); ng.gain.value = 0.5;
    chain(n, filt(A, 'bandpass', 900, 0.4), ng, mix);
    const am = A.ctx.createGain(); am.gain.value = 0.65;
    const lfo = A.ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.setValueAtTime(16, t); lfo.frequency.linearRampToValueAtTime(34, t + 5); lfo.start(t); srcs.push(lfo);
    const lg = A.ctx.createGain(); lg.gain.value = 0.3; lfo.connect(lg); lg.connect(am.gain);
    chain(mix, filt(A, 'lowpass', 3600), am, g);
    out(A, g, { ...p, verb: 0.4 });
    return { stop(te) { g.gain.cancelScheduledValues(te); g.gain.setValueAtTime(0.4, te); g.gain.exponentialRampToValueAtTime(Z, te + 0.12); for (const s of srcs) s.stop(te + 0.2); } };
  },
};

// ---- music -------------------------------------------------------------------------------------------
export const BPM = 150;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
const ROOTS = [38, 38, 34, 36]; // D, D, Bb, C
const CHORDS = [[62, 65, 69], [62, 65, 69, 72], [58, 62, 65], [60, 64, 67]];

export const INST = {
  kick(A, t, g = 1) {
    ad(A, t, 0.002, 1.0 * g, 0.22, osc(A, 'sine', t, 0.3, 165, 44, 0.09)).connect(A.music);
    ad(A, t, 0.001, 0.3 * g, 0.02, chain(noise(A, t, 0.04), filt(A, 'highpass', 2500))).connect(A.music);
  },
  snare(A, t, g = 1) {
    const mix = A.ctx.createGain();
    ad(A, t, 0.001, 0.55 * g, 0.15, chain(noise(A, t, 0.2), filt(A, 'bandpass', 2100, 0.7))).connect(mix);
    ad(A, t, 0.001, 0.4 * g, 0.08, osc(A, 'triangle', t, 0.12, 210, 130, 0.06)).connect(mix);
    mix.connect(A.music);
    const s = A.ctx.createGain(); s.gain.value = 0.25; mix.connect(s); s.connect(A.verb);
  },
  hat(A, t, g = 1, open = false) {
    ad(A, t, 0.001, 0.16 * g, open ? 0.16 : 0.03, chain(noise(A, t, 0.2), filt(A, 'highpass', 8200))).connect(A.music);
  },
  bass(A, t, midi, dur, g = 1) {
    const f = mtof(midi);
    const mix = A.ctx.createGain();
    const o1 = osc(A, 'sawtooth', t, dur, f), o2 = osc(A, 'square', t, dur, f / 2), o3 = osc(A, 'sawtooth', t, dur, f);
    o3.detune.value = 14;
    o1.connect(mix); o2.connect(mix); o3.connect(mix);
    const lp = filt(A, 'lowpass', 300, 5);
    lp.frequency.setValueAtTime(180, t);
    lp.frequency.exponentialRampToValueAtTime(1300, t + 0.02);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    const e = A.ctx.createGain();
    e.gain.setValueAtTime(Z, t);
    e.gain.linearRampToValueAtTime(0.2 * g, t + 0.006);
    e.gain.setValueAtTime(0.2 * g, t + dur * 0.7);
    e.gain.exponentialRampToValueAtTime(Z, t + dur);
    chain(mix, lp, e, A.music);
  },
  stab(A, t, notes, dur, g = 1) {
    const mix = A.ctx.createGain();
    for (const m of notes) for (const det of [-9, 0, 9]) { const o = osc(A, 'sawtooth', t, dur, mtof(m)); o.detune.value = det; o.connect(mix); }
    const lp = filt(A, 'lowpass', 3000, 1);
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const e = ad(A, t, 0.004, 0.035 * g, dur, null);
    chain(mix, lp, e, A.music);
    const s = A.ctx.createGain(); s.gain.value = 0.5; e.connect(s); s.connect(A.verb);
  },
  arp(A, t, midi, g = 1) {
    const e = ad(A, t, 0.002, 0.07 * g, 0.11, chain(osc(A, 'square', t, 0.14, mtof(midi)), filt(A, 'lowpass', 3600)));
    e.connect(A.music); e.connect(A.delaySend);
  },
  pad(A, t, notes, dur, g = 1) {
    const mix = A.ctx.createGain();
    for (const m of notes) for (const det of [-11, 11]) { const o = osc(A, 'sawtooth', t, dur, mtof(m)); o.detune.value = det; o.connect(mix); }
    const e = A.ctx.createGain();
    e.gain.setValueAtTime(Z, t);
    e.gain.linearRampToValueAtTime(0.03 * g, t + dur * 0.4);
    e.gain.linearRampToValueAtTime(Z, t + dur);
    chain(mix, filt(A, 'lowpass', 900, 0.5), e, A.music);
    const s = A.ctx.createGain(); s.gain.value = 0.7; e.connect(s); s.connect(A.verb);
  },
  riser(A, t, dur, g = 1) {
    const bp = filt(A, 'bandpass', 300, 1.2);
    bp.frequency.setValueAtTime(240, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const e = A.ctx.createGain();
    e.gain.setValueAtTime(Z, t);
    e.gain.exponentialRampToValueAtTime(0.4 * g, t + dur);
    e.gain.setValueAtTime(Z, t + dur + 0.01);
    chain(noise(A, t, dur), bp, e, A.music);
    const o = osc(A, 'sawtooth', t, dur, 110, 880, dur), og = A.ctx.createGain();
    og.gain.setValueAtTime(Z, t);
    og.gain.exponentialRampToValueAtTime(0.08 * g, t + dur);
    og.gain.setValueAtTime(Z, t + dur + 0.01);
    chain(o, filt(A, 'lowpass', 2400), og, A.music);
  },
  impact(A, t, g = 1) {
    ad(A, t, 0.004, 1.0 * g, 1.2, osc(A, 'sine', t, 1.5, 110, 27, 0.7)).connect(A.music);
    const c = ad(A, t, 0.002, 0.3 * g, 1.6, chain(noise(A, t, 1.8), filt(A, 'highpass', 4500)));
    c.connect(A.music);
    const s = A.ctx.createGain(); s.gain.value = 0.6; c.connect(s); s.connect(A.verb);
  },
};

// One bar of the fight loop. level: 0 pad only · 1 pulse (no drums) · 2 half drums · 3 full
export function scheduleBar(A, t, bar, level, opts = {}) {
  const i = ((bar % 4) + 4) % 4, root = ROOTS[i], chord = CHORDS[i], s = BEAT / 4;
  if (level <= 1 || opts.pad) INST.pad(A, t, chord.map((m) => m - 12), BAR * 1.05, level === 0 ? 1.6 : 1);
  if (level >= 1) {
    const pat = [0, -1, 0, 0, -1, 0, -1, 12, 0, -1, 0, 0, -1, 7, -1, 0];
    pat.forEach((p, k) => { if (p >= 0) INST.bass(A, t + k * s, root + p, s * 1.6, level >= 3 ? 1 : 0.8); });
    const ar = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2];
    if (level >= 2 || opts.arp) ar.forEach((n, k) => INST.arp(A, t + k * s, chord[n % chord.length] + 12 + (k % 8 === 7 ? 12 : 0), level >= 3 ? 1 : 0.7));
  }
  if (level >= 2) {
    const kicks = level >= 3 ? [0, 4, 8, 12, ...(i === 3 ? [14] : [])] : [0, 8];
    for (const k of kicks) INST.kick(A, t + k * s);
    for (const k of level >= 3 ? [4, 12] : [8]) INST.snare(A, t + k * s);
    for (let k = 0; k < 16; k++) if (level >= 3 || k % 2 === 0) INST.hat(A, t + k * s, k % 4 === 2 ? 1 : 0.45, k % 4 === 2);
    if (level >= 3 && i === 0) INST.stab(A, t, chord, BEAT * 1.5, 1);
    if (level >= 3 && i === 2) INST.stab(A, t + BEAT * 1.5, chord, BEAT * 1.5, 0.9);
  }
}

export function encodeWav(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels, sr = buffer.sampleRate;
  const ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
  return ab;
}
