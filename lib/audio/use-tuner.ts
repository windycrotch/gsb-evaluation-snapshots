"use client";

import { useEffect, useRef, useState } from "react";
import { detectPitch } from "./yin";
import { hzToNote } from "./note";
import {
  createTunerSession,
  TUNER_WORKLET_URL,
  type TunerAudioContext,
  type TunerMediaStream,
  type TunerReading,
  type TunerSession,
  type TunerState,
  type TunerWorkletNode,
} from "./tuner-session";

export type { TunerReading, TunerState };

// React bindings over the framework-independent session lifecycle. The session
// owns the generation token, so rapid start/stop clicks and a slow permission
// prompt cannot leak an old microphone stream or write a stale reading.

export function useTuner() {
  const [state, setState] = useState<TunerState>("idle");
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<TunerSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createTunerSession({
      getUserMedia: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false,
          },
        }) as Promise<TunerMediaStream>,
      createAudioContext: () => new AudioContext() as unknown as TunerAudioContext,
      loadWorkletModule: (context) =>
        (context as unknown as AudioContext).audioWorklet.addModule(TUNER_WORKLET_URL),
      createWorkletNode: (context) =>
        new AudioWorkletNode(
          context as unknown as AudioContext,
          "tuner-audio-processor",
        ) as unknown as TunerWorkletNode,
      detectPitch: (samples, options) => detectPitch(samples, options),
      hzToNote,
      onStateChange: setState,
      onReadingChange: setReading,
      onErrorChange: setError,
    });
  }

  // Unmount releases the microphone, the context and the worklet node so no
  // timer or audio node survives leaving the page.
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
    };
  }, []);

  return {
    state,
    reading,
    error,
    start: () => sessionRef.current!.start(),
    stop: () => sessionRef.current!.stop(),
  };
}
