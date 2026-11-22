/*
 * 混剪播放核心的本地验证（无需浏览器、无需安装依赖）。
 *
 * 运行：
 *   node --test test/
 *   或
 *   node --test test/playerCore.test.js
 *
 * 如何观察「绘制循环数量」与「监听是否残留」：
 *   - 循环数量：core.getDebugState().activeLoops（= loopsStarted - loopsStopped），
 *     不变量是任意时刻 ∈ {0, 1}；harness.frames.size 是「挂起的动画帧」数，同样 ≤ 1。
 *   - 监听残留：harness.listenerCount('keydown'|'mousemove'|'mouseup') 统计假 document
 *     上各类监听的数量；dispose 后必须全部归 0。
 *   浏览器里对应手段见 README「本地验证」一节。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMashupPlayer } = require('../src/playerCore.js')

// 三段：A[0,2) B[10,13) C[20,21) → 片长 2/3/1，总时长 6
const SEGMENTS = [
  { url: 'a.mp4', start: 0, end: 2 },
  { url: 'b.mp4', start: 10, end: 13 },
  { url: 'c.mp4', start: 20, end: 21 },
]

function makeHarness(segments = SEGMENTS) {
  const frames = new Map() // 挂起的动画帧：id -> cb
  let nextFrameId = 1
  const videos = [] // 主播放视频（按创建顺序）
  const preloadVideos = [] // 预加载视频
  const draws = []
  const docListeners = new Map() // type -> Set<fn>

  const documentRef = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      const set = docListeners.get(type)
      if (set) set.delete(fn)
    },
  }

  function makeVideo(isPreload) {
    const v = {
      src: '',
      currentTime: 0,
      paused: true,
      ended: false,
      muted: false,
      readyState: 4, // 元数据已就绪，可立即 seek
      play() {
        v.paused = false
        return Promise.resolve()
      },
      pause() {
        v.paused = true
      },
      removeAttribute(name) {
        if (name === 'src') v.src = ''
      },
      load() {},
      addEventListener() {},
      removeEventListener() {},
    }
    ;(isPreload ? preloadVideos : videos).push(v)
    return v
  }

  const harness = {
    frames,
    videos,
    preloadVideos,
    draws,
    states: [],
    closeRequested: false,
    canvas: {
      width: 640,
      height: 360,
      getContext: () => ({ drawImage: (...args) => draws.push(args) }),
    },
    core: null,
    // 推进一帧：先让所有「播放中」的视频走 dt 秒，再执行挂起的帧回调
    step(dt = 0.1) {
      videos.concat(preloadVideos).forEach((v) => {
        if (!v.paused && !v.ended) v.currentTime += dt
      })
      const cbs = [...frames.values()]
      frames.clear()
      cbs.forEach((cb) => cb())
    },
    run(seconds, dt = 0.1) {
      const n = Math.ceil(seconds / dt)
      for (let i = 0; i < n; i++) this.step(dt)
    },
    listenerCount(type) {
      const set = docListeners.get(type)
      return set ? set.size : 0
    },
    fireKey(keyCode) {
      const set = docListeners.get('keydown') || new Set()
      set.forEach((fn) => fn({ keyCode }))
    },
    currentVideo() {
      return videos[videos.length - 1]
    },
    // 单循环不变量：挂起帧 ≤ 1，活跃循环 ∈ {0,1}
    assertLoopInvariant() {
      assert.ok(frames.size <= 1, `挂起的动画帧应 ≤ 1，实际 ${frames.size}`)
      const { activeLoops } = this.core.getDebugState()
      assert.ok(activeLoops === 0 || activeLoops === 1, `活跃绘制循环应为 0 或 1，实际 ${activeLoops}`)
    },
  }

  harness.core = createMashupPlayer({
    segments,
    getCanvas: () => harness.canvas,
    createVideo: (seg, isPreload) => makeVideo(isPreload),
    requestFrame: (cb) => {
      const id = nextFrameId++
      frames.set(id, cb)
      return id
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
    documentRef,
    onState: (s) => harness.states.push({ ...s }),
    onRequestClose: () => {
      harness.closeRequested = true
    },
    onMouseMove: () => {},
    onMouseUp: () => {},
  })
  return harness
}

test('正常顺序播放：依次切段、总进度连续、播完收尾', () => {
  const h = makeHarness()
  h.core.start()
  assert.equal(h.core.getState().playIndex, 0)
  h.assertLoopInvariant()

  const seenIndexes = new Set([0])
  for (let i = 0; i < 70; i++) {
    h.step(0.1)
    seenIndexes.add(h.core.getState().playIndex)
    h.assertLoopInvariant()
  }

  // 三个片段都被依次播到
  assert.deepEqual([...seenIndexes].sort(), [0, 1, 2])
  // 全部播完
  const st = h.core.getState()
  assert.equal(st.ended, true)
  assert.equal(st.paused, true)
  assert.equal(st.playedTime, 6)

  // 进度条时间单调不减（切段处不跳变、不回退）
  const times = h.states.map((s) => s.playedTime)
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1] - 1e-9, `进度回退: ${times[i - 1]} -> ${times[i]}`)
  }
  // 播完后循环全部退出
  assert.equal(h.core.getDebugState().activeLoops, 0)
  assert.equal(h.frames.size, 0)
  // 确实往画布上画了东西
  assert.ok(h.draws.length > 0)
})

test('跳转：目标时间映射到正确片段与片内偏移，三者一致', () => {
  const h = makeHarness()
  h.core.start()
  h.run(1)

  // 跳到 4.5s → 片段 B（总轴 [2,5)），片内偏移 2.5 → currentTime = 10 + 2.5
  h.core.seekTo(4.5)
  let st = h.core.getState()
  assert.equal(st.playIndex, 1)
  assert.equal(st.playedTime, 4.5)
  assert.equal(h.currentVideo().currentTime, 12.5)
  assert.equal(h.currentVideo().src, 'b.mp4')
  h.assertLoopInvariant()

  // 跳回 0.5s → 片段 A，片内偏移 0.5
  h.core.seekTo(0.5)
  st = h.core.getState()
  assert.equal(st.playIndex, 0)
  assert.equal(st.playedTime, 0.5)
  assert.equal(h.currentVideo().currentTime, 0.5)
  h.assertLoopInvariant()

  // 边界：跳到片段交界 2.0 → 归属下一段开头，总进度连续
  h.core.seekTo(2.0)
  st = h.core.getState()
  assert.equal(st.playIndex, 1)
  assert.equal(st.playedTime, 2.0)
  assert.equal(h.currentVideo().currentTime, 10)

  // 跳到/越过末尾 → 视为播完
  h.core.seekTo(999)
  st = h.core.getState()
  assert.equal(st.ended, true)
  assert.equal(st.playedTime, 6)
  assert.equal(h.core.getDebugState().activeLoops, 0)

  // 播完后再次播放 → 从头开始
  h.core.toggle()
  st = h.core.getState()
  assert.equal(st.playIndex, 0)
  assert.equal(st.playedTime, 0)
  assert.equal(st.ended, false)
  h.assertLoopInvariant()
})

test('连续快速切段/跳转：任何时刻只有一个绘制循环，旧视频被暂停', () => {
  const h = makeHarness()
  h.core.start()
  h.run(0.5)

  // 连续 20 次跳转，中间不走任何帧（模拟用户狂点进度条）
  const targets = [4.5, 0.3, 5.5, 1.1, 3.3, 0, 5.9, 2.2, 4.4, 1.5, 0.7, 3.8, 5.1, 0.2, 2.9, 4.8, 1.9, 3.1, 5.4, 0.9]
  targets.forEach((t) => {
    h.core.seekTo(t)
    h.assertLoopInvariant()
  })
  // 除当前视频外，所有旧视频都被暂停
  h.videos.slice(0, -1).forEach((v, i) => {
    assert.equal(v.paused, true, `第 ${i} 个旧视频应已暂停`)
  })
  // 继续播放后位置与进度条一致
  h.run(0.5)
  const st = h.core.getState()
  assert.ok(Math.abs(st.playedTime - (0.9 + 0.5)) < 0.15, `跳转后播放应连续，实际 ${st.playedTime}`)
  h.assertLoopInvariant()

  // 超短片段快速自然切换
  const h2 = makeHarness([
    { url: 's1.mp4', start: 0, end: 0.15 },
    { url: 's2.mp4', start: 0, end: 0.15 },
    { url: 's3.mp4', start: 0, end: 0.15 },
    { url: 's4.mp4', start: 0, end: 0.15 },
  ])
  h2.core.start()
  for (let i = 0; i < 20; i++) {
    h2.step(0.1)
    h2.assertLoopInvariant()
  }
  assert.equal(h2.core.getState().ended, true)
  assert.equal(h2.core.getDebugState().activeLoops, 0)
})

test('暂停/恢复：循环随暂停退出、随恢复重启', () => {
  const h = makeHarness()
  h.core.start()
  h.run(0.5)

  h.core.toggle() // 暂停
  assert.equal(h.core.getState().paused, true)
  assert.equal(h.core.getDebugState().activeLoops, 0)
  assert.equal(h.frames.size, 0)
  const t = h.core.getState().playedTime
  h.run(0.5) // 暂停中帧不再推进
  assert.equal(h.core.getState().playedTime, t)

  h.core.toggle() // 恢复
  assert.equal(h.core.getState().paused, false)
  h.assertLoopInvariant()
  h.run(0.5)
  assert.ok(h.core.getState().playedTime > t)
})

test('关闭：动画帧、文档监听、视频对象全部释放；画布缺失也不抛错', () => {
  const h = makeHarness()
  h.core.start()
  h.run(1)

  // 关闭前：文档监听已绑定、循环在跑
  assert.equal(h.listenerCount('keydown'), 1)
  assert.equal(h.listenerCount('mousemove'), 1)
  assert.equal(h.listenerCount('mouseup'), 1)
  assert.equal(h.core.getDebugState().activeLoops, 1)

  // Esc 触发关闭回调
  h.fireKey(27)
  assert.equal(h.closeRequested, true)

  // 模拟画布节点已被移除后再清理
  h.canvas = null
  assert.doesNotThrow(() => h.core.dispose())

  const dbg = h.core.getDebugState()
  assert.equal(dbg.disposed, true)
  assert.equal(dbg.activeLoops, 0)
  assert.equal(h.frames.size, 0, '动画帧应全部取消')
  assert.equal(h.listenerCount('keydown'), 0, 'keydown 监听应移除')
  assert.equal(h.listenerCount('mousemove'), 0, 'mousemove 监听应移除')
  assert.equal(h.listenerCount('mouseup'), 0, 'mouseup 监听应移除')
  h.videos.concat(h.preloadVideos).forEach((v, i) => {
    assert.equal(v.paused, true, `第 ${i} 个视频应已暂停`)
    assert.equal(v.src, '', `第 ${i} 个视频的 src 应已释放`)
  })

  // dispose 幂等；关闭后帧回调不再产生任何效果
  assert.doesNotThrow(() => h.core.dispose())
  const drawsBefore = h.draws.length
  assert.doesNotThrow(() => h.run(1))
  assert.equal(h.draws.length, drawsBefore)
  assert.equal(h.frames.size, 0)
})

test('关闭后重开：新实例从头播放，不继承旧状态', () => {
  const h1 = makeHarness()
  h1.core.start()
  h1.run(3) // 播到片段 B
  h1.core.seekTo(5.5)
  h1.core.toggle() // 暂停
  h1.core.dispose()

  // 再次调用播放器 = 创建新实例
  const h2 = makeHarness()
  h2.core.start()
  const st = h2.core.getState()
  assert.equal(st.playIndex, 0, '应从第一个片段开始')
  assert.equal(st.playedTime, 0, '进度应归零')
  assert.equal(st.paused, false, '不应继承暂停态')
  assert.equal(h2.core.getDebugState().activeLoops, 1)

  // 新实例正常顺序播放
  h2.run(6.5)
  assert.equal(h2.core.getState().ended, true)
  assert.equal(h2.core.getDebugState().activeLoops, 0)
  // 旧实例保持沉寂
  assert.equal(h1.core.getDebugState().activeLoops, 0)
  assert.equal(h1.frames.size, 0)
})
