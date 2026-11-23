import type { AudioWorkletInitWasmEvent } from "./types.ts";

export type WasmLoadState = "idle" | "loading" | "loaded" | "error";

export type WasmErrorEvent = {
  type: "wasm-error";
  data: { message: string };
};

export type WasmLoaderOptions = {
  /** Called after a successful compile (already reports `wasm-loaded`). */
  onLoaded?: () => void;
};

export type WasmLoader = {
  /** Feed every inbound port message; non-`init-wasm` messages are ignored. */
  handle: (event: { type: string; data?: unknown }) => void;
  /** True once `wasm-loaded` has been posted. */
  isLoaded: () => boolean;
  /** Current loader state, useful for diagnostics. */
  state: () => WasmLoadState;
};

/**
 * Builds the `init-wasm` handler for a worklet processor.
 *
 * The processor can receive `init-wasm` more than once if the main thread
 * retries. Loading the module twice would create two WASM instances and leak
 * memory, so the loader remembers its state and ignores duplicates. A failed
 * compile is reported back to the main thread instead of becoming an unhandled
 * promise rejection that silently leaves the node without a module.
 */
export const createWasmLoader = (
  init: (module: Promise<WebAssembly.Module>) => Promise<unknown>,
  port: { postMessage: (message: unknown) => void },
  options: WasmLoaderOptions = {}
): WasmLoader => {
  let state: WasmLoadState = "idle";

  const handle = (event: { type: string; data?: unknown }) => {
    if (event.type !== "init-wasm") return;
    if (state === "loading" || state === "loaded") return;
    if (!(event.data instanceof ArrayBuffer)) {
      state = "error";
      port.postMessage({
        type: "wasm-error",
        data: { message: "init-wasm requires an ArrayBuffer payload" },
      } satisfies WasmErrorEvent);
      return;
    }

    state = "loading";

    Promise.resolve()
      .then(() => init(WebAssembly.compile(event.data as ArrayBuffer)))
      .then(() => {
        state = "loaded";
        port.postMessage({ type: "wasm-loaded" });
        options.onLoaded?.();
      })
      .catch((error: unknown) => {
        state = "error";
        port.postMessage({
          type: "wasm-error",
          data: {
            message:
              error instanceof Error ? error.message : String(error ?? "unknown"),
          },
        } satisfies WasmErrorEvent);
      });
  };

  return {
    handle,
    isLoaded: () => state === "loaded",
    state: () => state,
  };
};

/**
 * @deprecated Prefer {@link createWasmLoader}. Kept for backwards compatibility
 * with custom worklets that imported this helper directly.
 */
export const initWasm = (
  event: AudioWorkletInitWasmEvent,
  init: (module: Promise<WebAssembly.Module>) => Promise<unknown>,
  port: MessagePort
) => {
  createWasmLoader(init, port).handle(event);
};
