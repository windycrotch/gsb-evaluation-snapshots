/**
 * 离线测试：参数归一化 + “待应用 / 已应用”状态切换 + 着色器硬编码检查。
 *
 * 运行方式（无需安装任何依赖、不需要真实 GPU）：
 *   node --test chapter07/render3/
 * 或：
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createParameterStore,
  normalizeBlurDistance,
  normalizeRecursionTime,
  DEFAULT_BLUR_DISTANCE,
  DEFAULT_RECURSION_TIME,
  RECURSION_TIME_MAX,
  RECURSION_TIME_MIN,
} from './params.mjs';

const here = dirname(fileURLToPath(import.meta.url));


/* ----------------------------- 递归次数归一化 ----------------------------- */

test('normalizeRecursionTime 接受 [0, 13] 内的整数', () => {
  assert.equal(normalizeRecursionTime(0), 0);
  assert.equal(normalizeRecursionTime(5), 5);
  assert.equal(normalizeRecursionTime(13), 13);
  assert.equal(normalizeRecursionTime(RECURSION_TIME_MIN), 0);
  assert.equal(normalizeRecursionTime(RECURSION_TIME_MAX), 13);
});

test('normalizeRecursionTime 接受可转成合法整数的数字字符串', () => {
  assert.equal(normalizeRecursionTime('0'), 0);
  assert.equal(normalizeRecursionTime('13'), 13);
  assert.equal(normalizeRecursionTime('7'), 7);
});

test('normalizeRecursionTime 对越界整数回退为 1', () => {
  assert.equal(normalizeRecursionTime(-1), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(-100), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(14), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(100), DEFAULT_RECURSION_TIME);
});

test('normalizeRecursionTime 对非整数回退为 1', () => {
  assert.equal(normalizeRecursionTime(5.5), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(1.2), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime('5.5'), DEFAULT_RECURSION_TIME);
});

test('normalizeRecursionTime 对非数字与无穷值回退为 1', () => {
  assert.equal(normalizeRecursionTime(NaN), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(Infinity), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(-Infinity), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime('abc'), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(''), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime('   '), DEFAULT_RECURSION_TIME);
  assert.equal(normalizeRecursionTime(undefined), DEFAULT_RECURSION_TIME);
});


/* ----------------------------- 模糊距离归一化 ----------------------------- */

test('normalizeBlurDistance 接受任意有限数（含 0、负数、小数）', () => {
  assert.equal(normalizeBlurDistance(0), 0);
  assert.equal(normalizeBlurDistance(1), 1);
  assert.equal(normalizeBlurDistance(-2.5), -2.5);
  assert.equal(normalizeBlurDistance(0.001), 0.001);
  assert.equal(normalizeBlurDistance(1e9), 1e9);
  assert.equal(normalizeBlurDistance('3.5'), 3.5);
  assert.equal(normalizeBlurDistance('0'), 0);
});

test('normalizeBlurDistance 对非数字与无穷值回退为 1', () => {
  assert.equal(normalizeBlurDistance(NaN), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance(Infinity), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance(-Infinity), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance('abc'), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance(''), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance('  '), DEFAULT_BLUR_DISTANCE);
  assert.equal(normalizeBlurDistance(undefined), DEFAULT_BLUR_DISTANCE);
});


/* --------------------------- 待应用 / 已应用状态 --------------------------- */

test('初始化时待应用值与已应用值一致且经过归一化', () => {
  const store = createParameterStore({ recursionTime: 5, blurDistance: 0.001 });
  assert.deepEqual(store.getPending(), { recursionTime: 5, blurDistance: 0.001 });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 0.001 });

  const fallback = createParameterStore({ recursionTime: 99, blurDistance: NaN });
  assert.deepEqual(fallback.getApplied(), {
    recursionTime: DEFAULT_RECURSION_TIME,
    blurDistance: DEFAULT_BLUR_DISTANCE,
  });
});

test('setPending 只更新待应用值，不影响已应用值', () => {
  const store = createParameterStore({ recursionTime: 5, blurDistance: 1 });

  store.setPending({ recursionTime: 8 });
  assert.deepEqual(store.getPending(), { recursionTime: 8, blurDistance: 1 });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });

  store.setPending({ blurDistance: 0.25 });
  assert.deepEqual(store.getPending(), { recursionTime: 8, blurDistance: 0.25 });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });

  // 非法输入在进入待应用状态时就被归一化
  store.setPending({ recursionTime: 20, blurDistance: 'not-a-number' });
  assert.deepEqual(store.getPending(), {
    recursionTime: DEFAULT_RECURSION_TIME,
    blurDistance: DEFAULT_BLUR_DISTANCE,
  });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });
});

test('部分更新不会覆盖另一个待应用字段', () => {
  const store = createParameterStore({ recursionTime: 3, blurDistance: 2 });
  store.setPending({ recursionTime: 4 });
  assert.equal(store.getPending().blurDistance, 2);
  store.setPending({ blurDistance: 6 });
  assert.equal(store.getPending().recursionTime, 4);
});

test('applyPending 一次性把待应用值应用为已应用值', () => {
  const store = createParameterStore({ recursionTime: 5, blurDistance: 1 });

  store.setPending({ recursionTime: 11, blurDistance: 0.5 });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });

  const applied = store.applyPending();
  assert.deepEqual(applied, { recursionTime: 11, blurDistance: 0.5 });
  assert.deepEqual(store.getApplied(), { recursionTime: 11, blurDistance: 0.5 });
  assert.deepEqual(store.getPending(), { recursionTime: 11, blurDistance: 0.5 });

  // 没有新的待应用改动时再次应用，已应用值保持稳定
  store.applyPending();
  assert.deepEqual(store.getApplied(), { recursionTime: 11, blurDistance: 0.5 });
});

test('getter 返回的是副本，外部修改不会污染内部状态', () => {
  const store = createParameterStore({ recursionTime: 5, blurDistance: 1 });

  const pending = store.getPending();
  pending.recursionTime = 13;
  pending.blurDistance = 99;
  assert.deepEqual(store.getPending(), { recursionTime: 5, blurDistance: 1 });

  const applied = store.getApplied();
  applied.recursionTime = 0;
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });
});

test('多个 store 实例之间状态互不影响', () => {
  const a = createParameterStore({ recursionTime: 1, blurDistance: 1 });
  const b = createParameterStore({ recursionTime: 2, blurDistance: 2 });

  a.setPending({ recursionTime: 9 });
  assert.equal(a.getPending().recursionTime, 9);
  assert.equal(b.getPending().recursionTime, 2);
});


/* --------------------- 模拟页面交互：播放始终用已应用值 --------------------- */

test('完整交互流：改输入不影响播放，重置后才以新参数重新生成并继续', () => {
  // 用一个不依赖 GPU 的最小消费者模拟 app.js 的行为：
  // “底图参数”只在重置时更新；“单步/播放”只读已应用参数。
  const store = createParameterStore({ recursionTime: 5, blurDistance: 1 });
  let baseImageParams = store.getApplied();
  const blurSteps = [];

  const stepOnce = () => blurSteps.push(store.getApplied().blurDistance);
  const reset = () => {
    const applied = store.applyPending();
    baseImageParams = applied; // 重新生成底图
    return applied;
  };

  // 初始播放几步：使用初始已应用值 1
  stepOnce();
  stepOnce();

  // 用户修改两个输入（只更新待应用值），播放继续使用旧的已应用值
  store.setPending({ recursionTime: 10, blurDistance: 0.2 });
  stepOnce();
  stepOnce();
  assert.deepEqual(baseImageParams, { recursionTime: 5, blurDistance: 1 });
  assert.deepEqual(blurSteps, [1, 1, 1, 1]);
  assert.deepEqual(store.getPending(), { recursionTime: 10, blurDistance: 0.2 });
  assert.deepEqual(store.getApplied(), { recursionTime: 5, blurDistance: 1 });

  // 重置：待应用值一次性生效，底图按新参数重新生成
  assert.deepEqual(reset(), { recursionTime: 10, blurDistance: 0.2 });
  assert.deepEqual(baseImageParams, { recursionTime: 10, blurDistance: 0.2 });

  // 再次播放/单步读到的是新的已应用值
  stepOnce();
  assert.deepEqual(blurSteps, [1, 1, 1, 1, 0.2]);

  // 播放中再次修改输入并重置：动画参数立即切换为新的一组
  store.setPending({ recursionTime: 0, blurDistance: 0 });
  assert.deepEqual(reset(), { recursionTime: 0, blurDistance: 0 });
  stepOnce();
  assert.equal(blurSteps.at(-1), 0);
});


/* --------------------------- 模糊着色器硬编码检查 --------------------------- */

test('blur.frag 不再把模糊距离除以 1024，而是直接作为纹理坐标偏移', () => {
  const shader = readFileSync(join(here, 'blur.frag'), 'utf8');

  assert.doesNotMatch(shader, /1024/, '着色器中不应再出现硬编码的 1024 除数');
  assert.match(shader, /blurDistance/, '着色器应继续使用 blurDistance uniform');
  assert.match(shader, /float\s+d\s*=\s*blurDistance\s*;/, 'd 应直接取自 blurDistance');

  // 距离为 0 时四个采样坐标都等于当前纹素坐标，输出与原图一致
  assert.match(shader, /vec2\(\s*x\s*\+\s*d,\s*y\s*\)/);
  assert.match(shader, /vec2\(\s*x\s*-\s*d,\s*y\s*\)/);
  assert.match(shader, /vec2\(\s*x,\s*y\s*\+\s*d\s*\)/);
  assert.match(shader, /vec2\(\s*x,\s*y\s*-\s*d\s*\)/);
});
