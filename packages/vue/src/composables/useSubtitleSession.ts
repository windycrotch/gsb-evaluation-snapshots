import type { Track } from '@vue-player/core'
import type { Ref } from 'vue'
import { ref } from 'vue'

export interface SubtitleSession {
  /** Currently selected track for the active source, or null for "Off". */
  selectedTrack: Ref<Track | null>
  /**
   * Opens a new source session: the previous source's subtitle selection is
   * invalidated immediately so no stale "selected" state survives a switch.
   * The default track (if any) is applied later, once the new source is
   * actually playable.
   */
  startSession: (tracks: ReadonlyArray<Track> | undefined) => void
  /**
   * Re-establishes subtitles after the new source finished loading: applies
   * the default track unless the user explicitly chose "Off" for this
   * session. Also repairs selections that no longer exist in the new source.
   */
  onLoadComplete: (tracks: ReadonlyArray<Track> | undefined) => void
  /** User picked a track, or explicitly chose "Off" (null). */
  selectTrack: (track: Track | null) => void
}

function isSameTrack(a: Track | null, b: Track): boolean {
  return a !== null && a.language === b.language && a.label === b.label
}

/**
 * Owns subtitle selection across source switches. Each source switch is a
 * fresh session, so an old source's selection can never linger as an invalid
 * checked item, and a user's explicit "Off" is sticky until the next switch.
 */
export function createSubtitleSession(apply: (track: Track | null) => void): SubtitleSession {
  const selectedTrack = ref<Track | null>(null)
  // null  = user has not chosen anything in this session yet
  // false = user explicitly chose "Off"
  // true  = user explicitly chose a track
  let userChoice: Track | null | false = null

  function commit(track: Track | null) {
    selectedTrack.value = track
    apply(track)
  }

  function startSession(tracks: ReadonlyArray<Track> | undefined) {
    userChoice = null
    const previous = selectedTrack.value

    // Old source's selection is invalid from the moment loading starts —
    // nothing is rendered/checked until the new source becomes playable.
    // If the old selection exists in the new source it can be re-applied on
    // load-complete; otherwise it must not linger as an invalid checked item.
    if (previous && !tracks?.some((t) => isSameTrack(previous, t))) {
      selectedTrack.value = null
    }
    apply(null)
  }

  function onLoadComplete(tracks: ReadonlyArray<Track> | undefined) {
    // Explicit user choice always wins within a session, including "Off" —
    // the load-complete event must not reopen subtitles the user closed.
    if (userChoice !== null) {
      const choice = userChoice === false ? null : userChoice
      if (choice === null || tracks?.some((t) => isSameTrack(choice, t))) {
        commit(choice)
        return
      }
      // Selection vanished from this source — fall through to fallback.
    }

    // A still-valid selection carried over from the previous source is
    // restored as-is (the user's preference beats the new source's default).
    const carried = selectedTrack.value
    if (carried && tracks?.some((t) => isSameTrack(carried, t))) {
      commit(carried)
      return
    }

    // Nothing valid to restore — use the new source's default, or "Off".
    const defaultTrack = tracks?.find((t) => t.default) ?? null
    commit(defaultTrack)
  }

  function selectTrack(track: Track | null) {
    userChoice = track === null ? false : track
    commit(track)
  }

  return { selectedTrack, startSession, onLoadComplete, selectTrack }
}
