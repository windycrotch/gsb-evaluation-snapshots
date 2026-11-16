import BitcrusherWorklet from "@/workers/bitcrusher.ts?worker&url";
import "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?no-inline";
import BitcrusherWasmPath from "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?url&no-inline";
import type { AudioWorkletEventMessage } from "@/workers/types";
import { CustomAudioWorkletNode } from "./types";
import { assertNode, createWorkletNode } from "./utils";

export type BitcrusherParamConfirmedEvent =
  | AudioWorkletEventMessage<{ bits: number }>
  | AudioWorkletEventMessage<{ normfreq: number }>;

export type BitcrusherNode = CustomAudioWorkletNode & {
  setBits: (newBits: number) => void;
  setNormfreq: (newFreq: number) => void;
};

/**
 * Creates a Bitcrusher audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters.
 *
 * `onParamChange` (optional) receives confirmation messages posted by the
 * worklet after a parameter update has taken effect in the underlying WASM
 * module, e.g. `{ type: "set-bits-confirmed", data: { bits: 8 } }`. It is
 * purely informational and never affects the audio output.
 * @returns BitcrusherNode
 */
const createBitcrusherNode = async (
  audioCtx: AudioContext,
  bits = 4,
  normfreq = 0.1,
  onParamChange?: (event: BitcrusherParamConfirmedEvent) => void
) => {
  let nodeRef: AudioWorkletNode | null = null;

  // Setter functions to communicate with worklet params
  const setBits = (newBits: number) => {
    if (!nodeRef) return;
    nodeRef.port.postMessage({ type: "set-bits", data: newBits });
  };

  const setNormfreq = (newFreq: number) => {
    if (!nodeRef) return;
    nodeRef.port.postMessage({ type: "set-normfreq", data: newFreq });
  };

  // Create the node and return it
  nodeRef = await createWorkletNode(
    audioCtx,
    BitcrusherWasmPath,
    BitcrusherWorklet,
    "clawdio-bitcrusher",
    {
      bits,
      normfreq,
    },
    onParamChange as
      | ((event: AudioWorkletEventMessage<unknown>) => void)
      | undefined
  );

  assertNode(nodeRef, "Bitcrusher");

  return {
    node: nodeRef,
    setBits,
    setNormfreq,
  } as BitcrusherNode;
};

export default createBitcrusherNode;
