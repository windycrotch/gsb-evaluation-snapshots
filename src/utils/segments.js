/**
 * 混剪片段时间线工具（纯函数，不依赖 DOM / 网络，便于离线测试）
 */

// 规范化片段列表：解析 start/end，丢弃 end 不大于 start（或无法解析）的非法片段，
// 保证后续总时长与进度计算不会出现负数或除零。
export function normalizeSegments(list) {
  if (!Array.isArray(list)) return []
  const segments = []
  for (const item of list) {
    if (!item) continue
    const start = parseFloat(item.start)
    const end = parseFloat(item.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (end <= start) continue
    segments.push({ start, end, duration: end - start })
  }
  return segments
}

// 由片段列表计算总时长与累计时长表 skipDict（skipDict[i] 为第 i 段结束时的累计时长）
export function computeTimeline(segments) {
  const skipDict = []
  let totalTime = 0
  for (const seg of normalizeSegments(segments)) {
    totalTime += seg.duration
    skipDict.push(totalTime)
  }
  return { totalTime, skipDict }
}

// 根据累计时长表，把全局已播放时长定位到目标片段下标与片段内偏移。
// 入参越界（负数、超过总时长、非数字）时安全夹取，不会返回负偏移。
export function locateSegment(skipDict, playedTime) {
  if (!Array.isArray(skipDict) || skipDict.length === 0) {
    return { index: 0, offset: 0 }
  }
  let target = Number.isFinite(playedTime) ? playedTime : 0
  if (target < 0) target = 0
  let prevEnd = 0
  for (let i = 0; i < skipDict.length; i++) {
    if (target < skipDict[i]) {
      return { index: i, offset: target - prevEnd }
    }
    prevEnd = skipDict[i]
  }
  // 超出总时长：定位到最后一段的末尾
  const last = skipDict.length - 1
  const beforeLast = last > 0 ? skipDict[last - 1] : 0
  return { index: last, offset: skipDict[last] - beforeLast }
}
