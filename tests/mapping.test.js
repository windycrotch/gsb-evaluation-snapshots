// mapping.test.js — 验收点 1：标准音高映射到正确的弦与品。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchEngine } from '../src/engine.js';
import { TUNINGS, mapFrequencyToFret, freqToNoteName } from '../src/tuning.js';
import { harmonicStream, runFrames } from './helpers/signals.js';

const STANDARD = TUNINGS.standard.strings;

// 直接验证纯映射函数：六根空弦
test('六根空弦频率映射到对应弦的 0 品', () => {
  const expected = [
    { string: 6, fret: 0 }, // E2
    { string: 5, fret: 0 }, // A2
    { string: 4, fret: 0 }, // D3
    { string: 3, fret: 0 }, // G3
    { string: 2, fret: 0 }, // B3
    { string: 1, fret: 0 }, // E4
  ];
  STANDARD.forEach((freq, i) => {
    const r = mapFrequencyToFret(freq, STANDARD);
    assert.equal(r.inRange, true, `${freq}Hz 应在指板范围内`);
    assert.equal(r.string, expected[i].string, `${freq}Hz 弦号`);
    assert.equal(r.fret, expected[i].fret, `${freq}Hz 品数`);
  });
});

test('空弦音名换算正确', () => {
  assert.equal(freqToNoteName(STANDARD[0]), 'E2');
  assert.equal(freqToNoteName(STANDARD[1]), 'A2');
  assert.equal(freqToNoteName(STANDARD[5]), 'E4');
});

test('12 品频率 = 空弦频率的 2 倍：同弦 12 品可达，最低把位优先落到更粗的弦', () => {
  for (let s = 0; s < STANDARD.length; s++) {
    const r = mapFrequencyToFret(STANDARD[s] * 2, STANDARD);
    assert.equal(r.inRange, true);
    assert.ok(r.fret <= 12, `最低把位不应高于 12 品，实际 ${r.fret}`);
    // 该音高在原弦上确实是 12 品
    const sameString = mapFrequencyToFret(STANDARD[s] * 2, [STANDARD[s]]);
    assert.equal(sameString.fret, 12);
  }
  // 具体断言：E2*2=E3 → 4 弦 2 品（标准调弦上 E3 的最低把位）
  const e3 = mapFrequencyToFret(STANDARD[0] * 2, STANDARD);
  assert.equal(e3.string, 4);
  assert.equal(e3.fret, 2);
});

test('5 弦 3 品 = C4 附近 (130.81Hz) 映射到 5 弦 3 品', () => {
  const r = mapFrequencyToFret(130.8128, STANDARD);
  assert.equal(r.inRange, true);
  assert.equal(r.string, 5);
  assert.equal(r.fret, 3);
  assert.equal(r.noteName, 'C3');
});

test('同音多把位时优先最低把位（1 弦 E4 空弦 vs 其他弦高把位）', () => {
  // E4 = 329.63Hz：1 弦 0 品与 2 弦 5 品等都能弹出，应选 0 品
  const r = mapFrequencyToFret(329.6276, STANDARD);
  assert.equal(r.string, 1);
  assert.equal(r.fret, 0);
});

test('超出指板范围的频率不硬报位置', () => {
  const r = mapFrequencyToFret(40, STANDARD); // 远低于最低弦
  assert.equal(r.inRange, false);
  assert.equal(r.string, null);
  assert.equal(r.fret, null);
});

// 端到端：合成信号 → 完整分析链路 → 弦品
test('端到端：六根空弦合成音经完整引擎后报告正确弦品且置信度高', () => {
  const expectations = [
    { freq: 82.4069, string: 6, fret: 0, note: 'E2' },
    { freq: 110.0, string: 5, fret: 0, note: 'A2' },
    { freq: 146.8324, string: 4, fret: 0, note: 'D3' },
    { freq: 195.9977, string: 3, fret: 0, note: 'G3' },
    { freq: 246.9417, string: 2, fret: 0, note: 'B3' },
    { freq: 329.6276, string: 1, fret: 0, note: 'E4' },
  ];
  for (const exp of expectations) {
    const engine = new PitchEngine(STANDARD);
    engine.start();
    const frames = harmonicStream(exp.freq, [1, 0.8, 0.5, 0.3], 6);
    const { last } = runFrames(engine, frames);
    assert.equal(last.detected, true, `${exp.note} 应被检测到`);
    assert.equal(last.string, exp.string, `${exp.note} 弦号`);
    assert.equal(last.fret, exp.fret, `${exp.note} 品数`);
    assert.equal(last.noteName, exp.note);
    assert.ok(last.confidence >= 0.55, `${exp.note} 置信度应 >=0.55，实际 ${last.confidence}`);
    assert.ok(Math.abs(last.frequency - exp.freq) / exp.freq < 0.01,
      `频率误差 <1%，实际 ${last.frequency} vs ${exp.freq}`);
  }
});

test('端到端：D3 (146.83Hz) 类吉他信号识别为 4 弦空弦（最低把位优先）', () => {
  const engine = new PitchEngine(STANDARD);
  engine.start();
  const frames = harmonicStream(146.8324, [1, 0.9, 0.6, 0.4, 0.25], 6);
  const { last } = runFrames(engine, frames);
  assert.equal(last.detected, true);
  assert.equal(last.string, 4);
  assert.equal(last.fret, 0);
  assert.equal(last.noteName, 'D3');
});

test('端到端：A3 (220Hz) 映射到 3 弦 2 品这一最低把位', () => {
  const engine = new PitchEngine(STANDARD);
  engine.start();
  const frames = harmonicStream(220, [1, 0.8, 0.5], 6);
  const { last } = runFrames(engine, frames);
  assert.equal(last.detected, true);
  assert.equal(last.string, 3);
  assert.equal(last.fret, 2);
  assert.equal(last.noteName, 'A3');
});
