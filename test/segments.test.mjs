import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSegments, computeTimeline, locateSegment } from '../src/utils/segments.js'

// 与 src/data.js 相同的四段配置：3.12 + 5.88 + 8.92 + 3.2 = 21.12
const SAMPLE = [
  { start: '0', end: '3.120000' },
  { start: '4.320000', end: '10.200000' },
  { start: '11.400000', end: '20.320000' },
  { start: '21.520000', end: '24.72' },
]

test('normalizeSegments 解析字符串时间并保留合法片段', () => {
  const segs = normalizeSegments(SAMPLE)
  assert.equal(segs.length, 4)
  assert.ok(Math.abs(segs[0].duration - 3.12) < 1e-9)
  assert.ok(Math.abs(segs[2].duration - 8.92) < 1e-9)
})

test('normalizeSegments 丢弃 end <= start 与无法解析的非法片段', () => {
  const segs = normalizeSegments([
    { start: '5', end: '5' }, // end == start
    { start: '9', end: '2' }, // end < start，会产生负时长
    { start: 'abc', end: '3' }, // 无法解析
    { start: '1', end: '4' }, // 合法
    null,
    {},
  ])
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0], { start: 1, end: 4, duration: 3 })
})

test('computeTimeline 累计时长正确，总时长不为负', () => {
  const { totalTime, skipDict } = computeTimeline(SAMPLE)
  assert.ok(Math.abs(totalTime - 21.12) < 1e-9)
  assert.equal(skipDict.length, 4)
  assert.ok(Math.abs(skipDict[0] - 3.12) < 1e-9)
  assert.ok(Math.abs(skipDict[3] - 21.12) < 1e-9)
  // skipDict 单调递增
  for (let i = 1; i < skipDict.length; i++) {
    assert.ok(skipDict[i] > skipDict[i - 1])
  }
})

test('computeTimeline 全部片段非法时总时长为 0，不产生负数/NaN', () => {
  const { totalTime, skipDict } = computeTimeline([
    { start: '5', end: '5' },
    { start: '9', end: '2' },
  ])
  assert.equal(totalTime, 0)
  assert.deepEqual(skipDict, [])
  assert.ok(Number.isFinite(totalTime))
})

test('computeTimeline 空输入安全', () => {
  assert.deepEqual(computeTimeline(null), { totalTime: 0, skipDict: [] })
  assert.deepEqual(computeTimeline([]), { totalTime: 0, skipDict: [] })
})

const SKIP_DICT = computeTimeline(SAMPLE).skipDict

test('locateSegment 定位到第 N 段中间：下标与片段内偏移正确', () => {
  // 第 2 段（下标 1）从累计 3.12 开始，全局 5s -> 段内 1.88s
  const r = locateSegment(SKIP_DICT, 5)
  assert.equal(r.index, 1)
  assert.ok(Math.abs(r.offset - 1.88) < 1e-9)
  // 对应到源视频 currentTime = 片段 start + offset = 4.32 + 1.88 = 6.2
  const seg = normalizeSegments(SAMPLE)[r.index]
  assert.ok(Math.abs(seg.start + r.offset - 6.2) < 1e-9)
})

test('locateSegment 边界：恰好落在段末累计点时进入下一段开头', () => {
  const r = locateSegment(SKIP_DICT, SKIP_DICT[0])
  assert.equal(r.index, 1)
  assert.equal(r.offset, 0)
})

test('locateSegment 起点为第 0 段开头', () => {
  assert.deepEqual(locateSegment(SKIP_DICT, 0), { index: 0, offset: 0 })
})

test('locateSegment 越界输入被安全夹取，不产生负偏移', () => {
  assert.deepEqual(locateSegment(SKIP_DICT, -3), { index: 0, offset: 0 })
  assert.deepEqual(locateSegment(SKIP_DICT, NaN), { index: 0, offset: 0 })
  // 超过总时长：定位到最后一段末尾，偏移不超过该段时长
  const r = locateSegment(SKIP_DICT, 999)
  assert.equal(r.index, 3)
  assert.ok(Math.abs(r.offset - 3.2) < 1e-9)
})

test('locateSegment 空时间轴安全', () => {
  assert.deepEqual(locateSegment([], 10), { index: 0, offset: 0 })
  assert.deepEqual(locateSegment(undefined, 10), { index: 0, offset: 0 })
})
