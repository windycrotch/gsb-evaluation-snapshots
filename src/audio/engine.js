import { fadeOut, filter, gain, makeImpulse, noiseBuffer, osc } from './dsp.js';
import { PACKS } from './presets.js';
import { midiToFreq } from './scales.js';

const MAX_VOICES = 16;

function softClipCurve(amount = 2.2) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/** Quieter towards the top of the keyboard so high notes never bite. */
function pitchGain(midi) {
  if (midi <= 72) return 1;
  return Math.pow(2, (72 - midi) / 26);
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.preset = PACKS[0].presets[0];
    this.voices = new Map();
    this.sustained = new Set();
    this.sustain = false;
    this.scope = new Uint8Array(128);
    this.level = 0;
    this.peak = 0;
    this.ready = false;
  }

  init() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.bus = gain(ctx, 1);
    this.dry = gain(ctx, 1);
    this.sum = gain(ctx, 1);

    this.revSend = gain(ctx, 0.4);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.6, 3.2);
    this.revReturn = gain(ctx, 0.9);

    this.delSend = gain(ctx, 0.2);
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.27;
    this.delFb = gain(ctx, 0.34);
    this.delLp = filter(ctx, 'lowpass', 2400, 0.7);
    this.delReturn = gain(ctx, 0.6);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve();
    this.shaper.oversample = '2x';

    this.hp = filter(ctx, 'highpass', 28, 0.7);
    this.master = gain(ctx, 0.85);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;

    this.bus.connect(this.dry).connect(this.sum);
    this.bus.connect(this.revSend).connect(this.reverb).connect(this.revReturn).connect(this.sum);
    this.bus.connect(this.delSend).connect(this.delay);
    this.delay.connect(this.delLp).connect(this.delFb).connect(this.delay);
    this.delLp.connect(this.delReturn).connect(this.sum);

    this.sum.connect(this.comp).connect(this.shaper).connect(this.hp).connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.applyPreset(this.preset, 0);
    this.ready = true;
    return ctx;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  applyPreset(preset, ramp = 0.08) {
    this.preset = preset;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (param, v) => {
      param.cancelScheduledValues(t);
      if (ramp > 0) param.setTargetAtTime(v, t, ramp);
      else param.value = v;
    };
    set(this.revSend.gain, preset.reverb * 0.55);
    set(this.delSend.gain, preset.delay * 0.42);
    set(this.bus.gain, preset.gain);
    set(this.delay.delayTime, preset.delayTime ?? 0.27);
  }

  setPreset(preset) {
    this.applyPreset(preset);
  }

  get maxVoices() {
    return Math.min(MAX_VOICES, this.preset.poly ?? MAX_VOICES);
  }

  noteOn(id, midi, velocity = 0.85) {
    this.resume();
    const ctx = this.ctx;
    if (this.voices.has(id)) this.stopVoice(id, true);
    while (this.voices.size >= this.maxVoices) {
      // Steal the oldest ringing voice, or just the oldest.
      let victim = null;
      for (const [key, v] of this.voices) {
        if (v.voice.ring) {
          victim = key;
          break;
        }
        if (victim === null) victim = key;
      }
      if (victim === null) break;
      this.stopVoice(victim, true);
    }

    const t0 = Math.max(ctx.currentTime, ctx.currentTime + 0.001);
    const vel = Math.max(0.05, Math.min(1, velocity)) * pitchGain(midi);
    const freq = midiToFreq(midi);
    const voice = this.preset.build(ctx, { midi, freq, vel, t0, out: this.bus });
    const entry = { voice, midi, startedAt: t0, id };
    this.voices.set(id, entry);

    if (voice.ring) {
      const ms = Math.max(60, (voice.endTime - ctx.currentTime) * 1000 + 120);
      entry.timer = setTimeout(() => {
        if (this.voices.get(id) === entry) this.voices.delete(id);
      }, ms);
    }
    return { midi, freq, velocity: vel };
  }

  noteOff(id) {
    const entry = this.voices.get(id);
    if (!entry) return;
    if (entry.voice.ring) return; // percussive presets ring out on their own
    if (this.sustain) {
      this.sustained.add(id);
      return;
    }
    this.releaseVoice(id);
  }

  releaseVoice(id) {
    const entry = this.voices.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const end = entry.voice.release(this.ctx.currentTime);
    this.voices.delete(id);
    this.sustained.delete(id);
    return end;
  }

  stopVoice(id, immediate = false) {
    const entry = this.voices.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (immediate) entry.voice.kill(this.ctx.currentTime);
    else entry.voice.release(this.ctx.currentTime);
    this.voices.delete(id);
    this.sustained.delete(id);
  }

  setSustain(on) {
    this.sustain = on;
    if (!on) {
      for (const id of [...this.sustained]) this.releaseVoice(id);
      this.sustained.clear();
    }
  }

  panic() {
    for (const id of [...this.voices.keys()]) this.stopVoice(id, true);
    this.voices.clear();
    this.sustained.clear();
    if (this.ctx) {
      fadeOut(this.delFb.gain, this.ctx.currentTime, 0.05);
      this.delFb.gain.setTargetAtTime(0.34, this.ctx.currentTime + 0.2, 0.1);
    }
  }

  /** Short UI tick for knob turns. */
  tick(pitch = 1) {
    if (!this.ctx) this.init();
    this.resume();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = filter(ctx, 'bandpass', 2000 * pitch, 3);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.035);
    src.connect(bp).connect(g).connect(this.sum);
    src.start(t, Math.random() * 0.4, 0.05);
    src.stop(t + 0.06);

    const body = osc(ctx, 'triangle', 620 * pitch);
    const bg = gain(ctx, 0);
    bg.gain.setValueAtTime(0.05, t);
    bg.gain.exponentialRampToValueAtTime(0.0004, t + 0.05);
    body.connect(bg).connect(this.sum);
    body.start(t);
    body.stop(t + 0.07);
  }

  sample() {
    if (!this.analyser) return { level: 0, peak: 0 };
    this.analyser.getByteTimeDomainData(this.scope);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.scope.length; i++) {
      const v = (this.scope[i] - 128) / 128;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    this.level = Math.sqrt(sum / this.scope.length);
    this.peak = peak;
    return { level: this.level, peak };
  }

  get voiceCount() {
    return this.voices.size;
  }
}
