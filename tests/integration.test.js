// integration.test.js — 合成采集源与麦克风共用同一分析入口的集成验证。
// SyntheticCapture 不依赖任何浏览器 API（只产出 PCM 帧），可在 Node 直接运行；
// MicCapture 在浏览器里调用的是同一个 onFrame → engine.processFrame 路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticCapture } from '../src/audio.js';
import { PitchEngine } from '../src/engine.js';
import { TUNINGS } from '../src/tuning.js';
import { FFT_SIZE, HOP_SIZE } from '../src/dsp.js';

function runCapture(capture, engine, frameCount) {
  return new Promise((resolve) => {
    const results = [];
    capture.onFrame = (samples, rate) => {
      assert.ok(samples.length === FFT_SIZE, '每帧长度必须等于 FFT_SIZE');
      results.push(engine.processFrame(samples, rate));
      if (results.length >= frameCount) {
        capture.stop();
        resolve(results);
      }
    };
    engine.start();
    capture.start();
  });
}

test('SyntheticCapture 产出的帧经引擎识别为正确弦品（与麦克风同函数）', async () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const capture = new SyntheticCapture(() => {}, {
    frequency: 110,
    harmonics: [1, 1.5, 0.6, 0.3], // 强二次谐波，同 UI 默认演示配置
    sampleRate: 44100,
  });
  const results = await runCapture(capture, engine, 12);
  const last = results.at(-1);
  assert.equal(last.detected, true);
  assert.equal(last.string, 5); // A2 = 5 弦空弦
  assert.equal(last.fret, 0);
  assert.equal(last.noteName, 'A2');
  assert.ok(last.confidence >= 0.55);
  assert.equal(engine.running, true);
  engine.stop();
});

test('SyntheticCapture 每次回调推进 HOP_SIZE 个新样本（滑动帧）', async () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const capture = new SyntheticCapture(() => {}, { frequency: 220, harmonics: [1], sampleRate: 44100 });
  const seen = [];
  await new Promise((resolve) => {
    capture.onFrame = (samples) => {
      // 等环形缓冲被真实样本填满（FFT_SIZE/HOP_SIZE=4 帧）后再记录
      if (seen.length < 6) seen.push(samples.slice(0, 4));
      if (seen.length >= 6) { capture.stop(); resolve(); }
    };
    engine.start();
    capture.start();
  });
  // 相邻帧前几个样本不同，证明环形缓冲确实在滑动而非重复同一帧
  assert.notDeepEqual(seen[4], seen[5]);
  assert.notDeepEqual(seen[3], seen[4]);
  assert.equal(HOP_SIZE > 0, true);
  engine.stop();
});

test('setFrequency 在运行中切换音高后，引擎最终跟踪到新音高', async () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const capture = new SyntheticCapture(() => {}, { frequency: 110, harmonics: [1, 0.8], sampleRate: 44100 });
  const results = [];
  await new Promise((resolve) => {
    capture.onFrame = (samples, rate) => {
      results.push(engine.processFrame(samples, rate));
      if (results.length === 8) capture.setFrequency(146.8324); // A2 → D3
      if (results.length >= 20) { capture.stop(); resolve(); }
    };
    engine.start();
    capture.start();
  });
  const last = results.at(-1);
  assert.equal(last.detected, true);
  assert.equal(last.noteName, 'D3');
  engine.stop();
});

test('停止采集后不再有帧回调，引擎结果冻结', async () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  let calls = 0;
  const capture = new SyntheticCapture(() => {}, { frequency: 110, harmonics: [1], sampleRate: 44100 });
  await new Promise((resolve) => {
    capture.onFrame = () => { if (++calls === 6) { capture.stop(); engine.stop(); setTimeout(resolve, 80); } };
    engine.start();
    capture.start();
  });
  const frozen = calls;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, frozen, '停止后回调数不再增长');
});
