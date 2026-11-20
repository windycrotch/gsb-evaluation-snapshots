import type { Track } from '@vue-player/core'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import VideoPlayer from '../src/components/VideoPlayer/VideoPlayer.vue'

// ─── Fake HLS implementation (see usePlayer.test.ts for the rationale) ───
const { FakeHls } = vi.hoisted(() => {
  class FakeHls {
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVEL_SWITCHED: 'hlsLevelSwitched',
      ERROR: 'hlsError',
    }

    static isSupported() {
      return true
    }

    static instances: FakeHls[] = []

    levels: Array<{ height: number; bitrate: number }> = []
    currentLevel = -1
    nextLevel = -1
    destroyed = false
    src = ''
    private handlers = new Map<string, Set<(...args: any[]) => void>>()

    constructor(public config?: Record<string, unknown>) {
      FakeHls.instances.push(this)
    }

    on(event: string, cb: (...args: any[]) => void) {
      const set = this.handlers.get(event) ?? new Set()
      set.add(cb)
      this.handlers.set(event, set)
    }

    emit(event: string, data?: any) {
      this.handlers.get(event)?.forEach((cb) => cb(event, data))
    }

    loadSource(src: string) {
      this.src = src
    }

    attachMedia() {}

    destroy() {
      this.destroyed = true
      // Handlers intentionally kept: late events must be ignored by the player.
    }
  }
  return { FakeHls }
})

vi.mock('hls.js', () => ({ default: FakeHls }))

const SRC_A = 'https://cdn.test/movie-a/master.m3u8'
const SRC_B = 'https://cdn.test/movie-b/master.m3u8'

const TRACKS_A: Track[] = [
  { src: '/subs-a-en.vtt', label: 'English', language: 'en', default: true },
  { src: '/subs-a-de.vtt', label: 'Deutsch', language: 'de' },
]
const TRACKS_B: Track[] = [
  { src: '/subs-b-fr.vtt', label: 'Français', language: 'fr', default: true },
  { src: '/subs-b-es.vtt', label: 'Español', language: 'es' },
]
const TRACKS_NO_DEFAULT: Track[] = [{ src: '/subs-c-it.vtt', label: 'Italiano', language: 'it' }]

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function lastHls(): InstanceType<typeof FakeHls> {
  const instance = FakeHls.instances[FakeHls.instances.length - 1]
  expect(instance).toBeDefined()
  return instance
}

// jsdom does not implement TextTrack — stub the `track` property of every
// <track> element so the player's track-mode logic has something to toggle.
function stubTextTracks(video: HTMLVideoElement) {
  video.querySelectorAll('track').forEach((el) => {
    const trackEl = el as HTMLTrackElement
    Object.defineProperty(trackEl, 'track', {
      configurable: true,
      value: {
        language: trackEl.srclang,
        label: trackEl.label,
        mode: 'disabled',
        activeCues: [],
      },
    })
  })
}

function textTrackModes(video: HTMLVideoElement) {
  return Array.from(video.querySelectorAll('track')).map((el) => ({
    language: (el as HTMLTrackElement).srclang,
    mode: (el as HTMLTrackElement).track.mode,
  }))
}

describe('videoPlayer — source switch sessions', () => {
  let cleanups: Array<() => void> = []

  beforeEach(() => {
    FakeHls.instances.length = 0
    cleanups = []
  })

  afterEach(() => {
    cleanups.forEach((fn) => fn())
    document.body.innerHTML = ''
  })

  function setup(initialProps: { src: string; tracks: Track[] }) {
    const trackEvents: Array<Track | null> = []
    const errorEvents: any[] = []
    const props = reactive({ ...initialProps })
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(VideoPlayer, {
            src: props.src,
            tracks: props.tracks,
            onTrackChange: (t: Track | null) => trackEvents.push(t),
            onError: (e: any) => errorEvents.push(e),
          })
      },
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(Wrapper)
    app.mount(root)
    const video = root.querySelector('video')!
    cleanups.push(() => {
      app.unmount()
      root.remove()
    })
    return { root, video, props, trackEvents, errorEvents }
  }

  async function finishLoading(video: HTMLVideoElement) {
    const hls = lastHls()
    hls.levels = [{ height: 720, bitrate: 2_000_000 }]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)
    video.dispatchEvent(new Event('canplay'))
    await nextTick()
  }

  it('clears the subtitle selection on source switch, then applies the new default track', async () => {
    const { video, props, trackEvents } = setup({ src: SRC_A, tracks: TRACKS_A })
    await flush()
    stubTextTracks(video)
    await finishLoading(video)

    // Default track of source A applied once playable
    expect(trackEvents.at(-1)).toEqual(TRACKS_A[0])
    expect(textTrackModes(video)).toEqual([
      { language: 'en', mode: 'hidden' },
      { language: 'de', mode: 'disabled' },
    ])

    // Switch source — selection must reset before the new default applies
    props.src = SRC_B
    props.tracks = TRACKS_B
    await nextTick()
    await flush()
    expect(trackEvents).toContain(null)

    stubTextTracks(video)
    await finishLoading(video)

    expect(trackEvents.at(-1)).toEqual(TRACKS_B[0])
    expect(textTrackModes(video)).toEqual([
      { language: 'fr', mode: 'hidden' },
      { language: 'es', mode: 'disabled' },
    ])
  })

  it('keeps subtitles off after a source switch when the new source has no default track', async () => {
    const { video, props, trackEvents } = setup({ src: SRC_A, tracks: TRACKS_A })
    await flush()
    stubTextTracks(video)
    await finishLoading(video)
    expect(trackEvents.at(-1)).toEqual(TRACKS_A[0])

    props.src = SRC_B
    props.tracks = TRACKS_NO_DEFAULT
    await nextTick()
    await flush()
    stubTextTracks(video)
    await finishLoading(video)

    expect(trackEvents.at(-1)).toBeNull()
    expect(textTrackModes(video).every((t) => t.mode === 'disabled')).toBe(true)
  })

  it('never renders loading and error overlays at the same time, and recovers via retry', async () => {
    const { root, video, errorEvents } = setup({ src: SRC_A, tracks: TRACKS_A })
    await flush()
    stubTextTracks(video)

    const loading = () => root.querySelector('.vp-spinner') !== null
    const error = () => root.querySelector('.vp-error-message') !== null

    // Loading while the manifest is fetched
    await nextTick()
    expect(loading()).toBe(true)
    expect(error()).toBe(false)

    // Playable → loading collapses
    await finishLoading(video)
    await nextTick()
    expect(loading()).toBe(false)
    expect(error()).toBe(false)

    // Fatal error → error overlay replaces any loading state
    lastHls().emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })
    await nextTick()
    expect(error()).toBe(true)
    expect(loading()).toBe(false)
    expect(errorEvents).toHaveLength(1)

    // Retry starts a fresh session: error gone, loading shown, new instance
    root.querySelector<HTMLButtonElement>('.vp-error-retry')!.click()
    await nextTick()
    expect(error()).toBe(false)
    expect(loading()).toBe(true)
    await flush()
    expect(FakeHls.instances).toHaveLength(2)
    expect(lastHls().src).toBe(SRC_A)

    // New session becomes playable → loading collapses again
    await finishLoading(video)
    await nextTick()
    expect(loading()).toBe(false)
    expect(error()).toBe(false)
  })

  it('ignores a late error from the previous source after switching', async () => {
    const { root, props, errorEvents } = setup({ src: SRC_A, tracks: TRACKS_A })
    await flush()
    const stale = lastHls()

    props.src = SRC_B
    await nextTick()
    await flush()
    const current = lastHls()
    expect(stale.destroyed).toBe(true)
    expect(current).not.toBe(stale)

    // The old source's stream fails only now — must not surface
    stale.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })
    await nextTick()
    expect(errorEvents).toHaveLength(0)
    expect(root.querySelector('.vp-error-message')).toBeNull()
    expect(root.querySelector('.vp-spinner')).not.toBeNull()
  })
})
