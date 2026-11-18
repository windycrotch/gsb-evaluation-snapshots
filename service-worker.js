import { CHANNEL, DEFAULT_DELAY, normalizeDelay, normalizeMode, idleState, errorText, withTimeout } from "./shared.js";
import { videoOptions } from "./video-options.js";
import { locatePlayer, releaseLocator } from "./player-locator.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const CONTROL_URL = chrome.runtime.getURL("control.html");
const CROP_URL = chrome.runtime.getURL("crop.html");
let operations = Promise.resolve();

// Serialize mutations; repeated action clicks cannot create parallel audio paths.
function enqueue(operation) {
  const result = operations.then(operation);
  operations = result.catch(() => {});
  return result;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Consume user-authorized tab audio/video, process audio delay or encode bounded delayed A/V playback.",
  });
}

async function engineMessage(type, data = {}, timeout = 4000) {
  const result = await withTimeout(chrome.runtime.sendMessage({
    channel: CHANNEL, target: "offscreen", type, ...data,
  }), timeout);
  if (!result?.ok) throw new Error(result?.error || "音频引擎没有响应。");
  return result.state;
}

async function savedDelay() {
  const { delay = DEFAULT_DELAY } = await chrome.storage.local.get("delay");
  try { return normalizeDelay(delay); } catch { return DEFAULT_DELAY; }
}

async function savedMode() {
  return normalizeMode((await chrome.storage.local.get("mode")).mode);
}
async function savedVideoOptions() {
  return videoOptions((await chrome.storage.local.get("videoOptions")).videoOptions);
}
async function locate(tabId, sessionId, scope, manual) {
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    func: locatePlayer, args: [sessionId, scope, manual] });
  const result = results[0]?.result;
  if (!result || result.error) throw new Error(result?.error || "无法定位播放器，请手动框选或选择整个标签页。");
  return result;
}
async function removeLocator(state) {
  if (!state?.sessionId || !Number.isInteger(state.tabId) || state.mode !== "av" || state.region === "tab") return;
  await chrome.scripting.executeScript({ target: { tabId: state.tabId, frameIds: [0] },
    func: releaseLocator, args: [state.sessionId] }).catch(() => {});
}

async function remember(state) {
  await chrome.storage.session.set({ lastState: state });
  const text = state.active ? (state.phase === "capturing" ? "…" : state.phase === "interrupted" ? "~" : `${state.delay}s`)
    : state.phase === "error" || state.phase === "interrupted" ? "!" : "";
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color: state.active ? "#2769d3" : "#b95032" }),
    chrome.action.setTitle({ title: state.active ? `Live Audio Sync · ${state.delay.toFixed(1)} 秒 · ${state.tabTitle}` : "Live Audio Sync · 调整直播音画延迟" }),
  ]);
  void chrome.runtime.sendMessage({ channel: CHANNEL, target: "control", type: "STATE_CHANGED", state }).catch(() => {});
  return state;
}

async function readState() {
  const options = await savedVideoOptions();
  if (await hasOffscreen()) return { ...options, ...await engineMessage("STATE") };
  const { lastState } = await chrome.storage.session.get("lastState");
  if (lastState?.active) {
    return {
      ...options, ...lastState, active: false, phase: "interrupted", contextState: "closed",
      bufferRemaining: 0, transitionRemaining: 0, pauseRemaining: 0,
      error: "后台音频引擎已关闭，采集已释放。请回到网页点击扩展图标重新启动。",
    };
  }
  return { ...options, ...(lastState || { ...idleState(await savedDelay()), mode: await savedMode() }) };
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function closeViewer(state) {
  if (!Number.isInteger(state?.viewerTabId)) return;
  // Check identity as well as ID before closing an output tab.
  try {
    const tab = await chrome.tabs.get(state.viewerTabId);
    if (tab.url === chrome.runtime.getURL(`viewer.html#${state.sessionId}`)) await chrome.tabs.remove(tab.id);
  } catch { /* already closed */ }
}

async function start(tab, requestedMode) {
  const current = await readState();
  if (current.active) return current;
  const delay = await savedDelay();
  const mode = normalizeMode(requestedMode ?? await savedMode());
  await chrome.storage.local.set({ mode });
  if (!Number.isInteger(tab?.id) || !/^(https?|file):/.test(tab.url || "")) {
    return remember({ ...idleState(delay), phase: "error", error: "请在正在播放音频的普通网页上点击扩展图标（不支持 Chrome 设置页等内部页面）。" });
  }
  const target = { id: tab.id, title: tab.title || "当前标签页" };
  const options = await savedVideoOptions();
  const starting = { ...idleState(delay), ...options, mode, active: true, phase: "capturing", tabId: target.id, tabTitle: target.title,
    sessionId: crypto.randomUUID(), viewerTabId: null };
  await remember(starting);
  try {
    let geometry = null;
    if (mode === "av" && options.region !== "tab") {
      let manual = null;
      if (options.region === "manual") {
        manual = (await chrome.storage.session.get("manualCrop")).manualCrop;
        if (manual?.tabId !== tab.id || manual.url !== tab.url) throw new Error("请先为当前直播页框选播放器区域。");
      }
      geometry = await locate(tab.id, starting.sessionId, options.region, manual);
    }
    await ensureOffscreen();
    // Drain any previous terminal cleanup before obtaining a fresh short-lived
    // stream ID; never race a new capture against a closing native encoder.
    await engineMessage("CLEANUP", {}, 7000);
    if (mode === "av") {
      // Create the consumer before issuing a short-lived capture ID. Keeping it
      // inactive preserves the source tab's capture authorization and focus.
      const viewer = await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html#${starting.sessionId}`), active: false });
      starting.viewerTabId = viewer.id;
      // Honor an explicit Chrome tab/site mute before any delayed output can
      // start. This changes only our output tab, never the website's player.
      if (tab.mutedInfo?.muted) await chrome.tabs.update(viewer.id, { muted: true });
      await remember(starting);
    }
    // Official Chrome 116+ pattern: create consumer first, then obtain a fresh,
    // single-use ID in the worker. Never persist it or set consumerTabId.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
    const pending = engineMessage("START", { data: {
      streamId, tabId: target.id, tabTitle: target.title,
      sessionId: starting.sessionId, delay, mode, viewerTabId: starting.viewerTabId, ...options, geometry,
    } }, 25000);
    // A never-visible background tab may defer media loading/sourceopen. Make
    // the consumer visible after issuing the capture ID, BEFORE awaiting READY;
    // waiting for START first creates a cycle and its initialization times out.
    // Promise.all also observes both failures if activation or capture fails.
    const [result] = await Promise.all([pending, mode === "av"
      ? chrome.tabs.update(starting.viewerTabId, { active: true }) : Promise.resolve()]);
    if (!result.active) { await removeLocator(starting); await closeViewer(starting); await closeOffscreen(); }
    return remember(result);
  } catch (error) {
    // Closing the document also stops tracks if a START reply was lost.
    await removeLocator(starting);
    await closeViewer(starting);
    await closeOffscreen();
    return remember({ ...starting, active: false, phase: "error", error: `${errorText(error)} 请回到目标网页点击扩展图标重试。` });
  }
}

async function stop() {
  const current = await readState().catch(() => idleState());
  try {
    await closeViewer(current); // Remove A/V output before restoring source audio.
    if (await hasOffscreen()) await engineMessage("STOP", {}, current.mode === "av" ? 7000 : 5000);
  } catch {
    // Closing the offscreen document below is an independent release path.
  } finally {
    await removeLocator(current);
    // Last-resort cleanup if messaging/context.close failed.
    await closeOffscreen();
  }
  return remember({ ...idleState(await savedDelay()), ...await savedVideoOptions(), mode: await savedMode(), tabId: current.tabId, tabTitle: current.tabTitle, notice: "已停止延迟，网页恢复原始声音。" });
}

async function openCropPicker(tabId) {
  const state = await readState();
  if (state.active) throw new Error("请先停止延迟，再框选区域。");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !/^(https?|file):/.test(tab.url || "")) throw new Error("请在直播网页上点击图标并框选区域。");
  const geometry = await locate(tabId, null, "viewport", null);
  const current = () => chrome.tabs.query({ active: true, windowId: tab.windowId });
  if ((await current())[0]?.id !== tabId) throw new Error("当前网页已切换，请回到直播页重新框选。");
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
  if ((await current())[0]?.id !== tabId) throw new Error("预览期间网页已切换，请回到直播页重新框选。");
  const key = crypto.randomUUID();
  const picker = { key, image, tabId, url: tab.url, title: tab.title, viewport: geometry.viewport, createdAt: Date.now() };
  await chrome.storage.session.set({ cropPicker: picker });
  const page = await chrome.tabs.create({ url: `${CROP_URL}#${key}`, active: true });
  await chrome.storage.session.set({ cropPicker: { ...picker, pickerTabId: page.id } });
  return state;
}

async function cropPicker(message) {
  const { cropPicker: picker } = await chrome.storage.session.get("cropPicker");
  if (!picker || picker.key !== message.key || Date.now() - picker.createdAt > 300000) {
    if (picker && Date.now() - picker.createdAt > 300000) await chrome.storage.session.remove("cropPicker");
    throw new Error("框选已过期，请回到直播页重新框选。");
  }
  if (message.type === "CROP_DATA") return picker;
  const rect = message.rect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.x < 0 || rect.y < 0 || rect.width < 0.03 || rect.height < 0.03 || rect.x + rect.width > 1.001 || rect.y + rect.height > 1.001) throw new Error("请框选有效的视频区域。");
  await chrome.storage.session.set({ manualCrop: { tabId: picker.tabId, url: picker.url, viewport: picker.viewport, rect } });
  await chrome.storage.session.remove("cropPicker");
  await chrome.tabs.update(picker.tabId, { active: true });
  // The page closes itself after receiving this reply, so the reply is not lost.
  return { saved: true };
}

async function setDelay(value) {
  const delay = normalizeDelay(value);
  const state = await readState();
  const next = await hasOffscreen() ? await engineMessage("DELAY", { delay }) : { ...state, delay };
  await chrome.storage.local.set({ delay });
  return remember(next);
}

// Capture is commanded by the toolbar popup's Start button. There is no
// action.onClicked handler, since Chrome suppresses it when default_popup is set.

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL || message.target !== "worker") return;
  // Only our own packaged pages can command the worker.
  const fromOffscreen = sender.url === OFFSCREEN_URL;
  const fromControl = sender.url === CONTROL_URL;
  const fromCrop = sender.url === CROP_URL || sender.url?.startsWith(`${CROP_URL}#`);
  let operation;
  if (message.type === "ENGINE_CHANGED" && fromOffscreen) {
    operation = enqueue(async () => {
      if (!(await hasOffscreen())) return;
      const state = await engineMessage("STATE");
      await remember(state);
      if (!state.active && (state.phase === "error" || state.phase === "interrupted")) {
        await removeLocator(state);
        await closeViewer(state);
        await engineMessage("CLEANUP", {}, 7000).catch(() => {});
        await closeOffscreen();
      }
      return state;
    });
  } else if (message.type === "REGION_CHANGED" && sender.tab) {
    operation = enqueue(async () => {
      const state = await readState();
      if (!state.active || state.mode !== "av" || state.sessionId !== message.sessionId || state.tabId !== sender.tab.id || state.region === "tab") return state;
      return engineMessage("REGION", { sessionId: state.sessionId, geometry: message.geometry, error: message.error });
    });
  } else if (fromCrop && ["CROP_DATA", "CROP_SAVE"].includes(message.type)) {
    operation = enqueue(() => cropPicker(message));
  } else if (fromControl) {
    switch (message.type) {
      case "STATE": operation = readState(); break; // Do not block the UI behind a pending capture.
      case "STOP": operation = enqueue(stop); break;
      case "DELAY": operation = enqueue(() => setDelay(message.delay)); break;
      case "VIDEO_OPTIONS": operation = enqueue(async () => {
        const state = await readState();
        if (state.active) throw new Error("请先停止延迟，再切换区域或画质。");
        const options = videoOptions(message.options);
        await chrome.storage.local.set({ videoOptions: options });
        return remember({ ...state, ...options });
      }); break;
      case "CROP_PICKER": operation = enqueue(() => openCropPicker(message.tabId)); break;
      case "MODE": operation = enqueue(async () => {
        const state = await readState();
        if (state.active) throw new Error("请先停止延迟，再切换模式。");
        const mode = normalizeMode(message.mode);
        await chrome.storage.local.set({ mode });
        return remember({ ...state, mode });
      }); break;
      case "OPEN_VIEWER": operation = enqueue(async () => {
        const state = await readState();
        if (state.active && state.mode === "av") await chrome.tabs.update(state.viewerTabId, { active: true });
        return state;
      }); break;
      case "START": operation = enqueue(async () => {
        if (!Number.isInteger(message.tabId)) throw new Error("请在目标网页点击扩展图标，再点击开始延迟。");
        // Opening the toolbar popup grants activeTab. Pin its tab ID so focus
        // changes cannot accidentally select another capture target.
        return start(await chrome.tabs.get(message.tabId), message.mode);
      }); break;
      default: return;
    }
  } else { return; }
  Promise.resolve(operation).then(state => respond({ ok: true, state }), error => respond({ ok: false, error: errorText(error) }));
  return true;
});

async function interruptTab(tabId, reason) {
  const state = await readState();
  if (!state.active || (state.tabId !== tabId && state.viewerTabId !== tabId) || !(await hasOffscreen())) return;
  await removeLocator(state);
  await closeViewer(state);
  const final = await engineMessage("INTERRUPT", { reason }, state.mode === "av" ? 7000 : 5000);
  await remember(final);
  await closeOffscreen();
}

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.get("cropPicker").then(({ cropPicker: picker }) => {
    if (picker?.pickerTabId === tabId || picker?.tabId === tabId) return chrome.storage.session.remove("cropPicker");
  }).catch(() => {});
  void enqueue(() => interruptTab(tabId, "采集标签页或延迟播放页已关闭，资源已释放，网页恢复原声。请重新启动。" )).catch(console.error);
});

chrome.tabCapture.onStatusChanged.addListener(info => {
  if (info.status !== "stopped" && info.status !== "error") return;
  void enqueue(async () => {
    // A late 'stopped' event from the previous session must not kill a new one.
    const captures = await chrome.tabCapture.getCapturedTabs();
    if (captures.some(capture => capture.tabId === info.tabId && ["active", "pending"].includes(capture.status))) return;
    await interruptTab(info.tabId, "Chrome 已结束标签页音频采集，已恢复网页原声。请回到网页点击扩展图标重新启动。");
  }).catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueue(async () => {
    // Installation/update is deliberately idle; capture always needs user intent.
    await closeOffscreen();
    await remember({ ...idleState(await savedDelay()), ...await savedVideoOptions(), mode: await savedMode() });
  }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  void enqueue(async () => remember({ ...idleState(await savedDelay()), ...await savedVideoOptions(), mode: await savedMode() })).catch(console.error);
});
