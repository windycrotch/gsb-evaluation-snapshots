import MoogWorklet from "@/workers/moog.ts?worker&url";
import "clawdio-moog/clawdio_moog_bg.wasm?no-inline";
import MoogWasmPath from "clawdio-moog/clawdio_moog_bg.wasm?url&no-inline";
import type { AudioWorkletEventMessage } from "@/workers/types";
import { CustomAudioWorkletNode } from "./types";
import { assertNode, createWorkletNode } from "./utils";

export type MoogParamConfirmedEvent = AudioWorkletEventMessage<{
  cutoff: number;
  resonance: number;
}>;

export type MoogNode = CustomAudioWorkletNode & {
  setResonance: (resonance: number) => void;
  setCutoff: (cutoff: number) => void;
};

/**
 * Creates a Moog audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters.
 *
 * `onParamChange` (optional) receives confirmation messages posted by the
 * worklet after a parameter update has taken effect in the underlying WASM
 * module, e.g. `{ type: "set-cutoff-confirmed", data: { cutoff, resonance } }`.
 * It is purely informational and never affects the audio output.
 * @returns MoogNode
 */
const createMoogNode = async (
  audioCtx: AudioContext,
  cutoff = 0.065,
  resonance = 3.5,
  onParamChange?: (event: MoogParamConfirmedEvent) => void
) => {
  let nodeRef: AudioWorkletNode | null = null;

  // Setter functions to communicate with worklet params
  const setResonance = (newResonance: number) => {
    if (!nodeRef) return;
    nodeRef.port.postMessage({ type: "set-resonance", data: newResonance });
  };

  const setCutoff = (newCutoff: number) => {
    if (!nodeRef) return;
    nodeRef.port.postMessage({ type: "set-cutoff", data: newCutoff });
  };

  // Create the node and return it
  nodeRef = await createWorkletNode(
    audioCtx,
    MoogWasmPath,
    MoogWorklet,
    "clawdio-moog",
    {
      resonance,
      cutoff,
    },
    onParamChange as
      | ((event: AudioWorkletEventMessage<unknown>) => void)
      | undefined
  );

  assertNode(nodeRef, "Moog");

  return {
    node: nodeRef,
    setResonance,
    setCutoff,
  } as MoogNode;
};

export default createMoogNode;
