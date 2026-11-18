import type { LiveStateChangeEvent } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
} from '../hooks/useBunnyStreamPlayer.types';
import type { PlayerAction } from './playerReducer';
import type { Dispatch, SetStateAction } from 'react';

interface CurrentOptionsRef {
  current: UseBunnyStreamPlayerOptions | undefined;
}

/**
 * Generation gate shared by every handler built for one source generation.
 * Returns `true` while the generation that captured these handlers is still
 * the active one; after a source-key change (`RESET`) it returns `false`, so
 * late events from the torn-down source (onProgress, onReady, onError,
 * onPlaybackStateChange, …) are dropped before they can write into the new
 * source's aggregated state.
 */
export interface GenerationGate {
  isActive: () => boolean;
}

/**
 * Builds an event handler that unwraps `nativeEvent`, dispatches a reducer
 * action, and forwards the same payload to the matching user callback in
 * `optionsRef.current`. The callback is read at call time so option changes
 * between renders take effect without recreating the handler.
 *
 * Events arriving after the source generation was invalidated are ignored
 * completely: neither the reducer/user progress state nor the user-supplied
 * callback is touched, because the payload belongs to a source that no
 * longer owns the player.
 */
function bindHandler<E>(
  dispatch: Dispatch<PlayerAction>,
  optionsRef: CurrentOptionsRef,
  gate: GenerationGate,
  key: keyof UseBunnyStreamPlayerOptions,
  toAction: (e: E) => PlayerAction,
): (event: { nativeEvent: E }) => void {
  return (event) => {
    if (!gate.isActive()) {
      return;
    }
    const payload = event.nativeEvent;
    dispatch(toAction(payload));
    (optionsRef.current?.[key] as ((p: E) => void) | undefined)?.(payload);
  };
}

/** Builds the `onLiveStateChange` payload, dropping undefined optional fields. */
function buildLiveStatePayload(e: LiveStateChangeEvent) {
  const {
    state: liveState,
    isLive,
    reason,
    targetEpochMs,
    title,
    videoId,
    message,
    dvrEnabled,
  } = e;
  return {
    state: liveState,
    isLive,
    ...(reason !== undefined && { reason }),
    ...(targetEpochMs !== undefined && { targetEpochMs }),
    ...(title !== undefined && { title }),
    ...(videoId !== undefined && { videoId }),
    ...(message !== undefined && { message }),
    ...(dvrEnabled !== undefined && { dvrEnabled }),
  };
}

export function createPlayerEventHandlers(
  dispatch: Dispatch<PlayerAction>,
  setProgress: Dispatch<SetStateAction<PlayerProgress>>,
  optionsRef: CurrentOptionsRef,
  gate: GenerationGate,
): PlayerEventHandlers {
  return {
    onReady: bindHandler(dispatch, optionsRef, gate, 'onReady', (e) => ({
      type: 'READY' as const,
      videoId: e.videoId,
      durationMs: e.durationMs,
    })),
    onPlaybackStateChange: bindHandler(
      dispatch,
      optionsRef,
      gate,
      'onPlaybackStateChange',
      (e) => ({
        type: 'STATE_CHANGE' as const,
        state: e.state,
      }),
    ),
    onProgress: (e) => {
      // High-frequency: bypasses the reducer, so it needs the same
      // generation gate — otherwise a late tick from the previous source
      // would repopulate the progress bar after RESET zeroed it while
      // `state.durationMs` is still 0 for the loading new source.
      if (!gate.isActive()) {
        return;
      }
      const { positionMs, durationMs, progress: prog } = e.nativeEvent;
      setProgress({ positionMs, durationMs, progress: prog });
      optionsRef.current?.onProgress?.({ positionMs, durationMs, progress: prog });
    },
    onError: bindHandler(dispatch, optionsRef, gate, 'onError', (e) => ({
      type: 'ERROR' as const,
      error: e,
    })),
    onBuffering: bindHandler(dispatch, optionsRef, gate, 'onBuffering', (e) => ({
      type: 'BUFFERING' as const,
      isBuffering: e.isBuffering,
    })),
    onPlay: bindHandler(dispatch, optionsRef, gate, 'onPlay', () => ({ type: 'PLAY' as const })),
    onPause: bindHandler(dispatch, optionsRef, gate, 'onPause', () => ({
      type: 'PAUSE' as const,
    })),
    onEnd: bindHandler(dispatch, optionsRef, gate, 'onEnd', () => ({ type: 'END' as const })),
    onVolumeChange: bindHandler(dispatch, optionsRef, gate, 'onVolumeChange', (e) => ({
      type: 'VOLUME' as const,
      volume: e.volume,
      isMuted: e.isMuted,
    })),
    onPlaybackRateChange: bindHandler(dispatch, optionsRef, gate, 'onPlaybackRateChange', (e) => ({
      type: 'PLAYBACK_RATE' as const,
      rate: e.rate,
    })),
    onVideoSizeChange: bindHandler(dispatch, optionsRef, gate, 'onVideoSizeChange', (e) => ({
      type: 'VIDEO_SIZE' as const,
      width: e.width,
      height: e.height,
    })),
    onPlaybackError: bindHandler(dispatch, optionsRef, gate, 'onPlaybackError', (e) => ({
      type: 'PLAYBACK_ERROR' as const,
      message: e.message,
    })),
    onLiveStateChange: (e) => {
      if (!gate.isActive()) {
        return;
      }
      const payload = buildLiveStatePayload(e.nativeEvent);
      dispatch({ type: 'LIVE_STATE', liveState: payload });
      optionsRef.current?.onLiveStateChange?.(payload);
    },
    onLiveError: bindHandler(dispatch, optionsRef, gate, 'onLiveError', (e) => ({
      type: 'LIVE_ERROR' as const,
      message: e.message,
    })),
  };
}
