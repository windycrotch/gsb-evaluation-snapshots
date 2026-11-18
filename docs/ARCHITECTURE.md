# 架构与运行机制

面向维护者的实现说明。安装与快速使用见 [项目首页](../README.md)。

## 音画采集、裁剪与编码

音画链路：Offscreen `getUserMedia(audio + video)` → 视频轨按需通过 `MediaStreamTrackProcessor → VideoFrame 裁剪 → 扩展自己的 canvas 实际缩放 → captureStream(所选帧率)`；音频通过 Web Audio 规范为 48 kHz（只连接 MediaStreamDestination）→ 单个 `MediaRecorder`（分片 MP4，H.264 / AAC）→ 扩展同源 BroadcastChannel → 播放页 `MediaSource/SourceBuffer` → 一个 `<video>` 输出音画。不另外连接音频 DelayNode，避免双份声音及两个时钟漂移。裁剪由输入帧驱动，不依赖后台页面的 requestAnimationFrame 或定时绘图，不通过 JS 读取完整像素数组；输入处理队列最多一帧，及时释放 VideoFrame。使用扩展自己的画布真正缩放编码帧，避免把仅设置 displayWidth/displayHeight 当作实际像素缩放；硬件加速由 Chrome 决定。画布轨道声明所选帧率，并由每个捕获帧触发 requestFrame；不操作网站的视频元素。画布输出使用采集时刻的时间戳，裁剪和缩放可能给画面增加少量处理延迟，最终音画偏移需信号测量，不能仅凭输出帧率推断同步。部分 Mac 的捕获音轨为 96 kHz；编码前用原生音频线程规范为 AAC 编码器支持的 48 kHz。音画模式使用 MP4/H.264/AAC，不在失败时自动切回已出现同步问题的 WebM/Opus 链路。此音频处理不输出到扬声器，暂停时最多恢复 3 次，失败安全停止。编码分块连续追加，不逐块换 src，保持媒体时间戳和初始化数据。样本与视频不经过 Service Worker；Worker 休眠不承担播放任务。

音画模式需要 Chrome 同时支持 MP4/H.264/AAC 录制和 MediaSource 播放，启动时检查能力；本机 Chrome 154 支持，较旧浏览器可能只能使用纯音频模式。Chrome 116 是基础扩展 API 最低版本，并不保证所有编码器可用。

采集范围可以选择：

- **自动识别播放器**：在当前授权的标签页只读定位最大可见 video，B 站优先使用 `#live-player` 内的视频。读取位置和尺寸，跟随网页滚动、窗口变化及播放器元素替换。播放器需完整显示在网页视口内；区域丢失或不完整会停止采集并提示重新启动，不悄悄改成整个网页。区域内的弹幕、控制条或其他遮挡仍会出现在输出里。跨域 iframe 内的播放器需用手动框选。
- **手动框选**：先点击「框选当前网页的视频区域」，在扩展预览页拖出矩形，点击「使用这个区域」。回到源网页的插件面板点击开始。预览是当前标签页的一张本地截图，框选时尚未采集音画；截图只暂存于 session storage，保存或关闭选择页后清除。源网页滚动或窗口尺寸改变后要重新框选。手动区域只对当前标签页及 URL 生效。
- **整个标签页**：保持原先的网页整体捕获方式。

可选目标档位及视频目标码率：

| 档位 | 目标码率 |
| --- | ---: |
| 720p / 30fps | 4 Mbps |
| 720p / 60fps | 6 Mbps |
| 1080p / 30fps | 8 Mbps |
| 1080p / 60fps | 10 Mbps |

这些是编码器请求的目标值，并非实际速率或硬上限。当前 Chromium 的 MediaRecorder 使用可变码率，视频峰值预算可达目标的两倍；本机高动态直播请求 10 Mbps 时，实际数据平均可接近 20 Mbps。以面板按字节数统计的「数据平均」为准。音频目标码率为 128 kbps。1080p/60fps 使用 H.264 Level 4.2；各档位启动前检查录制与播放支持。裁剪前优先保留网页的原生像素密度（含 Retina），请求足够的整个标签页采样尺寸，最多 3840×2160；再把播放器区域缩至所选输出上限。除几个像素的 YUV 对齐误差外，初次输出不会把不足的区域像素放大来冒充更高分辨率；保持原宽高比，输出尺寸可能小于档位标称值。采集开始后输出尺寸固定，避免调整窗口引发编码格式变化。

面板分别显示播放器源视频尺寸（可读时）、采集区域实际像素、输出视频尺寸、目标编码码率、已产出的编码数据平均速率及媒体缓存时长。数据平均按实际字节数与录制经过时间计算，包含音频及封装；初始分块尚未送达时会波动。播放帧率根据输出视频计数每约 3 秒计算，扣除 droppedVideoFrames，是短时播放统计，既不是读取 30/60 的设置值，也不代表原直播每秒有同样数量的不同画面。暂停时帧率显示为空。

**这里的 1080p 指输出像素尺寸，无法保证与原生 1080p 直播流同等清晰。**本方案采集浏览器渲染的画面再有损编码；源视频分辨率、播放器显示大小、Chrome 采样和重编码都会影响画质。更高码率可减少压缩损失，无法恢复已丢失的细节。1080p/60fps 的缓冲数据及 CPU/GPU、内存、耗电开销更高，75 秒缓冲在 20 Mbps 下仅视频数据就约 188 MB，实际总开销还包含解码与浏览器缓存。所有媒体 `src/currentTime` 写操作仅用于扩展自己的元素。

播放缓冲按当前延迟保留约「延迟 + 0.75 + 6」秒，最多 75 秒；媒体时间每前进约 1 秒即可清理旧数据。30 秒模式通常只保留约 37 秒及关键帧/分块对齐余量，避免低延迟时还占用 75 秒数据。编码待发送队列与播放待追加队列按档位的两倍视频目标给出约 12 秒编码数据的预算，低档分别保留 8/16 MiB 的最低上限，1080p/60 档约 29 MiB，队列硬上限 32 MiB；这是有界待处理队列，不是整个媒体缓冲。MP4 分块可能跨越数秒，timeslice=250ms 不保证每块都很小。遇到 Chrome 媒体配额时，回收已播放的历史（保留当前位置前 1.5 秒），保留原块重试；没有可回收数据仍失败则安全停止。更长延迟和高码率组合可能受浏览器配额限制，需要降低档位。这里的「配额」是 Chrome 的媒体缓存内存上限，不是账号额度或流量；其大小受浏览器与内存压力影响，无法保证一个固定数值。缓存满且无法回收时，面板会明确提示降低画质或缩短延迟。停止/错误清理等待编码器 stop 事件和既有资源释放任务，再销毁 Offscreen；新采集在旧清理完成后才取新的流 ID。超过上限、编码/解码错误、数据序号断裂或消费者长时间失去响应时安全停止并要求重启，不无限重试。浏览器媒体缓存本身还有开销及配额，不能仅凭码率估算总内存。

音画模式额外预留 0.75 秒播放缓冲，并有采集、编码、分块和设备开销；**0 秒设置也存在基础延迟**。面板的目标值和播放页「缓冲位置差」都不是端到端测量，测试结果见 TESTING.md。调节以共享的单调时钟和播放时间为基准，避免编码分块不准时导致 −0.5 秒反而后退。增加延迟按差值倒计时，采集卡顿时仍可能需要等待可播放数据。恢复严重卡顿时会在扩展输出页做一次跳转校准，不使用加速追赶。

对 Mac 的 CPU/GPU、内存和耗电负担高于纯音频模式；原直播网页的后台行为、受保护内容、系统休眠、锁屏、页面丢弃及输出设备变化仍需要实机长时间验证。页面定位脚本只读位置和尺寸，没有播放器控制、网络拦截、服务器或录制文件。

若启动时源标签页被 Chrome 的标签页/网站静音，音画输出页会继承该静音状态，避免工具绕过你的静音选择。需要听声音时，先取消源网站的 Chrome 静音，然后停止并重新启动延迟；这不修改网页播放器自身的静音或音量。


## 架构与 Chrome API 约束

```text
点击工具栏 action（default_popup = control.html，获得 activeTab 授权）
  → Popup 读取并固定当前标签页 ID，点击开始后向 Service Worker 发消息
  → Service Worker 创建 / 找到 USER_MEDIA Offscreen Document
  → getMediaStreamId({ targetTabId })
  → 立即把单次使用的短期 ID 发给 Offscreen
  → getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', … } }, video: false })
  → MediaStreamAudioSourceNode → DelayNode(最大 60 秒) → GainNode → 系统默认输出
```

Chrome 原生 tabCapture 在采集期间抑制该标签页的直接声音。因此只需输出延迟链路，无需改动网页静音状态。初始 delayTime 在连接输入前设定，避免启动时泄漏原声。停止先静音并断开输出，再停止全部 MediaStreamTrack、关闭 AudioContext 和 Offscreen；不会保留延迟尾音。

流 ID 在 Offscreen 创建完成后才生成，立刻消费，不缓存、不重用，也不设置 `consumerTabId`。Chrome 116+ 才支持 Service Worker 生成的 ID 在 Offscreen 内消费。仅使用 `runtime.getContexts()` 检查文档，以兼容 116，而不依赖较新版本才有的 `offscreen.hasDocument()`。

Offscreen 使用 **USER_MEDIA**，与官方 tabCapture 示例一致，它实际负责 `getUserMedia()` 流；不用有「无音频 30 秒后关闭」规则的 AUDIO_PLAYBACK 文档，避免初始 30～60 秒缓冲或静音时丢失采集。AudioContext、DelayNode 和本地健康检查均在 Offscreen；Service Worker 不处理样本、不维持心跳，休眠不影响音频。Popup 只发消息；关闭面板不触发停止。Worker 重启后从现有 Offscreen 查询真实状态，而不是根据缓存重建采集。配置 default_popup 后没有注册 action.onClicked，避免 Chrome 不触发该事件造成失效。

权限为 `activeTab`、`tabCapture`、`offscreen`、`storage`、`scripting`。新增 scripting 仅配合点击图标时的 activeTab 授权，只读定位当前播放器区域及卸载定位观察器；不写网页 DOM、CSS 或媒体状态，不调用源播放器 play/pause/load，不读取直播地址、不发起站点网络请求。没有持久站点访问权限、自动 content_scripts、tabs 权限、网络拦截、跨站请求、遥测或录音文件。`chrome.tabs` 基础操作不要求 tabs 权限。Popup 由 Chrome 原生 action 管理，Offscreen 通过 `runtime.getContexts()` 查找。本地 storage 保存目标延迟、模式及视频选择；session 保存会话状态、手动区域，以及框选期间的一张临时截图。不存储音视频流 ID 或直播媒体数据。

## B 站兼容性边界

本扩展是通用标签页音画工具，可用于 B 站、YouTube Live 等。它仅只读定位原网站播放器，不改动 `video` / `audio` DOM，不修改 `src`、`currentTime`、`playbackRate`、`crossOrigin`，不控制播放器、不暂停画面、不重新加载网页，也不代理或修改直播请求。

播放器临时卡顿、静音或切线路时，保持同一个标签页捕获流和音频图。没有根据「无声」判定采集失败的逻辑，因为解说停顿也是正常情况。只有真实 track `mute` / `unmute` 更新中断状态；track `ended` 或 Chrome 捕获结束才终止采集。已有缓冲会继续输出，输入恢复的声音仍按设定延迟到达。

从扩展的代码路径看，没有主动触发此前「转圈 / 反复切线路」的播放器控制和请求操作。已在 B 站 33989 直播间运行约 5 分钟，视频持续播放，无等待/重载事件；真实输入/输出包络测得约 30 秒信号延迟，详细范围见 [TESTING.md](../TESTING.md)。**不能据此保证 B 站在所有 Chrome、直播间和设备组合上都兼容**；强制线路切换与整场观看仍需实测。如果直播出现异常，先停止扩展比较网页状态，再检查其他扩展。插件出错时会释放采集并提示重新启动，不会无限重新拉流或采集。

## 延迟调节与技术限制

- 初次启动需要等待设定延迟才能听见捕获后的第一段声音；没有历史音频可提前填充。
- 0.1 秒是**设置步进**。UI 的目标数字和缓冲倒计时不是端到端实测结果。实际输出还包含 Chrome 采集、音频处理块、系统/设备延迟，蓝牙耳机通常会再增加延迟。
- **增加延迟：暂停输出、继续缓存、自动恢复。** 例如 30 → 35 秒，先约 20 ms 淡出，静音期间将读取位置保持不动，等额外 5 秒音频积累后，以正常速度继续播放；淡出、稳定余量和淡入总计约 60 ms。面板显示暂停倒计时。没有暂停网页视频、采集流或 AudioContext，初始 60 秒缓冲仍受固定容量管理。
- **减少延迟：从已有缓冲向前跳转。** 例如 35 → 30 秒，会短暂淡出后跳过约 5 秒内容，约 70 ms 内恢复正常速度输出，不使用加速追赶。暂停中调回较小数值会取消原倒计时并按新的目标恢复。
- 调整时只在完全静音期间移动或跳转读头，避免旧版可听见的升降调。短暂停顿、淡入淡出及减少延迟造成的内容跳过仍然存在。频繁操作会重新安排当前暂停；初次缓冲尚未填满时，还需等待可用音频。始终只有一个输出链路，不混合两份解说。
- 停止会丢弃全部缓冲，直接恢复当前直播声音，因此会跳到直播当前时刻；重新启动要再次等待缓冲。
- 60 秒立体声 float32 缓冲在 48 kHz 下约 22 MiB（44.1 kHz 下约 20 MiB），另有浏览器开销；内存不会随着观看时长增长。纯音频模式没有 JS 样本队列、MediaRecorder 或逐段追加音频。
- 暂时的 AudioContext `suspended` / `interrupted` 会尝试 resume，每次事件最多 3 次，各有 2 秒超时；失败就停止并恢复原声。系统默认音频设备变化交给 Chrome/Web Audio 的默认输出路由处理，收到 `devicechange` 时提示。设备事件可能受浏览器权限限制；没有无声检测，不保证发现所有设备问题。
- 系统睡眠、Chrome 退出/更新、扩展重载/禁用、内存回收或标签页丢弃会影响采集。浏览器重启不自动采集。建议观看时保持 Mac 唤醒、避免主动丢弃直播标签页。
- tabCapture 通常可跨刷新/导航保留；刷新不会主动重启采集，缓冲里可能仍有刷新前音频。如果 Chrome 结束流，安全释放并要求重新启动。跨来源导航后 activeTab 授权可能过期，再次启动须在新网页点击图标。
- 只处理 Chrome 对指定标签页输出的声音/画面；DRM、浏览器内部页面等受 Chrome 采集限制。Safari 和未选择的 Chrome 标签页不在采集范围内。

## 验证与开发

Node.js 18+ 可运行无需安装依赖的快速检查：

```bash
cd BilibiliLiveDelay
npm test
npm run check
```

已执行的结果和精确范围见 [TESTING.md](../TESTING.md)。模拟流测试不等价于 B 站真实直播验证；OfflineAudioContext 信号测量也不等价于扬声器端到端测量。

手动测量测试音：

1. 在 Chrome 打开本地 `test/audio-test.html`。本地 file URL 捕获需要到扩展详情中开启「允许访问文件网址」。此许可只为本地测试，B 站使用不需要。
2. 点击「启动测试音」；每 8 秒发一个主提示音，并跟随 1～16 个短音标记编号。
3. 在同一测试标签页点击扩展图标，设定要测的值，点击开始延迟，等待初始缓冲结束。
4. 声音编号可能落后于屏幕显示；选择**实际听到的编号**，点击「我听到了」，记录源音频时钟与听到时刻之差。编号 128 秒重复一次，仅适用于当前 0～60 秒延迟及正常反应时间。
5. 人工反应会污染测量。建议手机同时录制屏幕时间标记与扬声器输出，用波形和画面读数对齐；测量蓝牙耳机需额外说明设备。
6. 分别验证 0、1、10、30、60 秒；记录**目标值与实测值两列**，不要将设置值直接写成测试结果。

浏览器信号测量页通过 ES Module 导入实际的 DelayGraph，若 file URL 阻止模块加载，可仅为开发启动本机静态服务器：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
# Chrome 打开 http://127.0.0.1:8765/test/offline-audio.html
```

这不是扩展运行依赖。测试页用 8 kHz 的 OfflineAudioContext 渲染已知输入脉冲，通过输出样本索引计算延迟，分辨率 0.125 ms。真实流用系统采样率，不强制 8 kHz。

发生错误时，先在面板查看中文信息。开发调试可在 `chrome://extensions` 查看 Service Worker / Offscreen 控制台。调试器附着会改变 Worker 的休眠行为，验证自然休眠时应关闭 DevTools。不要在运行中删除本地源码目录。

本地音画测试：打开 `test/av-test.html`，点击启动时间标记与短音，再从该标签页的插件面板开始音画延迟。顶部二进制条和大字秒数使用源音频时钟，每秒闪光与短音同步。比较当前源时间与播放页中捕获的源时间，分别记录目标和实测延迟；物理同步建议手机同时录制时间码画面和扬声器短音。浏览器内部测量及编码方案变化的记录见 [TESTING.md](../TESTING.md)。


## 官方依据

- [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)：用户调用扩展后采集、原声抑制、Chrome 116+ 的 ID 使用范围与单次短期有效性。
- [Chrome 音频捕获示例](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)：Service Worker + USER_MEDIA Offscreen 架构。
- [Canvas captureStream](https://developer.chrome.com/blog/capture-stream/)：扩展画布的尺寸和帧率。
- [Chromium MediaRecorder 编码器](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_encoder_wrapper.cc)：当前实现的可变码率与两倍峰值预算。
- [Chrome Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)：仅 runtime API、文档生命周期与 AUDIO_PLAYBACK 静音超时。
- [Chrome action](https://developer.chrome.com/docs/extensions/reference/api/action)：default_popup 与 onClicked 的互斥行为。
- [MDN MediaSource](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource)：连续媒体缓冲与统一音画播放。
- [MediaStream Recording 规范](https://www.w3.org/TR/mediastream-recording/)：分块需要保持连续数据，单块不保证独立播放。
- [MDN createDelay](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/createDelay)：最大延迟需显式指定，默认 delayTime 为 0。
- [Web Audio 规范](https://www.w3.org/TR/webaudio/)：DelayNode、AudioParam 和音频时钟行为。

文档核对日期：2026-10-10。
