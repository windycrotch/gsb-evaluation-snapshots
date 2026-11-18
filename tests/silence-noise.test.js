// silence-noise.test.js — 验收点 3：静音或纯噪声不产生高置信度结果。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrame, STABLE_CONF } from '../src/dsp.js';
import { PitchEngine } from '../src/engine.js';
import { TUNINGS } from '../src/tuning.js';
import { silenceFrame, whiteNoiseFrame, makeRng, harmonicStream, runFrames } from './helpers/signals.js';

const SR = 44100;

test('单帧：全静音返回 null（不报音高）', () => {
  assert.equal(analyzeFrame(silenceFrame(), SR), null);
});

test('单帧：白噪声返回 null 或置信度极低', () => {
  const r = analyzeFrame(whiteNoiseFrame(makeRng(42), 0.25), SR);
  if (r !== null) {
    assert.ok(r.confidence < STABLE_CONF,
      `噪声置信度必须低于稳定门限 ${STABLE_CONF}，实际 ${r.confidence}`);
  }
});

test('单帧：极低幅度信号按静音处理', () => {
  const tiny = new Float64Array(8192).fill(0.0001);
  assert.equal(analyzeFrame(tiny, SR), null);
});

test('引擎：连续静音帧永远不产生检测结果', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const frames = Array.from({ length: 10 }, () => silenceFrame());
  const { results } = runFrames(engine, frames);
  for (const r of results) {
    assert.equal(r.detected, false);
    assert.equal(r.frequency, null);
    assert.equal(r.string, null);
    assert.equal(r.fret, null);
    assert.ok(r.confidence < STABLE_CONF);
  }
});

test('引擎：连续白噪声帧不产生高置信度结果', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const rng = makeRng(7);
  const frames = Array.from({ length: 12 }, () => whiteNoiseFrame(rng, 0.3));
  const { results, last } = runFrames(engine, frames);
  assert.equal(last.detected, false);
  assert.equal(last.frequency, null);
  for (const r of results) {
    assert.ok(r.confidence < STABLE_CONF, `噪声帧置信度异常: ${r.confidence}`);
  }
});

test('引擎：噪声中偶发一帧正弦不足以锁定（时间平滑拦截闪烁）', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const rng = makeRng(99);
  const frames = Array.from({ length: 8 }, (_, i) =>
    i === 4 ? harmonicStream(110, [1], 1)[0] : whiteNoiseFrame(rng, 0.25));
  const { results } = runFrames(engine, frames);
  // 没有任何一帧达到“稳定检测”
  assert.ok(results.every((r) => !r.detected), '单帧偶发信号不应触发锁定');
});

test('引擎：真实信号消失后，结果回到未检测状态而非保留旧音高', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const tone = harmonicStream(110, [1, 0.8], 6);
  runFrames(engine, tone);
  const quiet = Array.from({ length: 5 }, () => silenceFrame());
  const { last } = runFrames(engine, quiet);
  assert.equal(last.detected, false);
  assert.equal(last.frequency, null);
});
