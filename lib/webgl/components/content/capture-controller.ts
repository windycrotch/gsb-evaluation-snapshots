/**
 * Framework-agnostic PNG-export / WebM-recording orchestration for the WebGL
 * canvas. Keeping this out of React makes the state machine (recording
 * lifecycle, serialized resize→capture→restore exports, teardown) testable
 * with plain mocked browser APIs and keeps the component a thin adapter.
 */

/** Resolves once `frames` animation frames have elapsed. */
function waitForFrames(frames: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = frames
    const tick = () => {
      remaining -= 1
      if (remaining <= 0) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** Stops every track of a capture stream, releasing the encoder resources. */
function stopStreamTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop()
  })
}

/** MediaRecorder mime-type candidates, best support first. */
const RECORDER_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return (
    RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ??
    ''
  )
}

export interface CaptureDeps {
  canvas: HTMLCanvasElement
  /** Current canvas/container size (live, read at call time). */
  getSize: () => { width: number; height: number }
  setSize: (width: number, height: number) => void
  /** Natural size of the loaded media, if known. */
  getAssetSize: () => { width: number; height: number } | undefined
  onRecordingChange: (recording: boolean) => void
  isMounted: () => boolean
}

export interface CaptureController {
  exportImage: () => void
  startRecording: () => void
  stopRecording: () => void
  /** Tears down any active recording/stream and pending object URLs. */
  dispose: () => void
}

export function createCaptureController(deps: CaptureDeps): CaptureController {
  const { canvas, getSize, setSize, getAssetSize, onRecordingChange } = deps

  let recorder: MediaRecorder | null = null
  let activeStream: MediaStream | null = null
  let chunks: Blob[] = []
  let downloadUrl: string | null = null

  // Serializes PNG exports so a second click (or an export fired while another
  // is still resizing the canvas) can never interleave its resize/restore with
  // the in-flight one and leave the canvas at the wrong dimensions.
  let exportQueue: Promise<void> = Promise.resolve()

  const isRecording = () => recorder !== null && recorder.state !== 'inactive'

  const startRecording = () => {
    // Guard against double starts; the existing stream must keep running across
    // mode switches and media changes, never be replaced mid-recording.
    if (isRecording()) return

    const stream = canvas.captureStream(60)
    const mimeType = pickRecorderMimeType()

    let created: MediaRecorder
    try {
      created = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch (error) {
      console.error('MediaRecorder is not supported', error)
      stopStreamTracks(stream)
      return
    }

    recorder = created
    activeStream = stream
    chunks = []

    created.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })

    created.addEventListener('error', (event) => {
      console.error('Recording error', event)
    })

    created.addEventListener('stop', () => {
      const blob = new Blob(chunks, {
        type: created.mimeType || 'video/webm',
      })
      chunks = []

      // The capture stream is single-use: release every track as soon as the
      // recording ends so the encoder/capture resources are freed.
      stopStreamTracks(stream)
      if (activeStream === stream) activeStream = null
      if (recorder === created) recorder = null

      // A stop during teardown must not trigger a DOM download or touch the
      // state of a tree that is gone.
      if (!deps.isMounted()) return

      if (blob.size > 0) {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl)
        downloadUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.download = 'dithering.webm'
        link.href = downloadUrl
        link.click()
      }

      onRecordingChange(false)
    })

    try {
      created.start()
      onRecordingChange(true)
    } catch (error) {
      console.error('Failed to start recording', error)
      stopStreamTracks(stream)
      activeStream = null
      recorder = null
    }
  }

  const stopRecording = () => {
    // No-op when nothing is active; the `stop` event owns teardown, button
    // state restoration and stream release.
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
  }

  const exportImage = () => {
    const base = { ...getSize() }
    const assetSize = getAssetSize()
    const target =
      assetSize && assetSize.width > 0 && assetSize.height > 0
        ? { ...assetSize }
        : base

    const job = async () => {
      // While recording the canvas must keep its dimensions: resizing a
      // captured canvas mid-stream is what produced corrupt/interrupted webms.
      const needsResize =
        !isRecording() &&
        (target.width !== base.width || target.height !== base.height)

      if (needsResize) {
        setSize(target.width, target.height)
        // Wait for React to commit, the composer to resize its buffers and the
        // render loop to draw at least one frame at the target dimensions.
        await waitForFrames(2)
        if (!deps.isMounted()) return
      }

      const link = document.createElement('a')
      link.download = 'dithering.png'
      link.href = canvas.toDataURL('image/png')
      link.click()

      if (needsResize) {
        // Restore the pre-export canvas size even if the user switched modes
        // (which never touches canvas size) while the export was in flight.
        setSize(base.width, base.height)
        await waitForFrames(1)
      }
    }

    // Queue rather than run concurrently: each export gets a clean
    // resize → capture → restore cycle, in click order.
    exportQueue = exportQueue
      .then(job)
      .catch((error) => console.error('PNG export failed', error))
  }

  const dispose = () => {
    const wasRecording = isRecording()
    if (recorder && recorder.state !== 'inactive') {
      // Detach first so the `stop` handler skips its store/DOM work; the
      // owning tree is being torn down.
      const current = recorder
      recorder = null
      current.stop()
    }
    if (activeStream) {
      stopStreamTracks(activeStream)
      activeStream = null
    }
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
      downloadUrl = null
    }
    if (wasRecording) onRecordingChange(false)
  }

  return { exportImage, startRecording, stopRecording, dispose }
}
