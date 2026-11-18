<div align="center">

<img src="docs/assets/hero.svg" alt="BilibiliLiveDelay：让解说，跟上画面。纯矢量控制面板示意，支持 0～60 秒音频或音画延迟。" width="100%">

# BilibiliLiveDelay

**让直播解说，跟上你正在看的画面。**

独立延迟 Chrome 标签页的声音，或同时延迟播放器画面与声音。
专为 F1 双流观看场景制作，也适用于其他网页直播。

[![Version](https://img.shields.io/badge/version-1.3.0-2769d3)](manifest.json)
[![Chrome](https://img.shields.io/badge/Chrome-116%2B-f0b429)](#quick-start)
[![Manifest](https://img.shields.io/badge/Manifest-V3-6b5bd2)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-27a46a)](LICENSE)

**[下载最新版本 →](https://github.com/Aurxs/BilibiliLiveDelay/releases/latest)** · [所有 Release](https://github.com/Aurxs/BilibiliLiveDelay/releases)

[快速安装](#quick-start) · [功能](#features) · [工作原理](#how-it-works) · [测试记录](TESTING.md) · [反馈问题](https://github.com/Aurxs/BilibiliLiveDelay/issues)

<sub>Native JavaScript · No build step · Audio and video processed on your device</sub>

</div>

---

## 为什么做这个工具？

你在 Safari 看 F1 官方纯净流，在 Chrome 听 B 站中文解说，却发现解说比画面快了半分钟：刚准备看超车，结果已经被提前说出来了。

**BilibiliLiveDelay 把更快的那一路延后。** 默认延迟 30 秒，从插件按钮随时微调，让解说与比赛画面对齐。

它通过 Chrome 标签页捕获 API 获取浏览器输出，在本机完成缓冲与延迟播放。

当前版本：**[1.3.0](https://github.com/Aurxs/BilibiliLiveDelay/releases/tag/v1.3.0)**。

<a id="features"></a>

## 功能一览

| 功能 | 你可以做什么 |
| --- | --- |
| 🎧 纯音频延迟 | 保持 Chrome 原视频播放，只延后声音，与另一浏览器画面对齐 |
| 🎬 音画一起延迟 | 在扩展播放页观看延后的声音与画面，支持全屏 |
| ✂️ 播放器区域裁剪 | 自动定位可见播放器，排除网页导航和聊天区；也可手动框选 |
| ⏱️ 0～60 秒 | 默认 30 秒，0.1 秒设置步进，支持 ±0.5 秒快捷微调 |
| 🔊 调节时保持正常音调 | 增加延迟暂停输出并倒计时恢复；减少延迟跳过已有缓冲 |
| 🖥️ 四档目标画质 | 720p/30、720p/60、1080p/30、1080p/60 |
| 🪟 工具栏控制面板 | 点击插件按钮调节；关闭面板后继续运行 |
| 🔒 本地处理 | 无服务器、账号、遥测或云端音视频上传 |

原生 JavaScript、HTML、CSS。**运行时无第三方依赖，无需构建。**

<a id="quick-start"></a>

## 快速安装

### 1. 下载扩展

打开 **[最新 Release](https://github.com/Aurxs/BilibiliLiveDelay/releases/latest)**，下载附件中的 **`BilibiliLiveDelay-v版本号.zip`** 并解压。ZIP 里直接包含可加载的扩展文件，无需构建。

Release 同时提供签名 **CRX3** 包和 **`SHA256SUMS`** 校验文件。Chrome 用户使用 ZIP 即可；CRX 供支持侧载的浏览器使用。

开发者也可以克隆仓库：

```bash
git clone https://github.com/Aurxs/BilibiliLiveDelay.git
```

### 2. 加载到 Chrome

1. 使用 **Chrome 116+**，打开 `chrome://extensions`。
2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后包含 `manifest.json` 的 **扩展文件夹**。
4. 在工具栏扩展菜单中固定 **Live Audio Sync · 直播音画延迟**。

完成。安装无需 Node.js，也无需启动服务器。

## 使用：F1 双流同步

### 只延迟中文解说

```text
Safari：F1 官方画面 ──────────────────→ 你看到的比赛
Chrome：B 站中文解说 → 缓冲 30 秒 ────→ 你听到的解说
```

1. 在 Safari 播放纯净流，在 Chrome 打开正常播放的 B 站直播间。
2. **在 B 站直播标签页点击插件图标**，选择「纯音频」。
3. 设为 **30.0 秒**，点击「开始延迟」。初次启动需等待缓冲。
4. 听到延迟后的解说时，用 `−0.5s` / `+0.5s` 微调，与 Safari 画面对齐。
5. 点击「停止延迟」释放采集、丢弃剩余缓冲，恢复网页当前时刻的声音。

纯音频模式只处理当前选择的 Chrome 标签页音频。

### 声音与画面一起延迟

1. 在源直播网页的插件面板选择「音画一起」。
2. 选择采集范围与目标画质，点击「开始延迟」。
3. 扩展打开自己的延迟播放页，缓冲完成后开始播放。需要时点击「播放声音与画面」允许 Chrome 输出。
4. 播放页支持「全屏」，按 `Esc` 退出；延迟仍从插件按钮调整。

**关闭控制面板会继续运行；关闭或刷新延迟播放页会结束本次音画采集。** 切换模式、范围或画质，需要先停止。

### 选择采集范围

| 范围 | 适用场景 |
| --- | --- |
| **自动识别播放器** · 默认 | 最大可见播放器；B 站优先定位 `#live-player` 内的视频 |
| **手动框选** | 自动定位失败，或播放器位于跨域 iframe 内 |
| **整个标签页** | 希望保留网页整体画面 |

自动模式要求播放器完整显示在网页视口内。手动模式先点击「框选当前网页的视频区域」，在本地截图预览中拖出矩形并保存，再回到源网页开始；滚动源网页或改变窗口尺寸后需要重新框选。

区域模式捕获并裁剪浏览器实际显示的画面，选区中的弹幕和控件也会保留。

### 延迟调节会发生什么？

| 操作 | 输出行为 |
| --- | --- |
| 30 → 35 秒 | 暂停输出约 5 秒，直播继续采集，面板显示倒计时，随后自动恢复 |
| 35 → 30 秒 | 跳过约 5 秒缓冲内容，以正常速度继续播放 |
| 拖动滑块 | 拖动时预览，松手后应用 |
| 停止后重启 | 丢弃旧缓冲，重新等待所选延迟 |

调节时保持正常音调，通过暂停、淡入淡出或跳过缓冲完成切换。

## 画质与资源占用

| 目标档位 | 请求的视频目标码率 |
| --- | ---: |
| 720p / 30fps · 默认 | 4 Mbps |
| 720p / 60fps | 6 Mbps |
| 1080p / 30fps | 8 Mbps |
| 1080p / 60fps | 10 Mbps |

音频目标码率为 128 kbps，视频使用可变码率。输出保持选区宽高比，小尺寸选区保留原始尺寸；面板可查看实际输出尺寸、播放帧率和平均码率。

建议从默认档位开始，再按直播源和设备性能提高画质。高画质与长延迟会增加资源占用，缓存不足时可降低画质或缩短延迟。缓存策略见 [架构说明](docs/ARCHITECTURE.md)。

<a id="how-it-works"></a>

## 工作原理

```mermaid
flowchart LR
    P[插件按钮面板] --> W[Service Worker 协调]
    W -->|一次性流 ID| O[Offscreen Document 采集]
    T[指定 Chrome 标签页] -->|tabCapture| O
    O --> A[纯音频：Web Audio / DelayNode]
    A --> S[延迟声音]
    O --> V[音画：区域裁剪 / MP4 编码]
    V --> B[播放页：MediaSource 缓冲]
    B --> AV[延迟声音与画面]
```

Offscreen Document 承担采集和处理，控制面板关闭、Service Worker 休眠时，无需由它们维持音频。音画数据通过扩展同源通道进入自己的播放页，不经过 Service Worker 转发。

每次只处理一个标签页。启动由用户点击触发；停止、不可恢复的采集错误或目标页关闭时，释放音轨、编码器与音频资源，并提示用户重新启动。

### 权限与隐私

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 用户点击图标后临时授权当前标签页 |
| `tabCapture` | 获取指定标签页的音频或音画 |
| `offscreen` | 在独立扩展文档中处理采集流 |
| `storage` | 保存设置与临时会话信息 |
| `scripting` | 只读定位播放器区域、管理定位观察器 |

没有持久的全站访问权限、网络拦截、直播请求代理或遥测。不会读取直播流地址，也不修改源播放器的 `src`、`currentTime`、`playbackRate`、`crossOrigin`、音量或静音状态。

媒体数据仅存在于运行时内存，不保存录制文件；手动框选用的截图只暂存在本地 session storage，保存或关闭选择页后清除。

## 常见问题

<details>
<summary><strong>会不会让 B 站反复切线路、转圈？</strong></summary>

扩展通过 Chrome 捕获标签页输出，保持源播放器正常播放。遇到卡顿时，可先停止扩展对比，再降低画质或缩短延迟。

</details>

<details>
<summary><strong>为什么开始后暂时听不到声音？</strong></summary>

第一次启动时没有历史音频，需要等待所选延迟填满。设为 30 秒就会先等待约 30 秒；音画模式还包含编码与播放安全余量。确认网页播放器本身没有被静音。

</details>

<details>
<summary><strong>1080p 为什么可能比源网页模糊？</strong></summary>

输出来自浏览器画面的裁剪和重编码。扩大源播放器显示区域、提高直播源清晰度，有助于改善输出效果；面板可查看源尺寸、区域采样和实际输出尺寸。

</details>

<details>
<summary><strong>缓存「配额」是什么？</strong></summary>

Chrome 为媒体缓存设置的内存上限，与账号额度或流量无关。高码率和长延迟会更快达到上限。扩展会回收已播放数据；没有可回收空间仍失败时安全停止，可降低画质或缩短延迟后重新启动。

</details>

<details>
<summary><strong>音画播放页仍然静音怎么办？</strong></summary>

如果启动时源标签页被 Chrome 网站/标签页静音，音画播放页会继承该状态。需要听声音时，先取消源网站的 Chrome 静音，再停止并重新启动。插件不改变网页播放器自身的音量和静音设置。

</details>

<details>
<summary><strong>0 秒、0.1 秒精度与长期稳定性怎么理解？</strong></summary>

延迟按 0.1 秒步进调整。音画模式另外预留 0.75 秒播放缓冲，采集、编码和输出设备也会带来基础延迟。观看期间请保持 Chrome 运行并避免系统休眠；测量与耐久记录见 [TESTING.md](TESTING.md)。

</details>

## 验证与开发

回归检查、音频信号测量及 B 站实播记录见 [TESTING.md](TESTING.md)。

最终 1.3 裁剪链路的静音实播观察：

| 项目 | 观察结果 |
| --- | --- |
| 自动播放器裁剪输出 | 实际 1920×1080 |
| 短时播放统计 | 约 54.0～59.7fps |
| 默认 30 秒下缓存范围 | 约 36.3～36.6 秒 |
| 手动框选 | 保存、启动、选中区域播放与停止流程通过 |

维护者可使用 Node.js 18+ 执行本地检查，无需安装依赖：

```bash
cd BilibiliLiveDelay
npm run check
npm test
```

项目提供 `test/audio-test.html` 与 `test/av-test.html`，分别生成周期性编号短音，以及同钟时间码画面与短音，便于记录目标延迟和实际输出延迟。测试 file URL 时需在扩展详情开启「允许访问文件网址」，B 站使用无需开启。

### 打包与发布

GitHub Actions 在推送 `main` 或手动运行 **Package extension** 时生成 CRX、ZIP 与 SHA-256 校验文件，可在 Actions 的 Artifacts 中下载。推送 **`v版本号` 标签**时，会在打包成功后自动发布带附件的 [GitHub Release](https://github.com/Aurxs/BilibiliLiveDelay/releases)。标签、`manifest.json` 和 `package.json` 的版本必须一致。

维护者需在仓库 Actions Secrets 中配置 **`CRX_PRIVATE_KEY`**，值为 RSA 私钥的完整 PEM 内容。所有版本复用同一把密钥，CRX 和 ZIP 的扩展 ID 因此保持一致；缺失密钥时打包会直接失败。私钥仅用于签名，不会进入安装包或 Git。

本地打包需要 Node.js 18+ 和 Google Chrome：

```bash
npm run package -- --key /path/to/private-key.pem
```

默认使用 macOS 的标准 Chrome 路径，Linux 使用 `google-chrome`；其他安装位置可通过 `CHROME_PATH` 指定可执行文件。产物在 `dist/`，仅包含根目录的扩展 JS、HTML、CSS、清单及许可证，不包含测试、文档或开发配置。需要新增子目录资源时，应同步更新打包脚本。

发布下一版本时，先同步两个版本文件、提交并推送，再创建与版本一致的标签，例如 `git tag v1.3.1` 后 `git push origin v1.3.1`。可在 `docs/releases/v版本号.md` 提供该版本发布说明；未提供时由 GitHub 自动生成。

```text
BilibiliLiveDelay/
├── manifest.json                 # MV3 与权限
├── service-worker.js             # 生命周期、授权、消息协调
├── offscreen.html / offscreen.js  # 独立采集入口
├── audio-engine.js / audio-graph.js
├── av-engine.js / av-playback.js
├── player-locator.js / video-cropper.js / video-options.js
├── control.html / control.js / control.css
├── viewer.html / viewer.js / viewer.css
├── crop.html / crop.js / crop.css
├── test/                         # 手动测量页面
├── tests/                        # 聚焦行为测试
└── docs/ARCHITECTURE.md           # 架构与 API 细节
```

## 参与贡献

欢迎 [提交 Issue](https://github.com/Aurxs/BilibiliLiveDelay/issues) 或 Pull Request。报告问题时请附上 Chrome 版本、操作系统、模式、画质、目标延迟及面板错误。

改动请保持播放器定位只读，不引入源播放器控制或直播请求拦截，并只验证相关行为。

下一步优先做：完整比赛耐久与资源观察、最终音画同步测量、输出设备切换验证；之后考虑站点设置、快捷键和用户触发的诊断导出。

## License

[MIT](LICENSE) © Aurxs。欢迎使用、修改与贡献。
