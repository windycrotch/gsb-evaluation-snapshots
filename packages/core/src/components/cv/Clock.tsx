import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
  ReactNode,
  useImperativeHandle,
} from 'react';
import { useAudioContext } from '../../context/AudioContext';
import { ModStreamRef } from '../../types/ModStream';
import { useControlledState } from '../../hooks/useControlledState';
import { acquireSharedTransport, releaseSharedTransport } from '../../transportRegistry';
import { WorkletTransport } from '../../transportWorklet';
import { TransportBus, TransportBusState } from '../../transportBus';

export interface ClockHandle {
  start: () => void;
  stop: () => void;
  reset: () => void;
  getState: () => {
    bpm: number;
    isRunning: boolean;
  };
}

export interface ClockRenderProps {
  bpm: number;
  setBpm: (value: number) => void;
  isRunning: boolean;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

export interface ClockProps {
  output: ModStreamRef;
  startOutput?: ModStreamRef;
  stopOutput?: ModStreamRef;
  label?: string;
  // Controlled props
  bpm?: number;
  onBpmChange?: (bpm: number) => void;
  // Event callbacks
  onRunningChange?: (isRunning: boolean) => void;
  // Render props
  children?: (props: ClockRenderProps) => ReactNode;
}

export const Clock = React.forwardRef<ClockHandle, ClockProps>(({
  output,
  startOutput,
  stopOutput,
  label = 'clock',
  bpm: controlledBpm,
  onBpmChange,
  onRunningChange,
  children,
}, ref) => {
  const audioContext = useAudioContext();
  const [bpm, setBpm] = useControlledState(controlledBpm, 120, onBpmChange);
  const [isRunning, setIsRunning] = useState(false);
  const [isWorkletReady, setIsWorkletReady] = useState(false);

  const clockGainRef = useRef<GainNode | null>(null);
  const startGainRef = useRef<GainNode | null>(null);
  const stopGainRef = useRef<GainNode | null>(null);
  const transportRef = useRef<WorkletTransport | null>(null);
  const transportBusRef = useRef<TransportBus | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const isControlled = controlledBpm !== undefined;
  const isControlledRef = useRef(isControlled);
  isControlledRef.current = isControlled;
  const controlledBpmRef = useRef(controlledBpm);
  controlledBpmRef.current = controlledBpm;
  const setBpmRef = useRef(setBpm);
  setBpmRef.current = setBpm;
  // The imperative handle may outlive the render that created it (the
  // AudioContext arrives one effect after mount), so read it via a ref.
  const audioContextRef = useRef(audioContext);
  audioContextRef.current = audioContext;
  // Mirrors `isRunning` for the imperative handle, which must not capture a
  // stale render value.
  const runningRef = useRef(isRunning);
  runningRef.current = isRunning;

  // Last tempo this Clock applied to (or adopted from) the shared clock.
  // Guards against re-pushing a stale local value after a sibling retuned.
  const appliedBpmRef = useRef<number | null>(null);
  // Later Clocks adopt the shared tempo instead of overwriting it on mount.
  const skipInitialTempoRef = useRef(false);
  // A start requested before the shared worklet finished loading.
  const startRequestedRef = useRef(false);

  // Create clock output once
  useEffect(() => {
    if (!audioContext) return;

    const clockGain = audioContext.createGain();
    clockGain.gain.value = 1.0;
    clockGainRef.current = clockGain;

    output.current = {
      audioNode: clockGain,
      gain: clockGain,
      context: audioContext,
      metadata: {
        label,
        sourceType: 'cv',
      },
    };

    if (startOutput) {
      const startGain = audioContext.createGain();
      startGain.gain.value = 1.0;
      startGainRef.current = startGain;

      startOutput.current = {
        audioNode: startGain,
        gain: startGain,
        context: audioContext,
        metadata: {
          label: `${label}-start`,
          sourceType: 'cv',
        },
      };
    }

    if (stopOutput) {
      const stopGain = audioContext.createGain();
      stopGain.gain.value = 1.0;
      stopGainRef.current = stopGain;

      stopOutput.current = {
        audioNode: stopGain,
        gain: stopGain,
        context: audioContext,
        metadata: {
          label: `${label}-stop`,
          sourceType: 'cv',
        },
      };
    }

    let active = true;
    let unsubscribeState: (() => void) | null = null;

    acquireSharedTransport(audioContext).then(({ transport, bus, isPrimary }) => {
      if (!active) return;
      transportRef.current = transport;
      transportBusRef.current = bus;
      const node = transport.getNode();
      if (node) {
        node.connect(clockGain, 0, 0);
        if (startGainRef.current) {
          node.connect(startGainRef.current, 1, 0);
        }
        if (stopGainRef.current) {
          node.connect(stopGainRef.current, 2, 0);
        }
      }
      output.current = {
        audioNode: clockGain,
        gain: clockGain,
        context: audioContext,
        transport: bus,
        metadata: {
          label,
          sourceType: 'cv',
        },
      };
      workletNodeRef.current = node;

      // Every Clock on this context mirrors the shared clock state, so a
      // sibling starting, stopping or retuning updates this Clock as well.
      unsubscribeState = bus.on('state', (payload) => {
        if (!active) return;
        const state = payload as TransportBusState;
        setIsRunning(state.isRunning);
        if (!isControlledRef.current) {
          setBpmRef.current(state.bpm);
        }
      });

      const sharedBpm = transport.bpm;
      if (isPrimary === false && typeof sharedBpm === 'number') {
        // A shared clock already exists. A controlled Clock explicitly
        // declares its tempo, so honour that; an uncontrolled one adopts the
        // shared tempo instead of resetting it to its own default on mount.
        const controlled = controlledBpmRef.current;
        if (isControlledRef.current && typeof controlled === 'number' && controlled !== sharedBpm) {
          appliedBpmRef.current = null;
          skipInitialTempoRef.current = false;
        } else {
          appliedBpmRef.current = sharedBpm;
          skipInitialTempoRef.current = true;
          if (!isControlledRef.current) {
            setBpmRef.current(sharedBpm);
          }
        }
      } else {
        // This Clock created the shared clock; seed it with the local tempo.
        appliedBpmRef.current = null;
        skipInitialTempoRef.current = false;
      }

      setIsRunning(transport.isPlaying);
      setIsWorkletReady(true);

      if (startRequestedRef.current && !transport.isPlaying) {
        transport.start(audioContext.currentTime);
      }
    }).catch((err) => {
      console.error('Failed to load transport worklet', err);
    });

    return () => {
      active = false;
      startRequestedRef.current = false;
      appliedBpmRef.current = null;
      skipInitialTempoRef.current = false;
      // Stop listening before releasing: an unmounted Clock must not react to
      // shared clock events, even while sibling Clocks keep it alive.
      if (unsubscribeState) {
        unsubscribeState();
        unsubscribeState = null;
      }
      transportRef.current = null;
      transportBusRef.current = null;
      clockGain.disconnect();
      output.current = null;
      clockGainRef.current = null;
      if (workletNodeRef.current) {
        try { workletNodeRef.current.disconnect(); } catch (e) {}
        workletNodeRef.current = null;
      }
      if (startGainRef.current) {
        startGainRef.current.disconnect();
        startGainRef.current = null;
      }
      if (startOutput) {
        startOutput.current = null;
      }
      if (stopGainRef.current) {
        stopGainRef.current.disconnect();
        stopGainRef.current = null;
      }
      if (stopOutput) {
        stopOutput.current = null;
      }
      releaseSharedTransport(audioContext);
      setIsWorkletReady(false);
    };
  }, [audioContext, label, startOutput, stopOutput]);

  const start = useCallback(() => {
    const context = audioContextRef.current;
    const transport = transportRef.current;

    startRequestedRef.current = true;
    setIsRunning(true);

    // Already running (possibly started by a sibling Clock): nothing to do
    // beyond reflecting the shared state. Missing transport means the worklet
    // is still loading; the pending request is honoured once it resolves.
    if (!context || !transport || transport.isPlaying) return;
    transport.start(context.currentTime);
  }, []);

  const stop = useCallback(() => {
    const context = audioContextRef.current;
    const transport = transportRef.current;

    startRequestedRef.current = false;
    setIsRunning(false);

    // Duplicate stop calls are a no-op instead of throwing or double-emitting.
    if (!context || !transport || !transport.isPlaying) return;
    transport.stop(context.currentTime);
  }, []);

  const reset = useCallback(() => {
    stop();
  }, [stop]);

  useEffect(() => {
    if (!audioContext || !transportRef.current || !isWorkletReady) return;

    if (skipInitialTempoRef.current) {
      skipInitialTempoRef.current = false;
      appliedBpmRef.current = bpm;
      return;
    }

    // Only push genuinely new values: re-applying our local bpm after a
    // sibling changed the tempo would silently revert the shared clock.
    if (appliedBpmRef.current === bpm) return;

    appliedBpmRef.current = bpm;
    if (transportRef.current.bpm === bpm) return;
    transportRef.current.setTempo(bpm, audioContext.currentTime);
  }, [bpm, audioContext, isWorkletReady]);


  useImperativeHandle(ref, () => ({
    start,
    stop,
    reset,
    getState: () => ({
      // The shared transport is the source of truth: the last Clock to set a
      // tempo or toggle running decides for every Clock on this context.
      bpm: transportRef.current?.bpm ?? bpm,
      isRunning: transportRef.current?.isPlaying ?? runningRef.current,
    }),
  }), [start, stop, reset, bpm]);

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  if (children) {
    return <>{children({
      bpm,
      setBpm,
      isRunning,
      start,
      stop,
      reset,
    })}</>;
  }

  return null;
});

Clock.displayName = 'Clock';
