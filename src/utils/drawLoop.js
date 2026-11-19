/**
 * 单实例绘制循环：基于 requestAnimationFrame + setTimeout 的轮询。
 * - start() 前会自动停止上一轮，保证同一时刻只有一个循环在运行；
 * - stop() 会取消未触发的 rAF 与定时器，并使已排队但未执行的回调失效；
 * - draw 回调返回 false 时循环自动停止（例如视频暂停或当前片段播完）。
 *
 * raf/caf/later/cancelLater 均可注入，便于在 Node 环境下离线测试。
 */
export default function createDrawLoop(draw, options = {}) {
  const raf = options.raf || ((cb) => window.requestAnimationFrame(cb))
  const caf = options.caf || ((id) => window.cancelAnimationFrame(id))
  const later = options.later || ((cb) => window.setTimeout(cb, 1000 / 60))
  const cancelLater = options.cancelLater || ((id) => window.clearTimeout(id))

  let token = 0
  let rafId = null
  let timerId = null
  let running = false

  function clearPending() {
    if (rafId !== null) {
      caf(rafId)
      rafId = null
    }
    if (timerId !== null) {
      cancelLater(timerId)
      timerId = null
    }
  }

  function schedule(myToken) {
    rafId = raf(() => {
      rafId = null
      timerId = later(() => {
        timerId = null
        tick(myToken)
      })
    })
  }

  function tick(myToken) {
    // 令牌失效（已被 stop/重新 start）或已停止：直接丢弃，不再绘制也不再调度
    if (myToken !== token || !running) return
    const keepGoing = draw()
    if (keepGoing === false) {
      running = false
      return
    }
    if (myToken === token && running) {
      schedule(myToken)
    }
  }

  return {
    start() {
      this.stop()
      running = true
      const myToken = ++token
      schedule(myToken)
    },
    stop() {
      token++
      running = false
      clearPending()
    },
    isRunning() {
      return running
    },
  }
}
