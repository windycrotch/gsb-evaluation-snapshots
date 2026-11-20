import { AudioWorkletInitWasmEvent } from "./types";

export const initWasm = (
  event: AudioWorkletInitWasmEvent,
  init: (module: Promise<WebAssembly.Module>) => Promise<unknown>,
  port: MessagePort
) => {
  // Handle loading WASM module
  if (event.type === "init-wasm") {
    init(WebAssembly.compile(event.data))
      .then(() => {
        port.postMessage({ type: "wasm-loaded" });
      })
      .catch((error: unknown) => {
        // Never let a failed compile become an unhandled rejection that can
        // tear down the audio thread. Report it; the processor keeps its
        // current (possibly null) module and process() stays a safe no-op
        // until a valid module arrives.
        port.postMessage({
          type: "init-wasm-failed",
          data: { error: String(error) },
        });
      });
  }
};
