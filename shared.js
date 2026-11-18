export const DEFAULT_DELAY = 30;
export const MAX_DELAY = 60;
export const CHANNEL = "live-audio-sync";
export const AV_CHANNEL = sessionId => `live-audio-sync-av-${sessionId}`;
export const normalizeMode = mode => mode === "av" ? "av" : "audio";
export const ACTIVE_PHASES = new Set(["capturing", "running", "interrupted"]);

export function normalizeDelay(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("延迟必须是有效数字。");
  }
  return Math.round(Math.min(MAX_DELAY, Math.max(0, value)) * 10) / 10;
}

export function idleState(delay = DEFAULT_DELAY) {
  return {
    phase: "idle", active: false, mode: "audio", delay, tabId: null, tabTitle: "",
    sessionId: null, error: "", notice: "", contextState: "closed",
    bufferRemaining: 0, transitionRemaining: 0, pauseRemaining: 0,
  };
}

export function errorText(error) {
  const name = error?.name || "Error";
  const descriptions = {
    NotAllowedError: "Chrome 未允许采集。请回到要采集的网页，再点击扩展图标。",
    NotFoundError: "找不到标签页音频流。请确认网页仍在播放，然后重新启动。",
    NotReadableError: "Chrome 无法读取标签页采集流。请停止其他采集扩展，必要时刷新网页后重新启动。",
    AbortError: "音频采集被取消，请重新启动。",
    TimeoutError: "音频采集或输出启动超时，已释放资源。请回到网页重新启动。",
  };
  return descriptions[name] || String(error?.message || "发生未知错误，请重新启动。");
}

// Late getUserMedia results must be stopped after a timeout/cancellation.
export function withTimeout(promise, ms, onLateResolve = () => {}) {
  let expired = false;
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(value => {
      if (expired) onLateResolve(value);
      return value;
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new DOMException("操作超时", "TimeoutError"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
