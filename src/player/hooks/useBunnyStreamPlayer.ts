/**
 * `useBunnyStreamPlayer` — a React hook that subscribes to all native
 * {@link BunnyStreamPlayer} events and exposes a single aggregated
 * `PlayerState` (low-frequency) + `PlayerProgress` (high-frequency),
 * eliminating the per-screen `useState` boilerplate.
 *
 * The hook is purely additive: it returns `eventHandlers` that the consumer
 * spreads onto `<BunnyStreamPlayer {...player.eventHandlers} />`, plus a
 * stable `controls` object that proxies the imperative ref API.
 *
 * State is split so that consumers reading only `state.*` (e.g. play/pause
 * buttons) do NOT re-render on every `onProgress` tick (~4×/s).
 */

import type { BunnyVodPlayerRef } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

import * as React from 'react';

import { createPlayerEventHandlers } from '../state/playerEventHandlers';
import { playerReducer } from '../state/playerReducer';
import { DEFAULT_PLAYER_STATE, DEFAULT_PROGRESS } from '../state/playerState';

export type {
  PlayerEventHandlers,
  PlayerProgress,
  PlayerState,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

/**
 * Subscribes to all {@link BunnyStreamPlayer} events and aggregates them into
 * a single `PlayerState` + `PlayerProgress`. See the file docstring for
 * usage.
 *
 * @param options  Optional user-supplied event handlers.
 * @param sourceKey  Identity key for the current source (e.g. from
 *   `sourceIdentityKey`). When this changes, the hook resets `state` and
 *   `progress` to defaults — this prevents stale VOD state (videoId,
 *   duration, progress, playback state) from lingering after a VOD → live
 *   transition or a source change. Pass `undefined` to opt out of resets
 *   (legacy behaviour).
 */
export function useBunnyStreamPlayer(
  options?: UseBunnyStreamPlayerOptions,
  sourceKey?: string | number,
): UseBunnyStreamPlayerResult {
  const ref = React.useRef<BunnyVodPlayerRef | null>(null);

  const [state, dispatch] = React.useReducer(playerReducer, DEFAULT_PLAYER_STATE);
  const [progress, setProgress] = React.useState<PlayerProgress>(DEFAULT_PROGRESS);

  // Monotonic source generation — the JS counterpart of the native
  // `GenerationToken` (android/.../commands/GenerationToken.kt). Every
  // source-key change bumps it; event handlers capture the generation they
  // were created for and reject events once a newer generation owns the
  // player, so late callbacks from the torn-down source can never write back
  // into the new source's aggregated state.
  const [generation, setGeneration] = React.useState(0);
  const activeGenerationRef = React.useRef(generation);

  // Reset state + progress when the source identity changes. The previous key
  // is tracked in a ref so the reset fires only on actual changes, not on
  // every render. This runs during render (React's documented
  // "adjusting state when a prop changes" pattern) rather than in an effect:
  // React restarts the render with the reset state before any event props are
  // reconciled, leaving no window in which a queued old-source event could be
  // delivered between the key change and the RESET commit.
  const prevSourceKey = React.useRef<string | number | undefined>(sourceKey);
  if (prevSourceKey.current !== sourceKey) {
    prevSourceKey.current = sourceKey;
    const nextGeneration = generation + 1;
    // Publish immediately so even the handlers of the in-flight render are
    // gated as stale before the restarted render lands.
    activeGenerationRef.current = nextGeneration;
    setGeneration(nextGeneration);
    // Reset state + progress to defaults together: the high-frequency
    // `progress` channel bypasses the reducer, so it must be zeroed in the
    // same render as RESET — otherwise the progress bar could keep an old
    // position while `state.durationMs` is already 0 for the loading source.
    dispatch({ type: 'RESET' });
    setProgress(DEFAULT_PROGRESS);
  } else {
    activeGenerationRef.current = generation;
  }

  // Store user handlers in a ref so the memoised event handlers below have a
  // stable identity even when the user passes inline callbacks.
  const optionsRef = React.useRef<UseBunnyStreamPlayerOptions | undefined>(options);
  optionsRef.current = options;

  // Stable imperative API — proxies the ref so consumers can call
  // `player.controls.play()` without touching the ref directly.
  const controls = React.useMemo<BunnyVodPlayerRef>(
    () => ({
      play: () => ref.current?.play(),
      pause: () => ref.current?.pause(),
      seekTo: (positionMs: number) => ref.current?.seekTo(positionMs),
      skipForward: (offsetMs?: number) => ref.current?.skipForward(offsetMs),
      skipBackward: (offsetMs?: number) => ref.current?.skipBackward(offsetMs),
      setVolume: (volume: number) => ref.current?.setVolume(volume),
      setPlaybackRate: (rate: number) => ref.current?.setPlaybackRate(rate),
      mute: () => ref.current?.mute(),
      unmute: () => ref.current?.unmute(),
      enterPiP: () => ref.current?.enterPiP(),
      setVideoQuality: (quality) => ref.current?.setVideoQuality(quality),
    }),
    [],
  );

  // Recreated only when the generation changes: same-key rerenders keep the
  // exact same handler identities, while a source change produces fresh
  // handlers whose gate rejects every event tagged with the old generation.
  const eventHandlers = React.useMemo<PlayerEventHandlers>(
    () =>
      createPlayerEventHandlers(dispatch, setProgress, optionsRef, {
        isActive: () => activeGenerationRef.current === generation,
      }),
    [generation],
  );

  return { ref, state, progress, controls, eventHandlers };
}
