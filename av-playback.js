import { normalizeDelay } from "./shared.js";

export const SAFETY_BUFFER = 0.75;
export const RETAIN_SECONDS = 75;

// Every src/currentTime operation here belongs to OUR extension video element.
// Source website elements are never accessed by the extension.
export class AVPlayback {
  constructor(video, { onStatus = () => {}, onError = () => {} } = {}) {
    this.video = video;
    this.onStatus = onStatus;
    this.onError = onError;
    this.queue = [];
    this.queuedBytes = 0;
    this.maxQueuedBytes = 16 * 1024 * 1024;
    this.sequence = 0;
    this.delay = 30;
    this.started = false;
    this.adjusting = false;
    this.blocked = false;
    this.closed = false;
    this.removedThrough = 0;
    this.wantPlay = false;
    this.errorHandler = () => this.fail(`延迟视频解码失败（${video.error?.code || "未知"}），请重新启动。`);
    video.addEventListener("error", this.errorHandler);
  }
  async configure(mime, delay) {
    if (!MediaSource.isTypeSupported(mime)) throw new Error("此 Chrome 不支持延迟播放所需的媒体格式，请使用纯音频模式。");
    this.delay = normalizeDelay(delay);
    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("延迟播放页初始化超时。")), 6000);
      this.mediaSource.addEventListener("sourceopen", () => {
        clearTimeout(timer);
        try {
          this.buffer = this.mediaSource.addSourceBuffer(mime);
          this.buffer.addEventListener("updateend", () => { this.pump(); this.tick(); });
          this.buffer.addEventListener("error", () => this.fail("媒体缓冲解析失败，请重新启动。"));
          this.timer = setInterval(() => this.tick(), 250);
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
      // Register sourceopen before resource selection and explicitly start the
      // extension player's load. The source site's media is never touched.
      this.video.src = this.url;
      this.video.load();
    });
  }
  append(bytes, sequence) {
    if (this.closed) return;
    if (sequence !== this.sequence++) { this.fail("音画数据不连续，已停止播放，请重新启动。"); return; }
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    if (this.queuedBytes > this.maxQueuedBytes) { this.fail("播放缓冲积压过多，请重新启动或选择较低画质。"); return; }
    this.pump();
  }
  range() {
    const ranges = this.buffer?.buffered;
    return ranges?.length ? { start: ranges.start(ranges.length - 1), end: ranges.end(ranges.length - 1) } : { start: 0, end: 0 };
  }
  liveTime() {
    return this.origin === undefined ? this.range().end : Math.max(0, (performance.timeOrigin + performance.now() - this.origin) / 1000);
  }
  seekTarget(start, end) {
    return Math.max(start + 0.01, Math.min(end - 0.15, this.liveTime() - this.delay - SAFETY_BUFFER));
  }
  pump() {
    if (this.closed || !this.buffer || this.buffer.updating || this.mediaSource.readyState !== "open") return;
    const { end } = this.range();
    const retention = Math.min(RETAIN_SECONDS, this.delay + SAFETY_BUFFER + 6);
    const removeBefore = Math.min(end - retention, this.video.currentTime - 3);
    try {
      if (removeBefore > this.removedThrough + 1) {
        this.removedThrough = removeBefore;
        this.buffer.remove(0, removeBefore);
      } else if (this.queue.length) {
        const bytes = this.queue[0];
        try {
          this.buffer.appendBuffer(bytes);
          this.queue.shift();
          this.queuedBytes -= bytes.byteLength;
        } catch (error) {
          // Chrome's media quota can be reached before the time-based trim at
          // high bitrate. Reclaim already-played history, retaining the current
          // decode neighborhood. Keep this exact chunk for the updateend retry.
          const through = this.video.currentTime - 1.5;
          if (error.name !== "QuotaExceededError" || through <= this.removedThrough + 0.5) throw error;
          this.removedThrough = through;
          this.buffer.remove(0, through);
        }
      }
    } catch (error) {
      this.fail(error.name === "QuotaExceededError"
        ? "浏览器音画缓存已达到内存上限，已安全停止。请选择较低画质或较短延迟后重新启动。"
        : `媒体缓冲无法继续：${error.message}。请重新启动。`);
    }
  }
  setDelay(value) {
    const next = normalizeDelay(value);
    if (next === this.delay) return;
    const previous = this.delay;
    this.delay = next;
    if (this.started) {
      this.video.pause();
      if (next > previous) this.adjusting = true;
      else {
        this.adjusting = false;
        const { start, end } = this.range();
        this.video.currentTime = this.seekTarget(start, end);
      }
    }
    this.tick();
  }
  async play(userGesture = false) {
    if (this.closed || this.wantPlay || (this.blocked && !userGesture)) return;
    this.wantPlay = true;
    try { await this.video.play(); this.blocked = false; }
    catch (error) {
      if (error.name === "NotAllowedError") this.blocked = true;
      else if (error.name !== "AbortError") this.fail(`无法播放延迟音画：${error.message}`);
    } finally { this.wantPlay = false; }
  }
  tick() {
    if (this.closed) return;
    const { start, end } = this.range();
    const desired = this.delay + SAFETY_BUFFER;
    let remaining = Math.max(0, desired - (this.liveTime() - this.video.currentTime));
    if (!this.started && end - start >= desired) {
      this.video.currentTime = this.seekTarget(start, end);
      this.started = true;
    }
    if (this.started) {
      if (this.adjusting && remaining <= 0.06) this.adjusting = false;
      if (!this.adjusting) {
        // No speed changes. Recover from stalls/background suspension by one
        // bounded seek in our player, keeping audio and video on the same clock.
        if (this.liveTime() - this.video.currentTime > desired + 1.5 || this.video.currentTime < start) {
          this.video.pause();
          this.video.currentTime = this.seekTarget(start, end);
        }
        if (this.video.paused && end - this.video.currentTime > 0.25) void this.play();
      }
    }
    remaining = Math.max(0, desired - (this.liveTime() - this.video.currentTime));
    if (!this.started) remaining = Math.max(remaining, desired - (end - start));
    this.onStatus({ phase: !this.started ? "capturing" : this.video.readyState < 3 ? "interrupted" : "running",
      bufferRemaining: !this.started ? remaining : 0, pauseRemaining: this.adjusting ? remaining : 0,
      actualDelay: this.started ? Math.max(0, end - this.video.currentTime) : null,
      bufferedSeconds: end - start, blocked: this.blocked,
      notice: this.blocked ? "请在延迟播放页点击「播放声音与画面」，允许 Chrome 输出。"
        : this.started && this.video.readyState < 3 ? "采集数据暂时不足，正在等待恢复；不会操作原网页播放器。" : "" });
    this.pump();
  }
  fail(error) { if (!this.closed) { this.close(); this.onError(error); } }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.video.removeEventListener("error", this.errorHandler);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.queue = [];
    this.queuedBytes = 0;
  }
}
