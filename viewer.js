import { AV_CHANNEL } from "./shared.js";
import { AVPlayback } from "./av-playback.js";
import { VIDEO_PRESETS } from "./video-options.js";

const $ = id => document.getElementById(id);
const sessionId = location.hash.slice(1);
const channel = new BroadcastChannel(AV_CHANNEL(sessionId));
let configured = false;
let lastReport = 0;
let ended = false;
let format = {}, fps = null, sampleTime = performance.now(), sampleFrames = 0;
const playback = new AVPlayback($("video"), {
  onStatus: state => {
    const now = performance.now();
    const quality = $("video").getVideoPlaybackQuality();
    const displayed = quality.totalVideoFrames - quality.droppedVideoFrames;
    if ($("video").paused || !playback.started) { sampleTime = now; sampleFrames = displayed; fps = null; }
    else if (now - sampleTime >= 3000) {
      fps = Math.max(0, (displayed - sampleFrames) * 1000 / (now - sampleTime));
      sampleTime = now; sampleFrames = displayed;
    }
    $("play").hidden = !state.blocked;
    const buffering = state.bufferRemaining > 0.05;
    const pausing = state.pauseRemaining > 0.05;
    $("overlay").hidden = !buffering && !pausing && !state.blocked && state.phase === "running";
    $("status").textContent = state.notice || (pausing ? `正在增加延迟，约 ${state.pauseRemaining.toFixed(1)} 秒后恢复音画`
      : buffering ? `正在缓存音画，约 ${state.bufferRemaining.toFixed(1)} 秒后开始播放` : "正在等待音画数据…");
    const width = $("video").videoWidth || format.width, height = $("video").videoHeight || format.height;
    $("detail").textContent = `目标 ${playback.delay.toFixed(1)} 秒 · 缓冲位置差 ${state.actualDelay?.toFixed(1) ?? "—"} 秒 · 输出 ${width || "—"}×${height || "—"} · 实测 ${fps?.toFixed(1) ?? "—"}fps`;
    if (now - lastReport > 500) { lastReport = now; channel.postMessage({ type: "STATUS", ...state,
      outputFps: fps, outputWidth: width, outputHeight: height }); }
  },
  onError: error => { $("overlay").hidden = false; $("status").textContent = error; channel.postMessage({ type: "ERROR", error }); },
});
channel.onmessage = async ({ data }) => {
  if (ended) return;
  if (data.type === "CONFIG" && !configured) {
    configured = true;
    format = data;
    playback.maxQueuedBytes = Math.max(16 * 1024 * 1024, Math.min(32 * 1024 * 1024, data.maxQueuedBytes || 0));
    clearInterval(hello);
    $("title").textContent = `${data.tabTitle} · ${data.region === "tab" ? "整个标签页" : data.region === "manual" ? "手动区域" : "播放器区域"} · ${VIDEO_PRESETS[data.quality]?.label || "720p / 30fps"}`;
    try { await playback.configure(data.mime, data.delay); channel.postMessage({ type: "READY" }); }
    catch (error) { playback.fail(error.message); }
  }
  if (data.type === "CHUNK") playback.append(data.bytes, data.sequence);
  if (data.type === "STARTED") playback.origin = data.origin;
  if (data.type === "DELAY") { lastReport = 0; playback.setDelay(data.delay); }
  if (data.type === "STOP") {
    ended = true;
    playback.close();
    channel.postMessage({ type: "RELEASED" });
    $("overlay").hidden = false;
    $("play").hidden = true;
    $("status").textContent = "已停止音画延迟，网页恢复原声。";
  }
};
const hello = setInterval(() => channel.postMessage({ type: "HELLO" }), 500);
channel.postMessage({ type: "HELLO" });
$("play").addEventListener("click", () => { void playback.play(true); });
$("fullscreen").addEventListener("click", async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $("stage").requestFullscreen(); }
  catch (error) { $("overlay").hidden = false; $("status").textContent = `无法进入全屏：${error.message}`; }
});
window.addEventListener("pagehide", () => {
  clearInterval(hello);
  playback.close();
  channel.postMessage({ type: "CLOSED" });
  channel.close();
});
