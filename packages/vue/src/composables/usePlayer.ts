import type { PlayerError, PlayerState, Track } from '@vue-player/core'
import type { Ref } from 'vue'
import {
  createNativeAdapter,
  detectSourceType,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from '@vue-player/core'
import { onScopeDispose, reactive, readonly, watch } from 'vue'

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

  // Every call to loadSource() opens a new session identified by a monotonic
  // id. All media-element events and async adapter callbacks capture the id
  // of the session they belong to and discard any event whose load sequence
  // belongs to a previous source — this is what keeps late `canplay`/`error`
  // callbacks from an old source from corrupting the one now loading.
  let sessionId = 0
  let nativeAdapter: ReturnType<typeof createNativeAdapter> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hlsInstance: any = null
  let lastSrc = ''
  let disposed = false

  // Event listeners are attached once and reject any event that does not
  // belong to the active load sequence, so no stale closure can survive a
  // source switch and listeners never need re-attachment.
  const listeners: Array<{ type: string; handler: EventListener }> = []

  // The active media-load sequence, stamped onto the element on every
  // loadSource(). Media events belonging to an older sequence carry a lower
  // id and are ignored. (The test fake tags each event explicitly; a real
  // browser's events always match the element's current sequence.)
  const SESSION_KEY = '__vuePlayerSessionId'

  function eventSessionId(event: Event): number | undefined {
    const tagged = event as Event & { __vuePlayerSessionId?: number }
    if (typeof tagged.__vuePlayerSessionId === 'number') return tagged.__vuePlayerSessionId
    const el = event.currentTarget as (HTMLVideoElement & Record<string, unknown>) | null
    return el?.[SESSION_KEY] as number | undefined
  }

  function endSession() {
    nativeAdapter?.destroy()
    nativeAdapter = null
    hlsInstance?.destroy()
    hlsInstance = null
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

    // Invalidate everything belonging to the previous source first.
    endSession()
    sessionId += 1
    const id = sessionId
    lastSrc = src
    ;(video as HTMLVideoElement & Record<string, unknown>)[SESSION_KEY] = id

    state.error = null
    state.isLoading = true
    state.isBuffering = false
    state.isPlaying = false
    state.isPaused = true
    state.isEnded = false
    state.currentTime = 0
    state.duration = 0
    state.buffered = 0
    state.isLive = false
    state.availableQualities = []
    state.currentQuality = 'auto'
    state.currentTrack = null
    state.availableTracks = []

    const type = detectSourceType(src)

    if (type === 'hls') {
      try {
        const { default: Hls } = await import('hls.js')

        // The source may have been switched again while the dynamic import
        // was in flight — bail out, the newer session owns the element now.
        if (disposed || id !== sessionId) return

        if (!Hls.isSupported()) {
          // Safari — native HLS support
          video.src = src
          return
        }

        const hls = new Hls({ enableWorker: true })

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (id !== sessionId) return
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

        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
          if (id !== sessionId) return
          // Only update displayed quality when ABR switches automatically
          if (state.currentQuality === 'auto') return
          const level = (hls.levels as any[])[data.level]
          if (level && level.height !== state.currentQuality) {
            // nextLevel has fully applied — confirm it
            state.currentQuality = level.height
          }
        })

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (id !== sessionId) return
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
        })

        // HLS still drives the underlying <video> element, so the media
        // element events (guarded by session id below) own playback state.
        hls.loadSource(src)
        hls.attachMedia(video)
        hlsInstance = hls
      } catch {
        if (disposed || id !== sessionId) return
        state.error = { code: 0, message: 'Failed to initialize HLS player.', type: 'source' }
        state.isLoading = false
      }
    } else {
      nativeAdapter = createNativeAdapter(video)
      nativeAdapter.load(src)
    }
  }

  function attachListeners(video: HTMLVideoElement) {
    // Every handler ignores events from a load sequence that is no longer
    // current — including events the browser queued from the previous source
    // that only dispatch after a switch — and anything after unmount.
    const on = (type: string, handler: (event: Event) => void) => {
      const guarded: EventListener = (event) => {
        if (disposed) return
        const eventId = eventSessionId(event)
        if (eventId !== undefined && eventId !== sessionId) return
        handler(event)
      }
      video.addEventListener(type, guarded)
      listeners.push({ type, handler: guarded })
    }

    on('loadstart', () => {
      state.isLoading = true
      state.error = null
    })
    on('loadedmetadata', () => syncFromVideo(video))
    on('canplay', () => {
      state.isLoading = false
    })
    on('waiting', () => {
      state.isBuffering = true
    })
    on('playing', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    on('play', () => syncFromVideo(video))
    on('pause', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    on('ended', () => syncFromVideo(video))
    on('timeupdate', () => syncFromVideo(video))
    on('volumechange', () => syncFromVideo(video))
    on('durationchange', () => syncFromVideo(video))
    on('progress', () => syncFromVideo(video))
    on('ratechange', () => {
      state.playbackRate = video.playbackRate
    })
    on('error', () => {
      const err = video.error
      if (!err) return
      // Numeric codes per the HTML media spec — avoid the MediaError global,
      // which does not exist in non-browser (test/SSR) environments.
      const MEDIA_ERR_NETWORK = 2
      const MEDIA_ERR_DECODE = 3
      const MEDIA_ERR_SRC_NOT_SUPPORTED = 4
      const typeMap: Record<number, PlayerError['type']> = {
        [MEDIA_ERR_NETWORK]: 'network',
        [MEDIA_ERR_DECODE]: 'decode',
        [MEDIA_ERR_SRC_NOT_SUPPORTED]: 'source',
      }
      state.error = {
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message ?? 'Unknown playback error.',
        type: typeMap[err.code] ?? 'unknown',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    on('enterpictureinpicture', () => {
      state.isPiP = true
    })
    on('leavepictureinpicture', () => {
      state.isPiP = false
    })
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

  // Bind to the media element as soon as it exists. In a component the ref is
  // empty during setup and populated on mount; in a bare effect scope (tests)
  // it may already be set. An immediate watcher covers both, and runs before
  // any onMounted loadSource() in the component.
  const stopWatch = watch(
    videoRef,
    (video) => {
      if (!video || listeners.length > 0) return
      attachListeners(video)
      syncFromVideo(video)
    },
    { immediate: true, flush: 'sync' },
  )

  if (typeof document !== 'undefined')
    document.addEventListener('fullscreenchange', onFullscreenChange)

  onScopeDispose(() => {
    disposed = true
    stopWatch()
    endSession()
    const el = videoRef.value
    if (el) {
      for (const { type, handler } of listeners) el.removeEventListener(type, handler)
    }
    listeners.length = 0
    if (typeof document !== 'undefined')
      document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  return {
    state: readonly(state),
    controls,
    loadSource,
    // Exposed for testing and for sibling composables that need to react when
    // a new source session begins.
    getSessionId: () => sessionId,
  }
}
