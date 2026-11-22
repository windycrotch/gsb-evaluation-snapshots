# Canvas Video Player 🎬

![npm](https://img.shields.io/npm/v/canvas-video-player)
![license](https://img.shields.io/github/license/ledtwo/canvas-video-player)
![stars](https://img.shields.io/github/stars/ledtwo/canvas-video-player?style=social)

A lightweight, seamless video mashup player rendered via `<canvas>`. Designed specifically for multi-video source splicing, short video sequence playback, and lightweight video preview scenarios on the Web.

## ✨ Core Features

* **Seamless Mashup Experience**: Say goodbye to the black screens, stuttering, and loading delays common when switching between traditional `<video>` tags. By drawing the underlying frames onto a Canvas, it achieves a truly seamless transition.
* **Precise Fragment Clipping**: Supports configuring independent playback periods (`start` / `end`) for each video source, rendering specific video segments exactly as needed.
* **Customizable Watermarks**: Built-in logo overlay functionality allows you to set the watermark position (e.g., top-left, bottom-right) independently for different video sources.
* **Minimalist API Design**: A highly encapsulated plugin approach. No need to mount cluttered DOM elements in your templates—invoke the player on the front end with just one line of code.
* **High-Performance Rendering**: Directly manipulates the Canvas to draw video streams, ensuring silky-smooth visual transitions.

## 🚀 Live Demo

Experience it online: [http://canvas-v.epochy.cn/](http://canvas-v.epochy.cn/)

## 📦 Installation

You can install it via npm or yarn:

```bash
npm install canvas-video-player
# OR
yarn add canvas-video-player
🛠️ Quick Start
The current version is deeply optimized for the Vue 2.x environment.

1. Global Registration (main.js)
JavaScript
import Vue from 'vue';
import canvasPlayer from "canvas-video-player";

Vue.use(canvasPlayer);
2. In-Component Invocation
Call the player directly via the $canvasVideoPlayer method without intruding on your existing HTML structure.

代码段
<template>
  <div id="app">
    <button @click="playVideo">▶️ Play Mashup Sequence</button>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      playlist: [
        {
          url: '[https://example.com/video1.mp4](https://example.com/video1.mp4)',
          width: 1080, // Canvas width for the video
          height: 1920, // Canvas height for the video
          logoPosition: { x: 'left', y: 'top' },
          playPoint: { start: '0', end: '3.120000' } // Play only the first 3.12 seconds
        },
        {
          url: '[https://example.com/video2.mp4](https://example.com/video2.mp4)',
          width: 1080,
          height: 1920,
          logoPosition: { x: 'right', y: 'bottom' },
          playPoint: { start: '1.5', end: '5.0' } // Continue playing from 1.5 seconds
        }
        // Supports an unlimited number of video fragments
      ]
    }
  },
  methods: {
    playVideo() {
      // Pass the playlist to invoke the player
      this.$canvasVideoPlayer(this.playlist);
    }
  }
}
</script>

🗺️ Roadmap
[x] Deep plugin support for Vue 2.x

[ ] Provide a pure Vanilla JS core library independent of any framework

[ ] Expand support for modern frameworks (e.g., React Hooks / Component ecosystem compatibility)

[ ] Add more video transition effects (Fade, Wipe, etc.)

## 🧪 本地验证

播放编排逻辑（跳转定位 / 单绘制循环 / 资源释放）已抽离为框架无关的
`src/playerCore.js`，`src/canvasPlayer.vue` 只负责 DOM 桥接。核心逻辑可在
Node 里直接验证，无需浏览器、无需安装依赖：

```bash
npm test          # 等价于 node --test
```

覆盖场景（`test/playerCore.test.js`）：

* 正常顺序播放：三段依次切换、`playIndex` 递进到结尾、总进度单调连续不跳变；
* 跳转：目标时间 → 正确的片段下标 + 片内偏移，进度条时间 / `playIndex` /
  `video.currentTime` 三者一致，边界时间归属下一段开头；
* 连续快速切段：20 次连续跳转（中间不走帧）与超短片段快速自然切换，
  全程断言单循环不变量，且所有旧视频均被暂停；
* 暂停/恢复：循环随暂停退出、随恢复重启；
* 关闭：动画帧全部取消、文档级监听（keydown/mousemove/mouseup）全部移除、
  视频暂停并释放 `src`；画布节点置 null 后 `dispose()` 仍不抛错，且幂等；
* 关闭后重开：新实例从头播放，不继承旧的片段下标、暂停态或残留循环。

### 如何观察绘制循环数量与监听是否残留

* **测试里**：`core.getDebugState()` 返回
  `{ activeLoops, loopsStarted, loopsStopped, documentListenersBound, ... }`。
  不变量是 `activeLoops ∈ {0, 1}`（播放中为 1，暂停/播完/关闭后为 0）；
  假 document 上的 `listenerCount(type)` 在 `dispose()` 后必须归 0。
* **浏览器里**：组件实例上挂着核心对象，控制台执行
  `vm._core.getDebugState().activeLoops` 即可查看当前活跃绘制循环数；
  文档级监听可用 Chrome DevTools 控制台的
  `getEventListeners(document)` 查看，关闭弹层后 `keydown` / `mousemove` /
  `mouseup` 下不应再残留本播放器的回调。

📄 License
MIT License
