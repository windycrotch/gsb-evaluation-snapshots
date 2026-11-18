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

## 🧪 本地测试（零依赖）

跳转/续播的核心时间线逻辑被抽成纯函数模块 [`src/timeline.js`](src/timeline.js)（全局播放时间 ↔ 片段下标 ↔ 片段内偏移），不依赖浏览器/DOM，可用 Node 内置测试运行器直接执行，**无需 `npm install`**：

```bash
# 方式一：npm 脚本（等价于 node --test）
npm test

# 方式二：直接调用 Node 内置 runner
node --test
```

要求 Node >= 20.10（开发环境验证版本为 Node 24），测试文件位于 [`test/timeline.test.js`](test/timeline.test.js)，使用内置的 `node:test` 与 `node:assert/strict`，不引入任何第三方包。

测试用自造的多片段配置（字符串型起止值，模拟真实接口数据）覆盖四类场景：

1. **中间片段跳转** — 跳到片段内部时，下标命中正确片段，片段内偏移 = 全局时间 − 该片段全局起点，且逆运算能还原全局时间（暂停再恢复不重置位置的数学保证）；
2. **精确分界点** — 全局时间恰好落在片段分界点时进入后一片段、偏移为 0，分界点前一刻仍属于前一片段；
3. **末段结束重播** — 落在总时长末端返回 `ended`（最后一片段结束），归零后重新定位回到首片段偏移 0；
4. **非法区间** — 时长非正、起止值为 `NaN`/`undefined`/普通文本等的片段被丢弃，总时长只累加合法片段的 `end-start`，任何输入下总时长与跳转结果都不会出现 `NaN`。

页面手动验证：`npm install && npm run serve` 启动后，点击/拖动进度条跳转、暂停后恢复、末段播完后再点播放，观察时间显示与画面片段是否一致。

### 时间线一致性规则（实现约定）

- 每个合法片段在全局时间线上占用半开区间 `[globalStart, globalEnd)`，`globalEnd - globalStart === end - start`；
- 全局时间 `t` 落在片段 `i` 区间内时，从源视频 `start + (t - globalStart)` 处播放；
- `t` 恰好等于分界点时进入后一片段（偏移 0）；`t >= 总时长` 时视为最后一片段结束；
- 进度条总时长恒等于各合法片段 `end-start` 之和。

🗺️ Roadmap
[x] Deep plugin support for Vue 2.x

[ ] Provide a pure Vanilla JS core library independent of any framework

[ ] Expand support for modern frameworks (e.g., React Hooks / Component ecosystem compatibility)

[ ] Add more video transition effects (Fade, Wipe, etc.)

📄 License
MIT License
