/*
 * 集成测试（node 直接运行）：jsdom + 假 video/canvas 驱动真实组件
 * 覆盖：跳转定位/边界、自然结束只推进一次、监听清理、关闭后重开
 */
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
global.window = dom.window
global.document = dom.window.document
global.navigator = dom.window.navigator
global.HTMLElement = dom.window.HTMLElement
global.Node = dom.window.Node
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)
window.requestAnimationFrame = global.requestAnimationFrame
window.cancelAnimationFrame = global.cancelAnimationFrame

const Vue = require('vue')
const compiler = require('vue-template-compiler')
const fs = require('fs')
const path = require('path')

// require 钩子：用项目自带的 vue-template-compiler 即时编译 .vue SFC
require.extensions['.vue'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = compiler.parseComponent(source)
  const script = parsed.script ? parsed.script.content : 'export default {}'
  let js = script
    .replace(/export\s+default/, 'module.exports =')
    .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, "const $1 = require('$2')")
  if (parsed.template) {
    const compiled = compiler.compile(parsed.template.content)
    js +=
      '\nmodule.exports.render = function(){' +
      compiled.render +
      '};\nmodule.exports.staticRenderFns = [' +
      compiled.staticRenderFns.map((f) => 'function(){' + f + '}').join(',') +
      '];\n'
  }
  module._compile(js, filename)
}
// SFC 内的 @import css / less 与逻辑无关，测试中忽略
require.extensions['.css'] = function () {}
require.extensions['.less'] = function () {}

const Player = require('../src/canvasPlayer.vue')

let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg)
  } else {
    fail++
    console.error('  ✗ ' + msg)
  }
}
function eq(a, b, msg) {
  assert(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`)
}

// ---- 假 Video 元素：基于真实 jsdom 元素覆盖行为，保留 Node 能力 ----
const rawCreateElement = document.createElement.bind(document)
function makeFakeVideo() {
  const el = rawCreateElement('video')
  el.__isFake = true
  // jsdom 媒体属性多为只读 getter，这里重定义为可写访问器
  let currentTimeValue = 0
  const writable = (name, value) => {
    Object.defineProperty(el, name, {
      get() {
        return value
      },
      set(v) {
        value = v
      },
      configurable: true,
    })
  }
  writable('paused', true)
  writable('ended', false)
  writable('seeking', false)
  // currentTime 赋值模拟真实 seek：先进入 seeking，异步派发 seeked。
  // tickTime/dispatch 走静默通道，避免测试中连续 tick 被 seeked 打断
  Object.defineProperty(el, 'currentTime', {
    get() {
      return currentTimeValue
    },
    set(v) {
      currentTimeValue = v
      if (el._silent) return
      el.seeking = true
      queueMicrotask(() => {
        el.seeking = false
        el.dispatch('seeked')
      })
    },
    configurable: true,
  })
  writable('videoWidth', 1080)
  writable('videoHeight', 1920)
  writable('width', 1080)
  writable('height', 1920)
  writable('volume', 0)
  writable('muted', false)
  writable('controls', false)
  el.preload = ''
  el._handlers = {}
  Object.defineProperty(el, 'src', {
    get() {
      return el._src
    },
    set(v) {
      el._src = v
      // 与真实浏览器一致：更换源后 currentTime 归零、结束态复位
      el.currentTime = 0
      el.ended = false
      el.seeking = false
      queueMicrotask(() => {
        el.dispatch('loadedmetadata')
        el.dispatch('durationchange')
      })
    },
    configurable: true,
  })
  el.play = function () {
    el.paused = false
    el.ended = false
    // 与真实浏览器一致：play 事件异步派发，确保监听器已注册
    queueMicrotask(() => el.dispatch('play'))
    return Promise.resolve()
  }
  el.pause = function () {
    el.paused = true
  }
  el.seekTo = function (t) {
    el.currentTime = t
    el.seeking = true
    queueMicrotask(() => {
      el.seeking = false
      el.dispatch('seeked')
    })
  }
  el.tickTime = function (t) {
    el._silent = true
    el.currentTime = t
    el._silent = false
    el.dispatch('timeupdate')
  }
  // 与真实浏览器一致：on* 置 null 后，派发时读到 null 就不再回调。
  // 处理器存在私有 store 里（jsdom 的 IDL setter 会覆盖自定义访问器）。
  el.dispatch = function (type) {
    const fn = el._handlers[type]
    if (typeof fn === 'function') fn({ type })
  }
  const handlerNames = [
    'durationchange', 'seeked', 'timeupdate', 'play', 'ended',
    'loadedmetadata', 'seeking', 'pause',
  ]
  handlerNames.forEach((type) => {
    el._handlers[type] = null
    Object.defineProperty(el, 'on' + type, {
      get() {
        return el._handlers[type]
      },
      set(fn) {
        el._handlers[type] = fn
      },
      configurable: true,
    })
  })
  el.removeAttribute = function () {}
  el.load = function () {}
  return el
}

// ---- 假 Canvas ----
function makeFakeCanvas() {
  const el = rawCreateElement('canvas')
  el.__isFake = true
  el.width = 300
  el.height = 150
  el._listeners = {}
  el.drawCount = 0
  el.getContext = () => ({ drawImage: () => { el.drawCount++ } })
  const rawAdd = el.addEventListener.bind(el)
  el.addEventListener = (type, fn) => {
    ;(el._listeners[type] = el._listeners[type] || []).push(fn)
    rawAdd(type, fn)
  }
  const rawRemove = el.removeEventListener.bind(el)
  el.removeEventListener = (type, fn) => {
    el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn)
    rawRemove(type, fn)
  }
  return el
}

// 监听 document 上真实绑定/移除的事件
const docAddSpy = []
const docRemoveSpy = []
const rawAdd = document.addEventListener.bind(document)
const rawRemove = document.removeEventListener.bind(document)
document.addEventListener = (type, fn, opts) => {
  docAddSpy.push({ type, fn })
  rawAdd(type, fn, opts)
}
document.removeEventListener = (type, fn) => {
  docRemoveSpy.push({ type, fn })
  rawRemove(type, fn)
}

function mountPlayer(options) {
  // 每个播放器实例独立统计监听绑定/移除
  docAddSpy.length = 0
  docRemoveSpy.length = 0
  document.body.innerHTML = ''
  const Ctor = Vue.extend(Player)
  // 用 data 工厂返回深拷贝，避免多个实例共享同一份数据对象（Vue2 会原地修改它）
  const vm = new Ctor({ data: () => JSON.parse(JSON.stringify(options)) })
  vm.$mount()
  document.body.appendChild(vm.$el)
  return vm
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

const sampleOptions = {
  logo: 'logo.png',
  list: [
    { url: 'a.mp4', width: 1080, height: 1920, logoPosition: { x: 'left', y: 'top' }, playPoint: { start: '0', end: '3.12' }, index: 0 },
    { url: 'b.mp4', width: 720, height: 1280, logoPosition: { x: 'right', y: 'top' }, playPoint: { start: '4.32', end: '10.2' }, index: 1 },
    { url: 'c.mp4', width: 1080, height: 1920, logoPosition: { x: 'left', y: 'bottom' }, playPoint: { start: '11.4', end: '20.32' }, index: 2 },
  ],
}

async function main() {
  // 拦截组件内部创建的 video/canvas（同 id 元素由组件复用，与真实行为一致）
  const createdVideos = []
  document.createElement = function (tag) {
    const lower = String(tag).toLowerCase()
    if (lower === 'video') {
      const v = makeFakeVideo()
      createdVideos.push(v)
      return v
    }
    if (lower === 'canvas') {
      return makeFakeCanvas()
    }
    return rawCreateElement(tag)
  }

  // ========== 用例 1：挂载即从第一段播放，初始状态一致 ==========
  console.log('\n[1] 挂载与初始播放')
  const vm = mountPlayer(sampleOptions)
  await flush()
  const mainVideo = document.getElementById('AutoVideoId')
  const preload = document.getElementById('preLoadVideoId')
  assert(!!mainVideo && mainVideo.tagName === 'VIDEO', '主视频对象已创建')
  assert(!!preload && preload.tagName === 'VIDEO', '预加载视频对象已创建')
  eq(vm.totalTime, 3.12 + (10.2 - 4.32) + (20.32 - 11.4), '总时长=各片段时长之和')
  eq(vm.skipDict[0], 3.12, '累计节点0正确')
  eq(vm.skipDict[1], 3.12 + 5.88, '累计节点1正确')
  eq(vm.playIndex, 0, '初始片段索引为0')
  assert(vm.videoObj === mainVideo, 'videoObj 指向当前片段视频对象')
  await flush()
  eq(mainVideo.currentTime, 0, '首段从片段起点(偏移0)开始')
  assert(vm.paused === false, '挂载后处于播放态')

  // ========== 用例 2：跳转到中间片段内部 ==========
  console.log('\n[2] 拖动跳转到第二段内部（累计 5.0s）')
  vm.playedTime = 5.0
  vm.skipProgress()
  await flush()
  eq(vm.playIndex, 1, '累计5.0s 定位到第二段(index=1)')
  // 片段内偏移 = 5.0 - 3.12 = 1.88，视频原始时间 = 4.32 + 1.88 = 6.2
  eq(mainVideo.currentTime, 4.32 + 1.88, '从第二段内部偏移处继续（原始时间6.2）')
  eq(vm.playedTime, 5.0, '进度显示与跳转点一致')
  eq(vm.segmentStart, 3.12, 'segmentStart 与索引同步')

  // timeupdate 驱动的累计进度
  mainVideo.tickTime(7.0) // 原始 7.0 -> 累计 3.12 + (7.0-4.32) = 5.8
  eq(vm.playedTime, 5.8, 'timeupdate 后进度与视频实际时间一致')

  // ========== 用例 3：跳到片段边界，落到相邻片段、无负偏移 ==========
  console.log('\n[3] 边界跳转')
  vm.playedTime = 3.12 // 正好第一段结束边界
  vm.skipProgress()
  await flush()
  eq(vm.playIndex, 1, '边界点落到后一段(index=1)')
  eq(mainVideo.currentTime, 4.32, '边界偏移为0，无负偏移')

  vm.playedTime = 0
  vm.skipProgress()
  await flush()
  eq(vm.playIndex, 0, '跳到0落在第一段')
  eq(mainVideo.currentTime, 0, '首段偏移为0，无负偏移')

  // ========== 用例 4：跳到总时长末尾 -> 结束态，无越界索引 ==========
  console.log('\n[4] 跳到总时长末尾')
  vm.playedTime = vm.totalTime
  vm.skipProgress()
  assert(vm.endFlag === true, '末尾跳转进入结束态')
  eq(vm.playIndex, vm.videoList.length, '索引停在 length（不越界）')
  eq(vm.playedTime, vm.totalTime, '进度停在总时长')

  // 结束态点击 -> 从第一段重新开始
  vm.changeVideoState()
  await flush()
  eq(vm.playIndex, 0, '结束态点击后从第一段重新开始')
  assert(vm.endFlag === false, '重开后 endFlag 复位')

  // ========== 用例 5：自然结束同一窗口重复 timeupdate 只推进一次 ==========
  console.log('\n[5] 自然结束去重推进')
  // 当前在第一段，捕获该片段注册的 timeupdate / ended 闭包（旧片段的残留事件）
  const seg0TimeUpdate = mainVideo.ontimeupdate
  const seg0Ended = mainVideo.onended
  assert(typeof seg0TimeUpdate === 'function', '第一段已注册 timeupdate 闭包')
  mainVideo.tickTime(3.12)
  eq(vm.playIndex, 1, '到达第一段末尾 -> 推进一次到第二段')
  // 同一结束窗口内：旧闭包再被触发（模拟浏览器迟到的 timeupdate / ended）
  // 其内部会话代号已过期，必须直接 return，不得再推进索引
  const genAfterSwitch = vm.sessionGen
  seg0TimeUpdate({ type: 'timeupdate' })
  seg0TimeUpdate({ type: 'timeupdate' })
  seg0Ended({ type: 'ended' })
  eq(vm.playIndex, 1, '旧片段残留闭包重复触发不会跳过片段')
  eq(vm.sessionGen, genAfterSwitch, '过期闭包不会开启新片段会话')
  assert(vm.isSwitching === false, '新片段加载后切换锁已释放')

  // 继续到第二段末尾（当前元素上的处理器已是第二段的新闭包）
  await flush()
  assert(mainVideo.ontimeupdate !== seg0TimeUpdate, '切换后元素上的处理器已替换为新闭包')
  mainVideo.tickTime(10.2)
  eq(vm.playIndex, 2, '第二段自然结束 -> 推进到第三段')
  mainVideo.tickTime(10.2)
  mainVideo.tickTime(10.5)
  eq(vm.playIndex, 2, '同一结束窗口重复触发不跳段')

  // 最后一段结束 -> 结束态
  await flush()
  mainVideo.tickTime(20.32)
  assert(vm.endFlag === true, '最后一段结束进入结束态')
  mainVideo.tickTime(20.32)
  mainVideo.dispatch('ended')
  eq(vm.playIndex, vm.videoList.length, '结束态重复触发不越界')

  // ========== 用例 6：切换片段后旧绘制循环退场，只剩一个循环 ==========
  console.log('\n[6] 绘制循环与画布配置')
  const canvas = document.getElementById('AutoCanvasId')
  vm.gotoPlay()
  await flush()
  const drawsAfterFirst = canvas.drawCount
  assert(drawsAfterFirst > 0, '当前片段绘制循环在工作')
  const widthFirst = canvas.width
  vm.playNext() // 切到第二段
  await flush()
  const drawsAfterSwitch = canvas.drawCount
  assert(drawsAfterSwitch > drawsAfterFirst, '新片段绘制循环继续工作')
  // 画布尺寸取当前视频对象的 intrinsic 尺寸（组件 onplay 中写入）
  eq(canvas.width, mainVideo.videoWidth, '画布宽度跟随当前视频 intrinsic 尺寸')
  eq(canvas.height, mainVideo.videoHeight, '画布高度跟随当前视频 intrinsic 尺寸')
  assert(canvas.width === 1080 && canvas.height === 1920, '画布尺寸已被 onplay 重写（非默认 300x150）')
  const logo = document.getElementById('logoId')
  assert(!!logo, 'logo 元素存在并跟随新片段配置')
  assert(logo.style.right !== '' || logo.style.left !== '', 'logo 方位样式已按片段写入')

  // 多次切换后 document 监听仍只有一套（不重复绑定）
  const keydownAdds = docAddSpy.filter((e) => e.type === 'keydown').length
  const mouseupAdds = docAddSpy.filter((e) => e.type === 'mouseup').length
  const mousemoveAdds = docAddSpy.filter((e) => e.type === 'mousemove').length
  eq(keydownAdds, 1, 'keydown 整个会话只绑定一次')
  eq(mouseupAdds, 1, 'mouseup 整个会话只绑定一次')
  eq(mousemoveAdds, 1, 'mousemove 整个会话只绑定一次')

  // ========== 用例 7：拖动松手 + 补发 click 只跳转一次 ==========
  console.log('\n[7] 拖动松手只触发一次跳转')
  vm.gotoPlay()
  await flush()
  const circle = document.getElementById('circle')
  circle.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
  assert(vm.drag === 1, 'mousedown 进入拖动态并暂停')
  assert(vm.paused === true, '拖动时视频暂停')
  document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }))
  assert(vm.drag === 0, 'mouseup 退出拖动态')
  const indexAfterDrop = vm.playIndex
  // 模拟浏览器在 bar 上补发的 click
  document.querySelector('.bar').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  eq(vm.playIndex, indexAfterDrop, '补发 click 不会造成二次跳转')

  // ========== 用例 8：关闭/Esc 彻底释放，且幂等 ==========
  console.log('\n[8] 关闭与资源释放')
  const keydownHandler = vm.keydown
  const mouseupHandler = vm.mouseup
  const mousemoveHandler = vm.mousemove
  const clickHandler = vm.changeVideoState
  vm.setFree = () => { vm._freed = true }
  vm.close()
  assert(vm.destroyed === true, 'close 后标记已销毁')
  assert(vm._freed === true, '关闭时释放单例占位（可再次打开）')
  assert(vm.videoObj === null, '当前视频对象已释放')
  assert(vm.preloadVideoObj === null, '预加载对象已释放')
  const removedTypes = docRemoveSpy.map((e) => e.type)
  assert(removedTypes.includes('keydown'), 'keydown 监听已移除')
  assert(removedTypes.includes('mouseup'), 'mouseup 监听已移除')
  assert(removedTypes.includes('mousemove'), 'mousemove 监听已移除')
  assert(
    docRemoveSpy.some((e) => e.type === 'keydown' && e.fn === keydownHandler) &&
      docRemoveSpy.some((e) => e.type === 'mouseup' && e.fn === mouseupHandler) &&
      docRemoveSpy.some((e) => e.type === 'mousemove' && e.fn === mousemoveHandler),
    '移除的就是绑定的同一批函数引用'
  )
  assert((canvas._listeners.click || []).indexOf(clickHandler) === -1, '画布点击监听已移除')

  // 关闭后残留异步事件回调不再操作状态
  const indexBefore = vm.playIndex
  mainVideo.tickTime(99)
  mainVideo.dispatch('ended')
  eq(vm.playIndex, indexBefore, '销毁后残留 timeupdate/ended 回调全部失效')

  // 幂等：Esc 与按钮同时触发不抛错
  let threw = false
  try {
    vm.close()
    vm.keydown({ keyCode: 27 })
  } catch (e) {
    threw = true
  }
  assert(!threw, '重复关闭/Esc 幂等不报错')

  // ========== 用例 9：关闭后再次打开，从第一段开始且无残留 ==========
  console.log('\n[9] 关闭后重新打开')
  // 模拟生产入口（index.js 的 seed 闸门）：旧会话 DOM 已随关闭移除，
  // 新会话是一次干净的重新挂载
  document.body.innerHTML = ''
  docAddSpy.length = 0
  docRemoveSpy.length = 0
  createdVideos.length = 0
  const vm2 = mountPlayer(sampleOptions)
  await flush()
  await flush()
  eq(vm2.playIndex, 0, '新会话从第一段开始')
  eq(vm2.playedTime, 0, '新会话累计进度归零')
  assert(vm2.destroyed === false, '新会话未被标记销毁')
  assert(vm2.endFlag === false, '新会话结束标记复位')
  assert(vm2.videoObj !== null && vm2.videoObj !== vm.videoObj, '新会话拥有独立视频对象')
  const v2keydown = docAddSpy.filter((e) => e.type === 'keydown').length
  eq(v2keydown, 1, '新会话重新绑定且只绑定一套监听')
  vm2.setFree = () => {}
  vm2.close()
  assert(vm2.destroyed === true, '新会话可正常关闭')

  console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
