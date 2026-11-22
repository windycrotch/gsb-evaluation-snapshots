/*
 * 多段视频混剪播放核心（框架无关）。
 *
 * 职责：
 *  1. 跳转：把目标总时长映射到「片段下标 + 片段内偏移」，保证进度条时间、
 *     playIndex 与实际播放位置三者一致。
 *  2. 切段：任何时刻同一画布最多只有一个绘制循环在跑。每次切换/跳转先让旧
 *     循环退出（取消挂起的动画帧 + 代际令牌失效），再启动新循环。
 *  3. 关闭：取消动画帧、移除文档级监听、暂停并释放视频对象；画布节点缺失
 *     也不抛错；dispose 幂等，可安全重复调用。
 *
 * 通过注入 getCanvas / createVideo / requestFrame / cancelFrame / documentRef，
 * 该模块既能在浏览器里被 Vue 组件驱动，也能在 Node 里用假对象直接测试。
 *
 * UMD 包装：Node（CommonJS）与浏览器（全局 MashupPlayerCore）均可使用；
 * webpack/vite 下 `import { createMashupPlayer } from './playerCore'` 亦可。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.MashupPlayerCore = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  function clamp(v, min, max) {
    v = Number(v)
    if (isNaN(v)) v = 0
    return v < min ? min : v > max ? max : v
  }

  function defaultRequestFrame(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb)
    return setTimeout(function () {
      cb()
    }, 16)
  }

  function defaultCancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    else clearTimeout(handle)
  }

  /**
   * @param {Object} options
   * @param {Array}  options.segments   [{ url, start, end, raw? }] start/end 为秒（可数字可字符串）
   * @param {Function} options.getCanvas  () => canvas | null —— 允许返回 null（节点已被移除）
   * @param {Function} options.createVideo (segmentRaw, isPreload) => video 元素
   * @param {Function} [options.requestFrame] 默认 requestAnimationFrame
   * @param {Function} [options.cancelFrame]  默认 cancelAnimationFrame
   * @param {Object}   [options.documentRef]  提供则在其上绑定 keydown/mousemove/mouseup
   * @param {Function} [options.onState]        状态变化回调（playedTime/playIndex/paused/ended/...）
   * @param {Function} [options.onRequestClose] Esc 触发
   * @param {Function} [options.onMouseMove]    文档级 mousemove（拖动进度条用）
   * @param {Function} [options.onMouseUp]      文档级 mouseup（拖动结束用）
   * @param {Function} [options.onEnded]        全部片段播完
   */
  function createMashupPlayer(options) {
    const opts = options || {}
    const segments = (opts.segments || [])
      .map(function (s) {
        return {
          raw: s.raw || s,
          url: s.url,
          start: clamp(parseFloat(s.start), 0, Number.MAX_SAFE_INTEGER),
          end: clamp(parseFloat(s.end), 0, Number.MAX_SAFE_INTEGER),
        }
      })
      .filter(function (s) {
        return s.end > s.start
      })

    // 每个片段在总时间轴上的累计起点；总时长为各片段时长之和
    const segStarts = []
    let total = 0
    segments.forEach(function (s) {
      segStarts.push(total)
      total += s.end - s.start
    })

    const requestFrame = opts.requestFrame || defaultRequestFrame
    const cancelFrame = opts.cancelFrame || defaultCancelFrame

    const state = {
      playIndex: 0,
      playedTime: 0,
      totalTime: total,
      paused: true,
      ended: false,
      muted: false,
    }

    let disposed = false
    let started = false
    // 代际令牌：每次启动新绘制循环 +1，旧循环的回调发现令牌过期立即退出，
    // 以此保证「同一画布同一时刻只有一个绘制循环」。
    let generation = 0
    let frameHandle = null
    let video = null
    let preloadVideo = null
    // 可观测性：loopsStarted - loopsStopped 即当前活跃绘制循环数，恒为 0 或 1
    const stats = { loopsStarted: 0, loopsStopped: 0 }
    const docDisposers = []

    function snapshot() {
      return {
        playIndex: state.playIndex,
        playedTime: state.playedTime,
        totalTime: state.totalTime,
        paused: state.paused,
        ended: state.ended,
        muted: state.muted,
      }
    }

    function emitState() {
      if (disposed) return
      if (typeof opts.onState === 'function') {
        try {
          opts.onState(snapshot())
        } catch (e) {
          /* 回调异常不应影响播放循环 */
        }
      }
    }

    // ---- 文档级监听：集中登记，dispose 时逐一移除 ----
    function addDocListener(type, handler) {
      const doc = opts.documentRef
      if (!doc || !handler || !doc.addEventListener) return
      doc.addEventListener(type, handler)
      docDisposers.push(function () {
        try {
          doc.removeEventListener(type, handler)
        } catch (e) {
          /* 忽略：文档对象不可用时也要继续清理其余项 */
        }
      })
    }

    function bindDocumentListeners() {
      addDocListener('keydown', function (e) {
        const key = e && (e.key !== undefined ? e.key : e.keyCode)
        if (key === 'Escape' || key === 'Esc' || key === 27) {
          if (typeof opts.onRequestClose === 'function') opts.onRequestClose()
        }
      })
      if (typeof opts.onMouseMove === 'function') {
        addDocListener('mousemove', function (e) {
          opts.onMouseMove(e)
        })
      }
      if (typeof opts.onMouseUp === 'function') {
        addDocListener('mouseup', function (e) {
          opts.onMouseUp(e)
        })
      }
    }

    function removeDocumentListeners() {
      while (docDisposers.length) {
        try {
          docDisposers.pop()()
        } catch (e) {
          /* 单个移除失败不阻塞其余清理 */
        }
      }
    }

    // ---- 绘制循环：单循环不变量 ----
    // 不变量：每个 beginLoop（loopsStarted+1）最终恰好对应一次
    // 「循环终止」（loopsStopped+1）——要么 step 自然退出，要么挂起帧被
    // cancelPendingFrame 取消。因此 activeLoops ∈ {0, 1}。
    function cancelPendingFrame() {
      if (frameHandle !== null) {
        try {
          cancelFrame(frameHandle)
        } catch (e) {
          /* 忽略 */
        }
        frameHandle = null
        stats.loopsStopped++
      }
    }

    function loopTerminated() {
      stats.loopsStopped++
    }

    function beginLoop() {
      cancelPendingFrame()
      generation++
      stats.loopsStarted++
      const gen = generation

      const step = function () {
        frameHandle = null
        if (disposed || gen !== generation) return loopTerminated()
        if (state.paused) return loopTerminated()
        const seg = segments[state.playIndex]
        if (!seg || !video) return loopTerminated()

        // 片段播完：先终止本循环，再切下一段或收尾
        if (video.ended || video.currentTime >= seg.end) {
          loopTerminated()
          onSegmentReached()
          return
        }

        drawFrame(video)

        // 进度条时间永远由「实际播放位置」推导，保证三者一致、切段连续
        const segLen = seg.end - seg.start
        const offset = clamp(video.currentTime - seg.start, 0, segLen)
        state.playedTime = clamp(segStarts[state.playIndex] + offset, 0, total)
        emitState()

        // emitState 的回调里可能又触发了暂停/跳转/关闭，需重新校验
        if (disposed || gen !== generation || state.paused) return loopTerminated()
        frameHandle = requestFrame(step)
      }

      frameHandle = requestFrame(step)
    }

    function drawFrame(v) {
      const canvas = opts.getCanvas ? opts.getCanvas() : null
      if (!canvas || !v) return
      try {
        const ctx = canvas.getContext && canvas.getContext('2d')
        if (!ctx) return
        const w = canvas.width || v.videoWidth || v.width
        const h = canvas.height || v.videoHeight || v.height
        if (w && h) ctx.drawImage(v, 0, 0, w, h)
      } catch (e) {
        /* 画布被移除/跨域等异常不中断循环 */
      }
    }

    // ---- 视频对象 ----
    function safePause(v) {
      if (!v) return
      try {
        v.pause()
      } catch (e) {
        /* 忽略 */
      }
    }

    function safePlay(v) {
      if (!v || !v.play) return
      try {
        const p = v.play()
        if (p && typeof p.catch === 'function') {
          p.catch(function () {
            /* 自动播放被拒等，保持 paused 状态由用户手势恢复 */
          })
        }
      } catch (e) {
        /* 忽略 */
      }
    }

    function releaseVideo(v) {
      if (!v) return
      safePause(v)
      try {
        if (v.removeAttribute) v.removeAttribute('src')
        else v.src = ''
      } catch (e) {
        /* 忽略 */
      }
      try {
        if (v.load) v.load()
      } catch (e) {
        /* 忽略 */
      }
    }

    // 元数据就绪后再定位；若期间又发生了跳转/切换（代际过期）则放弃本次定位
    function applySeek(v, time) {
      const gen = generation
      const doSeek = function () {
        if (disposed || gen !== generation || v !== video) return
        try {
          v.currentTime = time
        } catch (e) {
          /* 忽略 */
        }
      }
      if (v.readyState >= 1 || !v.addEventListener) {
        doSeek()
      } else {
        const onMeta = function () {
          try {
            v.removeEventListener('loadedmetadata', onMeta)
          } catch (e) {
            /* 忽略 */
          }
          doSeek()
        }
        v.addEventListener('loadedmetadata', onMeta)
      }
    }

    function preloadNext(index) {
      releaseVideo(preloadVideo)
      preloadVideo = null
      const next = segments[index + 1]
      if (!next || !opts.createVideo) return
      try {
        preloadVideo = opts.createVideo(next.raw, true)
        if (preloadVideo) preloadVideo.src = next.url
      } catch (e) {
        preloadVideo = null
      }
    }

    // ---- 播放编排 ----
    // 切换到指定片段的指定片内偏移。旧循环先退出、旧视频先暂停，再启动新循环。
    function playSegment(index, offset) {
      if (disposed || !segments[index]) return
      const seg = segments[index]
      const segLen = seg.end - seg.start
      offset = clamp(offset, 0, segLen)

      // 1. 停旧：取消挂起的动画帧（旧循环退出）+ 暂停旧视频
      cancelPendingFrame()
      safePause(video)

      // 2. 更新状态：下标与进度条时间立即对齐到目标位置
      state.playIndex = index
      state.ended = false
      state.paused = false
      state.playedTime = clamp(segStarts[index] + offset, 0, total)

      // 3. 换新视频
      if (opts.createVideo) {
        try {
          video = opts.createVideo(seg.raw, false)
        } catch (e) {
          video = null
        }
        if (video) {
          try {
            video.src = seg.url
          } catch (e) {
            /* 忽略 */
          }
        }
      }

      // 4. 启新循环（代际 +1，旧循环即使残留也会立即退出）
      beginLoop()

      // 5. 定位并播放
      if (video) {
        applySeek(video, seg.start + offset)
        if (video.muted !== undefined) video.muted = state.muted
        safePlay(video)
      }

      emitState()
      preloadNext(index)
    }

    function onSegmentReached() {
      if (state.playIndex >= segments.length - 1) {
        finish()
        return
      }
      // 自然切段：旧循环已退出（调用方已计数），新循环在此接管
      playSegment(state.playIndex + 1, 0)
    }

    function finish() {
      cancelPendingFrame()
      safePause(video)
      state.playedTime = total
      state.paused = true
      state.ended = true
      emitState()
      if (typeof opts.onEnded === 'function') {
        try {
          opts.onEnded()
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    // 把总时间轴上的时间映射为「片段下标 + 片内偏移」
    function locate(time) {
      const t = clamp(time, 0, total)
      for (let i = 0; i < segments.length; i++) {
        const segLen = segments[i].end - segments[i].start
        // 边界归属下一段（offset 0），保证总进度连续不跳变
        if (t < segStarts[i] + segLen || i === segments.length - 1) {
          return { index: i, offset: clamp(t - segStarts[i], 0, segLen) }
        }
      }
      return { index: 0, offset: 0 }
    }

    // ---- 对外 API ----
    function start() {
      if (disposed || started || !segments.length) return
      started = true
      state.playIndex = 0
      state.playedTime = 0
      state.ended = false
      bindDocumentListeners()
      playSegment(0, 0)
    }

    function seekTo(time) {
      if (disposed || !segments.length) return
      const t = clamp(time, 0, total)
      if (t >= total) {
        finish()
        return
      }
      const pos = locate(t)
      playSegment(pos.index, pos.offset)
    }

    function pause() {
      if (disposed || state.paused) return
      state.paused = true
      cancelPendingFrame()
      safePause(video)
      emitState()
    }

    function resume() {
      if (disposed) return
      if (!started) {
        start()
        return
      }
      if (state.ended) {
        seekTo(0)
        return
      }
      if (!state.paused) return
      state.paused = false
      safePlay(video)
      beginLoop()
      emitState()
    }

    function toggle() {
      if (state.ended) {
        seekTo(0)
        return
      }
      if (state.paused) resume()
      else pause()
    }

    function toggleMute() {
      state.muted = !state.muted
      if (video) {
        try {
          video.muted = state.muted
        } catch (e) {
          /* 忽略 */
        }
      }
      emitState()
    }

    // 关闭清理：取消动画帧、移除文档监听、暂停并释放视频。
    // 幂等；画布节点缺失不影响清理；任何单点失败都不抛出。
    function dispose() {
      if (disposed) return
      disposed = true
      cancelPendingFrame()
      removeDocumentListeners()
      releaseVideo(video)
      releaseVideo(preloadVideo)
      video = null
      preloadVideo = null
    }

    function getState() {
      return snapshot()
    }

    // 可观测性接口：测试与浏览器控制台均可用来检查循环数与监听残留
    function getDebugState() {
      return {
        started: started,
        disposed: disposed,
        playIndex: state.playIndex,
        playedTime: state.playedTime,
        totalTime: state.totalTime,
        paused: state.paused,
        ended: state.ended,
        loopsStarted: stats.loopsStarted,
        loopsStopped: stats.loopsStopped,
        activeLoops: stats.loopsStarted - stats.loopsStopped,
        hasPendingFrame: frameHandle !== null,
        documentListenersBound: docDisposers.length,
        hasVideo: !!video,
      }
    }

    return {
      start: start,
      seekTo: seekTo,
      pause: pause,
      resume: resume,
      toggle: toggle,
      toggleMute: toggleMute,
      dispose: dispose,
      getState: getState,
      getDebugState: getDebugState,
    }
  }

  return { createMashupPlayer: createMashupPlayer }
})
