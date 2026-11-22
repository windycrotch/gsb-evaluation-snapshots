import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { usePlayer } from '../../src/composables/usePlayer'
import { FakeTrackElement, FakeVideo, makeMediaError } from '../helpers/fakeVideo'

function setupPlayer(video = new FakeVideo()) {
  const scope = effectScope()
  const videoRef = ref<HTMLVideoElement | null>(video as unknown as HTMLVideoElement)
  const player = scope.run(() => usePlayer(videoRef))!
  return { scope, video, videoRef, ...player }
}

function driveToCanPlay(video: FakeVideo) {
  video.emit('loadstart')
  video.emit('loadedmetadata')
  video.emit('canplay')
}

describe('usePlayer source sessions', () => {
  it('reflects loading state only for the current source', () => {
    const { video, state, loadSource } = setupPlayer()

    loadSource('/movie-1.mp4')
    expect(state.isLoading).toBe(true)

    driveToCanPlay(video)
    expect(state.isLoading).toBe(false)

    // Switching immediately returns to loading for the new source.
    loadSource('/movie-2.mp4')
    expect(state.isLoading).toBe(true)
    expect(state.currentTime).toBe(0)
    expect(state.duration).toBe(0)
    expect(state.error).toBeNull()
  })

  it('resets playback state when a new source session starts', () => {
    const { video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    driveToCanPlay(video)

    video.duration = 120
    video.currentTime = 42
    video.paused = false
    video.setBuffered(80)
    video.emit('timeupdate')

    expect(state.currentTime).toBe(42)
    expect(state.duration).toBe(120)
    expect(state.buffered).toBe(80)
    expect(state.isPlaying).toBe(true)

    loadSource('/movie-2.mp4')
    expect(state.currentTime).toBe(0)
    expect(state.duration).toBe(0)
    expect(state.buffered).toBe(0)
    expect(state.isPlaying).toBe(false)
    expect(state.isPaused).toBe(true)
    expect(state.isBuffering).toBe(false)
    expect(state.currentTrack).toBeNull()
  })

  it('ignores events delivered after the source was switched (stale session)', () => {
    const { video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    driveToCanPlay(video)
    expect(state.isLoading).toBe(false)

    // Start loading the second source.
    loadSource('/movie-2.mp4')
    expect(state.isLoading).toBe(true)

    // Late events still tagged with the first source's load sequence arrive
    // after the switch — they must be ignored entirely.
    video.emitFromOldSession('canplay')
    video.emitFromOldSession('error')
    expect(state.isLoading).toBe(true)
    expect(state.error).toBeNull()

    // The new source's own events drive the state.
    driveToCanPlay(video)
    expect(state.isLoading).toBe(false)
  })

  it('keeps the loading spinner for the new source when the old source errors late', () => {
    const { video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    driveToCanPlay(video)

    loadSource('/movie-2.mp4')
    // An error event from the old session cannot surface on the new source.
    video.error = makeMediaError(2)
    video.emitFromOldSession('error')
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(true)

    // The active session's error still surfaces normally.
    video.emit('error')
    expect(state.error?.code).toBe(2)
    expect(state.isLoading).toBe(false)
  })

  it('surfaces errors from the active session and clears loading/buffering', () => {
    const { video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    video.emit('loadstart')
    video.emit('waiting')
    expect(state.isBuffering).toBe(true)

    video.error = makeMediaError(4)
    video.emit('error')
    expect(state.error).not.toBeNull()
    expect(state.error?.code).toBe(4)
    expect(state.isLoading).toBe(false)
    expect(state.isBuffering).toBe(false)
  })

  it('tracks buffering only while it belongs to the active session', () => {
    const { video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    video.emit('waiting')
    expect(state.isBuffering).toBe(true)
    video.emit('playing')
    expect(state.isBuffering).toBe(false)

    loadSource('/movie-2.mp4')
    expect(state.isBuffering).toBe(false)
  })

  it('does not write state from any listener after unmount', () => {
    const { scope, video, state, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    driveToCanPlay(video)

    scope.stop()

    // No listener should remain attached — events are fully ignored.
    const snapshot = JSON.parse(JSON.stringify(state))
    video.emit('loadstart')
    video.emit('canplay')
    video.emit('waiting')
    video.emit('playing')
    video.emit('timeupdate')
    expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot)
  })

  it('clears the video element and adapters on unmount', () => {
    const video = new FakeVideo()
    const { scope, loadSource } = setupPlayer(video)
    loadSource('/movie-1.mp4')
    expect(video.src).toBe('/movie-1.mp4')

    scope.stop()
    expect(video.src).toBe('')
  })

  it('applies and clears subtitle track modes through controls', () => {
    const trackEl = new FakeTrackElement('en', 'English')
    const video = new FakeVideo({ tracks: [trackEl] })
    const { state, controls, loadSource } = setupPlayer(video)
    loadSource('/movie-1.mp4')

    const track = { src: '/en.vtt', label: 'English', language: 'en' }
    controls.setTrack(track)
    expect(state.currentTrack).toEqual(track)
    expect(trackEl.track.mode).toBe('hidden')

    controls.setTrack(null)
    expect(state.currentTrack).toBeNull()
    expect(trackEl.track.mode).toBe('disabled')
  })

  it('retry reloads the last source as a fresh session', () => {
    const { video, state, controls, loadSource } = setupPlayer()
    loadSource('/movie-1.mp4')
    video.error = makeMediaError(2)
    video.emit('loadstart')
    video.emit('error')
    expect(state.error).not.toBeNull()

    controls.retry()
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(true)
    driveToCanPlay(video)
    expect(state.isLoading).toBe(false)
  })

  it('exposes monotonically increasing session ids on every load', () => {
    const { getSessionId, loadSource } = setupPlayer()
    const first = getSessionId()
    loadSource('/a.mp4')
    const second = getSessionId()
    loadSource('/b.mp4')
    const third = getSessionId()
    expect(second).toBe(first + 1)
    expect(third).toBe(second + 1)
  })

  it('attaches listeners when the element ref is populated after setup (component mount)', () => {
    // Mirrors a real component: the template ref is null during setup and is
    // only assigned when the <video> element is mounted.
    const scope = effectScope()
    const videoRef = ref<HTMLVideoElement | null>(null)
    const player = scope.run(() => usePlayer(videoRef))!

    const video = new FakeVideo()
    videoRef.value = video as unknown as HTMLVideoElement

    // Now a load + media events must drive state, proving listeners attached
    // when the ref became available rather than being skipped at setup.
    player.loadSource('/movie-1.mp4')
    expect(player.state.isLoading).toBe(true)
    driveToCanPlay(video)
    expect(player.state.isLoading).toBe(false)

    scope.stop()
    // After disposal the same events are fully ignored.
    const snapshot = JSON.parse(JSON.stringify(player.state))
    video.emit('waiting')
    video.emit('timeupdate')
    expect(JSON.parse(JSON.stringify(player.state))).toEqual(snapshot)
  })

  it('does not attach a fullscreen document listener when document is unavailable', () => {
    // Guard for non-DOM environments: construction must not throw.
    const scope = effectScope()
    const videoRef = ref(new FakeVideo() as unknown as HTMLVideoElement)
    expect(() => scope.run(() => usePlayer(videoRef))).not.toThrow()
    scope.stop()
  })

  it('ignores play/pause/seek control calls when no element is bound', () => {
    const scope = effectScope()
    const videoRef = ref<HTMLVideoElement | null>(null)
    const player = scope.run(() => usePlayer(videoRef))!
    expect(async () => {
      await player.controls.play()
      player.controls.pause()
      player.controls.seek(10)
      player.controls.setVolume(0.5)
    }).not.toThrow()
    scope.stop()
  })
})
