import { CHANNEL, DEFAULT_DELAY, normalizeDelay, idleState } from "./shared.js";
import { videoOptions } from "./video-options.js";

const $ = id => document.getElementById(id);
const labels = { idle: "未启动", capturing: "正在捕获", running: "正常运行", interrupted: "捕获中断", error: "发生错误" };
let state = idleState();
let busy = false;
let adjusting = false;
let editVersion = 0;
let delayTimer;
let pendingDelay = null;
let delaySending = false;
let uiError = "";
let selectedTab = null;
let selectingTab = true;
const targetReady = chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
  selectedTab = tabs[0] || null;
}).catch(error => { uiError = error.message; }).finally(() => {
  selectingTab = false;
  render();
});

async function send(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type, ...data });
  if (!reply?.ok) throw new Error(reply?.error || "后台没有响应，请回到网页点击扩展图标重试。");
  return reply.state;
}

function render(next = state) {
  if (next) state = next;
  const tabTitle = state.active ? state.tabTitle : selectedTab?.title || state.tabTitle;
  $("tab-title").textContent = tabTitle || (selectingTab ? "正在读取当前标签页…" : "尚未选择");
  $("tab-title").title = tabTitle || "";
  const pausing = state.phase === "running" && state.pauseRemaining > 0.02;
  $("status-label").textContent = pausing ? "暂停输出 · 正在增加延迟" : labels[state.phase] || "未启动";
  $("status-dot").className = `dot ${state.phase}`;
  const buffering = state.bufferRemaining > 0.15;
  const av = state.mode === "av";
  $("status-detail").textContent = state.notice || (state.active
    ? pausing ? `直播继续缓存，约 ${state.pauseRemaining.toFixed(1)} 秒后自动恢复${av ? "音画" : "声音"}。`
      : buffering ? `正在填充${av ? "音画" : "音频"}缓冲，预计还需 ${state.bufferRemaining.toFixed(1)} 秒。`
      : state.transitionRemaining > 0.01 ? "正在切换到已有音频缓冲，不改变播放速度。"
        : av ? `输出 ${state.outputWidth || state.width || "—"} × ${state.outputHeight || state.height || "—"} · 实测 ${state.outputFps?.toFixed(1) ?? "—"}fps` : "独立处理标签页音频，网页画面继续播放。"
    : "点击开始延迟，捕获当前网页音频。关闭面板后仍会运行。");
  if (!adjusting && pendingDelay === null && !delaySending) showDelay(state.delay);
  $("start").disabled = busy || state.active || selectingTab;
  $("stop").disabled = busy || !state.active;
  $("delay-slider").disabled = busy;
  $("mode").value = state.mode || "audio";
  $("mode").disabled = busy || state.active;
  const options = videoOptions(state);
  $("video-settings").hidden = !av;
  $("quality").value = options.quality;
  $("region").value = options.region;
  $("quality").disabled = $("region").disabled = busy || state.active;
  $("pick-region").hidden = options.region !== "manual";
  $("pick-region").disabled = busy || state.active || selectingTab;
  $("video-format").hidden = !state.active && !(state.phase === "error" && state.captureWidth);
  $("video-format").textContent = `${state.sourceWidth ? `播放器源 ${state.sourceWidth}×${state.sourceHeight} · ` : ""}`
    + `${state.cropWidth ? `采集区域 ${state.cropWidth}×${state.cropHeight}` : `网页采集 ${state.captureWidth || "—"}×${state.captureHeight || "—"}`}`
    + `${state.videoBitrate ? ` · 目标编码 ${(state.videoBitrate / 1_000_000).toFixed(0)}Mbps` : ""}`;
  if (state.encodedMbps) $("video-format").textContent += ` · 数据平均 ${state.encodedMbps.toFixed(1)}Mbps`;
  if (state.bufferedSeconds) $("video-format").textContent += ` · 缓冲 ${state.bufferedSeconds.toFixed(1)}秒`;
  $("open-viewer").hidden = !state.active || !av;
  for (const id of ["reset", "decrease", "increase"]) $(id).disabled = busy;
  $("error").textContent = uiError || state.error || "";
  $("error").hidden = !$("error").textContent;
}

function showDelay(value) {
  $("delay-slider").value = value;
  $("delay-value").value = Number(value).toFixed(1);
}

async function command(type) {
  if (busy) return;
  busy = true;
  uiError = "";
  render();
  try {
    // Commit the last slider edit before starting/stopping.
    await flushDelay();
    if (type === "START" || type === "CROP_PICKER") {
      await targetReady;
      if (!Number.isInteger(selectedTab?.id)) throw new Error("请在直播网页上点击扩展图标，再点击开始延迟。");
    }
    render(await send(type, type === "START" ? { tabId: selectedTab.id, mode: $("mode").value }
      : type === "CROP_PICKER" ? { tabId: selectedTab.id } : {}));
  } catch (error) { uiError = error.message; }
  finally { busy = false; render(); }
}

function queueDelay(value, defer = false) {
  ++editVersion;
  pendingDelay = normalizeDelay(value);
  showDelay(pendingDelay);
  clearTimeout(delayTimer);
  if (defer || adjusting) return; // Dragging previews only; commit on release.
  delayTimer = setTimeout(() => { void flushDelay(); }, 120);
}

async function flushDelay() {
  clearTimeout(delayTimer);
  // One in-flight update; subsequent slider edits coalesce to their latest value.
  if (delaySending) {
    await delaySending;
    return flushDelay();
  }
  if (pendingDelay === null) return;
  const delay = pendingDelay;
  pendingDelay = null;
  delaySending = (async () => {
    try { uiError = ""; render(await send("DELAY", { delay })); }
    catch (error) { uiError = error.message; }
  })();
  await delaySending;
  delaySending = false;
  if (pendingDelay !== null) return flushDelay();
  render();
}

$("start").addEventListener("click", () => void command("START"));
$("stop").addEventListener("click", () => void command("STOP"));
$("open-viewer").addEventListener("click", () => void command("OPEN_VIEWER"));
$("pick-region").addEventListener("click", () => void command("CROP_PICKER"));
for (const id of ["quality", "region"]) $(id).addEventListener("change", async () => {
  if (busy || state.active) return;
  const options = { quality: $("quality").value, region: $("region").value };
  busy = true; uiError = ""; render();
  try { render(await send("VIDEO_OPTIONS", { options })); }
  catch (error) { uiError = error.message; }
  finally { busy = false; render(); }
});
$("mode").addEventListener("change", async event => {
  busy = true;
  const mode = event.target.value;
  render();
  try { render(await send("MODE", { mode })); } catch (error) { uiError = error.message; }
  finally { busy = false; render(); }
});
$("reset").addEventListener("click", () => queueDelay(DEFAULT_DELAY));
$("decrease").addEventListener("click", () => queueDelay(Number($("delay-slider").value) - 0.5));
$("increase").addEventListener("click", () => queueDelay(Number($("delay-slider").value) + 0.5));
$("delay-slider").addEventListener("pointerdown", () => { adjusting = true; });
$("delay-slider").addEventListener("input", event => queueDelay(Number(event.target.value), true));
window.addEventListener("pointerup", () => { adjusting = false; void flushDelay(); });
window.addEventListener("pointercancel", () => { adjusting = false; void flushDelay(); });
$("delay-slider").addEventListener("change", () => { adjusting = false; void flushDelay(); });

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.channel === CHANNEL && message.target === "control" && message.type === "STATE_CHANGED") render(message.state);
});

async function refresh() {
  const version = editVersion;
  try {
    const next = await send("STATE");
    if (!busy && version === editVersion && !delaySending && pendingDelay === null) render(next);
  } catch (error) { uiError = error.message; render(); }
}

// Poll only while this UI is open. Audio playback never depends on this timer.
void refresh();
const refreshTimer = setInterval(() => { void refresh(); }, 250);
window.addEventListener("pagehide", () => {
  clearInterval(refreshTimer);
  clearTimeout(delayTimer);
  if (pendingDelay !== null) {
    void chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type: "DELAY", delay: pendingDelay }).catch(() => {});
  }
});
render();
