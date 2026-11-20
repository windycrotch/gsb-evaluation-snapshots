import type { Track } from '@vue-player/core'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'
import { usePlayer } from '../src/composables/usePlayer'

// ─── Fake HLS implementation ───
// Event-emitter stand-in for hls.js. destroy() intentionally keeps the
// registered handlers so tests can simulate a "leaky" instance whose late
// callbacks still fire after teardown — the player's session guard must
// ignore them.
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
    attached = false
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

    attachMedia() {
      this.attached = true
    }

    destroy() {
      this.destroyed = true
      // Deliberately NOT clearing handlers: a destroyed instance may still
      // deliver late events, and the player must ignore them.
    }
  }
  return { FakeHls }
})

vi.mock('hls.js', () => ({ default: FakeHls }))

const SRC_A = 'https://cdn.test/movie-a/master.m3u8'
const SRC_B = 'https://cdn.test/movie-b/master.m3u8'
const SRC_C = 'https://cdn.test/movie-c/master.m3u8'

const LEVELS = [
  { height: 720, bitrate: 2_000_000 },
  { height: 1080, bitrate: 4_500_000 },
  { height: 720, bitrate: 2_800_000 }, // duplicate height — must be deduped
  { height: 360, bitrate: 800_000 },
]

function mountPlayer() {
  let player!: ReturnType<typeof usePlayer>
  const Comp = defineComponent({
    setup() {
      const videoRef = ref<HTMLVideoElement | null>(null)
      player = usePlayer(videoRef)
      return () => h('video', { ref: videoRef })
    },
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(Comp)
  app.mount(root)
  const video = root.querySelector('video')!
  return {
    player,
    video,
    unmount() {
      app.unmount()
      root.remove()
    },
  }
}

function lastHls(): InstanceType<typeof FakeHls> {
  const instance = FakeHls.instances[FakeHls.instances.length - 1]
  expect(instance).toBeDefined()
  return instance
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('usePlayer — load sessions', () => {
  let cleanups: Array<() => void> = []

  beforeEach(() => {
    FakeHls.instances.length = 0
    cleanups = []
  })

  afterEach(() => {
    cleanups.forEach((fn) => fn())
  })

  function setup() {
    const mounted = mountPlayer()
    cleanups.push(mounted.unmount)
    return mounted
  }

  it('builds the quality list from the manifest: deduped by height, descending, quality reset to auto', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    const hls = lastHls()
    hls.levels = [...LEVELS]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    expect(player.state.availableQualities.map((q) => q.value)).toEqual([1080, 720, 360])
    expect(player.state.availableQualities.map((q) => q.label)).toEqual(['1080p', '720p', '360p'])
    expect(player.state.currentQuality).toBe('auto')
  })

  it('ignores late callbacks from a destroyed session after switching sources', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    const stale = lastHls()
    stale.levels = [...LEVELS]

    await player.loadSource(SRC_B)
    const current = lastHls()

    // Old instance was fully torn down
    expect(stale.destroyed).toBe(true)
    expect(current).not.toBe(stale)
    expect(current.src).toBe(SRC_B)

    // Late events from the old session must not leak into current state
    stale.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities).toEqual([])

    stale.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })
    expect(player.state.error).toBeNull()
    expect(player.state.isLoading).toBe(true)

    stale.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 0 })
    expect(player.state.currentQuality).toBe('auto')

    // The current session still works
    current.levels = [{ height: 480, bitrate: 1_200_000 }]
    current.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities.map((q) => q.value)).toEqual([480])
  })

  it('creates a single HLS instance for the final source when switching rapidly', async () => {
    const { player } = setup()
    const p1 = player.loadSource(SRC_A)
    const p2 = player.loadSource(SRC_B)
    const p3 = player.loadSource(SRC_C)
    await Promise.all([p1, p2, p3])
    await flush()

    expect(FakeHls.instances).toHaveLength(1)
    expect(lastHls().src).toBe(SRC_C)
    expect(player.state.isLoading).toBe(true)
    expect(player.state.error).toBeNull()
  })

  it('surfaces fatal errors, then recovers on retry with a fresh session', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    const failed = lastHls()

    failed.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })
    expect(player.state.error).toEqual({
      code: 404,
      message: 'Stream not found (404).',
      type: 'network',
    })
    expect(player.state.isLoading).toBe(false)
    expect(failed.destroyed).toBe(true)

    player.controls.retry()
    await flush()

    expect(FakeHls.instances).toHaveLength(2)
    const retried = lastHls()
    expect(retried.src).toBe(SRC_A)
    expect(player.state.error).toBeNull()
    expect(player.state.isLoading).toBe(true)

    // Late error from the failed instance must not clobber the retry session
    failed.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })
    expect(player.state.error).toBeNull()

    retried.levels = [...LEVELS]
    retried.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities.map((q) => q.value)).toEqual([1080, 720, 360])
    expect(player.state.currentQuality).toBe('auto')
  })

  it('ignores non-fatal HLS errors', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    lastHls().emit(FakeHls.Events.ERROR, { fatal: false })
    expect(player.state.error).toBeNull()
    expect(player.state.isLoading).toBe(true)
  })

  it('keeps a manually selected quality against automatic level switches within the session', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    const hls = lastHls()
    hls.levels = [...LEVELS]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    player.controls.setQuality(720)
    expect(hls.nextLevel).toBe(0) // first level with height 720
    expect(player.state.currentQuality).toBe(720)

    // ABR-style switch to another level must not override the manual choice
    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 3 }) // 360p
    expect(player.state.currentQuality).toBe(720)

    // Switching back to auto re-enables ABR
    player.controls.setQuality('auto')
    expect(hls.currentLevel).toBe(-1)
    expect(player.state.currentQuality).toBe('auto')

    // In auto mode, level switches never rewrite the displayed quality
    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 1 })
    expect(player.state.currentQuality).toBe('auto')
  })

  it('clears the subtitle selection when switching sources', async () => {
    const { player } = setup()
    await player.loadSource(SRC_A)
    const track: Track = { src: '/subs-en.vtt', label: 'English', language: 'en' }
    player.controls.setTrack(track)
    expect(player.state.currentTrack).toEqual(track)

    await player.loadSource(SRC_B)
    expect(player.state.currentTrack).toBeNull()
  })

  it('never shows loading and error at the same time and collapses loading once playable', async () => {
    const { player, video } = setup()
    await player.loadSource(SRC_A)
    expect(player.state.isLoading).toBe(true)
    expect(player.state.error).toBeNull()

    video.dispatchEvent(new Event('canplay'))
    expect(player.state.isLoading).toBe(false)

    lastHls().emit(FakeHls.Events.ERROR, { fatal: true })
    expect(player.state.error).toBeTruthy()
    expect(player.state.isLoading).toBe(false)
    expect(player.state.isBuffering).toBe(false)

    // Reloading clears the error and returns to a pure loading state
    await player.loadSource(SRC_A)
    expect(player.state.error).toBeNull()
    expect(player.state.isLoading).toBe(true)
  })

  it('destroys the instance on unmount and ignores its late events', async () => {
    const { player, unmount } = setup()
    await player.loadSource(SRC_A)
    const hls = lastHls()
    hls.levels = [...LEVELS]
    cleanups = [] // unmount manually

    unmount()
    expect(hls.destroyed).toBe(true)

    hls.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities).toEqual([])
    hls.emit(FakeHls.Events.ERROR, { fatal: true })
    expect(player.state.error).toBeNull()
  })

  it('does not create an HLS instance when unmounted while hls.js is still loading', async () => {
    const { player, unmount } = setup()
    cleanups = [] // unmount manually
    const pending = player.loadSource(SRC_A)
    unmount()
    await pending
    await flush()

    expect(FakeHls.instances).toHaveLength(0)
    expect(player.state.error).toBeNull()
  })
})
