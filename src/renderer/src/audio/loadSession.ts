/**
 * Cancelable per-deck load sessions.
 *
 * A deck load is asynchronous (file reads + decoding can take seconds), and
 * dragging a second track onto the same deck must invalidate the in-flight
 * load. Every load gets a monotonically increasing session id; the session is
 * the only place that may touch the deck once the load has started, and every
 * continuation checks {@link LoadSession.current} before doing so. A
 * superseded or failed load settles without writing a single byte of the
 * track's state, so a deck is always either fully on the winning track or
 * fully idle — never half-loaded.
 *
 * User actions that rebuild the vocal read head or move its read-ahead
 * (autotune key/enable, keylock, tempo/pitch) while a load is pending are
 * captured as *intents* on the live session instead of touching the engine,
 * whose graph still belongs to the previous track. When the winning load
 * commits, its intents are replayed onto the freshly built graph, so every
 * manual setting lands on the song that actually ends up on the deck.
 */
import type { AutotuneState, DeckState, TrackInfo } from '../state/store'
import type { LoadedStem } from './engine'
import type { WaveformPeaks } from './analysis'

/**
 * Operations that move the deck's read heads (main or vocal). These are the
 * operations that must be deferred while a load owns the deck, because the
 * engine graph they would manipulate still plays the previous song.
 */
export type DeckIntent =
  | { kind: 'tempo'; rate: number }
  | { kind: 'pitch'; semitones: number }
  | { kind: 'keylock'; enabled: boolean; pitchReset: boolean }
  | { kind: 'autotune'; patch: Partial<AutotuneState> }

/** Everything the session needs from the outside, so the ordering rules are unit-testable. */
export interface LoadSessionDeps {
  getTrack: (trackId: string) => TrackInfo | undefined
  /** Read + decode the track, either as separated stems or as a single mix buffer. */
  resolveStems: (track: TrackInfo) => Promise<LoadedStem[]>
  computeHiPeaks: (buffers: AudioBuffer[]) => WaveformPeaks
  getTrackPeaks: (trackId: string) => WaveformPeaks | null
  deck: {
    /** Replace the worklet's audio (and reset its read heads/stretch pipelines). */
    load: (stems: LoadedStem[]) => void
    /** Drop all audio and return the worklet to silence. */
    unload: () => void
    setTempo: (rate: number) => void
    setPitch: (semitones: number) => void
    setKeylock: (enabled: boolean) => void
    setAutotune: (settings: Partial<AutotuneState>) => void
    readonly duration: number
  }
  /** A fresh, fully reset deck state (mirrors the store's emptyDeck()). */
  resetDeck: () => DeckState
  /**
   * User preferences that survive a track swap on the same deck (pitch fader
   * range, reverb, section-phrase settings). Everything else is reset.
   */
  preserved?: () => Partial<DeckState>
  /**
   * Persist a partial deck state. Implementations merge over the live state;
   * the session needs the merged autotune object back for the detected-key
   * commit, so this returns the resulting deck state.
   */
  commitState: (patch: Partial<DeckState>) => DeckState
  setHiPeaks: (peaks: WaveformPeaks | null) => void
  setPeaks: (peaks: WaveformPeaks | null) => void
  onLoadError: (message: string) => void
}

export class LoadSession {
  private static counters = [0, 0]
  /** The live session per deck, or null once it has settled (or never started). */
  private static live: (LoadSession | null)[] = [null, null]

  readonly id: number
  readonly deckIndex: number
  readonly trackId: string
  /**
   * User intents captured while the load was pending, in arrival order.
   * Replayed in that order on commit, which makes repeated changes collapse
   * naturally (last write wins, exactly as direct engine calls would).
   */
  readonly intents: DeckIntent[] = []
  /**
   * A manual key/scale choice during this load wins over the track's detected
   * key. Per-session rather than a shared per-deck flag: a flag reset by the
   * next load would corrupt a still-pending previous load's decision.
   */
  manualKey = false
  private settled = false

  private constructor(deckIndex: number, trackId: string) {
    this.id = ++LoadSession.counters[deckIndex]
    this.deckIndex = deckIndex
    this.trackId = trackId
  }

  /** The session currently allowed to write this deck, if any. */
  static current(deckIndex: number): LoadSession | null {
    return LoadSession.live[deckIndex]
  }

  /** True when this session may still write its deck. */
  get isCurrent(): boolean {
    return LoadSession.live[this.deckIndex] === this && !this.settled
  }

  /**
   * Begin a new load on `deckIndex`, invalidating any in-flight session. The
   * deck is reset synchronously (including its engine autotune settings) before
   * the first await, so the UI never shows a mix of two songs' state.
   */
  static begin(deckIndex: number, trackId: string, deps: LoadSessionDeps): LoadSession {
    const session = new LoadSession(deckIndex, trackId)
    LoadSession.live[deckIndex] = session
    const reset = { ...deps.resetDeck(), ...deps.preserved?.() }
    // The engine's autotune graph belongs to the outgoing song; reset it now so
    // no correction from the old vocal can bleed into the new one.
    deps.deck.setAutotune(reset.autotune)
    deps.commitState({
      ...reset,
      loading: true,
      trackId,
      title: deps.getTrack(trackId)?.name ?? ''
    })
    return session
  }

  /**
   * Run the load to completion. Superseded sessions return without touching
   * anything (their replacement already reset the deck and owns its cleanup).
   * A failed live load returns the deck to a fully consistent idle state, so
   * retrying the same track works.
   */
  async run(deps: LoadSessionDeps): Promise<void> {
    const track = deps.getTrack(this.trackId)
    if (!track) {
      // The track vanished from the library mid-load.
      this.settleIdle(deps)
      return
    }
    let stems: LoadedStem[]
    try {
      stems = await deps.resolveStems(track)
    } catch (err) {
      this.settleIdle(deps, err instanceof Error ? err.message : String(err))
      return
    }
    if (!this.isCurrent) return

    // All async work is done. Everything from here to the settle is one
    // synchronous block: a session can only be superseded at an await
    // boundary, so checking once here guarantees the engine is never left
    // holding this session's audio under another session's reset state.
    const usingStems = stems.length > 1
    deps.setHiPeaks(deps.computeHiPeaks(stems.map((s) => s.buffer)))
    deps.deck.load(stems)
    deps.setPeaks(deps.getTrackPeaks(this.trackId))
    // Fresh track: neutral transport before replaying what the user asked for.
    deps.deck.setTempo(1)
    deps.deck.setPitch(0)
    deps.deck.setKeylock(false)
    this.replayIntents(deps)

    const committed = deps.commitState({
      loading: false,
      duration: deps.deck.duration,
      baseBpm: track.bpm,
      firstBeat: track.firstBeat,
      usingStems,
      stems: stems.map((s) => ({ name: s.name, active: true, volume: 1 }))
    })
    // Fold autotune intents into the committed state as the single source of
    // truth. The controller's store is normally already in sync because
    // setAutotune() writes the patch when the intent is captured, but replaying
    // them here keeps the session correct against any commitState adapter and
    // guarantees store and engine hold identical values.
    const autotune = this.mergeAutotuneIntents(committed.autotune)
    if (autotune !== committed.autotune) deps.commitState({ autotune })
    this.applyDetectedKey(track, autotune, deps)
    LoadSession.live[this.deckIndex] = null
    this.settled = true
  }

  /**
   * Replay captured autotune patches over a base state, in arrival order.
   * Returns the same reference when there were no autotune intents.
   */
  private mergeAutotuneIntents(base: AutotuneState): AutotuneState {
    const patches = this.intents
      .filter((i): i is Extract<DeckIntent, { kind: 'autotune' }> => i.kind === 'autotune')
      .map((i) => i.patch)
    if (patches.length === 0) return base
    return patches.reduce<AutotuneState>((acc, patch) => ({ ...acc, ...patch }), base)
  }

  /** Replay pending user operations onto the newly built engine graph. */
  private replayIntents(deps: LoadSessionDeps): void {
    for (const intent of this.intents) {
      switch (intent.kind) {
        case 'tempo':
          deps.deck.setTempo(intent.rate)
          break
        case 'pitch':
          deps.deck.setPitch(intent.semitones)
          break
        case 'keylock':
          deps.deck.setKeylock(intent.enabled)
          if (intent.pitchReset) deps.deck.setPitch(0)
          break
        case 'autotune':
          deps.deck.setAutotune(intent.patch)
          break
      }
    }
  }

  /**
   * Snap to the pentatonic form of the detected key — but only when the user
   * did not pick a key/scale themselves during the load. Manual key intents
   * have already been replayed into both the engine and the store.
   */
  private applyDetectedKey(
    track: TrackInfo,
    currentAutotune: AutotuneState,
    deps: LoadSessionDeps
  ): void {
    if (this.manualKey || track.musicalKey === null || track.musicalScale === null) return
    const detectedKey = {
      key: track.musicalKey,
      scale: (track.musicalScale === 'minor'
        ? 'minorPentatonic'
        : 'majorPentatonic') as AutotuneState['scale']
    }
    deps.deck.setAutotune(detectedKey)
    if (!this.isCurrent) return
    deps.commitState({ autotune: { ...currentAutotune, ...detectedKey } })
  }

  /**
   * Settle a live-but-unsuccessful load back to a consistent idle deck.
   * Superseded sessions do nothing here: the replacement already reset the
   * deck and owns its cleanup.
   */
  private settleIdle(deps: LoadSessionDeps, errorMessage?: string): void {
    if (!this.isCurrent) {
      this.settled = true
      return
    }
    const reset = { ...deps.resetDeck(), ...deps.preserved?.() }
    deps.setHiPeaks(null)
    deps.setPeaks(null)
    deps.deck.unload()
    deps.deck.setAutotune(reset.autotune)
    deps.commitState({ ...reset })
    LoadSession.live[this.deckIndex] = null
    this.settled = true
    if (errorMessage) deps.onLoadError(`Failed to load track: ${errorMessage}`)
  }
}
