/**
 * Authoritative timeline state for the Impact effect.
 *
 * The Leva panel and the shader uniforms are both *views* of this state:
 * the panel is only written back during auto-advance, and uniforms are
 * synced from here every frame. All transitions (scrub, play/pause,
 * preset switch) go through these methods so they stay atomic.
 */
export type ImpactTimelineState = {
  /** Normalized progress of the effect, 0..1 */
  time: number
  /** Seconds for a full 0..1 cycle */
  duration: number
  /** Random seed driving vesica placement */
  seed: number
  /** Whether time auto-advances each frame */
  playing: boolean
}

export const randomSeed = (random: () => number = Math.random) => Math.round(random() * 1000)

export const createImpactTimeline = (
  initial: { duration: number; seed?: number; playing?: boolean },
  random: () => number = Math.random,
) => {
  const state: ImpactTimelineState = {
    time: 0,
    duration: initial.duration,
    seed: initial.seed ?? 0,
    playing: initial.playing ?? true,
  }

  /**
   * Advance one frame. Returns the time to write back to the panel,
   * or null when paused (no write-back happens while paused).
   */
  const advance = (delta: number): number | null => {
    if (!state.playing) return null
    state.time += delta / state.duration
    if (state.time > 1) {
      state.seed = randomSeed(random)
      state.time = 0
    }
    return state.time
  }

  /** User dragged the time slider: their value becomes authoritative and playback pauses. */
  const scrub = (time: number) => {
    state.time = time
    state.playing = false
  }

  /**
   * Toggle autoplay. Resuming continues from the current value, except at
   * the end of the timeline, which restarts from 0 with a fresh seed.
   * Returns true when such a restart happened.
   */
  const setPlaying = (playing: boolean): boolean => {
    state.playing = playing
    if (playing && state.time >= 1) {
      state.time = 0
      state.seed = randomSeed(random)
      return true
    }
    return false
  }

  /** Atomically apply a preset: reset time, adopt the new duration, reseed, resume. */
  const applyPreset = (preset: { duration: number }) => {
    state.time = 0
    state.duration = preset.duration
    state.seed = randomSeed(random)
    state.playing = true
  }

  const setDuration = (duration: number) => {
    state.duration = duration
  }

  return { state, advance, scrub, setPlaying, applyPreset, setDuration }
}

export type ImpactTimeline = ReturnType<typeof createImpactTimeline>
