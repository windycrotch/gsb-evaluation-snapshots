"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DOWNBEAT_FREQUENCY,
  NORMAL_FREQUENCY,
  MetronomeEngine,
} from "@/lib/audio/metronome-engine";

// Chris Wilson's "A Tale of Two Clocks" lookahead scheduler.
// AudioContext.currentTime gives sample-accurate timing; setInterval drives
// the scheduling loop (which only queues events, never plays them directly).
// The timing/state machine itself lives in MetronomeEngine so it can be unit
// tested without a browser; this hook wires it to the Web Audio graph.

export interface UseMetronomeOptions {
  initialBpm?: number;
  initialBeatsPerBar?: number;
}

export function useMetronome(opts: UseMetronomeOptions = {}) {
  const [bpm, setBpmState] = useState(opts.initialBpm ?? 90);
  const [beatsPerBar, setBeatsPerBarState] = useState(
    opts.initialBeatsPerBar ?? 4,
  );
  const [running, setRunning] = useState(false);
  const [currentBeat, setCurrentBeat] = useState<number | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<MetronomeEngine | null>(null);

  if (engineRef.current === null) {
    engineRef.current = new MetronomeEngine({
      bpm: opts.initialBpm ?? 90,
      beatsPerBar: opts.initialBeatsPerBar ?? 4,
      getAudioTime: () => audioCtxRef.current?.currentTime ?? 0,
      scheduleClick: (beatIndex, isDownbeat, time) => {
        const ctx = audioCtxRef.current;
        if (!ctx) return () => {};
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.value = isDownbeat
          ? DOWNBEAT_FREQUENCY
          : NORMAL_FREQUENCY;
        env.gain.setValueAtTime(0.0001, time);
        env.gain.exponentialRampToValueAtTime(
          isDownbeat ? 0.6 : 0.4,
          time + 0.001,
        );
        env.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
        osc.connect(env).connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.06);
        return () => {
          try {
            osc.stop(time);
          } catch {
            // Already stopped, nothing to cancel.
          }
          osc.disconnect();
          env.disconnect();
        };
      },
      onBeat: (beatIndex) => setCurrentBeat(beatIndex),
    });
  }

  const engine = engineRef.current;

  // Cleanup on unmount: stop the loop and cancel anything still queued.
  useEffect(() => () => engine.stop(), [engine]);

  const setBpm = useCallback(
    (next: number) => {
      engine.setBpm(next);
      setBpmState(next);
    },
    [engine],
  );

  const setBeatsPerBar = useCallback(
    (next: number) => {
      engine.setBeatsPerBar(next);
      setBeatsPerBarState(next);
    },
    [engine],
  );

  const start = useCallback(() => {
    if (engine.isRunning) return;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") void ctx.resume();
    engine.start();
    setRunning(true);
  }, [engine]);

  const stop = useCallback(() => {
    if (!engine.isRunning) return;
    engine.stop(); // also cancels queued clicks and pending indicator updates
    setRunning(false);
    setCurrentBeat(null);
  }, [engine]);

  const toggle = useCallback(() => {
    if (engine.isRunning) stop();
    else start();
  }, [engine, start, stop]);

  return {
    bpm,
    setBpm,
    beatsPerBar,
    setBeatsPerBar,
    running,
    currentBeat,
    start,
    stop,
    toggle,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tap-tempo helper. Pure function, easy to test.
// Returns BPM averaged from the last N taps (or null if not enough data).
// Resets the rolling window if a gap > 2s between taps is observed.

const MAX_TAPS = 6;
const TAP_GAP_RESET_MS = 2000;

export function makeTapTempo() {
  let timestamps: number[] = [];

  function tap(now: number = performance.now()): number | null {
    const last = timestamps[timestamps.length - 1];
    if (last && now - last > TAP_GAP_RESET_MS) {
      timestamps = [];
    }
    timestamps.push(now);
    if (timestamps.length > MAX_TAPS) timestamps.shift();
    if (timestamps.length < 2) return null;
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return Math.round(60000 / avgMs);
  }

  function reset() {
    timestamps = [];
  }

  return { tap, reset };
}
