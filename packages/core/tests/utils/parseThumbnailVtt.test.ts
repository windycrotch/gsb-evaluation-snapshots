import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseThumbnailVtt, parseVttText } from '../../src/utils/parseThumbnailVtt'

const VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbs/a.jpg

00:00:05.000 --> 00:00:10.000
/sprite.jpg#xywh=0,0,160,90
`

describe('parseThumbnailVtt', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches and parses a thumbnail VTT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(VTT) }),
    )
    const cues = await parseThumbnailVtt('/thumbs.vtt')
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ start: 0, end: 5, url: '/thumbs/a.jpg' })
    expect(cues[1]).toMatchObject({ start: 5, end: 10, x: 0, y: 0, w: 160, h: 90 })
  })

  it('passes an abort signal through to fetch when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(VTT) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await parseThumbnailVtt('/thumbs.vtt', controller.signal)
    expect(fetchMock).toHaveBeenCalledWith('/thumbs.vtt', { signal: controller.signal })
  })

  it('returns an empty array without calling fetch when already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const cues = await parseThumbnailVtt('/thumbs.vtt', controller.signal)
    expect(cues).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an empty array on network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(parseThumbnailVtt('/thumbs.vtt')).resolves.toEqual([])
  })

  it('returns an empty array on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') }),
    )
    await expect(parseThumbnailVtt('/thumbs.vtt')).resolves.toEqual([])
  })

  it('treats an abort rejection as an empty result (superseded request)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))
    await expect(parseThumbnailVtt('/thumbs.vtt')).resolves.toEqual([])
  })
})

describe('parseVttText', () => {
  beforeEach(() => {
    // Self-made VTT parsing sanity check with CRLF line endings.
  })

  it('parses CRLF input and resolves relative URLs against the base', () => {
    const crlf = VTT.replace(/\n/g, '\r\n')
    const cues = parseVttText(crlf, 'https://example.com/assets/thumbs.vtt')
    expect(cues[0].url).toBe('https://example.com/thumbs/a.jpg')
    expect(cues[1].url).toBe('https://example.com/sprite.jpg')
  })

  it('ignores malformed xywh fragments', () => {
    const text = `WEBVTT

00:00:00.000 --> 00:00:05.000
/img.jpg#xywh=1,2
`
    const cues = parseVttText(text)
    expect(cues[0].w).toBeUndefined()
    expect(cues[0].url).toBe('/img.jpg')
  })
})
