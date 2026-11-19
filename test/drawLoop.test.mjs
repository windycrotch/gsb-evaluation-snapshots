import test from 'node:test'
import assert from 'node:assert/strict'
import createDrawLoop from '../src/utils/drawLoop.js'

// 可控的假调度器：手动推进“帧”，模拟浏览器的 rAF + setTimeout
function createFakeClock() {
  let rafSeq = 0
  let timerSeq = 0
  const rafs = new Map()
  const timers = new Map()
  return {
    raf: (cb) => {
      const id = ++rafSeq
      rafs.set(id, cb)
      return id
    },
    caf: (id) => {
      rafs.delete(id)
    },
    later: (cb) => {
      const id = ++timerSeq
      timers.set(id, cb)
      return id
    },
    cancelLater: (id) => {
      timers.delete(id)
    },
    flushRaf() {
      const cbs = [...rafs.values()]
      rafs.clear()
      cbs.forEach((cb) => cb())
    },
    flushTimers() {
      const cbs = [...timers.values()]
      timers.clear()
      cbs.forEach((cb) => cb())
    },
    // 推进一帧：先触发 rAF，再触发其产生的定时器
    frame() {
      this.flushRaf()
      this.flushTimers()
    },
    pending() {
      return rafs.size + timers.size
    },
  }
}

function makeLoop(draw) {
  const clock = createFakeClock()
  const loop = createDrawLoop(draw, {
    raf: clock.raf,
    caf: clock.caf,
    later: clock.later,
    cancelLater: clock.cancelLater,
  })
  return { clock, loop }
}

test('启动后每帧恰好绘制一次', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return true
  })
  loop.start()
  for (let i = 0; i < 5; i++) {
    clock.frame()
  }
  assert.equal(draws, 5)
  assert.ok(loop.isRunning())
})

test('快速连续重新 start（模拟连续跳转片段）后同一时刻只有一个绘制循环', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return true
  })
  // 模拟快速连续跳转：不推进帧，连续 start 多次
  loop.start()
  loop.start()
  loop.start()
  // 只应有一个待触发的回调
  assert.equal(clock.pending(), 1)
  for (let i = 0; i < 4; i++) {
    clock.frame()
  }
  // 每帧恰好一次绘制，没有叠加的旧循环
  assert.equal(draws, 4)
})

test('stop 后不再绘制，且已排队的回调失效', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return true
  })
  loop.start()
  clock.frame()
  clock.frame()
  assert.equal(draws, 2)
  loop.stop()
  assert.equal(clock.pending(), 0)
  clock.frame()
  clock.frame()
  assert.equal(draws, 2)
  assert.ok(!loop.isRunning())
})

test('rAF 已触发但定时回调未执行时 stop，残留回调不会绘制', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return true
  })
  loop.start()
  clock.flushRaf() // rAF 回调已执行，setTimeout 回调排队中
  loop.stop()
  clock.flushTimers() // 残留回调被令牌机制丢弃
  assert.equal(draws, 0)
})

test('draw 返回 false（视频暂停/片段播完）时循环自动停止', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return draws < 3 // 第 3 次返回 false
  })
  loop.start()
  for (let i = 0; i < 10; i++) {
    clock.frame()
  }
  assert.equal(draws, 3)
  assert.ok(!loop.isRunning())
})

test('stop 之后可以重新 start（模拟暂停后恢复播放）', () => {
  let draws = 0
  const { clock, loop } = makeLoop(() => {
    draws++
    return true
  })
  loop.start()
  clock.frame()
  loop.stop()
  clock.frame()
  assert.equal(draws, 1)
  loop.start()
  clock.frame()
  clock.frame()
  assert.equal(draws, 3)
})
