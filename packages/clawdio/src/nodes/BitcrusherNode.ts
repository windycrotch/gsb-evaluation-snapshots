import BitcrusherWorklet from "@/workers/bitcrusher.ts?worker&url";
import "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?no-inline";
import BitcrusherWasmPath from "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?url&no-inline";
import {
  DEFAULT_PARAMETERS,
  parameterMessageType,
  resolveInitialParameter,
} from "@/shared/parameters";
import { CustomAudioWorkletNode } from "./types";
import {
  assertNode,
  bindNodeLifecycle,
  createWorkletNode,
  postParameter,
  type NodeDisposer,
  type WorkletNodeEvents,
} from "./utils";

export type BitcrusherNode = CustomAudioWorkletNode & {
  setBits: (newBits: number) => void;
  setNormfreq: (newFreq: number) => void;
  /** Tear down the worklet (also runs automatically on disconnect/pagehide). */
  dispose: NodeDisposer;
};

export type BitcrusherNodeEvents = WorkletNodeEvents;

/**
 * Creates a Bitcrusher audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters
 * @returns BitcrusherNode
 */
const createBitcrusherNode = async (
  audioCtx: AudioContext,
  bits = DEFAULT_PARAMETERS.bits,
  normfreq = DEFAULT_PARAMETERS.normfreq,
  events?: BitcrusherNodeEvents
): Promise<BitcrusherNode> => {
  // Illegal initial values fall back to the documented defaults rather than
  // asking the Rust constructor to deal with them.
  const initialBits = resolveInitialParameter("bits", bits);
  const initialNormfreq = resolveInitialParameter("normfreq", normfreq);

  // The setters post straight to the worklet. The worklet queues values that
  // arrive before its WASM module is ready, so dragging a slider right after
  // page load still takes effect once initialization completes.
  let disposed = false;

  // Create the node and return it
  const nodeRef = await createWorkletNode(
    audioCtx,
    BitcrusherWasmPath,
    BitcrusherWorklet,
    "clawdio-bitcrusher",
    {
      bits: initialBits,
      normfreq: initialNormfreq,
    },
    events
  );

  assertNode(nodeRef, "Bitcrusher");

  const setBits = (newBits: number) => {
    if (disposed) return;
    postParameter(nodeRef, parameterMessageType("bits"), newBits);
  };

  const setNormfreq = (newFreq: number) => {
    if (disposed) return;
    postParameter(nodeRef, parameterMessageType("normfreq"), newFreq);
  };

  const teardown = bindNodeLifecycle(nodeRef);

  return {
    node: nodeRef,
    setBits,
    setNormfreq,
    dispose: () => {
      disposed = true;
      teardown();
    },
  };
};

export default createBitcrusherNode;
