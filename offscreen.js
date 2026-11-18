import { AudioEngine } from "./audio-engine.js";
import { AVEngine } from "./av-engine.js";
import { CHANNEL, errorText } from "./shared.js";

const notify = () => {
  void chrome.runtime.sendMessage({ channel: CHANNEL, target: "worker", type: "ENGINE_CHANGED" }).catch(() => {});
};
const audioEngine = new AudioEngine({
  mediaDevices: navigator.mediaDevices,
  createContext: () => new AudioContext({ latencyHint: "playback" }),
  onChange: notify,
});
const avEngine = new AVEngine({ mediaDevices: navigator.mediaDevices, onChange: notify });
let engine = audioEngine;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL || message.target !== "offscreen") return;
  let operation;
  try {
    switch (message.type) {
      case "STATE": operation = engine.snapshot(); break;
      case "CLEANUP": operation = engine.cleanupPromise || Promise.resolve(); break;
      case "START":
        if (!engine.snapshot().active) engine = message.data.mode === "av" ? avEngine : audioEngine;
        operation = engine.start(message.data); break;
      case "STOP": operation = engine.stop(message.reason); break;
      case "DELAY": operation = engine.setDelay(message.delay); break;
      case "REGION": operation = engine instanceof AVEngine ? engine.setRegion(message) : engine.snapshot(); break;
      case "INTERRUPT": operation = engine.fail(engine.session, "interrupted", message.reason); break;
      default: return;
    }
    Promise.resolve(operation).then(() => respond({ ok: true, state: engine.snapshot() }), error => respond({ ok: false, error: errorText(error) }));
  } catch (error) { respond({ ok: false, error: errorText(error) }); }
  return true;
});

// Cleanup fallback if the document is explicitly closed or extension reloaded.
window.addEventListener("pagehide", () => { void engine.stop(); });
