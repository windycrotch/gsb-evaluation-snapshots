import { AudioWorkletEventMessage } from "@/workers/types";

const handleNodeMessage =
  (
    nodeRef: AudioWorkletNode,
    config: unknown,
    onParamChange?: (event: AudioWorkletEventMessage<unknown>) => void
  ) =>
  (e: MessageEvent) => {
    const event = e.data as AudioWorkletEventMessage<unknown>;
    // WASM was loaded - so lets initialize our Rust-based module
    if (event.type === "wasm-loaded") {
      console.log("wasm loaded");
      if (!nodeRef) return;

      console.log("init rust module");
      // Initialize the WASM module with config data
      nodeRef.port.postMessage({
        type: "init-module",
        data: config,
      });
      return;
    }

    // Forward parameter confirmations (e.g. "set-bits-confirmed") so the
    // page can display the parameter values actually in effect. These
    // messages are informational only and never change audio processing.
    if (typeof event.type === "string" && event.type.endsWith("-confirmed")) {
      onParamChange?.(event);
    }
  };

export const createWorkletNode = async (
  audioCtx: AudioContext,
  wasmPath: string,
  worklet: string,
  workletName: string,
  config?: unknown,
  onParamChange?: (event: AudioWorkletEventMessage<unknown>) => void
) => {
  // Fetch the WASM module
  const response = await fetch(wasmPath);
  const wasmData = await response.arrayBuffer();
  console.log("got wasm", response, wasmData);

  // Create the worklet
  console.log("creating worklet...", worklet);
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
    nodeRef.port.onmessage = handleNodeMessage(
      nodeRef,
      config,
      onParamChange
    );

    console.log("created worklet node", nodeRef);

    nodeRef.addEventListener("processorerror", (e) =>
      console.error("Audio Worklet processing error", e)
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
