import { renderHook, act, waitFor } from '@testing-library/react';
import { useAudioProcessor, SSTVMode } from '../useAudioProcessor';
import { DecoderState } from '@/lib/sstv/decoder';

/**
 * These tests exercise the *lifecycle* contract of the audio hook: which
 * decoder exists, when it is created/destroyed, and that no audio graph leaks
 * across start/stop/reset/mode-switch.
 */
describe('useAudioProcessor lifecycle', () => {
  let mockAudioContextInstances: any[];
  let mockStreams: any[];
  let mockProcessors: any[];
  let getUserMedia: jest.Mock;
  let getUserMediaImpl: () => Promise<any>;

  const installGetUserMedia = () => {
    getUserMedia = jest.fn().mockImplementation(() => getUserMediaImpl());
    (global.navigator.mediaDevices as any).getUserMedia = getUserMedia;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAudioContextInstances = [];
    mockStreams = [];
    mockProcessors = [];

    getUserMediaImpl = () => {
      const track = { stop: jest.fn(), kind: 'audio' };
      const stream = {
        tracks: [track],
        getTracks: () => [track],
      };
      mockStreams.push(stream);
      return Promise.resolve(stream);
    };
    installGetUserMedia();

    global.AudioContext = jest.fn().mockImplementation(() => {
      const analyser = {
        fftSize: 2048,
        frequencyBinCount: 1024,
        getByteFrequencyData: jest.fn(),
        getFloatTimeDomainData: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
        context: null,
      };
      const processor = {
        connect: jest.fn(),
        disconnect: jest.fn(),
        onaudioprocess: null,
      };
      const ctx: any = {
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn().mockReturnValue({
          gain: { value: 1 },
          connect: jest.fn(),
          disconnect: jest.fn(),
        }),
        createScriptProcessor: jest.fn().mockImplementation(() => {
          mockProcessors.push(processor);
          return processor;
        }),
        createMediaStreamSource: jest.fn().mockReturnValue({
          connect: jest.fn(),
          disconnect: jest.fn(),
        }),
        sampleRate: 48000,
        close: jest.fn().mockResolvedValue(undefined),
        destination: {},
      };
      analyser.context = ctx;
      mockAudioContextInstances.push(ctx);
      return ctx;
    }) as any;
  });

  test('starts idle and decodes only after startRecording', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await waitFor(() => expect(result.current.state.isSupported).toBe(true));
    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.state.stats).toBeNull();

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.state).toBe(DecoderState.DECODING_IMAGE);
    expect(result.current.state.stats?.mode).toBe('Robot 36');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test('stopRecording keeps the decoded image and stats but frees the microphone', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });
    const statsWhileRecording = result.current.state.stats;

    await act(async () => {
      result.current.stopRecording();
    });

    expect(result.current.state.isRecording).toBe(false);
    // Stats are retained so the image can still be saved.
    expect(result.current.state.stats).not.toBeNull();
    expect(result.current.state.stats?.state).toBe(DecoderState.STOPPED);
    expect(result.current.state.stats?.mode).toBe(statsWhileRecording?.mode);

    // Stream tracks stopped and audio context closed.
    const stream = mockStreams[0];
    expect(stream).toBeDefined();
    expect(mockAudioContextInstances[0].close).toHaveBeenCalled();
  });

  test('resetDecoder clears stats when idle', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    // No session yet: reset just clears stats and does not throw.
    act(() => {
      result.current.resetDecoder();
    });
    expect(result.current.state.stats).toBeNull();
    expect(result.current.state.isRecording).toBe(false);
  });

  test('resetDecoder during a session clears image/progress and keeps decoding', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    // Feed real synthetic audio through the created decoder via the captured
    // processor node.
    const processor = mockProcessors[0];
    const { generateRobot36Samples, ROBOT36_EVEN_LINE, ROBOT36_ODD_LINE } = require('@/lib/sstv/testing/synthetic-sstv');
    const lines = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { ...ROBOT36_EVEN_LINE, luminance: 2200, chrominance: 1600 }
        : { ...ROBOT36_ODD_LINE, luminance: 1600, chrominance: 2200 }
    );
    const samples = generateRobot36Samples(lines, 48000);
    const input = new Float32Array(4096);
    for (let offset = 0; offset + 4096 <= samples.length; offset += 4096) {
      input.set(samples.subarray(offset, offset + 4096));
      act(() => {
        processor.onaudioprocess({ inputBuffer: { getChannelData: () => input } });
      });
    }

    expect(result.current.state.stats?.currentLine).toBeGreaterThan(0);

    await act(async () => {
      result.current.resetDecoder();
    });

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.currentLine).toBe(0);
    expect(result.current.state.stats?.progress).toBe(0);
    expect(result.current.state.stats?.state).toBe(DecoderState.DECODING_IMAGE);
  });

  test('changeMode while recording restarts a single session with the new mode', async () => {
    const { result, rerender } = renderHook(
      ({ mode }) => useAudioProcessor(mode),
      { initialProps: { mode: 'ROBOT36' as SSTVMode } }
    );

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.mode).toBe('Robot 36');

    await act(async () => {
      result.current.changeMode('PD120');
    });
    rerender({ mode: 'PD120' as SSTVMode });

    await waitFor(() => expect(result.current.state.isRecording).toBe(true));
    expect(result.current.state.stats?.mode).toBe('PD 120');
    expect(result.current.state.stats?.currentLine).toBe(0);
    expect(result.current.state.stats?.totalLines).toBe(496);

    // Exactly one live audio graph / microphone stream remains.
    expect(mockStreams.length).toBe(2);
    expect(mockAudioContextInstances.length).toBe(2);
    expect(mockAudioContextInstances[0].close).toHaveBeenCalled();
    expect(mockAudioContextInstances[1].close).not.toHaveBeenCalled();

    // Dimensions follow the new mode.
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });
  });

  test('changeMode while stopped swaps in a blank decoder for the new mode', async () => {
    const { result, rerender } = renderHook(
      ({ mode }) => useAudioProcessor(mode),
      { initialProps: { mode: 'ROBOT36' as SSTVMode } }
    );

    await act(async () => {
      result.current.changeMode('SCOTTIE_S1');
    });
    rerender({ mode: 'SCOTTIE_S1' as SSTVMode });

    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.state.stats).toBeNull();
    expect(result.current.getDimensions()).toEqual({ width: 320, height: 256 });
    const image = result.current.getImageData();
    expect(image).not.toBeNull();
    expect(image!.length).toBe(320 * 256 * 4);
    // Blank image
    for (let i = 0; i < image!.length; i += 4) {
      expect(image![i] === 0 && image![i + 1] === 0 && image![i + 2] === 0).toBe(true);
    }
  });

  test('a stop during microphone startup does not resurrect the session', async () => {
    let resolveStream: (value: any) => void = () => {};
    getUserMediaImpl = () => new Promise(resolve => { resolveStream = resolve; });
    installGetUserMedia();

    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.startRecording();
    });

    act(() => {
      result.current.stopRecording();
    });

    const track = { stop: jest.fn(), kind: 'audio' };
    const stream = { getTracks: () => [track] };
    await act(async () => {
      resolveStream(stream);
      await startPromise!;
    });

    expect(result.current.state.isRecording).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    // No audio context should have been constructed for the abandoned session.
    expect(mockAudioContextInstances.length).toBe(0);
  });

  test('stop then start begins a completely fresh frame', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    // Capture the handler itself: stopRecording detaches it from the node, and
    // a detached handler is exactly what a late audio callback would hold.
    const staleHandler = mockProcessors[0].onaudioprocess;
    const { generateRobot36Samples, ROBOT36_EVEN_LINE, ROBOT36_ODD_LINE } = require('@/lib/sstv/testing/synthetic-sstv');
    const lines = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { ...ROBOT36_EVEN_LINE, luminance: 2200, chrominance: 1600 }
        : { ...ROBOT36_ODD_LINE, luminance: 1600, chrominance: 2200 }
    );
    const samples = generateRobot36Samples(lines, 48000);
    const input = new Float32Array(4096);
    for (let offset = 0; offset + 4096 <= samples.length; offset += 4096) {
      input.set(samples.subarray(offset, offset + 4096));
      act(() => {
        staleHandler({ inputBuffer: { getChannelData: () => input } });
      });
    }
    expect(result.current.state.stats?.currentLine).toBeGreaterThan(0);

    await act(async () => {
      result.current.stopRecording();
    });

    // A callback already in flight from the stopped session must be inert.
    act(() => {
      staleHandler({ inputBuffer: { getChannelData: () => input } });
    });
    const lineAfterStop = result.current.state.stats?.currentLine;
    expect(lineAfterStop).toBeGreaterThan(0);

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats?.currentLine).toBe(0);
    expect(result.current.state.stats?.progress).toBe(0);
    expect(result.current.state.stats?.state).toBe(DecoderState.DECODING_IMAGE);
  });

  test('switching mode mid-decode discards the old frame and only the new decoder receives audio', async () => {
    const { result, rerender } = renderHook(
      ({ mode }) => useAudioProcessor(mode),
      { initialProps: { mode: 'ROBOT36' as SSTVMode } }
    );
    const { generateRobot36Samples, ROBOT36_EVEN_LINE, ROBOT36_ODD_LINE } =
      require('@/lib/sstv/testing/synthetic-sstv');

    await act(async () => {
      await result.current.startRecording();
    });

    // Decode part of a Robot36 frame.
    const oldHandler = mockProcessors[0].onaudioprocess;
    const robot36Lines = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { ...ROBOT36_EVEN_LINE, luminance: 2200, chrominance: 1600 }
        : { ...ROBOT36_ODD_LINE, luminance: 1600, chrominance: 2200 }
    );
    const robot36Samples = generateRobot36Samples(robot36Lines, 48000);
    const chunk = new Float32Array(4096);
    for (let offset = 0; offset + 4096 <= robot36Samples.length; offset += 4096) {
      chunk.set(robot36Samples.subarray(offset, offset + 4096));
      act(() => {
        oldHandler({ inputBuffer: { getChannelData: () => chunk } });
      });
    }
    const robot36Line = result.current.state.stats?.currentLine ?? 0;
    expect(robot36Line).toBeGreaterThan(0);

    // Switch mode while the session is still recording.
    await act(async () => {
      result.current.changeMode('PD120');
    });
    rerender({ mode: 'PD120' as SSTVMode });
    await waitFor(() =>
      expect(result.current.state.stats?.mode).toBe('PD 120')
    );

    // The old image is gone: a fresh, blank 640x496 buffer.
    const freshImage = result.current.getImageData()!;
    expect(freshImage.length).toBe(640 * 496 * 4);
    expect(freshImage.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
    expect(result.current.state.stats?.currentLine).toBe(0);

    // Late callbacks from the Robot36 session must not touch the new frame.
    act(() => {
      oldHandler({ inputBuffer: { getChannelData: () => chunk } });
    });
    expect(result.current.state.stats?.currentLine).toBe(0);
    expect(result.current.state.stats?.mode).toBe('PD 120');

    // Only one audio graph is live, and it belongs to the new session.
    expect(mockProcessors.length).toBe(2);
    expect(mockProcessors[0].disconnect).toHaveBeenCalled();
  });
});
