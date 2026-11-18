// stop.test.js — 验收点 4：停止后不再更新界面。
// 用一个轻量“假 UI”记录引擎产出的结果，验证 stop() 之后帧被完全拒绝。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchEngine } from '../src/engine.js';
import { TUNINGS } from '../src/tuning.js';
import { harmonicStream, runFrames } from './helpers/signals.js';

// 模拟 app.js 中的接线：仅在引擎运行时把结果推给 UI（停止后采集源已断开，
// 根本不会再产生回调；这里额外验证 processFrame 自身也拒绝新帧）。
function fakeUiWiring(engine) {
  const updates = [];
  const onFrame = (samples, rate) => {
    if (!engine.running) return; // 与 MicCapture/SyntheticCapture.stop() 后的行为一致
    const result = engine.processFrame(samples, rate);
    updates.push(result); // 真实 UI 在这里刷新读数与画布
  };
  return { updates, onFrame };
}

test('运行中：UI 持续收到稳定检测结果', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const ui = fakeUiWiring(engine);
  engine.start();
  const frames = harmonicStream(146.8324, [1, 0.8, 0.5], 6);
  for (const f of frames) ui.onFrame(f, 44100);
  const last = ui.updates.at(-1);
  assert.equal(last.detected, true);
  assert.equal(last.noteName, 'D3');
});

test('停止后：继续送入音频帧，UI 结果对象不再变化', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const ui = fakeUiWiring(engine);
  engine.start();
  const framesA = harmonicStream(146.8324, [1, 0.8, 0.5], 6);
  for (const f of framesA) ui.onFrame(f, 44100);
  const snapshot = structuredClone(ui.updates.at(-1));
  assert.equal(snapshot.detected, true);

  engine.stop();
  const updatesAtStop = ui.updates.length;

  // 停止后即便换一个完全不同的音高继续喂帧
  const framesB = harmonicStream(329.6276, [1, 0.8], 6);
  for (const f of framesB) ui.onFrame(f, 44100);

  assert.equal(ui.updates.length, updatesAtStop,
    '停止后 onFrame 产出的结果引用不再变化（processFrame 提前返回）');
  assert.deepEqual(ui.updates.at(-1), snapshot);
});

test('停止后直接调用 processFrame 返回的仍是停止前的最后结果', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  const { last: before } = runFrames(engine, harmonicStream(110, [1], 5));
  engine.stop();
  const after = engine.processFrame(harmonicStream(220, [1], 1)[0], 44100);
  assert.equal(after, engine.lastResult);
  assert.equal(after, before);
  assert.equal(engine.running, false);
});

test('重新 start 后追踪器复位，需要重新累积稳定帧才会再次检测', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  engine.start();
  runFrames(engine, harmonicStream(110, [1], 6));
  engine.stop();
  engine.start();
  // 第一帧不应立刻继承上一轮的锁定状态
  const first = engine.processFrame(harmonicStream(110, [1], 1)[0], 44100);
  assert.equal(first.detected, false);
  // 累积足够帧后重新锁定
  const { last } = runFrames(engine, harmonicStream(110, [1], 4));
  assert.equal(last.detected, true);
  assert.equal(last.noteName, 'A2');
});

test('未 start 的引擎拒绝任何帧', () => {
  const engine = new PitchEngine(TUNINGS.standard.strings);
  const r = engine.processFrame(harmonicStream(110, [1], 1)[0], 44100);
  assert.equal(r, null);
  assert.equal(engine.running, false);
});
