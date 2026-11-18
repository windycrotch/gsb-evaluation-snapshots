/*
 * 时间线纯函数模块：全局播放时间 <-> 片段下标 <-> 片段内偏移
 *
 * 约定：
 *  - 每个片段在全局时间线上占用 [globalStart, globalEnd)，globalEnd - globalStart === end - start
 *  - 全局时间 t 落在片段 i 的 [globalStart, globalEnd) 内时，
 *    片段内偏移 offset = t - globalStart，视频应从源视频 start + offset 处播放
 *  - t 恰好等于分界点 globalEnd_i（即下一片段 globalStart）时进入后一片段，偏移为 0
 *  - t >= 总时长时视为最后一片段结束（ended）
 *
 * 所有函数对非法输入做防御，任何返回值都不允许出现 NaN。
 */

/**
 * 把任意输入转成有限数字，非法时返回 fallback
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function toFiniteNumber(value, fallback = 0) {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 由原始片段配置构建时间线。
 * 起止值非法或时长非正（<= 0，含 NaN/Infinity）的片段会被丢弃，
 * 因此总时长始终是各合法片段 (end - start) 之和，不会被污染成 NaN。
 *
 * @param {Array<{playPoint?: {start?: *, end?: *}}>} [list]
 * @returns {{segments: Array, totalTime: number}}
 */
export function buildTimeline(list) {
  const segments = []
  let totalTime = 0
  const source = Array.isArray(list) ? list : []

  source.forEach((item) => {
    // 起止值必须本身就是有限数字（字符串数字可解析），
    // 任一非法（undefined/null/NaN/Infinity/普通文本）即丢弃整个片段，
    // 不用 0 兜底，以免把非法区间悄悄改写成合法片段。
    const start = Number.parseFloat(item && item.playPoint && item.playPoint.start)
    const end = Number.parseFloat(item && item.playPoint && item.playPoint.end)

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return
    }

    const duration = end - start

    if (!Number.isFinite(duration) || duration <= 0) {
      // 非法区间 / 非正时长：跳过，不计入总时长
      return
    }

    const globalStart = totalTime
    totalTime += duration
    segments.push({
      item: item || null,
      start,
      end,
      duration,
      globalStart,
      globalEnd: totalTime,
    })
  })

  return { segments, totalTime }
}

/**
 * 把外部给出的时间限制在 [0, totalTime] 内，非法输入归零。
 * @param {{totalTime: number}} timeline
 * @param {*} time
 * @returns {number}
 */
export function clampTime(timeline, time) {
  const total = Number.isFinite(timeline && timeline.totalTime) ? timeline.totalTime : 0
  const t = Number.parseFloat(time)
  if (!Number.isFinite(t) || t <= 0) return 0
  if (t >= total) return total
  return t
}

/**
 * 由全局时间定位片段下标与片段内偏移。
 *
 * @param {{segments: Array, totalTime: number}} timeline
 * @param {*} time 全局播放时间（秒）
 * @returns {{index: number, offset: number, ended: boolean, totalTime: number}}
 *   index 为命中的片段下标；ended 为 true 时 index === segments.length，
 *   表示落在总时长末端、最后一片段已结束。
 */
export function locate(timeline, time) {
  const segments = (timeline && timeline.segments) || []
  const totalTime = Number.isFinite(timeline && timeline.totalTime) ? timeline.totalTime : 0

  if (!segments.length) {
    return { index: 0, offset: 0, ended: true, totalTime }
  }

  let t = Number.parseFloat(time)
  if (!Number.isFinite(t) || t <= 0) t = 0

  // 落在总时长末端：最后一片段结束
  if (t >= totalTime) {
    return { index: segments.length, offset: 0, ended: true, totalTime }
  }

  // 半开区间 [globalStart, globalEnd)：
  // 恰好落在分界点时当前片段判断不成立，自然进入后一片段且偏移为 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (t < seg.globalEnd) {
      return { index: i, offset: t - seg.globalStart, ended: false, totalTime }
    }
  }

  // 兜底：理论不可达，保证不返回 NaN
  return { index: segments.length, offset: 0, ended: true, totalTime }
}

/**
 * locate 的逆运算：由片段下标与片段内偏移换算全局时间。
 * 偏移会被限制在 [0, duration] 内。
 *
 * @param {{segments: Array, totalTime: number}} timeline
 * @param {number} index
 * @param {number} offset
 * @returns {number}
 */
export function toGlobalTime(timeline, index, offset) {
  const segments = (timeline && timeline.segments) || []
  const seg = segments[index]
  if (!seg) {
    return Number.isFinite(timeline && timeline.totalTime) ? timeline.totalTime : 0
  }
  let o = Number.parseFloat(offset)
  if (!Number.isFinite(o) || o < 0) o = 0
  if (o > seg.duration) o = seg.duration
  return seg.globalStart + o
}
