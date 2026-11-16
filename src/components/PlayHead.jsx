import { useRef, useLayoutEffect, memo } from "react";
import "./PlayHead.css";

/**
 * Playhead position is driven by the transport snapshot:
 *   (currentStepID + progressInStep) / totalSteps
 * It stays frozen on the current step while paused and returns to the start
 * when stopped (currentStepID === null).
 */
const PlayHead = ({
  notesAreaWidthInPixels,
  currentStepID,
  progressInStep,
  totalSteps,
}) => {
  const playHeadRef = useRef(null);

  useLayoutEffect(() => {
    const step = currentStepID === null ? 0 : currentStepID;
    const fraction =
      currentStepID === null ? 0 : (step + progressInStep) / totalSteps;
    const progress = Math.min(fraction, 1);

    playHeadRef.current.style.transform =
      "translate3d(" +
      (progress * notesAreaWidthInPixels).toFixed(2) +
      "px, 0, 0px)";
  }, [
    notesAreaWidthInPixels,
    currentStepID,
    progressInStep,
    totalSteps,
  ]);

  return <div className="play_head" ref={playHeadRef}></div>;
};

export default memo(PlayHead);
