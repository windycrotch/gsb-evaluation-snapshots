// Pure playback synchronization helpers.
//
// Every visible signal in the player (canvas element entrances, subtitle
// highlight, voice/audio) must derive from one logical playhead. These
// functions contain no DOM or React dependencies so the synchronization
// rules can be unit-tested directly with Node's test runner.

export interface SyncSceneLike {
  durationSeconds: number;
  narration?: string;
  elements?: Array<{ triggerTimeSec?: number }>;
}

export interface SubtitleState {
  /** Index of the word that should be highlighted, or -1 when none is active. */
  wordIndex: number;
  /** True while a native word-boundary callback owns the highlight. */
  fromCallback: boolean;
}

/**
 * Split narration into the same word list used by the subtitle renderer and
 * the speech engine. Empty / whitespace-only narration yields zero words.
 */
export function splitNarrationWords(narration: string | undefined | null): string[] {
  if (!narration) return [];
  return narration.split(/\s+/).filter(Boolean);
}

/**
 * Estimate which word is being spoken from playhead progress.
 *
 * Used until the speech engine delivers real word-boundary callbacks.
 * The last word stays highlighted for the tail of the scene instead of
 * running past the end of the word list.
 */
export function estimateWordIndex(
  narration: string | undefined | null,
  currentTime: number,
  duration: number
): number {
  const words = splitNarrationWords(narration);
  if (words.length === 0) return -1;
  const safeDuration = Math.max(0.1, duration);
  const progress = Math.min(0.999, Math.max(0, currentTime / safeDuration));
  return Math.min(words.length - 1, Math.floor(progress * words.length));
}

/**
 * Resolve the subtitle highlight for a frame.
 *
 * Rules:
 * - A word-boundary callback that belongs to the active playback session
 *   always wins over the progress estimate.
 * - When no callback has been received (or callbacks have been invalidated
 *   by a seek / scene change), the highlight is estimated from the playhead.
 * - When paused, the last known word is held so the subtitle stops on the
 *   current word instead of jumping.
 */
export function resolveSubtitleState(params: {
  narration: string | undefined | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  /** Word index last reported by a word-boundary callback, -1 when none. */
  callbackWordIndex: number;
  /** Whether the callback index is still valid for the current session. */
  callbackValid: boolean;
}): SubtitleState {
  const { narration, currentTime, duration, isPlaying, callbackWordIndex, callbackValid } = params;
  const words = splitNarrationWords(narration);
  if (words.length === 0) return { wordIndex: -1, fromCallback: false };

  if (callbackValid && callbackWordIndex >= 0 && callbackWordIndex < words.length) {
    return { wordIndex: callbackWordIndex, fromCallback: true };
  }

  if (!isPlaying) {
    // Hold a word while paused: estimate from the frozen playhead so the
    // highlight reflects exactly where the user stopped.
    return { wordIndex: estimateWordIndex(narration, currentTime, duration), fromCallback: false };
  }

  return { wordIndex: estimateWordIndex(narration, currentTime, duration), fromCallback: false };
}

/**
 * Clamp a scene-relative time to [0, duration].
 */
export function clampToSceneTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(0, time), Math.max(0, duration));
}

/**
 * Effective element trigger time, clamped to the scene duration.
 *
 * An element whose configured trigger is outside the scene (negative, or
 * past the end) must still appear: it enters immediately at scene start or
 * at the final frame of the scene. This also keeps timeline markers inside
 * the scrubber so the progress bar can never overflow.
 */
export function effectiveTriggerTime(
  triggerTimeSec: number | undefined,
  duration: number
): number {
  const raw = typeof triggerTimeSec === 'number' && Number.isFinite(triggerTimeSec) ? triggerTimeSec : 0;
  return clampToSceneTime(raw, Math.max(0, duration));
}

/**
 * Entrance progress of an element at a given playhead time.
 * Returns 0 when the element has not started entering and 1 once its
 * entrance animation is complete.
 */
export function elementEntranceProgress(
  triggerTimeSec: number | undefined,
  currentTime: number,
  entranceDurationSec: number,
  sceneDuration: number
): number {
  const trigger = effectiveTriggerTime(triggerTimeSec, sceneDuration);
  if (currentTime < trigger) return 0;
  // A zero / missing / invalid entrance duration means an instant entry.
  if (!Number.isFinite(entranceDurationSec) || entranceDurationSec <= 0) {
    return 1;
  }
  const animDuration = Math.max(0.001, entranceDurationSec);
  const raw = (currentTime - trigger) / animDuration;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Whether an element should be fully present at a given time. Used by tests
 * and acceptance checks such as "seek past the trigger point -> element has
 * fully entered".
 */
export function isElementFullyEntered(
  triggerTimeSec: number | undefined,
  currentTime: number,
  entranceDurationSec: number,
  sceneDuration: number
): boolean {
  return elementEntranceProgress(triggerTimeSec, currentTime, entranceDurationSec, sceneDuration) >= 1;
}

/**
 * Monotonic token generator. Every playback session (play, seek, scene
 * switch, voice source replacement) gets a fresh token. Callbacks carrying
 * a stale token are ignored so a previous scene's speech events can never
 * touch the new scene's subtitles.
 */
export class SessionTokenSource {
  private token = 0;

  next(): number {
    this.token += 1;
    return this.token;
  }

  current(): number {
    return this.token;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }
}

/**
 * Decide whether the end of a scene was reached at a candidate time.
 */
export function isSceneEndReached(time: number, duration: number): boolean {
  return time >= Math.max(0, duration);
}

/**
 * Progress fraction in [0, 1] for a scene-relative time. Safe for zero or
 * invalid durations.
 */
export function sceneProgress(time: number, duration: number): number {
  const safeDuration = Math.max(0.1, duration);
  return Math.min(1, Math.max(0, time / safeDuration));
}
