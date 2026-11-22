/**
 * Hook-level session orchestration tests.
 *
 * These exercise the React hook against the mocked Web Audio API to verify that
 * start / reset / stop / restart / mode-change produce session boundaries that
 * the UI can rely on, and that the audio pipeline keeps feeding the decoder
 * across a reset or mode switch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAudioProcessor } from '@/hooks/useAudioProcessor';
import { SSTVDecoder, DecoderState } from '@/lib/sstv/decoder';
import { SSTV_MODES } from '@/lib/sstv/constants';

/** Reach into the mocked AudioContext to grab the ScriptProcessor node. */
function getProcessorNode() {
  const AudioCtor = global.AudioContext as unknown as jest.Mock;
  const ctx = AudioCtor.mock.results[AudioCtor.mock.results.length - 1].value;
  const createProcessor = ctx.createScriptProcessor as jest.Mock;
  return createProcessor.mock.results[createProcessor.mock.results.length - 1].value as {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: (n: number) => Float32Array } }) => void) | null;
    disconnect: jest.Mock;
    connect: jest.Mock;
  };
}

function feedAudio(node: ReturnType<typeof getProcessorNode>, length = 4096) {
  act(() => {
    node.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(length) },
    });
  });
}

function latestStats(result: { current: ReturnType<typeof useAudioProcessor> }) {
  return result.current.state.stats!;
}

describe('useAudioProcessor session orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('start opens a decoding session and publishes stats', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    await waitFor(() => expect(result.current.state.isRecording).toBe(true));

    const stats = latestStats(result);
    expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
    expect(stats.modeKey).toBe('ROBOT36');
    expect(stats.currentLine).toBe(0);
    expect(stats.totalLines).toBe(SSTV_MODES.ROBOT36.height);
    expect(result.current.getSessionId()).toBeGreaterThan(0);
  });

  test('reset while recording clears stats but keeps decoding and receiving audio', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));
    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));

    const node = getProcessorNode();
    const processSpy = jest.spyOn(SSTVDecoder.prototype, 'processSamples');
    const sessionBefore = result.current.getSessionId();

    feedAudio(node);
    expect(processSpy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resetDecoder();
    });

    // A new session was opened, but audio is still being decoded — not silenced.
    const afterReset = latestStats(result);
    expect(afterReset.sessionId).toBeGreaterThan(sessionBefore);
    expect(afterReset.currentLine).toBe(0);
    expect(afterReset.state).toBe(DecoderState.DECODING_IMAGE);
    expect(result.current.state.isRecording).toBe(true);

    const sessionsAfterReset = result.current.getSessionId();
    feedAudio(node);
    // The audio pipeline continues to hand samples to the decoder and does not
    // silently restart the session behind the user's back.
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(result.current.getSessionId()).toBe(sessionsAfterReset);

    processSpy.mockRestore();
  });

  test('reset while stopped clears the image and keeps the decoder idle', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));
    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));

    act(() => {
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(false));

    // Stopped stats are retained so the image stays visible.
    expect(result.current.state.stats).not.toBeNull();

    act(() => {
      result.current.resetDecoder();
    });

    const stats = latestStats(result);
    expect(stats.state).toBe(DecoderState.IDLE);
    expect(stats.currentLine).toBe(0);
    expect(result.current.getImageData()).not.toBeNull();
    expect(Array.from(result.current.getImageData()!).every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
  });

  test('stop retains image but a restart begins a new isolated session', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));
    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));
    const firstSession = result.current.getSessionId();

    act(() => {
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(false));

    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));

    const restarted = latestStats(result);
    expect(restarted.sessionId).toBeGreaterThan(firstSession);
    expect(restarted.currentLine).toBe(0);
    expect(restarted.frequency).toBe(1900);
    expect(restarted.state).toBe(DecoderState.DECODING_IMAGE);
  });

  test('mode change while recording rebuilds dimensions and clears the image in place', async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: 'ROBOT36' | 'PD120' }) => useAudioProcessor(mode),
      { initialProps: { mode: 'ROBOT36' as 'ROBOT36' | 'PD120' } }
    );

    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));

    const sessionBefore = result.current.getSessionId();

    // The component switches mode then re-renders with the new prop.
    act(() => {
      result.current.changeMode('PD120');
    });
    rerender({ mode: 'PD120' });

    await waitFor(() => expect(latestStats(result).modeKey).toBe('PD120'));

    const stats = latestStats(result);
    expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
    expect(stats.width).toBe(SSTV_MODES.PD120.width);
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
    expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
    expect(stats.sessionId).toBeGreaterThan(sessionBefore);
    // Audio pipeline still running.
    expect(result.current.state.isRecording).toBe(true);

    // Image buffer resized and fully black — no old-mode pixels.
    const image = result.current.getImageData()!;
    expect(image.length).toBe(SSTV_MODES.PD120.width * SSTV_MODES.PD120.height * 4);
    expect(Array.from(image).every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);

    // The filename reflects the new mode and session.
    expect(result.current.buildFilename()).toContain('pd120');
  });

  test('mode change while stopped updates dimensions without starting audio', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));
    await act(async () => {
      await result.current.startRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(true));
    act(() => {
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.state.isRecording).toBe(false));

    act(() => {
      result.current.changeMode('SCOTTIE_S2');
    });

    const stats = latestStats(result);
    expect(stats.modeKey).toBe('SCOTTIE_S2');
    expect(stats.totalLines).toBe(SSTV_MODES.SCOTTIE_S2.height);
    expect(stats.state).toBe(DecoderState.IDLE);
    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.getDimensions()).toEqual({
      width: SSTV_MODES.SCOTTIE_S2.width,
      height: SSTV_MODES.SCOTTIE_S2.height,
    });
  });
});
