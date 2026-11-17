/**
 * 纯 WebAudio 程序化音效 + 环境氛围（无外部音频资源，保证离线可运行）
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambientGain = null;
    this.muted = false;
    this.ready = false;
    this._bellTimer = null;
    this._penta = [0, 3, 5, 7, 10, 12, 15];
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    // 低频氛围铺底
    const ambient = ctx.createGain();
    ambient.gain.value = 0.0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 2.5;
    ambient.connect(filter).connect(master);
    this.ambientGain = ambient;

    const freqs = [55, 82.5, 110, 164.81];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f * (1 + (i - 1.5) * 0.0015);
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.28 : 0.1;
      osc.connect(g).connect(ambient);
      osc.start();
    });

    // 滤波器缓慢呼吸
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    ambient.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 4);

    this.ready = true;
    this._scheduleBells();
  }

  _scheduleBells() {
    if (this._bellTimer) clearInterval(this._bellTimer);
    this._bellTimer = setInterval(() => {
      if (!this.ready || this.muted) return;
      if (document.hidden) return;
      const step = this._penta[Math.floor(Math.random() * this._penta.length)];
      const freq = 261.63 * Math.pow(2, step / 12);
      this._bell(freq, 0.028 + Math.random() * 0.02);
    }, 5200);
  }

  _bell(freq, gain) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = Math.random() * 1.6 - 0.8;
      osc.connect(g).connect(pan).connect(this.master);
    } else {
      osc.connect(g).connect(this.master);
    }
    osc.start(t);
    osc.stop(t + 3.5);
  }

  _tone({ freq = 440, to = null, dur = 0.25, type = 'sine', gain = 0.15, attack = 0.006, delay = 0 }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.3, gain = 0.12, from = 2400, to = 200, q = 1.2, delay = 0 }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  collect(combo = 0) {
    const base = 523.25 * Math.pow(2, Math.min(combo, 8) / 12);
    this._tone({ freq: base, to: base * 2, dur: 0.22, type: 'triangle', gain: 0.11 });
    this._tone({ freq: base * 1.5, dur: 0.4, type: 'sine', gain: 0.05, delay: 0.03 });
  }

  jump() {
    this._noise({ dur: 0.22, gain: 0.05, from: 900, to: 2400, q: 0.8 });
    this._tone({ freq: 300, to: 520, dur: 0.16, type: 'sine', gain: 0.06 });
  }

  doubleJump() {
    this._noise({ dur: 0.26, gain: 0.05, from: 1600, to: 3200, q: 1 });
    this._tone({ freq: 660, to: 990, dur: 0.2, type: 'triangle', gain: 0.05 });
  }

  dash() {
    this._noise({ dur: 0.34, gain: 0.07, from: 300, to: 2600, q: 0.7 });
  }

  hit() {
    this._tone({ freq: 180, to: 48, dur: 0.42, type: 'sawtooth', gain: 0.16 });
    this._noise({ dur: 0.3, gain: 0.1, from: 600, to: 80, q: 0.6 });
  }

  portal() {
    [0, 0.09, 0.18, 0.3].forEach((d, i) => {
      this._tone({ freq: 392 * Math.pow(2, i / 4), dur: 0.6, type: 'sine', gain: 0.07, delay: d });
    });
  }

  warp() {
    this._tone({ freq: 120, to: 1400, dur: 1.3, type: 'sine', gain: 0.08 });
    this._noise({ dur: 1.2, gain: 0.06, from: 200, to: 3600, q: 0.6 });
  }

  victory() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      this._tone({ freq: f, dur: 1.4, type: 'sine', gain: 0.08, delay: i * 0.14 });
      this._tone({ freq: f * 0.5, dur: 1.6, type: 'triangle', gain: 0.035, delay: i * 0.14 });
    });
  }

  gameOver() {
    [440, 349.23, 261.63, 174.61].forEach((f, i) => {
      this._tone({ freq: f, dur: 0.9, type: 'sine', gain: 0.09, delay: i * 0.18 });
    });
  }

  ui() {
    this._tone({ freq: 880, to: 1200, dur: 0.1, type: 'sine', gain: 0.06 });
  }

  setMuted(m) {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.15);
    }
  }
}
