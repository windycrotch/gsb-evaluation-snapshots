/**
 * Minimal in-memory stand-ins for the browser media APIs these composables
 * touch. No real video element, no real network — everything is driven
 * manually from the tests by dispatching events.
 */

// Property the player stamps onto the element with the active session id.
const SESSION_KEY = '__vuePlayerSessionId'

export class FakeTextTrack {
  mode: TextTrackMode = 'disabled'
  language: string
  label: string
  activeCues: TextTrackCueList | null = null

  constructor(language: string, label: string) {
    this.language = language
    this.label = label
  }
}

export class FakeTrackElement {
  track: FakeTextTrack

  constructor(language: string, label: string) {
    this.track = new FakeTextTrack(language, label)
  }
}

export interface FakeVideoOptions {
  tracks?: FakeTrackElement[]
  error?: MediaError
}

export class FakeVideo extends EventTarget {
  paused = true
  ended = false
  currentTime = 0
  duration = Number.NaN
  volume = 1
  muted = false
  playbackRate = 1
  buffered: TimeRanges = {
    length: 0,
    start: () => 0,
    end: () => 0,
  }

  src = ''
  private trackElements: FakeTrackElement[] = []
  error: MediaError | null
  // Session id of the load sequence events currently belong to. The
  // composable overwrites the SESSION_KEY stamp on every loadSource(); the
  // fake mirrors it so its emitted events carry the matching id.
  private activeSessionId = 1

  constructor(options: FakeVideoOptions = {}) {
    super()
    this.trackElements = options.tracks ?? []
    this.error = options.error ?? null
    ;(this as unknown as Record<string, number>)[SESSION_KEY] = 1
  }

  // ── Element surface used by the composables ──
  querySelectorAll(): FakeTrackElement[] {
    return this.trackElements
  }

  load() {
    // Mirror the fresh stamp the composable applied before calling load().
    this.activeSessionId = (this as unknown as Record<string, number>)[SESSION_KEY]
    this.paused = true
    this.ended = false
    this.currentTime = 0
  }

  play() {
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }

  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }

  // ── Test helpers: drive the fake element through a loading lifecycle ──
  /** Dispatches an event belonging to the *current* load sequence. */
  emit(type: string) {
    const event = new Event(type) as Event & Record<string, unknown>
    event[SESSION_KEY] = this.activeSessionId
    this.dispatchEvent(event)
  }

  /**
   * Dispatches an event tagged as belonging to a previous load sequence —
   * simulates a late event from an old source arriving after a switch.
   */
  emitFromOldSession(type: string) {
    const event = new Event(type) as Event & Record<string, unknown>
    event[SESSION_KEY] = Math.max(1, this.activeSessionId - 1)
    this.dispatchEvent(event)
  }

  /** Id of the current media-load session. */
  get currentSessionId() {
    return this.activeSessionId
  }

  setBuffered(end: number) {
    this.buffered = {
      length: 1,
      start: () => 0,
      end: () => end,
    }
  }

  getTrack(language: string, label: string): FakeTextTrack | undefined {
    return this.trackElements.find(
      (el) => el.track.language === language && el.track.label === label,
    )?.track
  }
}

export function makeMediaError(code: number): MediaError {
  // Node has no MediaError global; the composable only reads code/message.
  return { code, message: `fake media error ${code}` } as unknown as MediaError
}
