<template>
  <div class="popup-layer">
    <div class="video-player-wrapper">
      <div id="VideoDom">
        <div id="canvasDom">
          <div v-show="showDom" id="progressBar" :class="[paused ? 'show' : '']">
            <div class="bar" @click="skipLine">
              <div
                ref="trunk"
                class="line"
                :class="['progress', paused ? 'pause' : 'play', !drag ? 'trans' : '']"
                :style="{ width: `${(playedTime / totalTime) * 100}%` }"
              ></div>
              <div id="circle" :class="{ trans: !drag }"></div>
            </div>

            <div class="left-box">
              <div href="#" class="btn">
                <button
                  class="play"
                  :class="[paused ? 'play' : 'pause']"
                  @click="changeVideoState"
                ></button>
              </div>
              <div class="total-time">{{ sToHs(playedTime) }} / {{ sToHs(totalTime) }}</div>
            </div>
            <div class="volume">
              <input type="checkbox" @click="changeVoiceStatus" />
              <svg viewBox="0 0 108 96">
                <path
                  d="M7,28 L35,28 L35,28 L59,8 L59,88 L35,68 L7,68 C4.790861,68 3,66.209139 3,64 L3,32 C3,29.790861 4.790861,28 7,28 Z"
                ></path>
                <path
                  d="M79,62 C83,57.3333333 85,52.6666667 85,48 C85,43.3333333 83,38.6666667 79,34 L49,3"
                ></path>
                <path
                  d="M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.6666667,32.3333333 95,25 L75.5,6 L49,33"
                ></path>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
    <i class="popup-layer-btn-close" @click="close">x</i>
    <div v-show="!showDom" class="loadEffect">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <section v-show="paused" class="playContainer" @click.prevent="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script>
export default {
  name: 'CanvasVideoPlayer',
  data() {
    return {
      list: [],
      playerlist: [],
      // 当前片段索引（一次会话内与 videoObj / 绘制循环始终指向同一段）
      playIndex: 0,
      logo: '',
      videoList: [],
      // 当前播放的视频对象
      videoObj: null,
      // 预加载视频对象
      preloadVideoObj: null,
      // 是否暂停
      paused: true,
      // 全部片段累计总时长
      totalTime: 0,
      // 累计已播放时长（进度条显示值）
      playedTime: 0,
      // 是否已播放到结尾
      endFlag: false,
      // 各片段累计结束时间节点，用于进度条快速定位
      skipDict: [],
      // 是否展示进度条
      showDom: false,
      // 是否正在拖动进度条
      drag: 0,
      // 拖动松手后浏览器会补发一次 click，用该标记吞掉，避免同一次操作跳转两次
      justDragged: false,
      // ===== 会话级运行时状态（不参与视图渲染）=====
      // 当前绘制循环的 requestAnimationFrame 句柄
      rafId: null,
      // 绘制循环是否运行中（同一时刻只允许一个绘制循环）
      drawRunning: false,
      // 片段会话代号：每次切换片段自增，旧片段残留的异步事件回调据此失效
      sessionGen: 0,
      // 同一结束窗口内只允许推进一次索引
      isSwitching: false,
      // 播放器是否已销毁（销毁后所有异步回调直接退场）
      destroyed: false,
      // document / DOM 级监听整个会话只绑定一次
      listenersBound: false,
      // 当前片段在累计时间轴上的起点时间
      segmentStart: 0,
    }
  },
  beforeDestroy() {
    this.teardown()
  },
  mounted() {
    this.playerlist = this.list.map((item) => {
      return {
        start: parseFloat(item.playPoint.start),
        end: parseFloat(item.playPoint.end),
      }
    })
    this.videoList = this.list
    this.comTotalTime()
    this.playedTime = 0
    this.bindGlobalListeners()
    this.$nextTick(() => {
      this.gotoPlay()
    })
  },
  methods: {
    // 外部入口（index.js 也会调用），仅做进度复位
    init() {
      this.playedTime = 0
    },
    // 计算总时长与各片段累计时间节点
    comTotalTime() {
      let totalTime = 0
      this.skipDict = this.playerlist.map((item) => {
        totalTime += item.end - item.start
        return totalTime
      })
      this.totalTime = totalTime
    },
    // 整个播放会话只绑定一次全局监听，引用固定，销毁时可精确移除
    bindGlobalListeners() {
      if (this.listenersBound) return
      this.listenersBound = true
      document.addEventListener('keydown', this.keydown)
      document.addEventListener('mousemove', this.mousemove)
      document.addEventListener('mouseup', this.mouseup)
      this.$nextTick(() => {
        if (this.destroyed) return
        const circle = document.querySelector('#circle')
        if (circle) circle.addEventListener('mousedown', this.onCircleMouseDown)
      })
    },
    onCircleMouseDown() {
      this.drag = 1
      this.justDragged = false
      if (this.videoObj && !this.videoObj.paused) {
        this.videoObj.pause()
        this.paused = true
      }
    },
    mousemove(e) {
      if (this.drag === 1) {
        this.setValue(e)
      }
    },
    mouseup() {
      if (this.drag === 1) {
        // 松手后浏览器会在进度条上补发一次 click，标记后由 skipLine 吞掉
        this.justDragged = true
        this.skipProgress()
      }
      this.drag = 0
    },
    // 拖动过程中实时刷新进度条时间（不改播放状态，松手时才跳转）
    setValue(touch) {
      const bar = document.querySelector('.bar')
      if (!bar || !this.totalTime) return
      const rect = bar.getBoundingClientRect()
      let oLeft = touch.clientX - rect.left
      oLeft = Math.max(0, Math.min(oLeft, rect.width))
      this.playedTime = (oLeft / rect.width) * this.totalTime
    },
    // 点击进度条跳转
    skipLine(e) {
      // 拖动松手补发的 click：跳过，同一次拖动只做一次跳转
      if (this.justDragged) {
        this.justDragged = false
        return
      }
      const bar = document.querySelector('.bar')
      if (!bar || !this.totalTime) return
      const rect = bar.getBoundingClientRect()
      let oLeft = e.clientX - rect.left
      oLeft = Math.max(0, Math.min(oLeft, rect.width))
      this.playedTime = (oLeft / rect.width) * this.totalTime
      this.skipProgress()
    },
    // 拖动松手 / 点击后的统一跳转：累计时间 -> 正确片段 + 片段内偏移
    skipProgress() {
      if (this.destroyed || !this.videoList.length || !this.totalTime) return
      const target = Math.max(0, Math.min(this.playedTime, this.totalTime))
      // 落在总时长末尾：进入结束态，不允许越界索引
      if (target >= this.totalTime - 0.001) {
        this.enterEndState()
        return
      }
      // 找到 target 所在片段：第一个累计节点大于 target 的片段
      let curIndex = this.skipDict.length - 1
      for (let i = 0; i < this.skipDict.length; i++) {
        if (target < this.skipDict[i]) {
          curIndex = i
          break
        }
      }
      const segStart = curIndex === 0 ? 0 : this.skipDict[curIndex - 1]
      const segDuration = this.playerlist[curIndex].end - this.playerlist[curIndex].start
      // 偏移钳制：不允许负偏移，也不允许超出本片段时长
      let offset = Math.max(0, Math.min(target - segStart, segDuration - 0.001))
      this.playedTime = segStart + offset
      this.endFlag = false
      this.isSwitching = false
      this.playIndex = curIndex
      this.VideoPlay(offset)
    },
    keydown(e) {
      if (e.keyCode === 27) {
        // Esc 关闭
        this.close()
      }
    },
    // 从第一段重新开始一次播放
    gotoPlay() {
      if (this.destroyed || !this.videoList.length) return
      this.playIndex = 0
      this.playedTime = 0
      this.paused = false
      this.endFlag = false
      this.isSwitching = false
      this.VideoPlay(0)
    },
    // 截获当前视频播放器
    updateCurrentVideo(videoObj) {
      this.videoObj = videoObj
    },
    // 播放 || 暂停：单次点击只切换一次状态
    changeVideoState() {
      if (this.destroyed || this.isSwitching) return
      if (this.endFlag || !this.videoObj) {
        // 结束态点击：从第一段重新播放
        this.gotoPlay()
        return
      }
      if (this.videoObj.paused) {
        this.videoObj.play()
        this.paused = false
      } else {
        this.videoObj.pause()
        this.paused = true
      }
    },
    // 静音
    changeVoiceStatus() {
      if (this.videoObj) {
        this.videoObj.muted = !this.videoObj.muted
      }
    },
    // 核心启动逻辑：加载并播放 playIndex 指向的片段，shortSliceTime 为片段内偏移
    VideoPlay(shortSliceTime = 0) {
      if (this.destroyed) return
      if (this.playIndex < 0 || this.playIndex >= this.videoList.length) return
      // 新片段会话：代号自增，上一片段残留的 timeupdate / onseeked / 绘制循环全部失效
      const gen = ++this.sessionGen
      this.isSwitching = false
      // 停掉上一片段的绘制循环，保证同一时刻只有一个绘制循环
      this.stopDrawLoop()

      const elDom = document.querySelector('#VideoDom')
      const canvasDom = document.querySelector('#canvasDom')

      // 一、解析当前片段参数
      const currentVideo = this.videoList[this.playIndex]
      const currentUrl = currentVideo.url
      const baseStartTime = parseFloat(currentVideo.playPoint.start)
      const currentStartTime = baseStartTime + shortSliceTime
      const currentEndTime = parseFloat(currentVideo.playPoint.end)
      const currentLogoInfo = {
        logo: this.logo,
        position: currentVideo.logoPosition,
        videoWidth: currentVideo.width,
      }
      // 当前片段在累计时间轴上的起点，与 playIndex 同步写入
      this.segmentStart = this.playIndex === 0 ? 0 : this.skipDict[this.playIndex - 1]

      // 二、下一片段（用于预加载），没有下一 片段时记为 -1
      const nextIndex = this.playIndex + 1 < this.videoList.length ? this.playIndex + 1 : -1

      // 三、复用或创建视频 / canvas 对象（固定角色，源被替换；旧对象先停止再复用）
      const videoObj = this.createVideo(elDom, 'AutoVideoId', false)
      const nextVideoObj = this.createVideo(elDom, 'preLoadVideoId', true)
      const CanvasEle = this.createCanvas(canvasDom, 'AutoCanvasId')
      const context = CanvasEle.getContext('2d')

      // 清掉两个视频元素上一次会话残留的事件与播放状态
      this.clearVideoHandlers(videoObj)
      this.clearVideoHandlers(nextVideoObj)
      try {
        nextVideoObj.pause()
      } catch (e) {
        /* noop */
      }

      this.updateCurrentVideo(videoObj)
      videoObj.src = currentUrl

      // 视频源改变时，定位到片段起点（含跳转偏移）
      videoObj.ondurationchange = () => {
        if (gen !== this.sessionGen || this.destroyed) return
        videoObj.currentTime = currentStartTime
      }
      // 重新定位完成后继续播放
      videoObj.onseeked = () => {
        if (gen !== this.sessionGen || this.destroyed) return
        videoObj.volume = 1
        const playPromise = videoObj.play()
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((error) => {
            console.log('sorry! 视频初始化失败', error)
          })
        }
      }
      // 播放位置改变：累计进度直接由视频原始时间推导，显示与实际视频时间一致
      videoObj.ontimeupdate = () => {
        if (gen !== this.sessionGen || this.destroyed) return
        if (videoObj.seeking) return
        // 累计进度直接由视频原始时间推导；钳制在本片段起点与总时长之间
        const rawProgress = this.segmentStart + (videoObj.currentTime - baseStartTime)
        this.playedTime = Math.max(this.segmentStart, Math.min(this.totalTime, rawProgress))
        if (videoObj.currentTime >= currentEndTime) {
          // 自然结束：playNext 内部有开关保护，同一结束窗口不会重复跳段
          this.playNext()
        }
      }
      videoObj.onplay = () => {
        if (gen !== this.sessionGen || this.destroyed) return
        this.paused = false
        // 画布尺寸跟随当前片段配置
        CanvasEle.width = videoObj.videoWidth || currentVideo.width
        CanvasEle.height = videoObj.videoHeight || currentVideo.height
        // logo 跟随当前片段配置
        this.createAndPutLogo(canvasDom, 'logoId', currentLogoInfo)
        this.showDom = true
        this.startDrawLoop(gen, videoObj, context, CanvasEle, currentStartTime, currentEndTime)
      }
      // 视频原生结束事件同样走带保护的推进逻辑
      videoObj.onended = () => {
        if (gen !== this.sessionGen || this.destroyed) return
        this.playNext()
      }

      // 四、预加载下一 片段：复用预加载对象并替换其源；没有下一 片段则释放
      this.preloadVideoObj = nextVideoObj
      if (nextIndex >= 0) {
        const nextVideo = this.videoList[nextIndex]
        nextVideoObj.src = nextVideo.url
        nextVideoObj.ondurationchange = () => {
          if (this.destroyed) return
          try {
            nextVideoObj.currentTime = parseFloat(nextVideo.playPoint.start)
          } catch (e) {
            /* noop */
          }
        }
      } else {
        this.clearVideoHandlers(nextVideoObj)
        nextVideoObj.removeAttribute('src')
        nextVideoObj.load()
      }
    },
    // 启动当前片段唯一的绘制循环
    startDrawLoop(gen, videoObj, context, CanvasEle, currentStartTime, currentEndTime) {
      this.stopDrawLoop()
      this.drawRunning = true
      const drawData = () => {
        // 会话已切换 / 播放器已销毁 / 循环被主动停止：立即退场，不再安排下一帧
        if (!this.drawRunning || this.destroyed || gen !== this.sessionGen) {
          return
        }
        if (videoObj.paused) {
          this.drawRunning = false
          this.rafId = null
          return
        }
        if (videoObj.ended || videoObj.currentTime >= currentEndTime) {
          this.drawRunning = false
          this.rafId = null
          this.playNext()
          return
        }
        if (videoObj.currentTime < currentStartTime) {
          // seek 过程中保持循环存活但不绘制，等待新画面
          this.rafId = window.requestAnimationFrame(drawData)
          return
        }
        context.drawImage(videoObj, 0, 0, CanvasEle.width, CanvasEle.height)
        this.rafId = window.requestAnimationFrame(drawData)
      }
      this.rafId = window.requestAnimationFrame(drawData)
    },
    stopDrawLoop() {
      this.drawRunning = false
      if (this.rafId !== null) {
        window.cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    },
    // 播放下一段：同一结束窗口只推进一次索引，重复触发不会跳过片段
    playNext() {
      if (this.destroyed || this.isSwitching) return
      if (this.playIndex >= this.videoList.length - 1) {
        this.enterEndState()
        return
      }
      this.isSwitching = true
      try {
        if (this.videoObj) this.videoObj.pause()
      } catch (e) {
        /* noop */
      }
      this.playIndex += 1
      this.VideoPlay(0)
    },
    // 进入结束态：停循环、停视频、索引停在末尾（点击后可从第一段重播）
    enterEndState() {
      this.stopDrawLoop()
      this.isSwitching = false
      this.endFlag = true
      this.paused = true
      this.playIndex = this.videoList.length
      this.playedTime = this.totalTime
      if (this.videoObj) {
        try {
          this.videoObj.pause()
        } catch (e) {
          /* noop */
        }
      }
    },
    // 创建并摆放 logo（每次切换片段时按新配置重排位置）
    createAndPutLogo(parentDom, domId, logoInfo) {
      this.$nextTick(() => {
        if (this.destroyed) return
        const canvasDom = document.querySelector('#AutoCanvasId')
        parentDom = parentDom || document.body
        let obj = document.getElementById(domId)
        if (!obj) {
          obj = document.createElement('img')
          obj.id = domId
          parentDom.appendChild(obj)
        }
        // 先清空上一片段残留的方位样式，避免两个方向的定位同时生效
        obj.style.position = 'absolute'
        obj.style.display = 'none'
        obj.style.left = ''
        obj.style.right = ''
        obj.style.top = ''
        obj.style.bottom = ''
        obj.style.width = `${(canvasDom.width * 150) / 1080}px`
        obj.style[logoInfo.position.x] = `${(canvasDom.width / 1080) * 60}px`
        obj.style[logoInfo.position.y] = `${(canvasDom.width / 1080) * 60}px`
        obj.src = logoInfo.logo
        this.$nextTick(() => {
          if (!this.destroyed) obj.style.display = 'block'
        })
      })
    },
    // 根据父容器大小设置视频尺寸
    setVideoStyle(vObj) {
      let parentWidth = vObj.parentNode.getBoundingClientRect().width
      let parentHeight = vObj.parentNode.getBoundingClientRect().height
      // 根据父容器宽高计算 视频缩放比例
      let scaleVal = Math.max(vObj.videoWidth / parentWidth, vObj.videoHeight / parentHeight)
      let scaleWidth = vObj.videoWidth / scaleVal
      let scaleHeight = vObj.videoHeight / scaleVal
      vObj.width = scaleWidth
      vObj.height = scaleHeight
    },
    // 创建视频对象（同 id 对象已存在时直接复用）
    createVideo(parentDom, domId, isMuted = false) {
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let obj = document.getElementById(domId)
      if (!obj) {
        obj = document.createElement('Video')
        obj.id = domId
        parentDom.appendChild(obj)
        let videoSize = parseInt(document.getElementsByTagName('video').length)
        // 设置视频属性
        obj.preload = 'auto'
        obj.style = 'background:#000000;display:none;position:absolute;left:100%;top:0;'
        obj.autoplay = ''
        obj.style.left = videoSize * 100 + '%'
        obj.controls = true
        obj.muted = isMuted
        obj.volume = 0.1
        // 视频加载 meta 信息后，把自身尺寸修改了
        obj.onloadedmetadata = () => {
          this.setVideoStyle(obj)
        }
      }
      return obj
    },
    // 创建 Canvas 对象（同 id 对象已存在时直接复用；画布点击监听只绑一次）
    createCanvas(parentDom, domId) {
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let Obj = document.getElementById(domId)
      if (!Obj) {
        Obj = document.createElement('Canvas')
        Obj.id = domId
        parentDom.appendChild(Obj)
        Obj.addEventListener('click', this.changeVideoState)
      }
      return Obj
    },
    clearVideoHandlers(v) {
      if (!v) return
      v.ondurationchange = null
      v.onseeked = null
      v.ontimeupdate = null
      v.onplay = null
      v.onended = null
      v.onseeking = null
      v.onpause = null
    },
    releaseVideo(v) {
      if (!v) return
      this.clearVideoHandlers(v)
      try {
        v.pause()
        v.removeAttribute('src')
        v.load()
      } catch (e) {
        /* noop */
      }
    },
    // 会话结束时的彻底释放：动画帧、定时器、键盘鼠标监听、画布点击监听、视频资源
    teardown() {
      if (this.destroyed) return
      this.destroyed = true
      this.stopDrawLoop()
      document.removeEventListener('keydown', this.keydown)
      document.removeEventListener('mousemove', this.mousemove)
      document.removeEventListener('mouseup', this.mouseup)
      const circle = document.querySelector('#circle')
      if (circle) circle.removeEventListener('mousedown', this.onCircleMouseDown)
      const canvas = document.querySelector('#AutoCanvasId')
      if (canvas) canvas.removeEventListener('click', this.changeVideoState)
      this.releaseVideo(document.getElementById('AutoVideoId'))
      this.releaseVideo(document.getElementById('preLoadVideoId'))
      this.videoObj = null
      this.preloadVideoObj = null
      // 通知入口（index.js）释放单例占位，允许再次打开
      if (typeof this.setFree === 'function') {
        this.setFree()
      }
    },
    close() {
      // 幂等：Esc 与关闭按钮同时触发、或重复点击只执行一次
      if (this.destroyed) return
      try {
        if (typeof this.onClose === 'function') {
          this.onClose(this)
        }
      } catch (e) {
        console.log(e)
      }
      try {
        this.$destroy()
        if (this.$el && this.$el.parentNode) {
          this.$el.parentNode.removeChild(this.$el)
        }
      } catch (e) {
        console.log(e)
      }
    },
    sToHs(s) {
      // 计算分钟
      s = parseFloat(s).toFixed(0)
      var h
      h = Math.floor(s / 60)
      // 计算秒
      s = s % 60
      // 将变量转换为字符串
      h += ''
      s += ''
      // 如果只有一位数，前面增加一个0
      h = h.length == 1 ? '0' + h : h
      s = s.length == 1 ? '0' + s : s
      return h + ':' + s
    },
  },
}
</script>
<style>
@import './style/style.css';
</style>
<style lang="less" scoped>
.popup-layer {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85);
  color: #fff;

  .video-player-wrapper {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .popup-layer-btn-close {
    position: absolute;
    right: 20px;
    top: 20px;
    width: 50px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    font-style: initial;
    font-size: 40px;
    line-height: 30px;
    cursor: pointer;
    padding: 6px 0 12px;
    border-radius: 100%;
    user-select: none;
    &:hover {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 1);
    }
  }
}

#VideoDom {
  position: relative;
  font-size: 0;
  line-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  #canvasDom {
    position: relative;
    #progressBar {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      bottom: 0;
      width: 100%;
      background: rgba(0, 0, 0, 0.521);
      z-index: 99;
      opacity: 0;
      transition: all 0.5s;
      .left-box {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 50%;
        .btn {
          height: 100%;
          color: #000;
          margin-right: 2px;
          background: transparent;
          border: none;
          button {
            margin: 10px;
            padding: 0;
            box-sizing: border-box;
            border: transparent;
            background: transparent;
            user-select: none;
            &.play {
              height: 20px;
              border-style: solid;
              outline: none;
              border-width: 10px 0 10px 18px;
              border-color: transparent transparent transparent #00a1d6;
              transition: all 0.1s linear;
            }
            &.pause {
              border-style: double;
              border-width: 0px 0px 0px 18px;
              border-color: #00a1d6;
            }
          }
        }
        .total-time {
          color: #e3e3e3;
          font-size: 15px;
          line-height: 100%;
          pointer-events: none;
          user-select: none;
        }
      }

      .bar {
        display: flex;
        align-items: center;
        margin: 10px auto 0;
        width: 98%;
        height: 7px;
        border-radius: 10px;
        background: #7171716e;
        transition: all 0.2s;
        cursor: pointer;
        .line {
          position: relative;
          width: 100%;
          height: 100%;
          background: #00a1d6;
          border-radius: 5px;
          animation-timing-function: linear;
          &.trans {
            transition: all 0.5s;
          }
          &.play {
            animation-play-state: running;
          }
          &.pause {
            animation-play-state: paused;
          }
        }
        #circle {
          position: relative;
          margin-left: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #fff;
          pointer-events: none;
          &.trans {
            pointer-events: auto;
            transition: all 0.5s;
          }
        }
      }

      &:hover {
        .bar {
          height: 13px;
          transition: all 0.2s;
          #circle {
            height: 14px;
            width: 14px;
          }
        }
      }
      &.show {
        opacity: 1;
      }
    }
    &:hover {
      #progressBar {
        opacity: 1;
        transition: all 1s;
      }
    }
  }
}
</style>
