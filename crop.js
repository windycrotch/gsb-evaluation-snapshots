import { CHANNEL } from "./shared.js";
const $ = id => document.getElementById(id);
const key = location.hash.slice(1);
let data, anchor, rect;
async function send(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type, key, ...fields });
  if (!reply?.ok) throw new Error(reply?.error || "后台没有响应，请重新框选。");
  return reply.state;
}
function fail(error) { $("error").hidden = false; $("error").textContent = error.message; }
async function closePage() { const tab = await chrome.tabs.getCurrent(); if (tab?.id) await chrome.tabs.remove(tab.id); }
// The image is kept at its intrinsic aspect ratio; the preview therefore has
// the same coordinates as the screenshot even on a Retina display.
function point(event) {
  const box = $("image").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
}
function select(event) {
  const p = point(event);
  rect = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), width: Math.abs(anchor.x - p.x), height: Math.abs(anchor.y - p.y) };
  Object.assign($("selection").style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
  $("selection").hidden = false;
  $("save").disabled = rect.width < 0.03 || rect.height < 0.03;
  $("size").textContent = `区域 ${Math.round(rect.width * 100)}% × ${Math.round(rect.height * 100)}%`;
}
$("preview").addEventListener("pointerdown", event => { if (!data || event.button !== 0) return; anchor = point(event); $("preview").setPointerCapture(event.pointerId); select(event); });
$("preview").addEventListener("pointermove", event => { if (anchor) select(event); });
$("preview").addEventListener("pointerup", event => { if (anchor) select(event); anchor = null; });
$("preview").addEventListener("pointercancel", () => { anchor = null; });
$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try { await send("CROP_SAVE", { rect }); await closePage(); }
  catch (error) { fail(error); $("save").disabled = false; }
});
$("cancel").addEventListener("click", () => void closePage());
try {
  data = await send("CROP_DATA");
  $("instruction").textContent = `${data.title || "当前网页"} · 拖动框选视频画面`;
  $("image").addEventListener("load", () => { $("preview").style.maxWidth = `${70 * $("image").naturalWidth / $("image").naturalHeight}vh`; }, { once: true });
  $("image").src = data.image;
} catch (error) { fail(error); }
