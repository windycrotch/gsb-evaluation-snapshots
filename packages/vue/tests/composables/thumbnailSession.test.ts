import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createThumbnailSession } from '../../src/composables/useThumbnailSession'

// Self-made thumbnail VTT — one plain image cue and one sprite-sheet cue.
const VTT_A = `WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbs/a1.jpg

00:00:05.000 --> 00:00:10.000
/sprite.jpg#xywh=10,20,160,90
`

const VTT_B = `WEBVTT

00:00:00.000 --> 00:00:08.000
/thumbs/b1.jpg
`

interface PendingFetch {
  url: string
  resolve: (res: { ok: boolean; text: () => Promise<string> }) => void
  reject: (err: Error) => void
}

function installFetchMock() {
  const pending: PendingFetch[] = []
  const fetchMock = vi.fn((url: string) => {
    return new Promise((resolve, reject) => {
      pending.push({
        url,
        resolve: (res) => resolve(res as never),
        reject,
      })
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    pending,
    fetchMock,
    succeed(at: number, body: string) {
      pending[at].resolve({ ok: true, text: () => Promise.resolve(body) })
    },
    fail(at: number) {
      pending[at].resolve({ ok: false, text: () => Promise.resolve('') })
    },
    rejectAt(at: number, err = new Error('network down')) {
      pending[at].reject(err)
    },
  }
}

describe('createThumbnailSession', () => {
  let mock: ReturnType<typeof installFetchMock>

  beforeEach(() => {
    mock = installFetchMock()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('loads and parses cues for the current source', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const promise = session.load('/thumbs-a.vtt')

      expect(mock.fetchMock).toHaveBeenCalledWith(
        '/thumbs-a.vtt',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      mock.succeed(0, VTT_A)
      await promise

      expect(session.cues.value).toHaveLength(2)
      expect(session.cues.value[0]).toMatchObject({
        start: 0,
        end: 5,
        url: '/thumbs/a1.jpg',
      })
      expect(session.cues.value[1]).toMatchObject({
        start: 5,
        end: 10,
        url: '/sprite.jpg',
        x: 10,
        y: 20,
        w: 160,
        h: 90,
      })
    })
    scope.stop()
  })

  it('clears stale cues immediately when switching sources', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const first = session.load('/thumbs-a.vtt')
      mock.succeed(0, VTT_A)
      await first
      expect(session.cues.value).toHaveLength(2)

      // New source starts loading — old preview must vanish synchronously.
      const second = session.load('/thumbs-b.vtt')
      expect(session.cues.value).toEqual([])
      mock.succeed(1, VTT_B)
      await second
      expect(session.cues.value.map((c) => c.url)).toEqual(['/thumbs/b1.jpg'])
    })
    scope.stop()
  })

  it('does not let a late response from an old source overwrite the new source', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const first = session.load('/thumbs-a.vtt')
      // Switch before the first request resolves.
      const second = session.load('/thumbs-b.vtt')
      expect(session.cues.value).toEqual([])
      expect(mock.pending).toHaveLength(2)

      // The stale request resolves late (and was aborted).
      mock.succeed(0, VTT_A)
      await first
      // New source's data is untouched by the late response.
      expect(session.cues.value).toEqual([])

      mock.succeed(1, VTT_B)
      await second
      expect(session.cues.value.map((c) => c.url)).toEqual(['/thumbs/b1.jpg'])
    })
    scope.stop()
  })

  it('aborts the previous request when a newer session starts', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      session.load('/thumbs-a.vtt')
      const firstSignal = mock.fetchMock.mock.calls[0][1].signal as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      session.load('/thumbs-b.vtt')
      expect(firstSignal.aborted).toBe(true)

      // Aborted fetch promise (real fetch rejects with AbortError).
      mock.rejectAt(0, new DOMException('aborted', 'AbortError'))
      mock.succeed(1, VTT_B)
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.cues.value.map((c) => c.url)).toEqual(['/thumbs/b1.jpg'])
    })
    scope.stop()
  })

  it('leaves the preview empty when the request rejects, without throwing', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const promise = session.load('/thumbs-missing.vtt')
      mock.rejectAt(0)
      await expect(promise).resolves.toBeUndefined()
      expect(session.cues.value).toEqual([])
    })
    scope.stop()
  })

  it('leaves the preview empty on a non-OK response', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const promise = session.load('/thumbs-404.vtt')
      mock.fail(0)
      await promise
      expect(session.cues.value).toEqual([])
    })
    scope.stop()
  })

  it('never leaves old thumbnails when the new source has no thumbnail URL', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const first = session.load('/thumbs-a.vtt')
      mock.succeed(0, VTT_A)
      await first
      expect(session.cues.value).toHaveLength(2)

      await session.load(undefined)
      expect(session.cues.value).toEqual([])
      // No fetch is issued when there is nothing to load.
      expect(mock.fetchMock).toHaveBeenCalledTimes(1)
    })
    scope.stop()
  })

  it('stops in-flight results from writing state after the scope is disposed', async () => {
    const scope = effectScope()
    let session: ReturnType<typeof createThumbnailSession> | undefined
    await scope.run(async () => {
      session = createThumbnailSession()
      session.load('/thumbs-a.vtt')
    })
    scope.stop()

    const signal = mock.fetchMock.mock.calls[0][1].signal as AbortSignal
    expect(signal.aborted).toBe(true)

    // Even if the request somehow resolves after unmount, state is frozen.
    mock.succeed(0, VTT_A)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session!.cues.value).toEqual([])
  })

  it('handles three rapid switches without cross-session pollution', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const session = createThumbnailSession()
      const p1 = session.load('/1.vtt')
      const p2 = session.load('/2.vtt')
      const p3 = session.load('/3.vtt')

      // All earlier requests were aborted.
      expect((mock.fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
      expect((mock.fetchMock.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true)
      expect((mock.fetchMock.mock.calls[2][1].signal as AbortSignal).aborted).toBe(false)

      mock.succeed(0, VTT_A)
      mock.succeed(1, VTT_B)
      await Promise.all([p1, p2])
      expect(session.cues.value).toEqual([])

      mock.succeed(2, VTT_B)
      await p3
      expect(session.cues.value.map((c) => c.url)).toEqual(['/thumbs/b1.jpg'])
    })
    scope.stop()
  })
})
