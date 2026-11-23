import { useCallback, useEffect, useRef, useState } from "react";
import useAudioStore from "@/store/audio";
import { createBitcrusherNode } from "clawdio";
import type { BitcrusherNode } from "clawdio";

type Props = {
  bits?: number;
  normfreq?: number;
};

const Bitcrusher = ({ bits: bitsProp = 4, normfreq: normfreqProp = 0.1 }: Props) => {
  const nodeRef = useRef<BitcrusherNode | null>(null);
  const { audioCtx, addAudioNode, removeAudioNode } = useAudioStore();

  // Local state so the sliders stay responsive while the node boots.
  const [bits, setBits] = useState(bitsProp);
  const [normfreq, setNormfreq] = useState(normfreqProp);
  const [error, setError] = useState<string | null>(null);

  const createNode = useCallback(async () => {
    nodeRef.current = await createBitcrusherNode(audioCtx, bitsProp, normfreqProp, {
      onParameterError: ({ message }) => setError(message),
    });

    addAudioNode("bitcrusher", nodeRef.current.node);
  }, [addAudioNode, audioCtx, bitsProp, normfreqProp]);

  useEffect(() => {
    if (!audioCtx || nodeRef.current) return;
    createNode();

    return () => {
      if (nodeRef.current) removeAudioNode("bitcrusher");
      // `dispose()` posts the teardown message and disconnects in one step.
      nodeRef.current?.dispose?.();
      nodeRef.current?.node.disconnect();
    };
  }, [audioCtx, createNode, removeAudioNode]);

  useEffect(() => {
    nodeRef.current?.setBits(bits);
  }, [bits]);

  useEffect(() => {
    nodeRef.current?.setNormfreq(normfreq);
  }, [normfreq]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <label>
        Bits: {bits}
        <input
          type="range"
          min={1}
          max={16}
          step={1}
          value={bits}
          onChange={(event) => setBits(Number(event.target.value))}
        />
      </label>

      <label>
        Norm Freq: {normfreq.toFixed(2)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={normfreq}
          onChange={(event) => setNormfreq(Number(event.target.value))}
        />
      </label>

      {error && <p style={{ color: "salmon" }}>Parameter rejected: {error}</p>}
    </div>
  );
};

export default Bitcrusher;
