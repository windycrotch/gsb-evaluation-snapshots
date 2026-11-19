import { AudioWorkletInitWasmEvent } from "./types";

/**
 * Load and compile the WASM bytes sent from the main thread.
 *
 * The message contract is unchanged:
 *  - main thread posts `{ type: "init-wasm", data: ArrayBuffer }`
 *  - worklet replies `{ type: "wasm-loaded" }` once `init()` resolves,
 *    which triggers the main thread's `init-module` message.
 *
 * New behavior: a compile/init failure no longer becomes an unhandled
 * promise rejection. We report `wasm-load-failed` (an additive message —
 * older main-thread code simply ignores unknown message types) and flip
 * the supplied `status` so the processor knows to stay silent instead of
 * touching a half-initialized module. A later successful `init-wasm`
 * message can recover the worklet without recreating it.
 */
export const initWasm = async (
  event: AudioWorkletInitWasmEvent,
  init: (
    module: Promise<WebAssembly.Module> | WebAssembly.Module,
  ) => Promise<unknown>,
  port: MessagePort,
  status?: { wasmReady: boolean; wasmFailed: boolean },
) => {
  // Handle loading WASM module
  if (event.type !== "init-wasm") {
    return;
  }

  try {
    // Await compilation ourselves: passing a rejecting promise straight
    // into the wasm-bindgen `init` would surface as an unhandled rejection
    // because the glue does not catch its input promise.
    const module = await WebAssembly.compile(event.data);
    await init(module);
    if (status) status.wasmReady = true;
    port.postMessage({ type: "wasm-loaded" });
  } catch (error) {
    if (status) status.wasmFailed = true;
    console.error("Failed to initialize WASM module", error);
    port.postMessage({ type: "wasm-load-failed", error: String(error) });
  }
};
