import { Howl } from "howler";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  checkAudioPermission,
  claimPlayer,
  isSoundEnabled,
  preloadSounds,
  SoundName,
  SoundPlayer,
  unlockAudioContext,
} from "./runtime";
import { SoundHookReturn, SoundOptions } from "./types";

interface SoundContextType {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

// We'll get the actual context from components.tsx when using it
type SoundContextValue = React.Context<SoundContextType | null>;

// This will be set by SoundProvider from components.tsx
let SoundContext: SoundContextValue;

// Function to set the context from components.tsx
export function setSoundContext(context: SoundContextValue): void {
  SoundContext = context;
}

type PlayerKind = "once" | "loop";
const PLAYER_KINDS: PlayerKind[] = ["once", "loop"];

interface ActiveSound {
  id: number;
  loop: boolean;
  howl: Howl;
  /** Settles the promise returned by play(); called on natural end, stop and unmount */
  resolver?: () => void;
}

/** Error raised when a play is abandoned because its component stopped or unmounted mid-load */
class PlayCancelledError extends Error {
  constructor() {
    super("Sound playback was cancelled");
    this.name = "PlayCancelledError";
  }
}

/**
 * Hook for using a sound in a component.
 * Will use local bundled sounds if available before falling back to remote.
 *
 * Concurrency model: the runtime shares one Howl instance across every concurrent caller of the
 * same sound. Each hook holds its own reference per player kind (`once`/`loop`); stopping or
 * unmounting releases only this hook's references, and the runtime unloads the player once the
 * last reference is gone.
 */
export function useSound(soundName: SoundName, defaultOptions: SoundOptions = {}): SoundHookReturn {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // One player for normal plays, one for looped plays (see PlayerOptions in runtime)
  const playersRef = useRef<Record<PlayerKind, SoundPlayer | null>>({ once: null, loop: null });
  // In-flight claim per kind, so concurrent plays in this hook share a single reference
  const pendingPlayersRef = useRef<Record<PlayerKind, Promise<SoundPlayer> | null>>({ once: null, loop: null });
  const activeSoundsRef = useRef<ActiveSound[]>([]);
  // Bumped on every stop/unmount/sound-name change so plays still loading get cancelled
  const epochRef = useRef(0);

  // Get sound enabled state from context if available, fall back to global state
  let enabled = isSoundEnabled();
  try {
    const soundContext = SoundContext ? useContext(SoundContext) : null;
    if (soundContext) enabled = soundContext.enabled;
  } catch (_e) { /* SoundContext may not be available */ }

  const handleEnd = useCallback(
    (howl: Howl, kind: PlayerKind, id: number) => {
      const soundIndex = activeSoundsRef.current.findIndex((sound) => sound.id === id && sound.howl === howl);
      if (soundIndex >= 0) {
        const sound = activeSoundsRef.current[soundIndex];

        if (sound.resolver) sound.resolver(); // Resolve sound (e.g. created in play())
        if (!sound.loop) activeSoundsRef.current.splice(soundIndex, 1);
      }

      // Free this player once none of its sounds are still playing through it. The player ref
      // guard matters after a stop: stopAll already released it, so the old end handler must not
      // release whatever newer player now occupies the slot.
      if (!activeSoundsRef.current.some((sound) => sound.howl === howl) && playersRef.current[kind]?.howl === howl) {
        playersRef.current[kind]?.release();
        playersRef.current[kind] = null;
      }
      if (activeSoundsRef.current.length === 0) setIsPlaying(false);
    },
    [setIsPlaying]
  );

  // Lazy loading approach - only load the sound when needed
  const ensurePlayer = useCallback(
    (kind: PlayerKind, epoch: number): Promise<SoundPlayer> => {
      const existing = playersRef.current[kind];
      if (existing && existing.isCurrent()) return Promise.resolve(existing);

      const pending = pendingPlayersRef.current[kind];
      if (pending) return pending;

      const holder: { promise?: Promise<SoundPlayer> } = {};
      const promise = (async () => {
        try {
          const player = await claimPlayer(soundName, kind === "loop" ? { loop: true } : undefined);

          // The component stopped/unmounted (or the sound name changed) while loading: release the
          // late reference and reject so the awaiting play settles instead of hanging.
          if (epoch !== epochRef.current) {
            player.release();
            throw new PlayCancelledError();
          }

          player.howl.on("end", (id: number) => handleEnd(player.howl, kind, id));
          playersRef.current[kind] = player;
          setIsLoaded(true);
          return player;
        } finally {
          // Only clear the slot if it still holds this promise, so concurrent callers in the
          // same tick keep sharing it until the claim actually settles.
          if (pendingPlayersRef.current[kind] === holder.promise) pendingPlayersRef.current[kind] = null;
        }
      })();
      holder.promise = promise;

      pendingPlayersRef.current[kind] = promise;
      return promise;
    },
    [soundName, handleEnd]
  );

  const play = useCallback(
    async (options: SoundOptions = defaultOptions) => {
      if (!enabled) return;

      const epoch = epochRef.current;
      const kind: PlayerKind = options.loop ? "loop" : "once";
      let player: SoundPlayer | undefined;
      try {
        // Ensure audio context is unlocked before playing
        await unlockAudioContext();

        // Ensure the sound is loaded (re-claims when a pack update made the player stale)
        player = await ensurePlayer(kind, epoch);
        const howl = player.howl;

        if (epoch !== epochRef.current) throw new PlayCancelledError();
        await player.ready;
        if (epoch !== epochRef.current) throw new PlayCancelledError();

        if (options.volume !== undefined) howl.volume(options.volume);
        if (options.rate !== undefined) howl.rate(options.rate);
        howl.loop(Boolean(options.loop));

        const id = howl.play();
        setIsPlaying(true);

        if (options.loop) {
          // For looped sounds, we just track them; stop/unmount settles any pending play
          activeSoundsRef.current.push({ id, loop: true, howl });
          return;
        }

        // For non-looped sounds, return a promise that resolves on end, stop or unmount
        return new Promise<void>((resolve) => {
          activeSoundsRef.current.push({ id, loop: false, howl, resolver: () => resolve() });
        });
      } catch (error) {
        // A failed load leaves no half-initialized cache entry (runtime evicts it); release this
        // hook's reference so the next play retries with a fresh claim, and surface the error to
        // the caller (onSoundError / catch).
        if (error instanceof PlayCancelledError) {
          // stop/unmount interrupted a play that was still loading: its promise settles here
          return;
        }
        if (player) {
          if (playersRef.current[kind] === player) playersRef.current[kind] = null;
          player.release();
        }
        console.error("Error playing sound:", error);
        throw error;
      }
    },
    [defaultOptions, enabled, ensurePlayer]
  );

  const stopAll = useCallback(() => {
    // Anything still loading must not resolve into a live reference
    epochRef.current += 1;
    pendingPlayersRef.current = { once: null, loop: null };

    const soundsToStop = activeSoundsRef.current;
    activeSoundsRef.current = [];

    for (const kind of PLAYER_KINDS) {
      const player = playersRef.current[kind];
      if (!player) continue;
      // Stop only this hook's own sound ids, so other components sharing the Howl keep playing
      for (const sound of soundsToStop) {
        if (sound.howl === player.howl) player.howl.stop(sound.id);
      }
      player.release();
      playersRef.current[kind] = null;
    }

    // Settle every pending play promise (natural end / stop / unmount all resolve, never hang).
    // Run after howl.stop(): any synchronous 'stop' event has already removed settled entries,
    // so this only resolves the promises stop genuinely interrupted.
    soundsToStop.forEach((sound) => sound.resolver?.());
  }, []);

  const stop = useCallback(() => {
    stopAll();
    setIsPlaying(false);
  }, [stopAll]);

  const pause = useCallback(() => {
    for (const kind of PLAYER_KINDS) playersRef.current[kind]?.howl.pause();
    setIsPlaying(false);
  }, []);

  const resume = useCallback(() => {
    if (!enabled || activeSoundsRef.current.length === 0) return;

    // Try to unlock audio context before resuming
    unlockAudioContext().then(() => {
      activeSoundsRef.current.forEach(({ id, howl }) => howl.play(id));
      setIsPlaying(true);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled && isPlaying) pause(); // Pause all sounds when disabled
  }, [enabled, isPlaying, pause]);

  // Preload on mount / sound-name change; release everything on cleanup or name change
  useEffect(() => {
    let cancelled = false;
    preloadSounds([soundName])
      .then(() => {
        if (!cancelled) setIsLoaded(true);
      })
      .catch(() => { /* surfaced later through play() */ });

    return () => {
      cancelled = true;
      setIsLoaded(false);
      setIsPlaying(false);
      stopAll();
    };
  }, [soundName, stopAll]);

  const checkPermission = useCallback(() => checkAudioPermission(), []);

  return { play, stop, pause, resume, isPlaying, isLoaded, checkPermission };
}

interface UseSoundOnChangeOptions extends SoundOptions {
  initial?: boolean;
}

/**
 * Hook for playing a sound when a value changes
 */
export function useSoundOnChange<T>(soundName: SoundName, value: T, options?: UseSoundOnChangeOptions): void {
  const { play } = useSound(soundName);
  const initialRef = useRef(true);

  useEffect(() => {
    const skipThisInitialRun = initialRef.current && options?.initial === false;
    initialRef.current = false;
    if (skipThisInitialRun) return;

    play(options).catch((err) => console.error("Failed to play sound:", err));
  }, [value]);
}

/**
 * Hook for accessing and controlling the sound enabled state
 */
export function useSoundEnabled(): [boolean, (enabled: boolean) => void] {
  const context = useContext(SoundContext);
  if (!context) throw new Error("useSoundEnabled must be used within a SoundProvider");

  return [context.enabled, context.setEnabled];
}
