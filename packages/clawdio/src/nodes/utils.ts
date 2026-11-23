import type { AudioWorkletEventMessage } from "@/workers/types";

export type ParameterErrorPayload = {
  parameter: string;
  value: unknown;
  message: string;
};

export type WorkletNodeEvents = {
  /** A parameter update was rejected by the worklet. */
  onParameterError?: (payload: ParameterErrorPayload) => void;
  /** The worklet failed while rendering a block. */
  onProcessingError?: (payload: { message: string }) => void;
  /** The WASM payload could not be compiled inside the worklet. */
  onWasmError?: (payload: { message: string }) => void;
};

export const handleNodeMessage =
  (nodeRef: AudioWorkletNode, config: unknown, events?: WorkletNodeEvents) =>
  (e: MessageEvent) => {
    const event = e.data as AudioWorkletEventMessage<unknown>;

    // WASM was loaded - so lets initialize our Rust-based module
    if (event.type === "wasm-loaded") {
      if (!nodeRef) return;

      // Initialize the WASM module with config data
      nodeRef.port.postMessage({
        type: "init-module",
        data: config,
      });
      return;
    }

    if (event.type === "parameter-error") {
      const payload = event.data as ParameterErrorPayload;
      // Surfacing this is important: silently dropping an update is what made
      // the old implementation look like "the slider does nothing".
      if (events?.onParameterError) {
        events.onParameterError(payload);
      } else {
        console.warn(`[clawdio] ${payload?.message ?? "Invalid parameter"}`);
      }
      return;
    }

    if (event.type === "processing-error") {
      const payload = event.data as { message: string };
      if (events?.onProcessingError) {
        events.onProcessingError(payload);
      } else {
        console.error("[clawdio] Audio processing error", payload?.message);
      }
      return;
    }

    if (event.type === "wasm-error") {
      const payload = event.data as { message: string };
      if (events?.onWasmError) {
        events.onWasmError(payload);
      } else {
        console.error("[clawdio] Failed to load WASM", payload?.message);
      }
    }
  };

export const createWorkletNode = async (
  audioCtx: AudioContext,
  wasmPath: string,
  worklet: string,
  workletName: string,
  config?: unknown,
  events?: WorkletNodeEvents
) => {
  // Fetch the WASM module
  const response = await fetch(wasmPath);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch WASM module for ${workletName}: ${response.status}`
    );
  }
  const wasmData = await response.arrayBuffer();

  try {
    // Resolve the URL relative to the current module
    await audioCtx.audioWorklet.addModule(worklet);
  } catch (e) {
    throw new Error(`Failed to add audio worklet module: ${e}`);
  }

  let nodeRef: AudioWorkletNode;
  try {
    nodeRef = new AudioWorkletNode(audioCtx, workletName);

    // Send the WASM payload to Audio processor
    nodeRef.port.postMessage({ type: "init-wasm", data: wasmData });

    // Get messages from the worklet/processor
    nodeRef.port.onmessage = handleNodeMessage(nodeRef, config, events);

    nodeRef.addEventListener("processorerror", (e) =>
      events?.onProcessingError
        ? events.onProcessingError({
            message:
              (e as unknown as { message?: string })?.message ??
              "Audio Worklet processor crashed",
          })
        : console.error("Audio Worklet processing error", e)
    );
    return nodeRef;
  } catch (e) {
    throw new Error(`Failed to create audio worklet node: ${e}`);
  }
};

export const assertNode = (nodeRef: AudioWorkletNode, nodeName: string) => {
  if (!nodeRef) {
    throw new Error(`Failed to create ${nodeName} node`);
  }
};

export type NodeDisposer = () => void;

/**
 * Wires up teardown for an AudioWorkletNode so the worklet side never keeps a
 * dangling port handler (and WASM instance) after the node is gone.
 *
 * The returned disposer is idempotent and is triggered by:
 * - `node.disconnect()` with no arguments (the usual "remove this node" call)
 * - `pagehide` / `beforeunload`
 * - calling it explicitly
 */
export const bindNodeLifecycle = (node: AudioWorkletNode): NodeDisposer => {
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;

    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", dispose);
      window.removeEventListener("beforeunload", dispose);
    }

    // Tell the worklet to drop its module + handler. Wrapped because the node
    // may already be closed during page teardown.
    try {
      node.port.postMessage({ type: "dispose" });
    } catch {
      // ignore
    }

    try {
      node.port.onmessage = null;
    } catch {
      // ignore
    }

    // Patch disconnect back to the original so this wrapper does not leak.
    if (originalDisconnect) {
      node.disconnect = originalDisconnect;
    }
  };

  const originalDisconnect = node.disconnect;
  node.disconnect = function patchedDisconnect(
    this: AudioWorkletNode,
    ...args: unknown[]
  ) {
    // `AudioWorkletNode#disconnect` is overloaded; forwarding through `apply`
    // keeps every overload working.
    const result = (
      originalDisconnect as (...disconnectArgs: unknown[]) => void
    ).apply(this, args);
    // Only treat a bare disconnect() as teardown; disconnecting from one
    // specific destination is a normal rewiring operation.
    if (args.length === 0) dispose();
    return result;
  } as AudioWorkletNode["disconnect"];

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", dispose);
    window.addEventListener("beforeunload", dispose);
  }

  return () => {
    dispose();
    // Explicit dispose also disconnects audio so the node stops rendering.
    try {
      (originalDisconnect as (...args: unknown[]) => void).call(node);
    } catch {
      // Already disconnected.
    }
  };
};

/** Post a parameter update, tolerating already-disposed nodes. */
export const postParameter = (
  node: AudioWorkletNode,
  type: string,
  data: unknown
) => {
  try {
    node.port.postMessage({ type, data });
  } catch {
    // Port closed (page unloading or node disposed); nothing to update.
  }
};
