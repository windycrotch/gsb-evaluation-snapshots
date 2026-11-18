// tracker.test.js — 时间平滑与八度跳变抑制的单元测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchTracker } from '../src/tracker.js';

const frame = (frequency, confidence = 0.7) => ({ frequency, confidence, rms: 0.2, snr: 20 });

test('不足 STABLE_FRAMES 的连续帧不产生稳定输出', () => {
  const t = new PitchTracker();
  assert.equal(t.pushFrame(frame(110)).stable, false);
  assert.equal(t.pushFrame(frame(110.1)).stable, false);
  const third = t.pushFrame(frame(109.9));
  assert.equal(third.stable, true);
});

test('锁定后出现单帧高八度跳变，输出保持原频率不闪烁', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 4; i++) t.pushFrame(frame(110));
  const before = t.pushFrame(frame(110));
  assert.equal(before.stable, true);
  assert.ok(Math.abs(before.frequency - 110) < 2);

  // 混入一帧 220Hz（高八度）
  const jumped = t.pushFrame(frame(220.4));
  assert.ok(jumped.frequency < 160, `八度跳变帧不应改变输出，实际 ${jumped.frequency}`);

  // 随后恢复 110Hz，输出仍在 110 附近
  const recovered = t.pushFrame(frame(110.1));
  assert.ok(Math.abs(recovered.frequency - 110) < 3);
});

test('持续的新音高（非八度）最终能重新锁定，不会被永久卡住', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 5; i++) t.pushFrame(frame(110));
  // 换到 146.83Hz（D3，与 A2 相隔纯四度）
  const results = [];
  for (let i = 0; i < 6; i++) results.push(t.pushFrame(frame(146.83)));
  const last = results.at(-1);
  assert.equal(last.stable, true);
  assert.ok(Math.abs(last.frequency - 146.83) < 3, `应跟踪到新音高，实际 ${last.frequency}`);
});

test('连续 null 帧释放锁定；单帧丢失保持输出', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 4; i++) t.pushFrame(frame(220));
  assert.equal(t.pushFrame(null).stable, true, '单帧丢失仍保持');
  assert.equal(t.pushFrame(null).stable, false, '连续两帧丢失后释放');
  assert.equal(t.locked, null);
});

test('reset 后历史与锁定全部清空', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 4; i++) t.pushFrame(frame(110));
  t.reset();
  assert.equal(t.locked, null);
  assert.equal(t.candidate, null);
  assert.deepEqual(t.history, []);
  assert.equal(t.pushFrame(frame(110)).stable, false);
});
