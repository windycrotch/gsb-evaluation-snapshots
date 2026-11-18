/*
 * 时间线跳转/续播逻辑的本地测试，零第三方依赖：
 *   node --test
 * （需要 Node >= 20.10，内置 node:test / node:assert；本仓库开发环境为 Node 24）
 *
 * 覆盖四类场景：
 *   1. 中间片段跳转
 *   2. 精确分界点
 *   3. 末段结束后重播
 *   4. 非法区间（非正时长 / 起止值非法）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTimeline,
  locate,
  clampTime,
  toGlobalTime,
  toFiniteNumber,
} from '../src/timeline.js'

const EPS = 1e-9

/** 自造的多片段配置（字符串起止值，模拟真实接口数据） */
function makeList() {
  return [
    { url: 'a.mp4', playPoint: { start: '0', end: '3.12' }, index: 0 },
    { url: 'b.mp4', playPoint: { start: '4.32', end: '10.2' }, index: 1 },
    { url: 'c.mp4', playPoint: { start: '11.4', end: '20.32' }, index: 2 },
    { url: 'd.mp4', playPoint: { start: '21.52', end: '24.72' }, index: 3 },
  ]
}

test('总时长等于各片段 (end-start) 之和', () => {
  const { totalTime, segments } = buildTimeline(makeList())
  const expected = 3.12 + (10.2 - 4.32) + (20.32 - 11.4) + (24.72 - 21.52)
  assert.ok(Math.abs(totalTime - expected) < EPS, `totalTime=${totalTime}`)
  assert.equal(segments.length, 4)
  // 累计边界
  assert.equal(segments[0].globalStart, 0)
  assert.ok(Math.abs(segments[0].globalEnd - 3.12) < EPS)
  assert.ok(Math.abs(segments[1].globalStart - 3.12) < EPS)
  assert.ok(Math.abs(segments[2].globalStart - (3.12 + 5.88)) < EPS)
  assert.ok(Math.abs(segments[3].globalEnd - totalTime) < EPS)
})

test('场景1：跳转到中间片段，下标/偏移与全局时间一致', () => {
  const timeline = buildTimeline(makeList())
  const { segments } = timeline

  // 跳到片段 2（下标从 0 起）内部：全局时间 = 该片段起点 + 已过时间
  const offsetInSeg2 = 2.5
  const globalT = segments[2].globalStart + offsetInSeg2
  const r = locate(timeline, globalT)

  assert.equal(r.ended, false)
  assert.equal(r.index, 2)
  assert.ok(Math.abs(r.offset - offsetInSeg2) < EPS)
  assert.ok(
    Math.abs(globalT - (segments[r.index].globalStart + r.offset)) < EPS,
    '全局时间必须等于片段 start + 片段内已过时间'
  )

  // 逆运算回推全局时间应保持不变（暂停再恢复不重置位置的数学保证）
  const back = toGlobalTime(timeline, r.index, r.offset)
  assert.ok(Math.abs(back - globalT) < EPS)

  // 视频源播放点 = 源 start + 片段内偏移
  const sourcePlayPoint = segments[r.index].start + r.offset
  assert.ok(Math.abs(sourcePlayPoint - (11.4 + 2.5)) < EPS)
})

test('场景1b：片段内任意偏移往返映射恒等', () => {
  const timeline = buildTimeline(makeList())
  for (const t of [0.001, 3.0, 5.5, 9.0, 12.0, 20.9]) {
    const loc = locate(timeline, t)
    assert.equal(loc.ended, false)
    const back = toGlobalTime(timeline, loc.index, loc.offset)
    assert.ok(Math.abs(back - t) < 1e-7, `往返不一致 t=${t} back=${back}`)
  }
})

test('场景2：精确落在分界点时进入后一片段，偏移为 0', () => {
  const timeline = buildTimeline(makeList())
  const { segments } = timeline

  // 片段 0 与片段 1 的分界点
  const boundary = segments[0].globalEnd
  const r = locate(timeline, boundary)
  assert.equal(r.ended, false)
  assert.equal(r.index, 1, '分界点必须进入后一片段')
  assert.equal(r.offset, 0)

  // 前一片段末端（差一极小量）仍属于前一片段
  const before = locate(timeline, boundary - 1e-6)
  assert.equal(before.index, 0)
  assert.ok(before.offset > 0)

  // 中间分界点同样进入后一片段
  const midBoundary = segments[2].globalEnd
  const r2 = locate(timeline, midBoundary)
  assert.equal(r2.index, 3)
  assert.equal(r2.offset, 0)

  // 分界点处换算出的源视频时间是后一片段的 start
  assert.ok(Math.abs(segments[r2.index].start + r2.offset - 21.52) < EPS)
})

test('场景3：落在总时长末端视为最后一片段结束', () => {
  const timeline = buildTimeline(makeList())
  const { segments, totalTime } = timeline

  const atEnd = locate(timeline, totalTime)
  assert.equal(atEnd.ended, true)
  assert.equal(atEnd.index, segments.length)
  assert.equal(atEnd.offset, 0)

  // 超过末端同样视为结束，clampTime 不会给出超过总时长的值
  assert.equal(clampTime(timeline, totalTime + 999), totalTime)
  assert.equal(locate(timeline, totalTime + 999).ended, true)

  // 末端前一刻仍在最后一片段内
  const nearEnd = locate(timeline, totalTime - 0.01)
  assert.equal(nearEnd.ended, false)
  assert.equal(nearEnd.index, segments.length - 1)
})

test('场景3b：全部播完后再次播放应从头开始', () => {
  const timeline = buildTimeline(makeList())
  const { totalTime } = timeline

  // 播放器重播等价于：把全局时间归零后重新定位
  const restartGlobal = clampTime(timeline, 0)
  assert.equal(restartGlobal, 0)
  const r = locate(timeline, restartGlobal)
  assert.equal(r.index, 0)
  assert.equal(r.offset, 0)
  assert.equal(r.ended, false)

  // 从末端点击进度条最左端也应回到首片段
  assert.equal(locate(timeline, clampTime(timeline, 0)).index, 0)
  assert.ok(totalTime > 0)
})

test('场景4：片段时长非正或起止值非法时不产生 NaN', () => {
  const dirty = [
    { playPoint: { start: '0', end: '3' } }, // 合法
    { playPoint: { start: '5', end: '5' } }, // 零时长 -> 丢弃
    { playPoint: { start: '9', end: '4' } }, // 负时长 -> 丢弃
    { playPoint: { start: 'abc', end: '4' } }, // 非法 start -> 丢弃
    { playPoint: { start: '2', end: undefined } }, // 非法 end -> 丢弃
    { playPoint: { start: null, end: NaN } }, // 全非法 -> 丢弃
    null, // 空项 -> 丢弃
    { playPoint: { start: '10', end: '14' } }, // 合法
  ]
  const timeline = buildTimeline(dirty)

  assert.equal(timeline.segments.length, 2, '只有两个合法片段')
  assert.equal(timeline.totalTime, 7, `总时长=${timeline.totalTime}`)
  assert.ok(Number.isFinite(timeline.totalTime))

  // 被丢弃的片段不参与定位：合法片段1占据全局 [0,3)，全局时间 4
  // 落在合法片段2（全局起点 3）内，偏移 = 4 - 3 = 1
  const r = locate(timeline, 4)
  assert.equal(r.index, 1)
  assert.equal(r.offset, 1)
  assert.equal(r.ended, false)

  // 对非法时间参数定位也不得返回 NaN
  for (const bad of [NaN, undefined, null, 'abc', {}, Infinity, -Infinity]) {
    const loc = locate(timeline, bad)
    assert.ok(Number.isFinite(loc.offset), `offset 对输入 ${String(bad)} 变成 NaN`)
    assert.equal(loc.index, 0)
    assert.equal(loc.offset, 0)
    assert.equal(clampTime(timeline, bad), 0)
  }
})

test('场景4b：全部片段非法 / 空输入时总时长为 0 且不产生 NaN', () => {
  for (const badList of [
    undefined,
    null,
    [],
    [{ playPoint: { start: 'x', end: 'y' } }],
    [{ playPoint: { start: 6, end: 2 } }],
    'not-an-array',
  ]) {
    const timeline = buildTimeline(badList)
    assert.equal(timeline.totalTime, 0)
    assert.deepEqual(timeline.segments, [])
    const loc = locate(timeline, 3)
    assert.equal(loc.ended, true)
    assert.equal(loc.index, 0)
    assert.equal(loc.offset, 0)
    assert.ok(Number.isFinite(loc.totalTime))
  }
})

test('toFiniteNumber 对各种脏值的兜底', () => {
  assert.equal(toFiniteNumber('2.5'), 2.5)
  assert.equal(toFiniteNumber(NaN, 7), 7)
  assert.equal(toFiniteNumber(undefined), 0)
  assert.equal(toFiniteNumber(Infinity, 9), 9)
  assert.equal(toFiniteNumber(null, 3), 3)
})
