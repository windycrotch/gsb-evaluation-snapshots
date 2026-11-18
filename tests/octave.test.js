// octave.test.js — 验收点 2：带强二次谐波的信号不被误判为高一个八度。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrame } from '../src/dsp.js';
import { PitchEngine } from '../src/engine.js';
import { TUNINGS } from '../src/tuning.js';
import { harmonicFrame, harmonicStream, runFrames } from './helpers/signals.js';

const SR = 44100;

test('单帧：二次谐波比基频强 50% 时，基频仍是 A2(110Hz) 而非 A3(220Hz)', () => {
  const frame = harmonicFrame(110, [1, 1.5, 0.6, 0.3], SR);
  const r = analyzeFrame(frame, SR);
  assert.ok(r, '应返回有效结果');
  // 允许 ±3% 误差，但绝不能落到 220Hz 附近
  assert.ok(Math.abs(r.frequency - 110) < 4,
    `期望 ~110Hz，实际 ${r.frequency.toFixed(2)}Hz`);
  assert.ok(r.frequency < 160, `频率不应接近高八度 220Hz，实际 ${r.frequency.toFixed(2)}Hz`);
});

test('单帧：极端情况二次谐波为基频 2 倍，仍判定真实基频', () => {
  const frame = harmonicFrame(82.4069, [1, 2, 1, 0.5], SR); // E2 + 很强的 E3
  const r = analyzeFrame(frame, SR);
  assert.ok(r, '应返回有效结果');
  assert.ok(Math.abs(r.frequency - 82.4069) < 4,
    `期望 ~82.4Hz，实际 ${r.frequency?.toFixed(2)}Hz`);
});

test('端到端：强二次谐波信号经平滑后锁定低八度，弦品不跳变', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  // A2 = 5 弦空弦；若误判高八度会变成 3 弦 2 品附近
  const frames = harmonicStream(110, [1, 1.5, 0.6, 0.3], 8);
  const { results, last } = runFrames(engine, frames);

  assert.equal(last.detected, true);
  assert.ok(Math.abs(last.frequency - 110) < 4, `最终频率应 ~110Hz，实际 ${last.frequency}`);
  assert.equal(last.string, 5);
  assert.equal(last.fret, 0);

  // 所有已检测帧都不能报告高八度位置（3 弦 2 品 = A3 区域）
  for (const [i, r] of results.entries()) {
    if (r.detected) {
      assert.ok(r.frequency < 160, `第 ${i} 帧发生八度跳变: ${r.frequency.toFixed(1)}Hz`);
    }
  }
});

test('端到端：高八度纯音本身仍能正确识别（防过度偏好低频）', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const frames = harmonicStream(220, [1], 8); // 真实 A3 纯正弦
  const { last } = runFrames(engine, frames);
  assert.equal(last.detected, true);
  assert.ok(Math.abs(last.frequency - 220) < 5, `期望 ~220Hz，实际 ${last.frequency}`);
  assert.equal(last.noteName, 'A3');
});

test('谐波栈整体上移一个八度时，输出随之移动而不是死守低频', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  // 261.63Hz = C4，在标准调弦上为 2 弦 1 品 / 3 弦 5 品等，最低把位 2 弦 1 品
  const frames = harmonicStream(261.6256, [1, 1.2, 0.7], 8);
  const { last } = runFrames(engine, frames);
  assert.equal(last.detected, true);
  assert.ok(Math.abs(last.frequency - 261.6256) / 261.6256 < 0.01);
  assert.equal(last.fret, 1);
  assert.equal(last.string, 2);
});
