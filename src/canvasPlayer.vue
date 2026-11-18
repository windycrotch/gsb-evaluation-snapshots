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
                :style="{ width: `${progressWidth()}%` }"
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
    <section v-show="paused" class="playContainer" @click="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script setup>
import { buildTimeline, locate, clampTime, toGlobalTime, toFiniteNumber } from './timeline'

export default {
  data() {
    return {
      list: [],
      // 时间线：segments（合法片段，含全局起止）与 totalTime
      timeline: { segments: [], totalTime: 0 },
      // new add ===
      playIndex: 0,
      RAFCancelReq: null,
      logo: '',
      // 当前播放对象
      videoObj: {},
      // 是否暂停
      paused: true,
      // 总时长（恒等于各合法片段 end-start 之和，不会为 NaN）
      totalTime: 0,
      // 当前全局播放时长
      playedTime: 0,
      // 缓存上一次 timeupdate 的视频 currentTime，用于累加全局时间
      cacheCurrentTime: 0,
      endFlag: false,
      // 动态增减
      activeLength: 0,
      // 是否展示进度条
      showDom: false,
      // 是否正在拖动进度条
      drag: 0,
      // 事件是否已绑定（避免重复绑定）
      eventBound: false,
      // 片段切换保护：同一边界只允许触发一次 playNext/finishPlay
      switching: false,
    }
  },
  beforeDestroy() {
    this.setFree()
    console.log('desotory')
    document.removeEventListener('keydown', this.keydown)
    document.removeEventListener('mousemove', this.mouseover)
    document.removeEventListener('mouseup', this.mouseup)
    const canvas = document.querySelector('#AutoCanvasId')
    if (canvas) {
      canvas.removeEventListener('click', this.changeVideoState)
    }
  },
  mounted() {
    let _self = this
    this.init()
    _self.comTotalTime()
    document.addEventListener('keydown', _self.keydown)
    document.addEventListener('mousemove', _self.mouseover)
    document.addEventListener('mouseup', _self.mouseup)
    _self.$nextTick(() => {
      _self.gotoPlay()
    })
  },

  methods: {
    initDrop2() {
      let _self = this
      if (_self.eventBound) {
        return
      }
      _self.eventBound = true
      _self.drag = 0
      let dropBtn = document.querySelector('#circle')
      //进度按钮被点击
      dropBtn.addEventListener('mousedown', function() {
        _self.drag = 1
        if (_self.videoObj && !_self.videoObj.paused) {
          _self.videoObj.pause()
          _self.paused = true
        }
      })
      // 点击画布切换播放/暂停
      document.querySelector('#AutoCanvasId').addEventListener('click', _self.changeVideoState)
    },
    // 进度条宽度百分比，总时长为 0 时避免除出 NaN/Infinity
    progressWidth() {
      if (!this.totalTime || !Number.isFinite(this.totalTime) || this.totalTime <= 0) {
        return 0
      }
      const t = clampTime(this.timeline, this.playedTime)
      return (t / this.totalTime) * 100
    },
    // 由指针在进度条上的位置换算全局时间（基于 bar 自身的包围盒，不再误用 offsetX）
    timeFromPointer(clientX) {
      let bar = document.querySelector('.bar')
      if (!bar || !bar.offsetWidth) {
        return 0
      }
      let rect = bar.getBoundingClientRect()
      let x = clientX - rect.left
      if (x < 0) {
        x = 0
      } else if (x > rect.width) {
        x = rect.width
      }
      return (x / rect.width) * this.totalTime
    },
    setValue(touch) {
      let _self = this
      // 拖动实时改变全局时间（先夹取，保证不越界、不为 NaN）
      _self.playedTime = clampTime(_self.timeline, _self.timeFromPointer(touch.clientX))
    },
    mouseup() {
      let _self = this
      if (_self.drag === 1) {
        _self.skipProgress()
      }
      _self.drag = 0
    },
    mouseover(e) {
      let _self = this
      if (_self.drag === 1) {
        _self.setValue(e)
      }
    },
    // 拖动结束 / 点击进度条后的统一跳转：
    // 由全局时间定位片段下标与片段内偏移，三者始终一致
    skipProgress() {
      let _self = this
      if (!_self.timeline.segments.length) {
        return
      }
      const target = clampTime(_self.timeline, _self.playedTime)
      _self.playedTime = target
      const loc = locate(_self.timeline, target)

      if (loc.ended) {
        // 拖到总时长末端：视为最后一片段结束，停在末尾
        _self.endFlag = true
        _self.paused = true
        _self.playIndex = _self.timeline.segments.length
        if (_self.videoObj && !_self.videoObj.paused) {
          _self.videoObj.pause()
        }
        return
      }

      _self.endFlag = false
      _self.playIndex = loc.index
      // 从该片段 start 加上片段内已过时间处开始播放
      _self.VideoPlay(loc.offset)
    },
    // 点击快进跳转
    skipLine(e) {
      let _self = this
      _self.playedTime = clampTime(_self.timeline, _self.timeFromPointer(e.clientX))
      _self.skipProgress()
    },
    init() {
      this.RAF()
      this.playedTime = 0
    },
    resetVideo() {
      if (this.videoObj && !this.videoObj.paused) {
        this.videoObj.pause()
        this.paused = true
        this.playIndex = 0
      }
    },
    RAF(cb) {
      return window.requestAnimationFrame(() => {
        window.setTimeout(cb, 1000 / 60)
      })
    },
    // 计算总时长：非法区间在 buildTimeline 内被丢弃，总时长恒为各合法片段时长之和
    comTotalTime() {
      this.timeline = buildTimeline(this.list)
      this.totalTime = this.timeline.totalTime
    },
    close() {
      let _self = this
      try {
        if (typeof _self.onClose === 'function') {
          _self.onClose(_self)
        }
        setTimeout(() => {
          _self.$destroy(true)
          _self.$el.parentNode.removeChild(_self.$el)
        }, 200)
      } catch (e) {
        console.log(e)
      }
    },
    keydown(e) {
      let _self = this
      if (e.keyCode === 27) {
        // esc关闭消息
        _self.close()
      }
    },
    // add 播放器核心方法
    async gotoPlay() {
      let _self = this
      _self.switching = false
      _self.playIndex = 0
      _self.playedTime = 0
      _self.paused = false
      _self.endFlag = false
      _self.VideoPlay(0)
    },
    // 截获当前视频播放器
    updateCurrentVideo(videoObj) {
      this.videoObj = videoObj
    },
    // 播放 || 暂停
    changeVideoState() {
      // 全部播完后再次播放：从头开始
      if (this.endFlag || this.playIndex >= this.timeline.segments.length) {
        this.gotoPlay()
        return
      }
      if (!this.videoObj || !this.videoObj.play) {
        return
      }
      if (this.videoObj.paused) {
        // 恢复播放：不重建视频、不重新 seek，片段内位置保持不变
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
    // 核心启动逻辑：shortSliceTime 为片段内偏移（秒）
    async VideoPlay(shortSliceTime = 0) {
      let _self = this
      const segments = _self.timeline.segments
      if (_self.playIndex < 0 || _self.playIndex >= segments.length) {
        return
      }
      // 新片段开始，解除切换保护
      _self.switching = false
      // console.log("_self.playIndex: " + _self.playIndex);
      // 准备工作start
      let elDom = document.querySelector('#VideoDom')
      let canvasDom = document.querySelector('#canvasDom')
      // 一、解析当前视频的各个参数 视频信息：1.当前播放路径、2.播放开始时间、3.播放结束时间、4.下部视频下标
      let segment = segments[_self.playIndex]
      let currentVideo = segment.item
      let currentUrl = currentVideo.url
      // 从该片段 start 加上片段内已过时间处开始播放
      let currentStartTime = segment.start + toFiniteNumber(shortSliceTime, 0)
      let currentEndTime = segment.end
      // logo信息
      let currentLogoInfo = {
        logo: _self.logo,
        position: currentVideo.logoPosition,
        videoWidth: currentVideo.width,
      }
      let nextIndex = _self.playIndex + 1
      // 当前视频 配置end

      //创建
      // 创建当前视频的Dom节点
      let videoObj = await _self.createVideo(elDom, 'AutoVideoId')
      // 创建canvas的Dom节点
      let CanvasEle = await _self.createCanvas(canvasDom, 'AutoCanvasId') //document.getElementById('AutoCanvasId')
      let context = CanvasEle.getContext('2d')

      videoObj.src = currentUrl
      // 更新视频对象
      _self.updateCurrentVideo(videoObj)
      // 全局时间与片段内偏移保持一致（跳转时 playedTime 已先定位，这里再校正一次）
      _self.playedTime = clampTime(
        _self.timeline,
        toGlobalTime(_self.timeline, _self.playIndex, shortSliceTime)
      )
      //视频源改变时，指定开始播放时间
      videoObj.ondurationchange = function() {
        // console.log("ondurationchange");
        videoObj.currentTime = currentStartTime
        _self.cacheCurrentTime = currentStartTime
      }
      //重新定位播放位置
      videoObj.onseeked = function() {
        // console.log("onseeked");
        _self.cacheCurrentTime = videoObj.currentTime
        _self.paused = false
        _self.videoObj.volume = 1
        let playPromise = _self.videoObj.play()

        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              _self.initDrop2()
            })
            .catch((error) => {
              console.log('sorry! 视频初始化失败', error)
            })
        }
      }
      //播放位置改变：以视频 currentTime 的增量推进全局时间，暂停期间不产生增量
      videoObj.ontimeupdate = function() {
        let delta = videoObj.currentTime - _self.cacheCurrentTime
        // 过滤 seek/重置造成的回跳与脏值，保证全局时间不被污染、不出现 NaN
        if (Number.isFinite(delta) && delta >= 0 && Number.isFinite(_self.playedTime)) {
          _self.playedTime = clampTime(_self.timeline, _self.playedTime + delta)
        }
        _self.cacheCurrentTime = videoObj.currentTime
        // 半开区间：到达片段 end 即切下一片段（分界点进入后一片段）
        if (videoObj.currentTime >= currentEndTime && !_self.switching) {
          _self.playNext(videoObj)
        }
      }
      // 兜底：源视频本身播完时若 timeupdate 未及时触发，也确保进入结束/下一片段流程
      videoObj.onended = function() {
        if (_self.switching) {
          return
        }
        if (_self.playIndex < segments.length - 1) {
          _self.playNext(videoObj)
        } else {
          _self.finishPlay()
        }
      }

      //开始播放
      videoObj.onplay = function() {
        // console.log("onplay");
        CanvasEle.width = videoObj.width
        CanvasEle.height = videoObj.height
        _self.RAFCancelReq = _self.RAF(drawData)
        // 创建logo
        _self.createAndPutLogo(canvasDom, 'logoId', currentLogoInfo)
        // 展示进度条
        _self.showDom = true
      }

      // 二、是否有下一视频：有则预加载并定位到其 start，没有则不创建无效节点
      let nextSegment = segments[nextIndex]
      if (nextSegment) {
        let nextVideoObj = await _self.createVideo(elDom, 'preLoadVideoId', true)
        nextVideoObj.src = nextSegment.item.url
        //视频源改变时，指定开始播放时间
        nextVideoObj.ondurationchange = function() {
          nextVideoObj.currentTime = nextSegment.start
        }
      }

      //取消轮询
      let cancelAnimationFrame = function(flag) {
        window.cancelAnimationFrame(flag)
      }

      function drawData() {
        if (
          videoObj.ended ||
          videoObj.paused ||
          videoObj.currentTime < currentStartTime ||
          videoObj.currentTime >= currentEndTime
        ) {
          // console.log("videoObj.paused", videoObj.paused);
          cancelAnimationFrame(_self.RAFCancelReq)
          videoObj.pause()
          return
        }
        context.drawImage(videoObj, 0, 0, videoObj.width, videoObj.height)
        _self.RAF(drawData)
      }
    },
    // 创建并摆放logo
    createAndPutLogo(parentDom, domId, logoInfo) {
      this.$nextTick(() => {
        let canvasDom = document.querySelector('#AutoCanvasId')
        parentDom = parentDom || document.body
        let obj = document.getElementById(domId)
        if (!obj) {
          obj = document.createElement('img')
          obj.id = domId
          parentDom.appendChild(obj)
        }
        obj.style = {}
        obj.style.display = 'none'
        obj.style.width = `${(canvasDom.width * 150) / 1080}px`
        obj.style.position = 'absolute'
        obj.style[logoInfo.position.x] = `${(canvasDom.width / 1080) * 60}px`
        obj.style[logoInfo.position.y] = `${(canvasDom.width / 1080) * 60}px`
        obj.src = logoInfo.logo
        this.$nextTick(() => {
          obj.style.display = 'block'
        }, 10000)
      })
    },
    //根据父容器大小设置视频尺寸
    setVideoStyle(vObj) {
      let parentWidth = vObj.parentNode.getBoundingClientRect().width
      let parentHeight = vObj.parentNode.getBoundingClientRect().height
      //根据父容器宽高计算 视频缩放比例
      let scaleVal = Math.max(vObj.videoWidth / parentWidth, vObj.videoHeight / parentHeight)
      let scaleWidth = vObj.videoWidth / scaleVal
      let scaleHeight = vObj.videoHeight / scaleVal
      vObj.width = scaleWidth
      vObj.height = scaleHeight
    },

    //创建视频对象
    createVideo(parentDom, domId, isMuted = false) {
      let _self = this
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
        //设置视频属性
        obj.preload = 'auto'
        obj.style = 'background:#000000;display:none;position:absolute;left:100%;top:0;'
        obj.autoplay = ''
        obj.style.left = videoSize * 100 + '%'
        obj.controls = true
        obj.muted = isMuted
        obj.volume = 0.1
        //视频加载meta信息后，把自身尺寸修改了
        obj.onloadedmetadata = function() {
          // console.log('onloadedmetadata')
          _self.setVideoStyle(obj)
        }
      }
      return obj
    },
    //创建 Canvas对象
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
      }
      return Obj
    },

    // 全部片段播完：停在总时长末端，等待再次播放时从头开始
    finishPlay() {
      let _self = this
      _self.switching = true
      _self.playedTime = clampTime(_self.timeline, _self.totalTime)
      _self.playIndex = _self.timeline.segments.length
      _self.paused = true
      _self.endFlag = true
    },
    // 播放下一曲
    playNext(curVideo) {
      let _self = this
      if (_self.switching) {
        return
      }
      _self.switching = true
      if (curVideo) {
        curVideo.pause()
      }
      // 全局时间对齐到累计边界，保证分界点精确、不累积浮点误差
      const nextIndex = _self.playIndex + 1
      if (nextIndex >= _self.timeline.segments.length) {
        _self.finishPlay()
        return
      }
      const nextSeg = _self.timeline.segments[nextIndex]
      _self.playedTime = clampTime(_self.timeline, nextSeg.globalStart)
      _self.playIndex = nextIndex
      _self.endFlag = false
      // 后一片段从其 start（片段内偏移 0）开始
      _self.VideoPlay(0)
    },
    sToHs(s) {
      // 脏值兜底，避免展示 NaN
      let num = Number.parseFloat(s)
      if (!Number.isFinite(num) || num < 0) {
        num = 0
      }
      //计算分钟
      //算法：将秒数除以60，然后下舍入，既得到分钟数
      num = num.toFixed(0)
      var h
      h = Math.floor(num / 60)
      //计算秒
      //算法：取得秒%60的余数，既得到秒数
      num = num % 60
      //将变量转换为字符串
      h += ''
      num += ''
      //如果只有一位数，前面增加一个0
      h = h.length == 1 ? '0' + h : h
      num = num.length == 1 ? '0' + num : num
      return h + ':' + num
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
