import type { ThumbnailCue, ThumbnailState } from '../types/thumbnail'
import { parseTimecode } from './time'

function resolveUrl(base: string, url: string): string {
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

/**
 * A coordinate is only usable when it is a finite, non-negative number.
 * `xywh=-1,0,160,90`, `xywh=a,b,c,d` or `xywh=0,0,0,90` all fail this check,
 * in which case the cue falls back to full-image preview instead of being
 * cropped at a wrong offset.
 */
function parseSpriteFragment(fragment: string): Pick<ThumbnailCue, 'x' | 'y' | 'w' | 'h'> | null {
  if (!fragment.startsWith('xywh=')) return null

  const nums = fragment
    .slice(5)
    .split(',')
    .map((part) => Number(part.trim()))

  if (nums.length !== 4) return null
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return null

  const [x, y, w, h] = nums
  // A zero-sized frame can never render a visible thumbnail.
  if (w === 0 || h === 0) return null

  return { x, y, w, h }
}

/**
 * Parse thumbnail cues out of WebVTT text.
 *
 * Cues with unparseable time ranges or empty image URLs are dropped. Malformed
 * `xywh` fragments do not invalidate the cue — the coordinate fields are
 * simply omitted so the UI can fall back to showing the whole image.
 */
export function parseVttText(text: string, baseUrl = ''): ThumbnailCue[] {
  const cues: ThumbnailCue[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0

  // Skip WEBVTT header and any metadata blocks
  while (i < lines.length && !lines[i].includes('-->')) i++

  while (i < lines.length) {
    const line = lines[i].trim()

    if (!line.includes('-->')) {
      i++
      continue
    }

    // Parse "HH:MM:SS.mmm --> HH:MM:SS.mmm" — ignore position settings after the second timestamp
    const arrowIdx = line.indexOf('-->')
    const start = parseTimecode(line.slice(0, arrowIdx).trim())
    const endPart = line
      .slice(arrowIdx + 3)
      .trim()
      .split(/\s/)[0]
    const end = parseTimecode(endPart)

    i++
    const imgLine = lines[i]?.trim()
    if (!imgLine) {
      i++
      continue
    }

    // A cue covering no time cannot be matched against any hover position.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      i++
      continue
    }

    const hashIdx = imgLine.lastIndexOf('#')
    const rawUrl = hashIdx !== -1 ? imgLine.slice(0, hashIdx) : imgLine
    const fragment = hashIdx !== -1 ? imgLine.slice(hashIdx + 1) : ''

    if (!rawUrl) {
      i++
      continue
    }

    const cue: ThumbnailCue = { start, end, url: resolveUrl(baseUrl, rawUrl) }
    const sprite = parseSpriteFragment(fragment)
    if (sprite) Object.assign(cue, sprite)

    cues.push(cue)
    i++
  }

  return cues
}

/**
 * Fetch and parse a thumbnail WebVTT file.
 *
 * Never throws: network failures, CORS rejections, non-OK responses, empty
 * bodies and files without any usable cue all resolve to `status: 'error'`
 * with an empty cue list, so callers can hide the preview area and keep the
 * rest of the timeline (seek, chapters) working.
 */
export async function loadThumbnailVtt(url: string): Promise<ThumbnailState> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { status: 'error', cues: [] }

    const text = await res.text()
    if (!text.trim()) return { status: 'error', cues: [] }

    const cues = parseVttText(text, url)
    if (!cues.length) return { status: 'error', cues: [] }

    return { status: 'ready', cues }
  } catch {
    return { status: 'error', cues: [] }
  }
}

/**
 * Backwards-compatible wrapper: resolves to the parsed cue list (empty on any
 * failure). New code should use {@link loadThumbnailVtt} to distinguish
 * load failures from an unconfigured thumbnail source.
 */
export async function parseThumbnailVtt(url: string): Promise<ThumbnailCue[]> {
  const { cues } = await loadThumbnailVtt(url)
  return cues
}

/**
 * Pick the thumbnail cue for a playback time (seconds).
 *
 * Boundary rules:
 * - A time landing exactly on a cue's end time belongs to the *next* cue
 *   (intervals are `[start, end)`).
 * - Times before the first cue return `null` — there is no frame to show.
 * - Times past the last cue return the last cue (the nearest valid frame),
 *   which also covers videos whose duration exceeds the thumbnail span.
 * - Empty input and non-finite/negative times return `null`.
 *
 * Cues are sorted defensively on every call.
 */
export function findThumbnailCue(cues: ThumbnailCue[], time: number): ThumbnailCue | null {
  if (!cues.length || !Number.isFinite(time) || time < 0) return null

  const sorted = [...cues].sort((a, b) => a.start - b.start)

  if (time < sorted[0].start) return null

  let lo = 0
  let hi = sorted.length - 1
  let result = -1

  // Rightmost cue whose start is <= time. Because intervals are [start, end),
  // an exact end-time match naturally rolls over to the following cue.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].start <= time) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  if (result === -1) return null
  return sorted[result]
}
