import { useEffect, useRef, useState } from 'react';
import { audioSynth } from '../utils/audio';

export const STAGE_ADVANCE_DELAY = 350;
export const MODAL_REVEAL_DELAY = 400;
export const RIPPLE_DELAY = 650;

export const STAGES = [
  {
    // Stage 0: Maceta + tallo verde base (sin hojas)
    stemHeight: 50,
    visibleLeaves: 0,
    reasons: [],
    showTitle: false,
    showSpecial: false,
    btnText: "Regar con amor",
    btnEmoji: "💛"
  },
  {
    // Stage 1: Tallo igual, aparece 1° hoja
    stemHeight: 50,
    visibleLeaves: 1,
    reasons: ["Sos hermosa"],
    showTitle: true,
    showSpecial: false,
    btnText: "Otro poquito",
    btnEmoji: "💧"
  },
  {
    // Stage 2: Crece el tallo y aparece 2° hoja
    stemHeight: 110,
    visibleLeaves: 2,
    reasons: ["Sos hermosa", "Sos divertida"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 3: Crece el tallo, mantiene 2° hoja (NO aparece hoja nueva)
    stemHeight: 170,
    visibleLeaves: 2,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 4: Tallo igual, aparece 3° hoja
    stemHeight: 170,
    visibleLeaves: 3,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo", "Sos auténtica"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 5: Crece el tallo y aparece 4° hoja
    stemHeight: 225,
    visibleLeaves: 4,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo", "Sos auténtica", "Sos perfecta"],
    showTitle: true,
    showSpecial: true,
    btnText: "Regar con mas amor",
    btnEmoji: "💛",
    triggersModal: true
  }
];

export function useFlowerStage() {
  const [currentStage, setCurrentStage] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [bloomSunflower, setBloomSunflower] = useState(false);
  const [dropsKey, setDropsKey] = useState(0);
  const [showRipple, setShowRipple] = useState(false);
  const [triggerBurst, setTriggerBurst] = useState(false);
  // Drives the button's native `disabled` attribute while a delay is in flight.
  const [isPending, setIsPending] = useState(false);

  // Ref mirror of the pending flag so synchronous rapid clicks are ignored
  // before React has re-rendered the disabled button.
  const isPendingRef = useRef(false);
  // Every timer scheduled by a click is tracked here so a reset can cancel it.
  const timersRef = useRef([]);
  // Incremented on every reset; callbacks captured under an old token bail out,
  // so a queued delay can never mutate a freshly reset state.
  const resetTokenRef = useRef(0);

  const stage = STAGES[currentStage];

  const addTimer = (callback, delay) => {
    const id = setTimeout(callback, delay);
    timersRef.current.push(id);
    return id;
  };

  const clearAllTimers = () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  };

  useEffect(() => () => clearAllTimers(), []);

  // Restore the exact first-visit appearance: stage 0 data, no flower,
  // no card, no water animation, and no pending transition.
  const resetToInitial = () => {
    resetTokenRef.current += 1;
    clearAllTimers();
    isPendingRef.current = false;
    setIsPending(false);
    setCurrentStage(0);
    setShowModal(false);
    setBloomSunflower(false);
    setTriggerBurst(false);
    setDropsKey(0);
    setShowRipple(false);
  };

  const handleWater = () => {
    // Bloom state: one click returns to the initial stage.
    if (bloomSunflower) {
      resetToInitial();
      return;
    }

    // Ignore clicks while a 350 ms / 400 ms delay is still in flight, or while
    // the final card is open. Each valid click therefore advances at most one
    // stage, no matter how fast the visitor clicks.
    if (isPendingRef.current || showModal) {
      return;
    }

    audioSynth.playWaterSound();

    // Water drop + ripple feedback for this valid click.
    setDropsKey(Date.now());
    setShowRipple(false);

    const token = resetTokenRef.current;
    isPendingRef.current = true;
    setIsPending(true);

    addTimer(() => {
      if (token !== resetTokenRef.current) return;
      setShowRipple(true);
    }, RIPPLE_DELAY);

    if (stage.triggersModal) {
      // Stage 5: the click reveals the final card instead of growing further.
      addTimer(() => {
        if (token !== resetTokenRef.current) return;
        setShowModal(true);
        isPendingRef.current = false;
        setIsPending(false);
      }, MODAL_REVEAL_DELAY);
      return;
    }

    if (currentStage < STAGES.length - 1) {
      const nextStage = currentStage + 1;
      addTimer(() => {
        if (token !== resetTokenRef.current) return;
        setCurrentStage(nextStage);
        audioSynth.playGrowSound(nextStage);
        isPendingRef.current = false;
        setIsPending(false);
      }, STAGE_ADVANCE_DELAY);
    }
  };

  const handleRevealFlower = () => {
    setShowModal(false);
    setBloomSunflower(true);
    setTriggerBurst(true);
    audioSynth.playFanfareSound();
  };

  return {
    currentStage,
    stage,
    showModal,
    bloomSunflower,
    dropsKey,
    showRipple,
    triggerBurst,
    isPending,
    handleWater,
    handleRevealFlower,
  };
}
