import type { Track } from '@vue-player/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'
import { usePlayer } from '../../src/composables/usePlayer'
import { createSubtitleSession } from '../../src/composables/useSubtitleSession'
import { createThumbnailSession } from '../../src/composables/useThumbnailSession'
import { FakeTrackElement, FakeVideo } from '../helpers/fakeVideo'

/**
 * Drives the three composables exactly the way VideoPlayer.vue wires them,
 * without mounting a component — so the full switching flow is testable with
 * a fake video element and a mocked fetch, no real media or network.
 */
function harness(video: FakeVideo, initialTracks: Track[]) {
  const scope = effectScope()
  const videoRef = ref(video as unknown as HTMLVideoElement)

  const result = scope.run(() => {
    const player = usePlayer(videoRef)
    const subtitles = createSubtitleSession((t) => player.controls.setTrack(t))
    const thumbnails = createThumbnailSession()

    // Same watcher as VideoPlayer.vue: re-establish subtitles on canplay.
    // flush:'sync' because a bare effect scope has no component scheduler to
    // flush pre-component watchers.
    watch(
      () => player.state.isLoading,
      (loading) => {
        if (loading || player.state.error) return
        subtitles.onLoadComplete(initialTracks)
      },
      { flush: 'sync' },
    )

    function switchSource(src: string, tracks: Track[], thumbUrl?: string) {
      initialTracks.splice(0, initialTracks.length, ...tracks)
      subtitles.startSession(tracks)
      thumbnails.load(thumbUrl)
      player.loadSource(src)
    }

    return { player, subtitles, thumbnails, switchSource }
  })!

  return { scope, ...result }
}

const VTT_ONE = `WEBVTT

00:00:00.000 --> 00:00:10.000
/one.jpg
`
const VTT_TWO = `WEBVTT

00:00:00.000 --> 00:00:10.000
/two.jpg
`

interface PendingFetch {
  resolve: (body: string) => void
  reject: (err: Error) => void
}

beforeEach(() => {
  const pending: PendingFetch[] = []
  const fetchMock = vi.fn(
    (_url: string) =>
      new Promise((resolve, reject) => {
        pending.push({
          resolve: (body) => resolve({ ok: true, text: () => Promise.resolve(body) }),
          reject,
        })
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  ;(globalThis as any).__pendingFetches = pending
})

afterEach(() => vi.unstubAllGlobals())

const pendingFetches = (): PendingFetch[] => (globalThis as any).__pendingFetches

describe('source switching as one isolated session', () => {
  it('normal switch: subtitles default-on and thumbnails match the new source', async () => {
    const video = new FakeVideo({ tracks: [new FakeTrackElement('en', 'English')] })
    const en: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
    const h = harness(video, [en])

    h.switchSource('/one.mp4', [en], '/one-thumbs.vtt')
    expect(h.player.state.isLoading).toBe(true)
    expect(h.subtitles.selectedTrack.value).toBeNull()
    expect(h.thumbnails.cues.value).toEqual([])

    pendingFetches()[0].resolve(VTT_ONE)
    // Two microtask ticks: fetch resolution, then res.text() inside the parser.
    await new Promise((r) => setTimeout(r, 0))
    video.emit('loadstart')
    video.emit('canplay')

    expect(h.player.state.isLoading).toBe(false)
    expect(h.subtitles.selectedTrack.value).toEqual(en)
    expect(h.thumbnails.cues.value.map((c) => c.url)).toEqual(['/one.jpg'])

    // ─ Switch to the second source ─
    const de: Track = { src: '/de.vtt', label: 'Deutsch', language: 'de', default: true }
    h.switchSource('/two.mp4', [de], '/two-thumbs.vtt')
    // Old session invalidated immediately.
    expect(h.player.state.isLoading).toBe(true)
    expect(h.subtitles.selectedTrack.value).toBeNull()
    expect(h.thumbnails.cues.value).toEqual([])

    pendingFetches()[1].resolve(VTT_TWO)
    await new Promise((r) => setTimeout(r, 0))
    video.emit('canplay')

    expect(h.subtitles.selectedTrack.value).toEqual(de)
    expect(h.thumbnails.cues.value.map((c) => c.url)).toEqual(['/two.jpg'])

    h.scope.stop()
  })

  it('rapid switches: a late old-source response never pollutes the new session', async () => {
    const video = new FakeVideo()
    const en: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
    const h = harness(video, [en])

    h.switchSource('/one.mp4', [en], '/one-thumbs.vtt')
    h.switchSource('/two.mp4', [en], '/two-thumbs.vtt')
    h.switchSource('/three.mp4', [en], '/three-thumbs.vtt')

    expect(h.player.state.isLoading).toBe(true)
    expect(h.thumbnails.cues.value).toEqual([])
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // First two requests were superseded/aborted.
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
    expect((fetchMock.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true)

    // Old responses arrive late — in any order.
    pendingFetches()[0].resolve(VTT_ONE)
    pendingFetches()[1].resolve(VTT_TWO)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.thumbnails.cues.value).toEqual([])

    // Only the newest session's result is accepted.
    pendingFetches()[2].resolve(VTT_TWO)
    // Two microtask ticks: fetch promise resolution, then res.text().
    await new Promise((r) => setTimeout(r, 0))
    expect(h.thumbnails.cues.value.map((c) => c.url)).toEqual(['/two.jpg'])

    // Loading state still belongs to the newest source; stale canplays were detached.
    video.emit('canplay')
    expect(h.player.state.isLoading).toBe(false)
    expect(h.subtitles.selectedTrack.value).toEqual(en)

    h.scope.stop()
  })

  it('thumbnail failure: preview stays empty and no error is thrown', async () => {
    const video = new FakeVideo()
    const en: Track = { src: '/en.vtt', label: 'English', language: 'en' }
    const h = harness(video, [en])

    const p = h.thumbnails.load('/missing.vtt')
    pendingFetches()[0].reject(new Error('boom'))
    await expect(p).resolves.toBeUndefined()
    expect(h.thumbnails.cues.value).toEqual([])

    h.scope.stop()
  })

  it('non-OK thumbnail response: preview stays empty and no error is thrown', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') }),
    )
    const video = new FakeVideo()
    const h = harness(video, [])

    await expect(h.thumbnails.load('/404.vtt')).resolves.toBeUndefined()
    expect(h.thumbnails.cues.value).toEqual([])

    h.scope.stop()
  })

  it('unmount: no residual state updates from events, fetches or timers', async () => {
    const video = new FakeVideo({ tracks: [new FakeTrackElement('en', 'English')] })
    const en: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
    const h = harness(video, [en])
    h.switchSource('/one.mp4', [en], '/one-thumbs.vtt')
    video.emit('loadstart')
    video.emit('canplay')
    expect(h.subtitles.selectedTrack.value).toEqual(en)

    const stateSnapshot = JSON.parse(JSON.stringify(h.player.state))
    h.scope.stop()

    // Pending thumbnail fetch is aborted.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal
    expect(signal.aborted).toBe(true)

    // A late response cannot resurrect cues.
    pendingFetches()[0].resolve(VTT_ONE)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.thumbnails.cues.value).toEqual([])

    // Late media events cannot mutate player state (listeners detached).
    video.emit('canplay')
    video.emit('waiting')
    video.emit('timeupdate')
    expect(JSON.parse(JSON.stringify(h.player.state))).toEqual(stateSnapshot)

    // Subtitle selection remains frozen at its last value.
    expect(h.subtitles.selectedTrack.value).toEqual(en)
  })

  it('user "Off" is sticky within a session but resets to default on switch', () => {
    const video = new FakeVideo({ tracks: [new FakeTrackElement('en', 'English')] })
    const en: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
    const h = harness(video, [en])

    h.switchSource('/one.mp4', [en])
    video.emit('loadstart')
    video.emit('canplay')
    expect(h.subtitles.selectedTrack.value).toEqual(en)

    h.subtitles.selectTrack(null)
    expect(h.subtitles.selectedTrack.value).toBeNull()

    // A repeated canplay (stall recovery) must not reopen subtitles.
    video.emit('canplay')
    expect(h.subtitles.selectedTrack.value).toBeNull()

    // New source → fresh session → default track comes back.
    h.switchSource('/two.mp4', [en])
    video.emit('canplay')
    expect(h.subtitles.selectedTrack.value).toEqual(en)

    h.scope.stop()
  })
})
