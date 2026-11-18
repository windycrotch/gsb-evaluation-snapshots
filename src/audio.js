// audio.js — Web Audio 采集与本地合成信号源。
// 两条路径产出完全相同形态的 PCM 帧，交给 PitchEngine.processFrame，
// 因此合成信号验收与真实麦克风走的是同一套分析函数。

import { FFT_SIZE, HOP_SIZE } from './dsp.js';

export class MicCapture {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    this.timer = null;
    this.ring = new Float32Array(FFT_SIZE);
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('当前浏览器不支持麦克风采集 (mediaDevices 不可用)，请使用现代浏览器或 https/localhost 环境。'), {
        code: 'UNSUPPORTED',
      });
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        throw Object.assign(new Error('麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风后再点“开始”。'), {
          code: 'PERMISSION_DENIED', cause: err,
        });
      }
      if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
        throw Object.assign(new Error('没有检测到可用的麦克风或音频输入设备，请连接设备后重试。'), {
          code: 'NO_DEVICE', cause: err,
        });
      }
      throw Object.assign(new Error('麦克风无法读取：' + (err?.message || err) + '。请检查系统录音权限与设备占用情况。'), {
        code: 'UNREADABLE', cause: err,
      });
    }

    this.stream = stream;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE * 2; // 时间域缓冲足够取一帧
    source.connect(this.analyser);
    this.ring.fill(0);

    this.timer = setInterval(() => this._poll(), (HOP_SIZE / this.audioCtx.sampleRate) * 1000);
    return this.audioCtx.sampleRate;
  }

  _poll() {
    if (!this.analyser || !this.audioCtx) return; // stop() 与定时器尾触发的竞态保护
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    // 滑动环形缓冲，每次推入最新 HOP_SIZE 个样本，保留一帧 FFT_SIZE
    this.ring.copyWithin(0, HOP_SIZE);
    this.ring.set(buf.subarray(buf.length - HOP_SIZE), FFT_SIZE - HOP_SIZE);
    this.onFrame(this.ring.slice(), this.audioCtx.sampleRate);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close();
    this.audioCtx = null;
    this.analyser = null;
  }
}

// 本地合成源：基频 + 可选谐波栈（二次谐波可设得比基频还强，专门验证八度误判）。
// 不经过扬声器发声，只把 PCM 喂给同一个 onFrame 回调。
export class SyntheticCapture {
  constructor(onFrame, { frequency = 220, harmonics = [1], sampleRate = 44100 } = {}) {
    this.onFrame = onFrame;
    this.frequency = frequency;
    this.harmonics = harmonics; // 如 [1, 1.4, 0.5] => 基频、强二次、弱三次
    this.sampleRate = sampleRate;
    this.timer = null;
    this.phase = 0;
    this.ring = new Float32Array(FFT_SIZE);
  }

  setFrequency(frequency) {
    this.frequency = frequency;
  }

  start() {
    const intervalMs = (HOP_SIZE / this.sampleRate) * 1000;
    this.timer = setInterval(() => this._tick(), intervalMs);
    return Promise.resolve(this.sampleRate);
  }

  _tick() {
    const chunk = new Float32Array(HOP_SIZE);
    for (let i = 0; i < HOP_SIZE; i++) {
      let v = 0;
      for (let h = 0; h < this.harmonics.length; h++) {
        const amp = this.harmonics[h];
        if (!amp) continue;
        v += amp * Math.sin(2 * Math.PI * this.frequency * (h + 1) * this.phase);
      }
      chunk[i] = v * 0.33;
      this.phase += 1 / this.sampleRate;
    }
    this.ring.copyWithin(0, HOP_SIZE);
    this.ring.set(chunk, FFT_SIZE - HOP_SIZE);
    this.onFrame(this.ring.slice(), this.sampleRate);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
