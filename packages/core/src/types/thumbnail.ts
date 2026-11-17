export interface ThumbnailCue {
  start: number // cue start time in seconds
  end: number // cue end time in seconds
  url: string // absolute image URL
  x?: number // sprite x offset (px)
  y?: number // sprite y offset (px)
  w?: number // sprite frame width (px)
  h?: number // sprite frame height (px)
}

/**
 * Lifecycle of the thumbnail data behind a `thumbnails` prop.
 *
 * - `none`    — no thumbnail URL configured
 * - `loading` — the WebVTT file is being fetched
 * - `ready`   — at least one usable cue was parsed
 * - `error`   — the fetch failed (network/CORS/non-OK status) or the
 *               response parsed into zero usable cues
 */
export type ThumbnailStatus = 'none' | 'loading' | 'ready' | 'error'

export interface ThumbnailState {
  status: ThumbnailStatus
  cues: ThumbnailCue[]
}
