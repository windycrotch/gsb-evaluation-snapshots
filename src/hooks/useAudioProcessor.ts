import { useCallback, useEffect, useRef, useState } from 'react';
import { SSTVDecoder, DecoderStats } from '@/lib/sstv/decoder';
import { SSTV_MODES, SAMPLE_RATE } from '@/lib/sstv/constants';

export type SSTVMode = keyof typeof SSTV_MODES;

export interface AudioProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  stats: DecoderStats | null;
}

/**
 * Audio capture + SSTV decoding lifecycle.
 *
 * A decoding session follows an explicit lifecycle:
 *
 *   idle ──start──▶ decoding ──stop──▶ stopped ──start──▶ decoding (fresh)
 *     ▲                │                   │
 *     └─────reset──────┴───────reset───────┘
 *
 * - start():   opens the microphone and creates a brand-new decoder.
 * - decoding:  samples are fed to exactly one decoder instance.
 * - stop():    disconnects the audio graph, keeps the decoded image for saving.
 * - reset():   clears image, progress, sync state and both decoder buffers;
 *              if a session is active it immediately starts a fresh one.
 * - mode change: tears down the current session (and audio graph) before a new
 *              decoder for the new mode is created, so two decoders can never
 *              write to the same canvas.
 */
export function useAudioProcessor(mode: SSTVMode = 'ROBOT36') {
  const [state, setState] = useState<AudioProcessorState>({
    isRecording: false,
    isSupported: false,
    error: null,
    stats: null,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<SSTVDecoder | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  // Lifecycle bookkeeping. `sessionTokenRef` invalidates any in-flight async
  // start (e.g. a getUserMedia() that resolves after stop/reset/mode change).
  const sessionTokenRef = useRef(0);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);

  // Latest mode, readable from async callbacks without stale closures.
  const modeRef = useRef<SSTVMode>(mode);

  // Tear down the audio graph and stream. Does not touch the decoder.
  const teardownAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    if (silentGainRef.current) {
      silentGainRef.current.disconnect();
      silentGainRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      // close() is async; ignore errors from an already-closed context.
      void ctx.close().catch(() => undefined);
    }
  }, []);

  // Check browser support on mount
  useEffect(() => {
    const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
    const hasMediaDevices = typeof navigator !== 'undefined' &&
                            !!navigator.mediaDevices &&
                            typeof navigator.mediaDevices.getUserMedia === 'function';

    setState(prev => ({ ...prev, isSupported: hasAudioContext && hasMediaDevices }));
  }, []);

  /**
   * Calculate Signal-to-Noise Ratio (SNR) in dB from the live analyser.
   * Returns null when no audio graph is available.
   */
  const calculateSNR = useCallback((): number | null => {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) return null;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    // SSTV signal band: 1200-2300 Hz (sync to white)
    const signalBandStart = 1200;
    const signalBandEnd = 2300;
    // Noise bands outside the SSTV signal
    const noiseBandLow1 = 300;
    const noiseBandLow2 = 1000;
    const noiseBandHigh1 = 2500;
    const noiseBandHigh2 = 4000;

    const freqToBin = (freq: number) => Math.floor((freq / nyquist) * bufferLength);

    const signalBinStart = freqToBin(signalBandStart);
    const signalBinEnd = freqToBin(signalBandEnd);
    const noiseBinLow1 = freqToBin(noiseBandLow1);
    const noiseBinLow2 = freqToBin(noiseBandLow2);
    const noiseBinHigh1 = freqToBin(noiseBandHigh1);
    const noiseBinHigh2 = freqToBin(noiseBandHigh2);

    let signalPower = 0;
    let signalCount = 0;
    for (let i = signalBinStart; i <= signalBinEnd; i++) {
      signalPower += dataArray[i] * dataArray[i];
      signalCount++;
    }
    if (signalCount === 0) return null;
    signalPower /= signalCount;

    let noisePower = 0;
    let noiseCount = 0;
    for (let i = noiseBinLow1; i <= noiseBinLow2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }
    for (let i = noiseBinHigh1; i <= noiseBinHigh2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }
    if (noiseCount === 0) return null;
    noisePower /= noiseCount;

    if (noisePower < 1) noisePower = 1;
    if (signalPower < 1) signalPower = 1;

    return 10 * Math.log10(signalPower / noisePower);
  }, []);

  /**
   * Replace the active decoder with a fresh instance for `modeName`.
   * The previous decoder is stopped first so it can never consume samples or
   * write to the canvas after the swap.
   */
  const createDecoder = useCallback((sampleRate: number, modeName: SSTVMode): SSTVDecoder => {
    if (decoderRef.current) {
      decoderRef.current.stop();
    }
    const decoder = new SSTVDecoder(sampleRate, modeName);
    decoderRef.current = decoder;
    return decoder;
  }, []);

  /**
   * Start a decoding session: request the microphone, build the audio graph and
   * create a brand-new decoder for the current mode. Safe to call while a
   * previous session is stopping: the newest call owns the session token.
   */
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) {
      return;
    }

    const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
    const hasMediaDevices = typeof navigator !== 'undefined' &&
                            !!navigator.mediaDevices &&
                            typeof navigator.mediaDevices.getUserMedia === 'function';

    if (!hasAudioContext || !hasMediaDevices) {
      setState(prev => ({
        ...prev,
        error: 'Web Audio API not supported in this browser',
        isRecording: false,
      }));
      return;
    }

    const token = ++sessionTokenRef.current;
    const sessionMode = modeRef.current;
    isStartingRef.current = true;

    try {
      // Don't specify sampleRate - let the browser use the hardware's native rate
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // A stop/reset/mode change happened while we were waiting for permission.
      if (token !== sessionTokenRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      streamRef.current = stream;

      // Firefox requires AudioContext and MediaStream to have the same sample rate
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      console.log(`AudioContext created with sample rate: ${audioContext.sampleRate} Hz`);

      const source = audioContext.createMediaStreamSource(stream);

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      source.connect(analyser);

      // The decoder must exist before the first audio callback fires.
      const decoder = createDecoder(audioContext.sampleRate, sessionMode);
      decoder.start();

      const publishStats = () => {
        // Ignore callbacks from a superseded session.
        if (token !== sessionTokenRef.current || decoderRef.current !== decoder) {
          return;
        }
        const stats = decoder.getStats();
        let snr: number | null = null;
        try {
          snr = calculateSNR();
        } catch {
          snr = null;
        }
        setState(prev => ({ ...prev, stats: { ...stats, snr } }));
      };

      let useScriptProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const bufferSize = 4096;
          const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          processorNodeRef.current = processor;

          processor.onaudioprocess = (event) => {
            if (token !== sessionTokenRef.current || decoderRef.current !== decoder) {
              return;
            }
            const inputData = event.inputBuffer.getChannelData(0);
            decoder.processSamples(inputData);
            publishStats();
          };

          analyser.connect(processor);
          processor.connect(audioContext.destination);
          useScriptProcessor = true;
          console.log('Using ScriptProcessorNode for audio processing');
        }
      } catch {
        console.warn('ScriptProcessorNode not available, using polling fallback');
      }

      // Fallback: requestAnimationFrame polling for Safari/iOS
      if (!useScriptProcessor) {
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.001;
        silentGainRef.current = silentGain;
        analyser.connect(silentGain);
        silentGain.connect(audioContext.destination);

        const pollAudio = () => {
          // Stop the loop as soon as the session is no longer current.
          if (token !== sessionTokenRef.current ||
              decoderRef.current !== decoder ||
              !analyserRef.current) {
            return;
          }

          const bufferLength = analyser.fftSize;
          const dataArray = new Float32Array(bufferLength);
          analyser.getFloatTimeDomainData(dataArray);

          decoder.processSamples(dataArray);
          publishStats();

          animationFrameRef.current = requestAnimationFrame(pollAudio);
        };

        console.log('Using requestAnimationFrame polling for audio processing (Safari-compatible)');
        animationFrameRef.current = requestAnimationFrame(pollAudio);
      }

      // A mode switch may have replaced the decoder while the graph was built.
      if (token !== sessionTokenRef.current || decoderRef.current !== decoder) {
        teardownAudio();
        return;
      }

      isRecordingRef.current = true;
      setState(prev => ({
        ...prev,
        isRecording: true,
        error: null,
        stats: decoder.getStats(),
      }));
    } catch (err) {
      if (token === sessionTokenRef.current) {
        teardownAudio();
        const error = err instanceof Error ? err.message : 'Failed to access microphone';
        setState(prev => ({
          ...prev,
          error,
          isRecording: false,
        }));
      }
    } finally {
      // Only the session that still owns the token may clear the "starting" flag.
      if (token === sessionTokenRef.current) {
        isStartingRef.current = false;
      }
    }
  }, [calculateSNR, createDecoder, teardownAudio]);

  /**
   * Stop the session: release the microphone and audio nodes. The decoded
   * image and its statistics are retained so the user can still save it, but
   * no further samples reach the decoder.
   */
  const stopRecording = useCallback(() => {
    // Invalidate any in-flight start so it cannot resurrect the session.
    sessionTokenRef.current++;
    isStartingRef.current = false;
    isRecordingRef.current = false;

    teardownAudio();

    if (decoderRef.current) {
      decoderRef.current.stop();
      const stats = decoderRef.current.getStats();
      setState(prev => ({
        ...prev,
        isRecording: false,
        stats: { ...stats, snr: prev.stats?.snr ?? null },
      }));
    } else {
      setState(prev => ({ ...prev, isRecording: false }));
    }
  }, [teardownAudio]);

  /**
   * Reset the current session: blank the image, zero progress and sync state
   * and clear both internal circular buffers. If a session is active, a fresh
   * one starts immediately; otherwise the decoder is left idle.
   */
  const resetDecoder = useCallback(() => {
    const decoder = decoderRef.current;
    if (!decoder) {
      setState(prev => ({ ...prev, stats: null }));
      return;
    }

    decoder.reset();

    if (isRecordingRef.current) {
      // Keep the session token: we stay in the same audio session but start a
      // brand-new frame with completely clear buffers.
      decoder.start();
      const stats = decoder.getStats();
      setState(prev => ({ ...prev, stats: { ...stats, snr: prev.stats?.snr ?? null } }));
    } else {
      // Stopped (or never started): remain inactive, just blanked.
      setState(prev => ({ ...prev, stats: null }));
    }
  }, []);

  /**
   * Switch the decoder to `newMode`.
   *
   * - While recording: stop the old session *first*, then start a new one with
   *   the new mode (only one decoder ever owns the canvas).
   * - While stopped/idle: replace the image with a blank image of the new mode.
   */
  const changeMode = useCallback((newMode: SSTVMode) => {
    if (modeRef.current === newMode) {
      return;
    }
    const wasActive = isRecordingRef.current || isStartingRef.current;
    modeRef.current = newMode;

    if (wasActive) {
      // Invalidate any pending start and tear down the old session.
      stopRecording();
      void startRecording();
      return;
    }

    // No active audio graph: swap in a fresh, idle decoder for the new mode.
    if (decoderRef.current) {
      decoderRef.current.stop();
      decoderRef.current = null;
    }
    const sampleRate = audioContextRef.current?.sampleRate ?? SAMPLE_RATE;
    decoderRef.current = new SSTVDecoder(sampleRate, newMode);
    setState(prev => ({ ...prev, stats: null }));
  }, [startRecording, stopRecording]);

  // React to mode prop changes (mode is also switched explicitly by the UI).
  useEffect(() => {
    changeMode(mode);
  }, [mode, changeMode]);

  const getImageData = useCallback((): Uint8ClampedArray | null => {
    return decoderRef.current ? decoderRef.current.getImageData() : null;
  }, []);

  const getDimensions = useCallback(() => {
    if (decoderRef.current) {
      return decoderRef.current.getDimensions();
    }
    const modeConfig = SSTV_MODES[modeRef.current];
    return { width: modeConfig.width, height: modeConfig.height };
  }, []);

  const getAnalyser = useCallback((): AnalyserNode | null => {
    return analyserRef.current;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Invalidate any in-flight start; refs are intentionally read at cleanup
      // time so the latest session is torn down, not the one from mount.
      const tokenRef = sessionTokenRef;
      tokenRef.current++;
      isRecordingRef.current = false;
      teardownAudio();
      if (decoderRef.current) {
        decoderRef.current.stop();
      }
    };
  }, [teardownAudio]);

  return {
    state,
    startRecording,
    stopRecording,
    resetDecoder,
    changeMode,
    getImageData,
    getDimensions,
    getAnalyser,
  };
}
