import { DelayGraph } from "./audio-graph.js";
import { idleState, normalizeDelay, errorText, withTimeout } from "./shared.js";

const stopTracks = stream => stream.getTracks().forEach(track => track.stop());

// One interruption cycle gets a bounded number of resume attempts. Never loop forever.
const RECOVERY_LIMIT = 3;
const RESUME_TIMEOUT_MS = 2000;
const CLOSE_TIMEOUT_MS = 2000;
const DEVICE_FAILURE = "音频设备变化后无法恢复音频输出，已释放采集并恢复网页原声。请重新启动。";
const SUSPEND_NOTICE = "音频输出被暂停，正在尝试恢复…";
const SUSPEND_FAILURE = "音频输出暂停后无法恢复，已释放采集并恢复网页原声。请重新启动。";
const MUTE_NOTICE = "采集流暂时中断；保留缓冲并等待恢复，不会重新加载播放器。";

const contextStateOf = context => context?.state || "closed";

export class AudioEngine {
  constructor({ mediaDevices, createContext, onChange = () => {} }) {
    this.mediaDevices = mediaDevices;
    this.createContext = createContext;
    this.onChange = onChange;
    this.state = idleState();
    this.session = null;
    this.generation = 0;
    this.deviceChanged = () => {
      // Keep the existing capture, delay graph and buffered audio. Only the
      // AudioContext's observable state is re-checked; capture is never reacquired.
      const session = this.session;
      if (!session?.graph || !session.context) return;
      void this.recover(session, "device");
    };
    mediaDevices.addEventListener?.("devicechange", this.deviceChanged);
  }

  emit() { this.onChange(this.snapshot()); }

  snapshot() {
    const session = this.session;
    const context = session?.context;
    return {
      ...this.state,
      ...(session?.graph?.timing() || {}),
      // Buffered audio, scheduled adjustment pauses and the raw AudioContext
      // state stay separate so the panel can describe what is actually observable.
      contextState: context ? context.state : (this.state.contextState || "closed"),
      sampleRate: context ? context.sampleRate : (this.state.sampleRate || null),
      recovering: Boolean(session?.recovering),
      recoveryAttempt: this.state.recoveryAttempt || 0,
      recoveryLimit: RECOVERY_LIMIT,
    };
  }

  async start({ streamId, tabId, tabTitle, sessionId, delay }) {
    // A second Start shares the active session; a Start issued while the
    // previous session is still closing must not open a second audio graph.
    if (this.session || this.stopping) return this.snapshot();
    const value = normalizeDelay(delay);
    const token = ++this.generation;
    const session = {
      token, stream: null, context: null, graph: null, timer: null,
      recovering: false, recoveryReason: "", listeners: [],
    };
    this.session = session;
    this.state = {
      ...idleState(value), active: true, phase: "capturing", contextState: "closed",
      tabId, tabTitle, sessionId, startedAt: Date.now(), recoveryAttempt: 0,
    };
    this.emit();
    try {
      const stream = await withTimeout(this.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: false,
      }), 12000, stopTracks);
      // A Stop (or a newer session) while capture is pending: release the late
      // stream and never construct an audio graph for it.
      if (this.generation !== token) { await this.discardTracked(session, stream); return this.snapshot(); }
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
      if (this.generation !== token) { await this.discardTracked(session); return this.snapshot(); }
      if (context.state !== "running") throw new Error("音频输出未能启动，已释放采集。请回到网页重新启动。");
      session.graph = new DelayGraph(context, context.createMediaStreamSource(stream), this.state.delay);
      this.listen(session, context, "statechange", () => {
        if (this.session !== session) return;
        if (context.state === "closed") {
          void this.fail(session, "error", "音频输出意外关闭，已释放采集。请重新启动。");
        } else {
          this.updateHealth(session);
          if (context.state !== "running") void this.recover(session, "context");
        }
      });
      this.updateHealth(session);
      // Local health check only: no worker heartbeat or repeated capture attempts.
      session.timer = setInterval(() => {
        if (this.session === session && context.state !== "running") void this.recover(session, "context");
      }, 2000);
      return this.snapshot();
    } catch (error) {
      // Errors raised after a Stop belong to a dead session: release quietly.
      if (this.generation !== token) { await this.discardTracked(session); return this.snapshot(); }
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
    const contextState = contextStateOf(session.context);
    const muted = session.stream ? session.stream.getAudioTracks().some(track => track.muted) : false;
    const paused = contextState !== "running";
    const attempt = this.state.recoveryAttempt || 0;
    this.state.phase = paused || muted ? "interrupted" : "running";
    this.state.contextState = contextState;
    this.state.notice = paused
      ? session.recovering
        ? `${session.recoveryReason === "device" ? "音频设备已变化" : "音频输出已暂停"}，正在恢复${attempt ? `（第 ${attempt}/${RECOVERY_LIMIT} 次）` : ""}；采集流与延迟缓冲保持不变。`
        : SUSPEND_NOTICE
      : muted ? MUTE_NOTICE : "";
    this.emit();
  }

  async recover(session, reason = "context") {
    if (this.session !== session || !session.context || session.recovering) return false;
    if (contextStateOf(session.context) === "running") {
      // A device change can arrive while output is still running. Keep the
      // capture/graph; just re-confirm the observable state and clear hints.
      this.state.recoveryAttempt = 0;
      this.updateHealth(session);
      return true;
    }
    session.recovering = true;
    session.recoveryReason = reason;
    this.state.recoveryAttempt = 0;
    this.updateHealth(session);
    // Bounded AudioContext recovery for each interruption. Never recapture.
    for (let attempt = 1; attempt <= RECOVERY_LIMIT; attempt++) {
      if (this.session !== session) return false;
      this.state.recoveryAttempt = attempt;
      this.updateHealth(session);
      try { await withTimeout(session.context.resume(), RESUME_TIMEOUT_MS); } catch { /* bounded retry */ }
      if (this.session !== session) return false;
      if (contextStateOf(session.context) === "running") {
        session.recovering = false;
        session.recoveryReason = "";
        this.state.recoveryAttempt = 0;
        this.updateHealth(session); // Back to running; recovery notice cleared.
        return true;
      }
    }
    if (this.session !== session) return false;
    session.recovering = false;
    session.recoveryReason = "";
    await this.fail(session, "error", reason === "device" ? DEVICE_FAILURE : SUSPEND_FAILURE);
    return false;
  }

  setDelay(delay) {
    this.state.delay = normalizeDelay(delay);
    this.session?.graph?.setDelay(this.state.delay);
    this.emit();
    return this.snapshot();
  }

  // Release anything a stopped/aborted start produced after Stop ran. Idempotent:
  // each component is detached before closing, so an AudioContext created after
  // the first cleanup is still released and no audio graph is ever built.
  async discard(session, stream = null) {
    if (stream) stopTracks(stream);
    if (!session) return;
    clearInterval(session.timer);
    session.timer = null;
    session.listeners.forEach(remove => remove());
    session.listeners = [];
    const graph = session.graph;
    session.graph = null;
    if (graph) {
      try { graph.disconnect(); } catch { /* context may already be closed */ }
    }
    const captured = session.stream;
    session.stream = null;
    if (captured) stopTracks(captured);
    const context = session.context;
    session.context = null;
    if (context && context.state !== "closed") {
      try { await withTimeout(context.close(), CLOSE_TIMEOUT_MS); } catch { /* already gone */ }
    }
  }

  async release(session) {
    if (!session) return;
    // Disconnect output FIRST, then stop tracks; no delayed tail over restored audio.
    await this.discard(session);
  }

  // Aborted starts share the cleanup registry so a following stop/start waits
  // for a late capture's track and AudioContext to finish releasing.
  discardTracked(session, stream = null) {
    return this.trackCleanup(this.discard(session, stream));
  }

  trackCleanup(cleanup) {
    const previous = this.cleanupPromise || Promise.resolve();
    this.pendingCleanups = (this.pendingCleanups || 0) + 1;
    const wrapped = Promise.resolve(cleanup).catch(() => {}).finally(() => { this.pendingCleanups--; });
    // A repeated Stop or a late error must not hide an in-flight cleanup.
    this.cleanupPromise = Promise.all([previous, wrapped]).then(() => {});
    return this.cleanupPromise;
  }

  // Terminal state that cannot be confused with a newer running session.
  clearState(phase, { error = "", notice = "", reason = "" } = {}) {
    return {
      ...idleState(this.state.delay), phase, active: false,
      tabId: this.state.tabId, tabTitle: this.state.tabTitle,
      mode: this.state.mode || "audio", sampleRate: this.state.sampleRate || null,
      contextState: "closed", error, notice: reason || notice, recoveryAttempt: 0, recoveryLimit: RECOVERY_LIMIT,
    };
  }

  async fail(session, phase, message) {
    if (!session || this.session !== session) return;
    ++this.generation;
    this.session = null;
    // Mark terminal state before awaiting close; a concurrent new session cannot be overwritten.
    this.state = this.clearState(phase, { error: message });
    const cleanup = this.trackCleanup(this.release(session));
    await cleanup;
    if (this.session) return; // A new session started during cleanup; keep its state.
    this.emit();
  }

  async stop(reason = "") {
    // Repeated Stop shares the in-flight cleanup. It must never act on a
    // session that started after the first Stop began.
    if (this.stopping) return this.stopping;
    if (!this.session && this.pendingCleanups) {
      // A terminal error is still releasing resources. Wait for that cleanup but
      // keep the readable error/phase; a late Stop must not rewrite it as idle.
      await (this.cleanupPromise || Promise.resolve());
      return this.snapshot();
    }
    if (!this.session) {
      // A Stop after a completed Stop is a no-op: it must not overwrite the
      // notice/error of the session that already ended.
      if (reason && this.state.phase === "idle") {
        this.state = { ...this.state, notice: reason };
        this.emit();
      }
      return this.snapshot();
    }
    ++this.generation;
    const session = this.session;
    this.session = null;
    this.state = this.clearState("idle", { reason });
    this.trackCleanup(this.release(session));
    this.stopping = (async () => {
      await (this.cleanupPromise || Promise.resolve());
      if (this.session) return this.snapshot(); // Restarted meanwhile; do not clobber.
      this.emit();
      return this.snapshot();
    })();
    try { return await this.stopping; } finally { this.stopping = null; }
  }
}
