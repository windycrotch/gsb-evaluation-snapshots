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
                  d="M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.666667,32.3333333 95,25 L75.5,6 L49,33"
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
    <section v-show="paused" class="playContainer" @click="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script>
import { createMashupPlayer } from './playerCore'

export default {
  data() {
    return {
      list: [],
      logo: '',
      // 当前片段下标（由核心回同步）
      playIndex: 0,
      // 是否暂停
      paused: true,
      // 总时长
      totalTime: 0,
      // 当前播放时长（总时间轴）
      playedTime: 0,
      // 是否全部播完
      endFlag: false,
      // 是否展示进度条
      showDom: false,
      // 是否正在拖动进度条
      drag: 0,
    }
  },
  mounted() {
    this.setupCore()
    // 进度条圆点按下 → 进入拖动态（元素由 v-show 控制，始终存在，只绑一次）
    const circle = this.$el && this.$el.querySelector('#circle')
    if (circle) circle.addEventListener('mousedown', this.onDragStart)
    this.init()
  },
  beforeDestroy() {
    this.teardownCore()
    if (typeof this.setFree === 'function') this.setFree()
  },

  methods: {
    // 由 index.js 在挂载后调用；幂等，重复调用不会重复启动
    init() {
      if (this._core) this._core.start()
    },
    setupCore() {
      const self = this
      const segments = (this.list || []).map((item) => ({
        url: item.url,
        start: parseFloat(item.playPoint.start),
        end: parseFloat(item.playPoint.end),
        raw: item,
      }))
      this._core = createMashupPlayer({
        segments,
        documentRef: document,
        // 画布按需创建；节点被移除时返回 null，核心会跳过绘制但不中断
        getCanvas() {
          return self.ensureCanvas()
        },
        createVideo(segRaw, isPreload) {
          return self.ensureVideo(isPreload)
        },
        requestFrame: (cb) => window.requestAnimationFrame(cb),
        cancelFrame: (h) => window.cancelAnimationFrame(h),
        onState(s) {
          self.applyState(s)
        },
        onRequestClose() {
          self.close()
        },
        onMouseMove(e) {
          self.onDragMove(e)
        },
        onMouseUp() {
          self.onDragEnd()
        },
      })
    },
    teardownCore() {
      if (this._core) {
        this._core.dispose()
        this._core = null
      }
    },
    // 核心状态 → 视图
    applyState(s) {
      const indexChanged = s.playIndex !== this.playIndex
      this.playedTime = s.playedTime
      this.totalTime = s.totalTime
      this.paused = s.paused
      this.endFlag = s.ended
      this.playIndex = s.playIndex
      if (!this.showDom) this.showDom = true
      if (indexChanged || !this._canvasSized) {
        this.syncCanvasSize()
        this.updateLogo()
      }
    },
    ensureCanvas() {
      let canvas = document.getElementById('AutoCanvasId')
      if (!canvas) {
        const parent = document.getElementById('canvasDom')
        if (!parent) return null
        canvas = document.createElement('canvas')
        canvas.id = 'AutoCanvasId'
        canvas.addEventListener('click', this.changeVideoState)
        parent.appendChild(canvas)
      }
      return canvas
    },
    ensureVideo(isPreload) {
      const parent = document.getElementById('VideoDom') || this.$el || document.body
      const id = isPreload ? 'preLoadVideoId' : 'AutoVideoId'
      let v = document.getElementById(id)
      if (!v) {
        v = document.createElement('video')
        v.id = id
        v.preload = 'auto'
        v.style.cssText = 'background:#000;display:none;position:absolute;left:100%;top:0;'
        parent.appendChild(v)
      }
      v.muted = !!isPreload
      return v
    },
    syncCanvasSize() {
      const canvas = document.getElementById('AutoCanvasId')
      const item = this.list[this.playIndex]
      if (canvas && item && item.width && item.height) {
        canvas.width = item.width
        canvas.height = item.height
        this._canvasSized = true
      }
    },
    // 创建并摆放logo
    updateLogo() {
      this.$nextTick(() => {
        const canvasDom = document.getElementById('canvasDom')
        const canvas = document.getElementById('AutoCanvasId')
        const item = this.list[this.playIndex]
        if (!canvasDom || !canvas || !item) return
        let obj = document.getElementById('logoId')
        if (!obj) {
          obj = document.createElement('img')
          obj.id = 'logoId'
          canvasDom.appendChild(obj)
        }
        const pos = item.logoPosition || { x: 'left', y: 'top' }
        obj.style.position = 'absolute'
        obj.style.width = `${(canvas.width * 150) / 1080}px`
        obj.style[pos.x] = `${(canvas.width / 1080) * 60}px`
        obj.style[pos.y] = `${(canvas.width / 1080) * 60}px`
        obj.src = this.logo
      })
    },
    // ---- 进度条：点击跳转 ----
    skipLine(e) {
      const bar = e.currentTarget
      if (!bar || !this.totalTime) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      const t = ratio * this.totalTime
      this.playedTime = t
      if (this._core) this._core.seekTo(t)
    },
    // ---- 进度条：拖动 ----
    onDragStart() {
      this.drag = 1
      if (this._core) this._core.pause()
    },
    onDragMove(e) {
      if (this.drag !== 1) return
      const bar = this.$el && this.$el.querySelector('.bar')
      if (!bar || !this.totalTime) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      // 拖动中只更新预览时间，松手时才真正 seek
      this.playedTime = ratio * this.totalTime
    },
    onDragEnd() {
      if (this.drag !== 1) return
      this.drag = 0
      if (this._core) this._core.seekTo(this.playedTime)
    },
    // 播放 || 暂停
    changeVideoState() {
      if (this._core) this._core.toggle()
    },
    // 静音
    changeVoiceStatus() {
      if (this._core) this._core.toggleMute()
    },
    // 关闭弹层：先清理播放器资源，再销毁组件
    close() {
      if (this._closed) return
      this._closed = true
      try {
        if (typeof this.onClose === 'function') this.onClose(this)
      } catch (e) {
        console.log(e)
      }
      this.teardownCore()
      setTimeout(() => {
        try {
          this.$destroy(true)
          if (this.$el && this.$el.parentNode) {
            this.$el.parentNode.removeChild(this.$el)
          }
        } catch (e) {
          console.log(e)
        }
      }, 200)
    },
    sToHs(s) {
      //计算分钟
      //算法：将秒数除以60，然后下舍入，既得到分钟数
      s = parseFloat(s).toFixed(0)
      var h
      h = Math.floor(s / 60)
      //计算秒
      //算法：取得秒%60的余数，既得到秒数
      s = s % 60
      //将变量转换为字符串
      h += ''
      s += ''
      //如果只有一位数，前面增加一个0
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
