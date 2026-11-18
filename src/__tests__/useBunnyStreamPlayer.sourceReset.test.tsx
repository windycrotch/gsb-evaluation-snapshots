import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useBunnyStreamPlayer } from '../player/hooks/useBunnyStreamPlayer';
import { DEFAULT_PLAYER_STATE, DEFAULT_PROGRESS } from '../player/state/playerState';
import { fire } from './helpers';

// Render the hook with an explicit source key, mirroring how the example
// screens pass `sourceIdentityKey(source)` as the second argument.
async function renderPlayerHookWithKey(
  initialKey: string | number,
  options?: Parameters<typeof useBunnyStreamPlayer>[0],
) {
  return renderHook(
    ({ key, options: opts }: { key: string | number; options: typeof options }) =>
      useBunnyStreamPlayer(opts, key),
    { initialProps: { key: initialKey, options } },
  );
}

describe('useBunnyStreamPlayer source reset and stale-event invalidation', () => {
  // --- 1. Normal source change resets aggregated state + progress ---

  it('resets state and progress to defaults when the source key changes', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');

    // Populate the first source's aggregated state.
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-1',
      durationMs: 60_000,
    });
    await fire(result.current.eventHandlers.onPlay, { positionMs: 0, durationMs: 60_000 });
    await fire(result.current.eventHandlers.onBuffering, { isBuffering: true });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 30_000,
      durationMs: 60_000,
      progress: 0.5,
    });
    expect(result.current.state.videoId).toBe('vid-1');
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.state.isBuffering).toBe(true);
    expect(result.current.state.isLoading).toBe(false);
    expect(result.current.progress.positionMs).toBe(30_000);

    await rerender({ key: 'video-2', options: undefined });

    // Low-frequency state is back to defaults.
    expect(result.current.state).toStrictEqual(DEFAULT_PLAYER_STATE);
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.state.playbackState).toBe('idle');
    expect(result.current.state.isPlaying).toBe(false);
    expect(result.current.state.isBuffering).toBe(false);
    expect(result.current.state.isLoading).toBe(true);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.liveState).toBeNull();
    // High-frequency progress channel is zeroed in the same reset — no
    // progress-bar-value / duration-zero mismatch.
    expect(result.current.progress).toStrictEqual(DEFAULT_PROGRESS);
    expect(result.current.progress.positionMs).toBe(0);
    expect(result.current.progress.durationMs).toBe(0);
    expect(result.current.progress.progress).toBe(0);

    await unmount();
  });

  it('resets an error and a live state left behind by the previous source', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('live-1');
    await fire(result.current.eventHandlers.onError, { code: 'X', message: 'boom' });
    await fire(result.current.eventHandlers.onLiveStateChange, {
      state: 'live',
      isLive: true,
    });
    expect(result.current.state.error).not.toBeNull();
    expect(result.current.state.liveState).not.toBeNull();

    await rerender({ key: 'vod-2', options: undefined });

    expect(result.current.state.error).toBeNull();
    expect(result.current.state.liveState).toBeNull();
    expect(result.current.state.playbackState).toBe('idle');
    expect(result.current.state.isLoading).toBe(true);
    await unmount();
  });

  it('handles several rapid source changes, resetting on every change', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    await fire(result.current.eventHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 1_000,
      durationMs: 60_000,
      progress: 0.01,
    });

    await rerender({ key: 'video-2', options: undefined });
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.progress.positionMs).toBe(0);

    await rerender({ key: 'video-3', options: undefined });
    expect(result.current.state).toStrictEqual(DEFAULT_PLAYER_STATE);
    expect(result.current.progress).toStrictEqual(DEFAULT_PROGRESS);

    // Events from the newest source work normally.
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-3',
      durationMs: 90_000,
    });
    expect(result.current.state.videoId).toBe('vid-3');
    expect(result.current.state.durationMs).toBe(90_000);
    await unmount();
  });

  // --- 2. Late events from the old source are dropped ---

  it('drops a late onProgress from the old source and keeps progress zeroed', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 42_000,
      durationMs: 60_000,
      progress: 0.7,
    });

    // Capture the handlers bound to the first source generation.
    const oldHandlers = result.current.eventHandlers;
    await rerender({ key: 'video-2', options: undefined });
    expect(result.current.progress).toStrictEqual(DEFAULT_PROGRESS);

    // The old native host emits one more tick while tearing down.
    await fire(oldHandlers.onProgress, {
      positionMs: 59_000,
      durationMs: 60_000,
      progress: 0.98,
    });

    expect(result.current.progress).toStrictEqual(DEFAULT_PROGRESS);
    expect(result.current.state).toStrictEqual(DEFAULT_PLAYER_STATE);
    await unmount();
  });

  it.each([
    'onReady',
    'onPlaybackStateChange',
    'onError',
    'onPlay',
    'onPause',
    'onEnd',
    'onBuffering',
    'onVolumeChange',
    'onPlaybackRateChange',
    'onVideoSizeChange',
    'onPlaybackError',
    'onLiveStateChange',
    'onLiveError',
  ] as const)('drops a late %s from the old source', async (handlerName) => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    const oldHandlers = result.current.eventHandlers;
    await rerender({ key: 'video-2', options: undefined });
    expect(result.current.state).toStrictEqual(DEFAULT_PLAYER_STATE);

    const payloads = {
      onReady: { videoId: 'vid-old', durationMs: 60_000 },
      onPlaybackStateChange: { state: 'playing', positionMs: 1_000 },
      onError: { code: 'PLAYBACK_FAILED', message: 'late', nativeCode: '5001' },
      onPlay: { positionMs: 1_000, durationMs: 60_000 },
      onPause: { positionMs: 1_000, durationMs: 60_000 },
      onEnd: { positionMs: 60_000, durationMs: 60_000 },
      onBuffering: { isBuffering: true },
      onVolumeChange: { volume: 0.4, isMuted: true },
      onPlaybackRateChange: { rate: 2 },
      onVideoSizeChange: { width: 1920, height: 1080 },
      onPlaybackError: { message: 'late failure' },
      onLiveStateChange: { state: 'live' as const, isLive: true },
      onLiveError: { message: 'late live failure' },
    };

    await fire(
      oldHandlers[handlerName] as (e: { nativeEvent: unknown }) => void,
      payloads[handlerName],
    );

    expect(result.current.state).toStrictEqual(DEFAULT_PLAYER_STATE);
    await unmount();
  });

  it('does not forward late old-source events to user callbacks', async () => {
    const userCallbacks = {
      onProgress: jest.fn(),
      onReady: jest.fn(),
      onError: jest.fn(),
      onPlaybackStateChange: jest.fn(),
    };
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1', userCallbacks);
    const oldHandlers = result.current.eventHandlers;
    await rerender({ key: 'video-2', options: userCallbacks });

    await fire(oldHandlers.onProgress, {
      positionMs: 59_000,
      durationMs: 60_000,
      progress: 0.98,
    });
    await fire(oldHandlers.onReady, { videoId: 'vid-old', durationMs: 60_000 });
    await fire(oldHandlers.onError, { code: 'X', message: 'late' });
    await fire(oldHandlers.onPlaybackStateChange, { state: 'playing', positionMs: 1 });

    expect(userCallbacks.onProgress).not.toHaveBeenCalled();
    expect(userCallbacks.onReady).not.toHaveBeenCalled();
    expect(userCallbacks.onError).not.toHaveBeenCalled();
    expect(userCallbacks.onPlaybackStateChange).not.toHaveBeenCalled();
    await unmount();
  });

  it('accepts events from the new source after dropping old ones', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    const oldHandlers = result.current.eventHandlers;
    await fire(oldHandlers.onProgress, {
      positionMs: 50_000,
      durationMs: 60_000,
      progress: 0.83,
    });

    await rerender({ key: 'video-2', options: undefined });
    await fire(oldHandlers.onError, { code: 'X', message: 'late' });
    expect(result.current.state.error).toBeNull();

    // The new source's own events must flow through normally.
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-2',
      durationMs: 120_000,
    });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 5_000,
      durationMs: 120_000,
      progress: 0.04,
    });
    expect(result.current.state.videoId).toBe('vid-2');
    expect(result.current.state.durationMs).toBe(120_000);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isLoading).toBe(false);
    expect(result.current.progress).toEqual({
      positionMs: 5_000,
      durationMs: 120_000,
      progress: 0.04,
    });
    await unmount();
  });

  // --- 3. Same-key rerenders do not reset ---

  it('does not reset when rerendered with the same source key', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-1',
      durationMs: 60_000,
    });
    await fire(result.current.eventHandlers.onPlay, { positionMs: 0, durationMs: 60_000 });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 10_000,
      durationMs: 60_000,
      progress: 0.16,
    });
    const handlersBefore = result.current.eventHandlers;
    const stateBefore = result.current.state;
    const progressBefore = result.current.progress;

    await rerender({ key: 'video-1', options: undefined });
    await rerender({ key: 'video-1', options: undefined });

    // No reset: state/progress values and handler identity are preserved.
    expect(result.current.state).toBe(stateBefore);
    expect(result.current.progress).toBe(progressBefore);
    expect(result.current.eventHandlers).toBe(handlersBefore);
    expect(result.current.state.videoId).toBe('vid-1');
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.progress.positionMs).toBe(10_000);
    await unmount();
  });

  it('numeric source keys use value identity, so 1 and 1 do not reset', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey(1);
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-1',
      durationMs: 60_000,
    });
    const stateBefore = result.current.state;

    await rerender({ key: 1, options: undefined });

    expect(result.current.state).toBe(stateBefore);
    await unmount();
  });

  // --- 4. No sourceKey keeps the legacy behaviour ---

  it('without a sourceKey, rerenders never reset accumulated state', async () => {
    const { result, rerender, unmount } = await renderHook(
      (opts: Parameters<typeof useBunnyStreamPlayer>[0]) => useBunnyStreamPlayer(opts),
      { initialProps: undefined },
    );
    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-1',
      durationMs: 60_000,
    });
    await fire(result.current.eventHandlers.onPlay, { positionMs: 0, durationMs: 60_000 });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 20_000,
      durationMs: 60_000,
      progress: 0.33,
    });
    const handlersBefore = result.current.eventHandlers;

    await rerender(undefined);
    await rerender(undefined);

    // Legacy behaviour: no resets and stable handler identity.
    expect(result.current.state.videoId).toBe('vid-1');
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.progress.positionMs).toBe(20_000);
    expect(result.current.eventHandlers).toBe(handlersBefore);
    await unmount();
  });

  it('without a sourceKey, every event keeps writing state (no generation gating)', async () => {
    const { result, unmount } = await renderHook(() => useBunnyStreamPlayer());
    const firstHandlers = result.current.eventHandlers;

    await fire(firstHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    await fire(firstHandlers.onProgress, {
      positionMs: 8_000,
      durationMs: 60_000,
      progress: 0.13,
    });
    await fire(firstHandlers.onPlaybackStateChange, { state: 'playing', positionMs: 8_000 });
    await fire(firstHandlers.onBuffering, { isBuffering: true });

    expect(result.current.state.videoId).toBe('vid-1');
    expect(result.current.state.playbackState).toBe('playing');
    expect(result.current.state.isBuffering).toBe(true);
    expect(result.current.progress.positionMs).toBe(8_000);
    expect(result.current.eventHandlers).toBe(firstHandlers);
    await unmount();
  });

  // --- Existing event semantics stay intact after a reset ---

  it('READY from the new source clears a reset-loading state and sets duration', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    await fire(result.current.eventHandlers.onError, { code: 'X', message: 'old' });

    await rerender({ key: 'video-2', options: undefined });
    expect(result.current.state.isLoading).toBe(true);

    await fire(result.current.eventHandlers.onReady, {
      videoId: 'vid-2',
      durationMs: 120_000,
    });
    expect(result.current.state.playbackState).toBe('ready');
    expect(result.current.state.durationMs).toBe(120_000);
    expect(result.current.state.videoId).toBe('vid-2');
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isLoading).toBe(false);
    await unmount();
  });

  it('PLAYBACK_ERROR from the new source does not overwrite a structured onError', async () => {
    const { result, unmount } = await renderPlayerHookWithKey('video-1');
    const structuredError = {
      code: 'PLAYBACK_FAILED',
      message: 'engine boom',
      nativeCode: '5001',
    };
    await fire(result.current.eventHandlers.onError, structuredError);
    await fire(result.current.eventHandlers.onPlaybackError, {
      message: 'fetch failure',
    });

    expect(result.current.state.error).toStrictEqual(structuredError);
    await unmount();
  });

  it('LIVE_STATE from the new source clears isLoading only for non-loading states', async () => {
    const { result, unmount } = await renderPlayerHookWithKey('live-1');
    expect(result.current.state.isLoading).toBe(true);

    await fire(result.current.eventHandlers.onLiveStateChange, {
      state: 'loading',
      isLive: false,
    });
    expect(result.current.state.isLoading).toBe(true);

    await fire(result.current.eventHandlers.onLiveStateChange, {
      state: 'live',
      isLive: true,
    });
    expect(result.current.state.isLoading).toBe(false);
    expect(result.current.state.liveState).toEqual({ state: 'live', isLive: true });
    await unmount();
  });

  it('stays synchronously consistent: no progress value with a zero duration after reset', async () => {
    const { result, rerender, unmount } = await renderPlayerHookWithKey('video-1');
    await fire(result.current.eventHandlers.onReady, { videoId: 'vid-1', durationMs: 60_000 });
    await fire(result.current.eventHandlers.onProgress, {
      positionMs: 45_000,
      durationMs: 60_000,
      progress: 0.75,
    });

    // Observe every intermediate render produced by the key change.
    const snapshots: Array<{ durationMs: number; positionMs: number }> = [];
    await act(async () => {
      rerender({ key: 'video-2', options: undefined });
      snapshots.push({
        durationMs: result.current.state.durationMs,
        positionMs: result.current.progress.positionMs,
      });
    });

    expect(snapshots).not.toHaveLength(0);
    for (const snapshot of snapshots) {
      // A zero duration must never be paired with a leftover position.
      expect(snapshot.durationMs === 0 ? snapshot.positionMs === 0 : true).toBe(true);
    }
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.progress).toStrictEqual(DEFAULT_PROGRESS);
    await unmount();
  });
});
