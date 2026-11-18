import { AV_CHANNEL, idleState, normalizeDelay, errorText, withTimeout } from "./shared.js";
import { VIDEO_PRESETS, videoOptions, captureSize, queueBudget } from "./video-options.js";
import { VideoCropper } from "./video-cropper.js";

const stopTracks = stream => stream.getTracks().forEach(track => track.stop());

// Owns capture/encoding only. The visible extension page is the sole A/V output.
export class AVEngine {
  constructor({ mediaDevices, onChange = () => {} }) {
    this.mediaDevices = mediaDevices;
    this.onChange = onChange;
    this.state = idleState();
    this.session = null;
    this.cleanupPromise = Promise.resolve();
  }
  emit() { this.onChange(this.snapshot()); }
  snapshot() {
    const elapsed = (performance.now() - (this.session?.reportedAt || performance.now())) / 1000;
    const paused = this.state.active && this.session?.context && this.session.context.state !== "running";
    return { ...this.state, contextState: this.session?.context?.state || "closed",
      ...(paused ? { phase: "interrupted", notice: "音画模式音频处理暂停，正在恢复。" } : {}),
      pauseRemaining: Math.max(0, (this.state.pauseRemaining || 0) - elapsed) };
  }
  async start({ streamId, tabId, tabTitle, sessionId, delay, viewerTabId, quality, region, geometry }) {
    if (this.session) return this.snapshot();
    const session = { stream: null, recorder: null, channel: new BroadcastChannel(AV_CHANNEL(sessionId)),
      context: null, audioSource: null, audioDestination: null, recovering: false,
      timer: null, reportedAt: performance.now(), lastHeartbeat: performance.now(), sequence: 0,
      pendingBytes: 0, writes: Promise.resolve(), listeners: [] };
    this.session = session;
    const options = videoOptions({ quality, region });
    const preset = VIDEO_PRESETS[options.quality];
    const budget = queueBudget(preset.bitrate);
    this.state = { ...idleState(normalizeDelay(delay)), ...options, mode: "av", active: true, phase: "capturing",
      tabId, tabTitle, sessionId, viewerTabId, startedAt: Date.now(), bufferRemaining: delay,
      actualDelay: null, bufferedSeconds: 0, contextState: "not-used" };
    const config = () => ({ type: "CONFIG", mime: session.mime, delay: this.state.delay, tabTitle, quality: options.quality,
      region: options.region, width: this.state.width, height: this.state.height, targetFps: preset.fps, maxQueuedBytes: budget.playback });
    this.emit();
    let ready;
    const consumerReady = new Promise(resolve => { ready = resolve; });
    session.channel.onmessage = ({ data }) => {
      if (data.type === "RELEASED") { session.released?.(); return; }
      if (this.session !== session) return;
      if (data.type === "HELLO" && session.configReady) session.channel.postMessage(config());
      if (data.type === "READY") { session.lastHeartbeat = performance.now(); ready(); }
      if (data.type === "STATUS") {
        session.lastHeartbeat = session.reportedAt = performance.now();
        const { phase, bufferRemaining, pauseRemaining, actualDelay, bufferedSeconds, notice, blocked, outputFps, outputWidth, outputHeight } = data;
        const changed = phase !== this.state.phase || blocked !== this.state.blocked;
        Object.assign(this.state, { phase, bufferRemaining, pauseRemaining, actualDelay, bufferedSeconds, notice, blocked, outputFps, outputWidth, outputHeight });
        if (changed) this.emit(); // Status transitions only; no worker heartbeat.
      }
      if (data.type === "ERROR") void this.fail(session, "error", data.error);
      if (data.type === "CLOSED") void this.fail(session, "interrupted", "延迟播放页已关闭，采集已释放，网页恢复原声。");
    };
    try {
      session.mime = [`video/mp4;codecs=avc1.4200${preset.level},mp4a.40.2`, `video/mp4;codecs=avc1.42E0${preset.level},mp4a.40.2`]
        .find(type => MediaRecorder.isTypeSupported(type));
      if (!session.mime) throw new Error(`此 Chrome 不支持 ${preset.label} 的 MP4 / H.264 / AAC 编码，请选择较低档位或纯音频模式。`);
      if (options.region !== "tab" && !geometry?.rect) throw new Error("播放器区域定位失败，请重新启动或手动框选。");
      const size = captureSize(preset, geometry);
      const stream = await withTimeout(this.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId,
          maxWidth: size.width, maxHeight: size.height, minFrameRate: preset.fps, maxFrameRate: preset.fps } },
      }), 12000, stopTracks);
      if (this.session !== session) { stopTracks(stream); return this.snapshot(); }
      session.stream = stream;
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw new Error("采集流缺少音轨或画面，请重新启动。");
      // AAC encoders on macOS require a supported input format. Normalize on
      // the native audio thread; this destination never connects to speakers.
      const context = session.context = new AudioContext({ sampleRate: 48000 });
      await withTimeout(context.resume(), 4000);
      if (this.session !== session) return this.snapshot();
      if (context.state !== "running") throw new Error("音画音频处理无法启动，请重新启动。");
      session.audioSource = context.createMediaStreamSource(stream);
      session.audioDestination = context.createMediaStreamDestination();
      session.audioSource.connect(session.audioDestination);
      this.state.sampleRate = context.sampleRate;
      let videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      Object.assign(this.state, { width: settings.width, height: settings.height, captureWidth: settings.width,
        captureHeight: settings.height, sourceWidth: geometry?.sourceWidth, sourceHeight: geometry?.sourceHeight,
        frameRate: settings.frameRate, targetFps: preset.fps, videoBitrate: preset.bitrate, mime: session.mime });
      if (options.region !== "tab") {
        session.cropper = new VideoCropper({ geometry, preset,
          onFormat: format => Object.assign(this.state, format),
          onError: error => void this.fail(session, "error", `播放器画面裁剪失败：${errorText(error)}`) });
        videoTrack = await session.cropper.start(videoTrack);
        if (this.session !== session) return this.snapshot();
      }
      const encodedStream = new MediaStream([...session.audioDestination.stream.getAudioTracks(), videoTrack]);
      this.state.encoderFrameRate = videoTrack.getSettings().frameRate;
      for (const track of stream.getTracks()) {
        const ended = () => void this.fail(session, "interrupted", "标签页音画采集已结束。请回到直播网页重新启动。");
        track.addEventListener("ended", ended);
        session.listeners.push(() => track.removeEventListener("ended", ended));
      }
      session.configReady = true;
      session.channel.postMessage(config());
      await withTimeout(consumerReady, 8000);
      if (this.session !== session) return this.snapshot();
      const recorder = new MediaRecorder(encodedStream, { mimeType: session.mime, videoBitsPerSecond: preset.bitrate,
        audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000 });
      session.recorder = recorder;
      recorder.onerror = event => void this.fail(session, "error", `音画编码失败：${errorText(event.error)} 请更新 Chrome 或使用纯音频模式。`);
      recorder.onstop = () => { if (this.session === session) void this.fail(session, "interrupted", "音画编码意外停止，请重新启动。"); };
      recorder.ondataavailable = event => {
        if (this.session !== session || !event.data.size) return;
        session.encodedBytes += event.data.size;
        this.state.encodedMbps = session.encodedBytes * 8 / 1_000_000 / Math.max(0.1, (performance.now() - session.recordingAt) / 1000);
        session.pendingBytes += event.data.size;
        if (session.pendingBytes > budget.pending) { void this.fail(session, "error", "音画编码积压过多，已安全停止。请重新启动或选择较低画质。"); return; }
        session.writes = session.writes.then(async () => {
          const bytes = await event.data.arrayBuffer();
          session.pendingBytes -= event.data.size;
          if (this.session === session) session.channel.postMessage({ type: "CHUNK", sequence: session.sequence++, bytes });
        }).catch(error => void this.fail(session, "error", errorText(error)));
      };
      // Share a monotonic epoch with the consumer. Chunk delivery times are
      // irregular and cannot serve as the live edge used by delay adjustments.
      session.channel.postMessage({ type: "STARTED", origin: performance.timeOrigin + performance.now() });
      session.recordingAt = performance.now();
      session.encodedBytes = 0;
      recorder.start(250);
      session.timer = setInterval(() => {
        if (session.context.state !== "running") void this.recover(session);
        // Hidden silent tabs can have timers batched once per minute by Chrome.
        // Closing a viewer is handled immediately via CLOSED/tabs.onRemoved.
        if (performance.now() - session.lastHeartbeat > 120000) {
          void this.fail(session, "error", "延迟播放页长时间无响应，已停止采集。请重新启动。");
        }
      }, 3000);
      return this.snapshot();
    } catch (error) { await this.fail(session, "error", errorText(error)); return this.snapshot(); }
  }
  setDelay(value) {
    this.state.delay = normalizeDelay(value);
    this.session?.channel.postMessage({ type: "DELAY", delay: this.state.delay });
    this.emit();
    return this.snapshot();
  }
  async setRegion({ sessionId, geometry, error }) {
    const session = this.session;
    if (!session || this.state.sessionId !== sessionId) return this.snapshot();
    if (error || !geometry?.rect) await this.fail(session, "interrupted", error || "播放器区域已丢失，请重新启动。");
    else {
      session.cropper?.setGeometry(geometry);
      Object.assign(this.state, { sourceWidth: geometry.sourceWidth, sourceHeight: geometry.sourceHeight });
    }
    return this.snapshot();
  }
  async release(session) {
    if (!session) return;
    clearInterval(session.timer);
    session.listeners.forEach(remove => remove());
    let encoderStopped = Promise.resolve();
    if (session.recorder) {
      session.recorder.onstop = session.recorder.onerror = session.recorder.ondataavailable = null;
      if (session.recorder.state !== "inactive") {
        encoderStopped = new Promise(resolve => session.recorder.addEventListener("stop", resolve, { once: true }));
        session.recorder.stop();
      }
    }
    // Silence buffered output before allowing Chrome to restore the source audio.
    const released = new Promise(resolve => { session.released = resolve; });
    session.channel.postMessage({ type: "STOP" });
    await withTimeout(released, 1000).catch(() => {});
    await withTimeout(session.cropper?.close(), 2000).catch(() => {});
    session.audioSource?.disconnect();
    session.audioDestination?.stream.getTracks().forEach(track => track.stop());
    if (session.stream) stopTracks(session.stream);
    await withTimeout(encoderStopped, 2000).catch(() => {});
    if (session.context) await withTimeout(session.context.close(), 2000).catch(() => {});
    session.channel.close();
  }
  async recover(session) {
    if (this.session !== session || session.recovering) return;
    session.recovering = true;
    this.emit();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await withTimeout(session.context.resume(), 2000); } catch { /* bounded recovery */ }
      if (this.session !== session) return;
      if (session.context.state === "running") { session.recovering = false; this.emit(); return; }
    }
    await this.fail(session, "error", "音画音频处理暂停后无法恢复，请重新启动。");
  }
  async fail(session, phase, error) {
    if (!session || this.session !== session) return;
    this.session = null; // Cancel pending capture/consumer initialization too.
    this.state = { ...this.state, active: false, phase, error, notice: "", bufferRemaining: 0, pauseRemaining: 0 };
    // A viewer CLOSED event can race with the worker's STOP command. Keep the
    // release promise after clearing session so STOP still waits for tracks,
    // encoder and AudioContext cleanup before the document is destroyed.
    this.cleanupPromise = this.release(session);
    this.emit();
    await this.cleanupPromise;
  }
  async stop(reason = "") {
    const session = this.session;
    this.session = null;
    if (session) this.cleanupPromise = this.release(session);
    await this.cleanupPromise;
    this.state = { ...idleState(this.state.delay), mode: "av", tabId: this.state.tabId, tabTitle: this.state.tabTitle, notice: reason };
    this.emit();
    return this.snapshot();
  }
}
