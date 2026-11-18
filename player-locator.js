// Serialized by chrome.scripting into the activeTab's isolated world. This is
// read-only: no DOM/style writes, media control calls or network access.
export function locatePlayer(sessionId, scope = "player", manual = null) {
  globalThis.__liveAudioSyncLocator?.close();
  const viewport = () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio });
  function read() {
    const vp = viewport();
    if (scope === "viewport") return { viewport: vp };
    if (scope === "manual") {
      if (!manual || Math.abs(manual.viewport.width - vp.width) > 2 || Math.abs(manual.viewport.height - vp.height) > 2 ||
        Math.abs((manual.viewport.scrollX ?? vp.scrollX) - vp.scrollX) > 2 || Math.abs((manual.viewport.scrollY ?? vp.scrollY) - vp.scrollY) > 2) {
        throw new Error("手动区域尚未设置，或网页滚动/窗口尺寸已改变，请重新框选播放器区域。");
      }
      return { viewport: vp, rect: manual.rect, label: "手动区域" };
    }
    const root = document.querySelector("#live-player") || document;
    const videos = [...root.querySelectorAll("video")].map(video => ({ video, box: video.getBoundingClientRect() }))
      .filter(({ video, box }) => box.width >= 120 && box.height >= 80 && getComputedStyle(video).visibility !== "hidden")
      .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    const selected = videos[0];
    if (!selected) throw new Error("未找到可见播放器。请先正常播放直播，或选择「手动框选」。");
    const { box, video } = selected;
    if (box.left < -2 || box.top < -2 || box.right > vp.width + 2 || box.bottom > vp.height + 2) {
      throw new Error("播放器未完整显示在网页内。请滚动到完整画面后重新启动，或手动框选可见区域。");
    }
    return { viewport: vp, rect: { x: Math.max(0, box.left) / vp.width, y: Math.max(0, box.top) / vp.height,
      width: Math.min(box.width, vp.width - Math.max(0, box.left)) / vp.width,
      height: Math.min(box.height, vp.height - Math.max(0, box.top)) / vp.height },
      sourceWidth: video.videoWidth, sourceHeight: video.videoHeight, label: "播放器区域" };
  }
  let initial;
  try { initial = read(); } catch (error) { return { error: error.message }; }
  if (!sessionId || scope === "viewport") return initial;
  let last = JSON.stringify(initial), timer, closed = false;
  const report = () => {
    if (closed) return;
    let geometry, error;
    try { geometry = read(); } catch (e) { error = e.message; }
    const next = JSON.stringify(geometry || { error });
    if (next === last) return;
    last = next;
    try {
      void chrome.runtime.sendMessage({ channel: "live-audio-sync", target: "worker", type: "REGION_CHANGED",
        sessionId, geometry, error }).catch(close);
    } catch { close(); } // Extension reload can synchronously invalidate runtime.
  };
  const schedule = () => { if (!timer && !closed) timer = setTimeout(() => { timer = null; report(); }, 200); };
  const resize = new ResizeObserver(schedule);
  resize.observe(document.documentElement);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  function close() {
    closed = true; clearTimeout(timer); resize.disconnect(); mutations.disconnect();
    removeEventListener("scroll", schedule, true); removeEventListener("resize", schedule);
    removeEventListener("pagehide", close);
    if (globalThis.__liveAudioSyncLocator?.sessionId === sessionId) delete globalThis.__liveAudioSyncLocator;
  }
  addEventListener("pagehide", close, { once: true });
  globalThis.__liveAudioSyncLocator = { sessionId, close };
  return initial;
}
export function releaseLocator(sessionId) {
  if (globalThis.__liveAudioSyncLocator?.sessionId === sessionId) globalThis.__liveAudioSyncLocator.close();
}
