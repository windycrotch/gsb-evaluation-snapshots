import type { PlayerError, PlayerState, Track } from '@vue-player/core'
import type { Ref } from 'vue'
import {
  createNativeAdapter,
  detectSourceType,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from '@vue-player/core'
import { onMounted, onUnmounted, reactive, readonly } from 'vue'

export interface PlayerControls {
  play: () => Promise<void>
  pause: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  setSpeed: (rate: number) => void
  setQuality: (value: number | 'auto') => void
  setTrack: (track: Track | null) => void
  toggleFullscreen: () => Promise<void>
  togglePiP: () => Promise<void>
  retry: () => void
}

const ERROR_MESSAGES: Record<number, string> = {
  1: 'Playback was aborted.',
  2: 'Network error — could not load the video.',
  3: 'The video format is not supported by your browser.',
  4: 'Video not found or format not supported.',
}

// Cache the dynamic import so rapid consecutive loadSource calls share a
// single module fetch instead of racing several identical imports.
let hlsModulePromise: Promise<typeof import('hls.js')> | null = null
function importHls() {
  hlsModulePromise ??= import('hls.js')
  return hlsModulePromise
}

function makeDefaultState(): PlayerState {
  return {
    isPlaying: false,
    isPaused: true,
    isEnded: false,
    isLoading: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    isMuted: false,
    isFullscreen: false,
    isPiP: false,
    isLive: false,
    currentQuality: 'auto',
    availableQualities: [],
    playbackRate: 1,
    currentTrack: null,
    availableTracks: [],
    error: null,
  }
}

export function usePlayer(videoRef: Ref<HTMLVideoElement | null>) {
  const state = reactive<PlayerState>(makeDefaultState())

  let nativeAdapter: ReturnType<typeof createNativeAdapter> | null = null
  let hlsInstance: any = null
  let lastSrc = ''
  // Each loadSource/retry starts a new session. Async continuations and HLS
  // event handlers capture the session id at creation and bail out when it no
  // longer matches, so late callbacks from a destroyed session can never
  // write stale quality levels or errors into the current state.
  let sessionId = 0

  function clearVideo() {
    const video = videoRef.value
    if (!video) return
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  function destroyAdapters() {
    // Invalidate the previous session — any of its pending async work
    // (dynamic import, manifest parse, ABR switch, error callback) becomes
    // a no-op from this point on.
    sessionId++
    nativeAdapter?.destroy()
    nativeAdapter = null
    hlsInstance?.destroy()
    hlsInstance = null
    // Always clear video element between source switches
    clearVideo()
  }

  function syncFromVideo(video: HTMLVideoElement) {
    state.isPlaying = !video.paused && !video.ended
    state.isPaused = video.paused
    state.isEnded = video.ended
    state.currentTime = video.currentTime
    state.duration = Number.isFinite(video.duration) ? video.duration : 0
    state.volume = video.volume
    state.isMuted = video.muted
    state.playbackRate = video.playbackRate
    state.isLive = video.duration === Infinity
    if (video.buffered.length > 0) {
      state.buffered = video.buffered.end(video.buffered.length - 1)
    }
  }

  async function loadSource(src: string) {
    const video = videoRef.value
    if (!video) return

    lastSrc = src
    destroyAdapters()
    // Session for this load — captured after destroyAdapters() bumped the id.
    const session = sessionId

    state.error = null
    state.isLoading = true
    state.isBuffering = false
    state.currentTime = 0
    state.duration = 0
    state.buffered = 0
    state.isLive = false
    state.availableQualities = []
    state.currentQuality = 'auto'
    // Subtitle selection belongs to the previous source — clear it now; the
    // new source's default track is re-applied once loading finishes.
    state.currentTrack = null

    const type = detectSourceType(src)

    if (type === 'hls') {
      try {
        const { default: Hls } = await importHls()

        // A newer loadSource/retry (or unmount) invalidated this session
        // while hls.js was loading — don't create an instance for it.
        if (session !== sessionId) return

        if (!Hls.isSupported()) {
          // Safari — native HLS support
          video.src = src
          return
        }

        const hls = new Hls({ enableWorker: true })
        hlsInstance = hls
        // True only while this exact instance belongs to the live session.
        const isCurrent = () => session === sessionId && hlsInstance === hls

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!isCurrent()) return
          const seen = new Set<number>()
          state.availableQualities = (hls.levels as any[])
            .map((level, i) => ({
              value: level.height as number,
              label: level.height ? `${level.height}p` : `Level ${i}`,
              bitrate: level.bitrate as number,
            }))
            .filter((q) => {
              if (seen.has(q.value)) return false
              seen.add(q.value)
              return true
            })
            .sort((a, b) => b.value - a.value)
          state.currentQuality = 'auto'
        })

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!isCurrent()) return
          if (!data.fatal) return
          const code = (data as any).response?.code ?? 0
          const isNotFound = code === 404
          state.error = {
            code,
            message: isNotFound
              ? 'Stream not found (404).'
              : 'Failed to load the stream. Check the URL or try again.',
            type: 'network',
          }
          state.isLoading = false
          state.isBuffering = false
          hls.destroy()
          if (hlsInstance === hls) hlsInstance = null
        })

        hls.loadSource(src)
        hls.attachMedia(video)
      } catch {
        if (session !== sessionId) return
        state.error = { code: 0, message: 'Failed to initialize HLS player.', type: 'source' }
        state.isLoading = false
      }
    } else {
      nativeAdapter = createNativeAdapter(video)
      nativeAdapter.load(src)
    }
  }

  function onFullscreenChange() {
    state.isFullscreen = !!document.fullscreenElement
  }

  function applyTrackModes(video: HTMLVideoElement) {
    const track = state.currentTrack
    Array.from(video.querySelectorAll<HTMLTrackElement>('track')).forEach((el) => {
      const t = el.track
      const isActive = track !== null && t.language === track.language && t.label === track.label
      t.mode = isActive ? 'hidden' : 'disabled'
    })
  }

  function attachListeners(video: HTMLVideoElement) {
    video.addEventListener('loadstart', () => {
      state.isLoading = true
      state.error = null
    })
    video.addEventListener('loadedmetadata', () => {
      syncFromVideo(video)
    })
    video.addEventListener('canplay', () => {
      state.isLoading = false
    })
    video.addEventListener('waiting', () => {
      state.isBuffering = true
    })
    video.addEventListener('playing', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('play', () => syncFromVideo(video))
    video.addEventListener('pause', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('ended', () => syncFromVideo(video))
    video.addEventListener('timeupdate', () => syncFromVideo(video))
    video.addEventListener('volumechange', () => syncFromVideo(video))
    video.addEventListener('durationchange', () => syncFromVideo(video))
    video.addEventListener('progress', () => syncFromVideo(video))
    video.addEventListener('ratechange', () => {
      state.playbackRate = video.playbackRate
    })
    video.addEventListener('error', () => {
      const err = video.error
      if (!err) return
      const typeMap: Record<number, PlayerError['type']> = {
        [MediaError.MEDIA_ERR_NETWORK]: 'network',
        [MediaError.MEDIA_ERR_DECODE]: 'decode',
        [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'source',
      }
      state.error = {
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message ?? 'Unknown playback error.',
        type: typeMap[err.code] ?? 'unknown',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    video.addEventListener('enterpictureinpicture', () => {
      state.isPiP = true
    })
    video.addEventListener('leavepictureinpicture', () => {
      state.isPiP = false
    })

    // Fullscreen must be observed on document — the player element is not <video>
    document.addEventListener('fullscreenchange', onFullscreenChange)
  }

  const controls: PlayerControls = {
    async play() {
      await videoRef.value?.play()
    },
    pause() {
      videoRef.value?.pause()
    },
    seek(seconds) {
      const video = videoRef.value
      if (!video || !state.duration) return
      video.currentTime = Math.max(0, Math.min(state.duration, seconds))
    },
    setVolume(value) {
      const video = videoRef.value
      if (!video) return
      video.volume = Math.max(0, Math.min(1, value))
      if (video.muted && value > 0) video.muted = false
    },
    toggleMute() {
      if (videoRef.value) videoRef.value.muted = !videoRef.value.muted
    },
    setSpeed(rate) {
      if (videoRef.value) videoRef.value.playbackRate = rate
    },
    setQuality(value) {
      if (!hlsInstance) return
      if (value === 'auto') {
        hlsInstance.currentLevel = -1 // -1 re-enables ABR
      } else {
        const idx = (hlsInstance.levels as any[]).findIndex((l) => l.height === value)
        // nextLevel switches at the next segment boundary — no buffer flush, no freeze
        if (idx !== -1) hlsInstance.nextLevel = idx
      }
      // The displayed quality is only ever changed here (and reset by a new
      // session's manifest) — LEVEL_SWITCHED is intentionally not subscribed,
      // so a manual pick is never overwritten by automatic ABR switches.
      state.currentQuality = value
    },
    setTrack(track) {
      state.currentTrack = track
      const video = videoRef.value
      if (video) applyTrackModes(video)
    },
    async toggleFullscreen() {
      const video = videoRef.value
      const el = video?.closest<HTMLElement>('.vp-player')
      if (!el) return
      if (getFullscreenElement()) {
        await exitFullscreen()
      } else if ('requestFullscreen' in el || 'webkitRequestFullscreen' in el) {
        await enterFullscreen(el)
      } else {
        // iOS Safari: only supports fullscreen on the video element itself
        const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
        iosVideo.webkitEnterFullscreen?.()
      }
    },
    async togglePiP() {
      const video = videoRef.value
      if (!video) return
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    },
    retry() {
      if (lastSrc) loadSource(lastSrc)
    },
  }

  onMounted(() => {
    const video = videoRef.value
    if (!video) return
    attachListeners(video)
    syncFromVideo(video)
  })

  onUnmounted(() => {
    destroyAdapters()
    document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  return { state: readonly(state), controls, loadSource }
}
