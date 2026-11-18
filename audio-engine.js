import { DelayGraph } from "./audio-graph.js";
import { idleState, normalizeDelay, errorText, withTimeout } from "./shared.js";

const stopTracks = stream => stream.getTracks().forEach(track => track.stop());

export class AudioEngine {
  constructor({ mediaDevices, createContext, onChange = () => {} }) {
    this.mediaDevices = mediaDevices;
    this.createContext = createContext;
    this.onChange = onChange;
    this.state = idleState();
    this.session = null;
    this.generation = 0;
    this.deviceChanged = () => {
      if (!this.session) return;
      this.state.notice = "音频设备发生变化；输出跟随系统默认设备。如无声音，请停止后重新启动。";
      this.emit();
      void this.recover(this.session);
    };
    mediaDevices.addEventListener?.("devicechange", this.deviceChanged);
  }

  emit() { this.onChange(this.snapshot()); }

  snapshot() {
    return {
      ...this.state,
      ...(this.session?.graph?.timing() || {}),
      contextState: this.session?.context?.state || "closed",
      sampleRate: this.session?.context?.sampleRate || null,
    };
  }

  async start({ streamId, tabId, tabTitle, sessionId, delay }) {
    if (this.session) return this.snapshot();
    const value = normalizeDelay(delay);
    const token = ++this.generation;
    const session = { token, stream: null, context: null, graph: null, timer: null, recovering: false, listeners: [] };
    this.session = session;
    this.state = {
      ...idleState(value), active: true, phase: "capturing",
      tabId, tabTitle, sessionId, startedAt: Date.now(),
    };
    this.emit();
    try {
      const stream = await withTimeout(this.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: false,
      }), 12000, stopTracks);
      if (this.generation !== token) { stopTracks(stream); return this.snapshot(); }
      session.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some(track => track.readyState === "ended")) {
        throw new Error("采集流没有可用音轨，请回到网页重新启动。");
      }
      for (const track of tracks) {
        this.listen(session, track, "ended", () => void this.fail(session, "interrupted", "标签页音频采集已结束，已恢复网页原声。请回到网页重新启动。"));
        this.listen(session, track, "mute", () => this.updateHealth(session));
        this.listen(session, track, "unmute", () => this.updateHealth(session));
      }
      const context = this.createContext();
      session.context = context;
      // resume before wiring live input; no direct passthrough while starting.
      await withTimeout(context.resume(), 4000);
      if (this.generation !== token) return this.snapshot();
      if (context.state !== "running") throw new Error("音频输出未能启动，已释放采集。请回到网页重新启动。");
      session.graph = new DelayGraph(context, context.createMediaStreamSource(stream), this.state.delay);
      this.listen(session, context, "statechange", () => {
        if (context.state === "closed") {
          void this.fail(session, "error", "音频输出意外关闭，已释放采集。请重新启动。");
        } else {
          this.updateHealth(session);
          if (context.state !== "running") void this.recover(session);
        }
      });
      this.updateHealth(session);
      // Local health check only: no worker heartbeat or repeated capture attempts.
      session.timer = setInterval(() => {
        if (session.context.state !== "running") void this.recover(session);
      }, 2000);
      return this.snapshot();
    } catch (error) {
      await this.fail(session, "error", errorText(error));
      return this.snapshot();
    }
  }

  listen(session, target, event, handler) {
    target.addEventListener(event, handler);
    session.listeners.push(() => target.removeEventListener(event, handler));
  }

  updateHealth(session) {
    if (this.session !== session || !session.graph) return;
    const muted = session.stream.getAudioTracks().some(track => track.muted);
    const paused = session.context.state !== "running";
    this.state.phase = muted || paused ? "interrupted" : "running";
    this.state.notice = paused ? "音频输出被暂停，正在尝试恢复。"
      : muted ? "采集流暂时中断；保留缓冲并等待恢复，不会重新加载播放器。" : "";
    this.emit();
  }

  async recover(session) {
    if (this.session !== session || session.recovering || !session.context) return;
    if (session.context.state === "running") return;
    session.recovering = true;
    this.updateHealth(session);
    // Bounded AudioContext recovery for each interruption. Never recapture automatically.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.session !== session) return;
      try { await withTimeout(session.context.resume(), 2000); } catch { /* bounded retry */ }
      if (this.session !== session) return;
      if (session.context.state === "running") {
        session.recovering = false;
        this.updateHealth(session);
        return;
      }
    }
    await this.fail(session, "error", "音频输出暂停后无法恢复，已释放采集并恢复网页原声。请重新启动。");
  }

  setDelay(delay) {
    this.state.delay = normalizeDelay(delay);
    this.session?.graph?.setDelay(this.state.delay);
    this.emit();
    return this.snapshot();
  }

  async release(session) {
    if (!session) return;
    clearInterval(session.timer);
    session.listeners.forEach(remove => remove());
    // Disconnect output FIRST, then stop tracks; no delayed tail over restored audio.
    try { session.graph?.disconnect(); } catch { /* context may already be closed */ }
    if (session.stream) stopTracks(session.stream);
    if (session.context && session.context.state !== "closed") {
      try { await withTimeout(session.context.close(), 2000); } catch { /* capture is already released */ }
    }
  }

  async fail(session, phase, message) {
    if (!session || this.session !== session) return;
    ++this.generation;
    this.session = null;
    // Mark terminal state before awaiting close; a concurrent new session cannot be overwritten.
    this.state = { ...this.state, phase, active: false, error: message, notice: "", bufferRemaining: 0, transitionRemaining: 0, pauseRemaining: 0 };
    await this.release(session);
    this.emit();
  }

  async stop(reason = "") {
    ++this.generation;
    const session = this.session;
    this.session = null;
    this.state = { ...idleState(this.state.delay), tabId: this.state.tabId, tabTitle: this.state.tabTitle, notice: reason };
    await this.release(session);
    this.emit();
    return this.snapshot();
  }
}
