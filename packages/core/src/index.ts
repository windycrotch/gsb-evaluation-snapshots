export { createDashAdapter } from './adapters/dash'

export { createHlsAdapter } from './adapters/hls'
export { createNativeAdapter } from './adapters/native'

export type { NativeAdapter } from './adapters/native'
export type {
  Chapter,
  PlayerError,
  PlayerOptions,
  PlayerState,
  Quality,
  ThumbnailCue,
  ThumbnailState,
  ThumbnailStatus,
  Track,
  VideoSource,
} from './types'

export {
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
  isFullscreenSupported,
  isPiPSupported,
} from './utils/fullscreen'

export {
  findThumbnailCue,
  loadThumbnailVtt,
  parseThumbnailVtt,
  parseVttText,
} from './utils/parseThumbnailVtt'
export { detectSourceType } from './utils/source'

export type { SourceType } from './utils/source'
export { formatTime, parseTimecode } from './utils/time'
