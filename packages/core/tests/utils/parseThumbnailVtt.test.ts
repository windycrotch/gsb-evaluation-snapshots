import { afterEach, describe, expect, it, vi } from 'vitest'
import { findThumbnailCue, loadThumbnailVtt, parseVttText } from '../../src/utils/parseThumbnailVtt'

const VALID_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
/sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
/sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
/frame.jpg
`

describe('parseVttText', () => {
  it('parses cues with and without sprite coordinates', () => {
    const cues = parseVttText(VALID_VTT, 'https://cdn.example.com/thumbnails.vtt')
    expect(cues).toHaveLength(3)
    expect(cues[0]).toMatchObject({ start: 0, end: 5, x: 0, y: 0, w: 160, h: 90 })
    expect(cues[0].url).toBe('https://cdn.example.com/sprite.jpg')
    expect(cues[1]).toMatchObject({ start: 5, end: 10, x: 160, y: 0, w: 160, h: 90 })
    // No fragment → no coordinates, full-image fallback path.
    expect(cues[2]).toEqual({ start: 10, end: 15, url: 'https://cdn.example.com/frame.jpg' })
  })

  it('drops invalid xywh fragments but keeps the cue for whole-image fallback', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
/sprite.jpg#xywh=abc,0,160,90

00:00:05.000 --> 00:00:10.000
/sprite.jpg#xywh=0,0,160

00:00:10.000 --> 00:00:15.000
/sprite.jpg#xywh=-160,0,160,90

00:00:15.000 --> 00:00:20.000
/sprite.jpg#xywh=0,0,0,90

00:00:20.000 --> 00:00:25.000
/sprite.jpg#xywh=NaN,0,160,90

00:00:25.000 --> 00:00:30.000
/sprite.jpg#xywh=320,0,160,90
`
    const cues = parseVttText(vtt, 'https://cdn.example.com/t.vtt')
    expect(cues).toHaveLength(6)
    for (const cue of cues.slice(0, 5)) {
      expect(cue.x).toBeUndefined()
      expect(cue.w).toBeUndefined()
      expect(cue.url).toBe('https://cdn.example.com/sprite.jpg')
    }
    // The one valid fragment still parses.
    expect(cues[5]).toMatchObject({ x: 320, y: 0, w: 160, h: 90 })
  })

  it('accepts whitespace inside xywh fragments', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
/sprite.jpg#xywh=0, 0, 160, 90
`
    const cues = parseVttText(vtt, 'https://cdn.example.com/t.vtt')
    expect(cues[0]).toMatchObject({ x: 0, y: 0, w: 160, h: 90 })
  })

  it('drops cues with invalid or inverted time ranges', () => {
    const vtt = `WEBVTT

00:00:10.000 --> 00:00:05.000
/a.jpg

00:00:05.000 --> 00:00:05.000
/b.jpg#xywh=0,0,10,10

00:00:15.000 --> 00:00:20.000
/c.jpg
`
    const cues = parseVttText(vtt)
    expect(cues).toHaveLength(1)
    expect(cues[0].url.endsWith('/c.jpg')).toBe(true)
  })

  it('drops cues with empty image URLs', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
/ok.jpg
`
    const cues = parseVttText(vtt, 'https://cdn.example.com/t.vtt')
    expect(cues).toHaveLength(1)
    expect(cues[0].url).toBe('https://cdn.example.com/ok.jpg')
  })

  it('returns an empty array for empty or header-only input', () => {
    expect(parseVttText('')).toEqual([])
    expect(parseVttText('WEBVTT\n\n')).toEqual([])
    expect(parseVttText('   \n  \n')).toEqual([])
  })
})

describe('findThumbnailCue', () => {
  const cues = parseVttText(VALID_VTT)

  it('matches within a half-open [start, end) interval', () => {
    expect(findThumbnailCue(cues, 0)?.start).toBe(0)
    expect(findThumbnailCue(cues, 4.999)?.start).toBe(0)
  })

  it('rolls over to the next cue when landing exactly on an end time', () => {
    expect(findThumbnailCue(cues, 5)?.start).toBe(5)
    expect(findThumbnailCue(cues, 10)?.start).toBe(10)
  })

  it('returns the last cue for times past the final cue', () => {
    expect(findThumbnailCue(cues, 15)?.start).toBe(10)
    expect(findThumbnailCue(cues, 600)?.start).toBe(10)
  })

  it('returns null for times before the first cue', () => {
    expect(findThumbnailCue(cues, -1)).toBeNull()
  })

  it('returns null for empty input or non-finite times', () => {
    expect(findThumbnailCue([], 5)).toBeNull()
    expect(findThumbnailCue(cues, Number.NaN)).toBeNull()
    expect(findThumbnailCue(cues, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('works with unsorted cues', () => {
    const shuffled = [cues[2], cues[0], cues[1]]
    expect(findThumbnailCue(shuffled, 7)?.start).toBe(5)
    expect(findThumbnailCue(shuffled, 14)?.start).toBe(10)
  })

  it('picks the correct cue among adjacent cues sharing a boundary', () => {
    const dense = [
      { start: 0, end: 2, url: 'a' },
      { start: 2, end: 4, url: 'b' },
      { start: 4, end: 6, url: 'c' },
    ]
    expect(findThumbnailCue(dense, 2)?.url).toBe('b')
    expect(findThumbnailCue(dense, 3.999)?.url).toBe('b')
    expect(findThumbnailCue(dense, 4)?.url).toBe('c')
  })
})

describe('loadThumbnailVtt', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns ready state with parsed cues on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(VALID_VTT) }),
    )
    const result = await loadThumbnailVtt('https://cdn.example.com/t.vtt')
    expect(result.status).toBe('ready')
    expect(result.cues).toHaveLength(3)
  })

  it('reports error when the request rejects (network / CORS)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await loadThumbnailVtt('https://other-origin.example.com/t.vtt')
    expect(result).toEqual({ status: 'error', cues: [] })
  })

  it('reports error on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    const result = await loadThumbnailVtt('https://cdn.example.com/missing.vtt')
    expect(result).toEqual({ status: 'error', cues: [] })
  })

  it('reports error on an empty response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') }))
    const result = await loadThumbnailVtt('https://cdn.example.com/empty.vtt')
    expect(result).toEqual({ status: 'error', cues: [] })
  })

  it('reports error when every cue is invalid', async () => {
    const allInvalid = `WEBVTT

00:00:10.000 --> 00:00:05.000
/a.jpg

00:00:05.000 --> 00:00:05.000
/b.jpg
`
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(allInvalid) }),
    )
    const result = await loadThumbnailVtt('https://cdn.example.com/bad.vtt')
    expect(result).toEqual({ status: 'error', cues: [] })
  })
})
