// signals.js — 测试用信号合成工具。与浏览器中的 SyntheticCapture 数学等价，
// 但直接返回 PCM 帧数组，便于在 Node 中做确定性分析。

import { FFT_SIZE } from '../../src/dsp.js';

// 可复现的 PRNG（mulberry32），避免测试依赖 Math.random 的实现。
export function makeRng(seed = 1234567) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成一帧稳态谐波信号。
// freq: 基频 Hz；partials: 各次谐波幅度数组（下标 0 = 基频）
export function harmonicFrame(freq, partials, sampleRate = 44100, length = FFT_SIZE, phase0 = 0) {
  const frame = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let h = 0; h < partials.length; h++) {
      if (!partials[h]) continue;
      v += partials[h] * Math.sin(2 * Math.PI * freq * (h + 1) * (i / sampleRate) + phase0);
    }
    frame[i] = v * 0.33;
  }
  return frame;
}

export function silenceFrame(length = FFT_SIZE) {
  return new Float64Array(length);
}

export function whiteNoiseFrame(rng = makeRng(), amplitude = 0.2, length = FFT_SIZE) {
  const frame = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    frame[i] = (rng() * 2 - 1) * amplitude;
  }
  return frame;
}

// 把同一帧（或帧工厂产出的多帧）依次喂给引擎，返回最后一帧结果与全部结果。
export function runFrames(engine, frames, sampleRate = 44100) {
  const results = [];
  for (const frame of frames) results.push(engine.processFrame(frame, sampleRate));
  return { results, last: results[results.length - 1] };
}

// 生成 n 帧相位连续的谐波信号（模拟真实持续发声，而非重复同一段）
export function harmonicStream(freq, partials, n, sampleRate = 44100) {
  const frames = [];
  let phase = 0;
  for (let k = 0; k < n; k++) {
    const frame = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      let v = 0;
      for (let h = 0; h < partials.length; h++) {
        if (!partials[h]) continue;
        v += partials[h] * Math.sin(2 * Math.PI * freq * (h + 1) * phase);
      }
      frame[i] = v * 0.33;
      phase += 1 / sampleRate;
    }
    frames.push(frame);
  }
  return frames;
}
