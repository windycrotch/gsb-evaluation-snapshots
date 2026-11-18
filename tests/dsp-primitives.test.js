// dsp-primitives.test.js — FFT 与工具函数的基础正确性，保证上层算法建立在可靠原语上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, hannWindow, rms, analyzeFrame } from '../src/dsp.js';
import { freqToMidi, midiToName, freqToNoteName } from '../src/tuning.js';
import { harmonicFrame } from './helpers/signals.js';

test('FFT：直流信号能量全部落在 0 号 bin', () => {
  const input = new Float64Array(1024).fill(0.7);
  const { re, im } = fft(input);
  assert.ok(Math.abs(re[0] - 0.7 * 1024) < 1e-9);
  assert.ok(Math.abs(im[0]) < 1e-9);
  let leak = 0;
  for (let b = 1; b < 1024; b++) leak += re[b] * re[b] + im[b] * im[b];
  assert.ok(leak < 1e-12);
});

test('FFT：正弦波在对应频率 bin 出现峰值', () => {
  const n = 8192;
  const sr = 44100;
  const freq = 1000;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin(2 * Math.PI * freq * (i / sr));
  const { re, im } = fft(input);
  const binHz = sr / n;
  const expectedBin = Math.round(freq / binHz);
  let peakBin = 0;
  let peakMag = 0;
  for (let b = 0; b < n / 2; b++) {
    const mag = Math.hypot(re[b], im[b]);
    if (mag > peakMag) { peakMag = mag; peakBin = b; }
  }
  assert.ok(Math.abs(peakBin - expectedBin) <= 1);
});

test('FFT：Parseval 能量守恒（时域能量 ≈ 频域能量）', () => {
  const n = 2048;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin(2 * Math.PI * 37 * (i / n)) + 0.5 * Math.cos(2 * Math.PI * 91 * (i / n));
  const timeEnergy = input.reduce((s, v) => s + v * v, 0);
  const { re, im } = fft(input);
  let freqEnergy = 0;
  for (let b = 0; b < n; b++) freqEnergy += re[b] * re[b] + im[b] * im[b];
  assert.ok(Math.abs(freqEnergy / n - timeEnergy) / timeEnergy < 1e-10);
});

test('Hann 窗：端点为 0、中心为 1、长度缓存复用', () => {
  const w = hannWindow(16);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[8] - 1) < 1e-12);
  assert.equal(hannWindow(16), w); // 同一实例缓存
});

test('rms：满幅与静音', () => {
  assert.equal(rms(new Float64Array(100).fill(0)), 0);
  assert.ok(Math.abs(rms(new Float64Array(100).fill(0.5)) - 0.5) < 1e-12);
});

test('MIDI/音名换算符合十二平均律', () => {
  assert.ok(Math.abs(freqToMidi(440) - 69) < 1e-9);
  assert.equal(midiToName(69), 'A4');
  assert.equal(freqToNoteName(261.6256), 'C4');
  assert.equal(freqToNoteName(82.4069), 'E2');
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(59), 'B3');
});

test('analyzeFrame：1kHz 正弦的频率估计误差小于 1 个 FFT bin', () => {
  const sr = 44100;
  const r = analyzeFrame(harmonicFrame(1000, [1], sr), sr);
  assert.ok(r);
  const binHz = sr / 8192;
  assert.ok(Math.abs(r.frequency - 1000) < binHz,
    `误差 ${Math.abs(r.frequency - 1000).toFixed(2)}Hz，bin=${binHz.toFixed(2)}Hz`);
  assert.ok(r.confidence > 0.5);
});
