import MoogWorklet from "@/workers/moog.ts?worker&url";
import "clawdio-moog/clawdio_moog_bg.wasm?no-inline";
import MoogWasmPath from "clawdio-moog/clawdio_moog_bg.wasm?url&no-inline";
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

export type MoogNode = CustomAudioWorkletNode & {
  setResonance: (resonance: number) => void;
  setCutoff: (cutoff: number) => void;
  /** Tear down the worklet (also runs automatically on disconnect/pagehide). */
  dispose: NodeDisposer;
};

export type MoogNodeEvents = WorkletNodeEvents;

const MOOG_PARAMETER_MESSAGES = {
  cutoff: parameterMessageType("cutoff"),
  resonance: parameterMessageType("resonance"),
};

/**
 * Creates a Moog audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters
 * @returns MoogNode
 */
const createMoogNode = async (
  audioCtx: AudioContext,
  cutoff = DEFAULT_PARAMETERS.cutoff,
  resonance = DEFAULT_PARAMETERS.resonance,
  events?: MoogNodeEvents
): Promise<MoogNode> => {
  const initialCutoff = resolveInitialParameter("cutoff", cutoff);
  const initialResonance = resolveInitialParameter("resonance", resonance);

  let disposed = false;

  // Setter functions communicate with worklet params. The worklet validates and
  // queues updates until its WASM module exists.
  const nodeRef = await createWorkletNode(
    audioCtx,
    MoogWasmPath,
    MoogWorklet,
    "clawdio-moog",
    {
      cutoff: initialCutoff,
      resonance: initialResonance,
    },
    events
  );

  assertNode(nodeRef, "Moog");

  const setResonance = (newResonance: number) => {
    if (disposed) return;
    postParameter(
      nodeRef,
      MOOG_PARAMETER_MESSAGES.resonance,
      newResonance
    );
  };

  const setCutoff = (newCutoff: number) => {
    if (disposed) return;
    postParameter(nodeRef, MOOG_PARAMETER_MESSAGES.cutoff, newCutoff);
  };

  const teardown = bindNodeLifecycle(nodeRef);

  return {
    node: nodeRef,
    setResonance,
    setCutoff,
    dispose: () => {
      disposed = true;
      teardown();
    },
  };
};

export default createMoogNode;
