import { useCallback, useEffect, useRef, useState } from "react";
import useAudioStore from "@/store/audio";
import { createMoogNode } from "clawdio";
import type { MoogNode } from "clawdio";

type Props = {
  resonance?: number;
  cutoff?: number;
};

const Moog = ({
  resonance: resonanceProp = 3.5,
  cutoff: cutoffProp = 0.065,
}: Props) => {
  const nodeRef = useRef<MoogNode | null>(null);
  const { audioCtx, addAudioNode, removeAudioNode } = useAudioStore();

  // Local state so the sliders stay responsive while the node boots.
  const [resonance, setResonance] = useState(resonanceProp);
  const [cutoff, setCutoff] = useState(cutoffProp);
  const [error, setError] = useState<string | null>(null);

  const createNode = useCallback(async () => {
    nodeRef.current = await createMoogNode(
      audioCtx,
      cutoffProp,
      resonanceProp,
      {
        onParameterError: ({ message }) => setError(message),
      }
    );

    addAudioNode("moog", nodeRef.current.node);
  }, [addAudioNode, audioCtx, cutoffProp, resonanceProp]);

  useEffect(() => {
    if (!audioCtx || nodeRef.current) return;
    createNode();

    return () => {
      if (nodeRef.current) removeAudioNode("moog");
      // `dispose()` posts the teardown message and disconnects in one step.
      nodeRef.current?.dispose?.();
      nodeRef.current?.node.disconnect();
    };
  }, [audioCtx, createNode, removeAudioNode]);

  useEffect(() => {
    nodeRef.current?.setResonance(resonance);
  }, [resonance]);

  useEffect(() => {
    nodeRef.current?.setCutoff(cutoff);
  }, [cutoff]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <label>
        Cutoff: {cutoff.toFixed(3)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={cutoff}
          onChange={(event) => setCutoff(Number(event.target.value))}
        />
      </label>

      <label>
        Resonance: {resonance.toFixed(2)}
        <input
          type="range"
          min={0}
          max={20}
          step={0.1}
          value={resonance}
          onChange={(event) => setResonance(Number(event.target.value))}
        />
      </label>

      {error && <p style={{ color: "salmon" }}>Parameter rejected: {error}</p>}
    </div>
  );
};

export default Moog;
