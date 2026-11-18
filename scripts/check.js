import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), "..");
const files = fs.readdirSync(root).filter(name => name.endsWith(".js"));
for (const name of files) execFileSync(process.execPath, ["--check", path.join(root, name)]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.action.default_popup !== "control.html" || manifest.content_scripts || manifest.host_permissions) {
  throw new Error("Manifest violates the tab-only architecture.");
}
for (const permission of manifest.permissions) {
  if (!["activeTab", "tabCapture", "offscreen", "storage", "scripting"].includes(permission)) throw new Error(`Unexpected permission: ${permission}`);
}
for (const name of [manifest.background.service_worker, "offscreen.html", "control.html", "control.js", "control.css", "viewer.html", "viewer.js", "av-engine.js", "av-playback.js", "crop.html", "crop.js", "video-cropper.js", "player-locator.js"]) {
  if (!fs.existsSync(path.join(root, name))) throw new Error(`Missing file: ${name}`);
}
const source = files.map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
if (/chrome\.action\.onClicked\.addListener|chrome\.windows\.create/.test(source)) {
  throw new Error("Toolbar popup must not rely on action.onClicked or open separate windows.");
}
if (/chrome\.(webRequest|declarativeNetRequest)|createMediaElementSource|playbackRate|crossOrigin|consumerTabId\s*:/.test(source)) {
  throw new Error("Forbidden player/network integration found.");
}
const locator = fs.readFileSync(path.join(root, "player-locator.js"), "utf8");
if (/\.(src|srcObject|currentTime|volume|muted|innerHTML|outerHTML)\s*=|\.style\b|\.(play|pause|load|appendChild|removeChild|setAttribute)\s*\(|fetch\s*\(/.test(locator)) {
  throw new Error("Page locator must remain read-only.");
}
console.log(`PASS: ${files.length} JS files parsed; MV3 permissions checked; page locator read-only; no player control/network integrations.`);
