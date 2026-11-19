/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ──────────────────────────────────────────────────────────
   AudioRecorder — captures the master bus AND superdough's output
   into one MediaStreamDestination, records as WebM (opus), and
   publishes the finished take to the shared take store.
   ────────────────────────────────────────────────────────── */

import { getSharedContext, getMasterGain } from './context'
import { getStrudelOutputNode } from './strudel-tap'
import { getLastTake as readLastTake, setLastTake } from './take-store'

/** How often to look for superdough's output node while a take is running. */
const STRUDEL_POLL_INTERVAL_MS = 500

/** What start() can report. A second start while recording is a no-op, never a
 *  second MediaRecorder. */
export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'already-recording' }
  | { ok: false; reason: 'unsupported'; message: string }

/** What stop() can report. Every branch is a value, so callers never have to
 *  wrap stop in a try/catch just to handle "I was not recording". */
export type StopResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: 'not-recording' }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'recorder-error'; message: string }

/** Everything a single take owns, so stop() can tear exactly it down. */
interface RecordingSession {
  destination: MediaStreamAudioDestinationNode
  masterGain: GainNode
  recorder: MediaRecorder
  chunks: Blob[]
  strudelTap: AudioNode | null
  strudelPollTimer: ReturnType<typeof setTimeout> | null
  stopPromise: Promise<StopResult> | null
}

/** Disconnect an edge without letting an already-removed one throw. */
function safeDisconnect(source: AudioNode | null, target: AudioNode | null): void {
  if (!source || !target) return
  try {
    source.disconnect(target)
  } catch {
    /* Already disconnected — safe to ignore */
  }
}

/** Records audio from the master gain node and exports as WebM download. */
export class AudioRecorder {
  /**
   * Exactly one active session, or null. Holding it as a single slot is what
   * makes a duplicate start impossible: there is nowhere for a second
   * destination or MediaRecorder to live.
   */
  private session: RecordingSession | null = null

  /**
   * Start recording — taps master gain into a MediaStreamDestination.
   *
   * Strudel is tapped SEPARATELY and deliberately. superdough terminates at
   * `audioContext.destination`, not at masterGain, so a recording that only
   * tapped the master bus captured silence for the default engine — which is
   * every session in the library. adoptSharedContextForStrudel() puts both on
   * the same context, which is what makes a single MediaStreamDestination able
   * to receive both.
   *
   * superdough's controller only exists once the first note has played, so the
   * Strudel tap is attached asynchronously and, if it is not up yet, polled for
   * while the take runs. A note played thirty seconds in still lands in the
   * recording.
   */
  start(): StartResult {
    if (this.session) return { ok: false, reason: 'already-recording' }

    const ctx = getSharedContext()
    const masterGain = getMasterGain()
    const destination = ctx.createMediaStreamDestination()
    masterGain.connect(destination)

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(destination.stream, {
        mimeType: 'audio/webm;codecs=opus',
      })
    } catch (err) {
      /* Releasing the destination matters: a start that fails after wiring the
         graph would otherwise leave masterGain feeding a dead node. */
      safeDisconnect(masterGain, destination)
      return {
        ok: false,
        reason: 'unsupported',
        message: err instanceof Error ? err.message : 'MediaRecorder is unavailable',
      }
    }

    const session: RecordingSession = {
      destination,
      masterGain,
      recorder,
      chunks: [],
      strudelTap: null,
      strudelPollTimer: null,
      stopPromise: null,
    }
    this.session = session

    this.attachStrudelTap(session)

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) session.chunks.push(e.data)
    }

    try {
      /* Collect data every 100ms for near-real-time chunk availability */
      recorder.start(100)
    } catch (err) {
      this.cleanup(session)
      return {
        ok: false,
        reason: 'unsupported',
        message: err instanceof Error ? err.message : 'MediaRecorder failed to start',
      }
    }

    return { ok: true }
  }

  /**
   * Attach superdough's output to this take's destination, retrying until it
   * appears or the take ends.
   *
   * Every asynchronous continuation re-checks `this.session === session`. That
   * single comparison is what stops a late-arriving node from connecting into
   * a destination that stop() already tore down — the leak this poll would
   * otherwise reintroduce.
   */
  private attachStrudelTap(session: RecordingSession): void {
    const attempt = (): void => {
      if (this.session !== session) return

      void getStrudelOutputNode()
        .then((node) => {
          if (this.session !== session) return

          if (!node || node.context !== session.destination.context) {
            session.strudelPollTimer = setTimeout(attempt, STRUDEL_POLL_INTERVAL_MS)
            return
          }

          node.connect(session.destination)
          session.strudelTap = node
        })
        .catch(() => {
          if (this.session !== session) return
          session.strudelPollTimer = setTimeout(attempt, STRUDEL_POLL_INTERVAL_MS)
        })
    }

    attempt()
  }

  /**
   * Stop recording and return the finished take.
   *
   * Never rejects: stopping before starting resolves `{ ok: false, reason:
   * 'not-recording' }`. A take with no audio is reported as 'empty' and does
   * NOT replace the previous good take in the shared store — otherwise a stray
   * click on record/stop would erase the recording the user actually wants to
   * export.
   */
  stop(): Promise<StopResult> {
    const session = this.session
    if (!session) return Promise.resolve({ ok: false, reason: 'not-recording' })
    if (session.stopPromise) return session.stopPromise

    session.stopPromise = new Promise<StopResult>((resolve) => {
      /* A real MediaRecorder can fire onerror and onstop for the same stop, in
         either order. First outcome wins; the other callback is ignored. */
      let settled = false
      const settle = (result: StopResult): void => {
        if (settled) return
        settled = true
        this.cleanup(session)
        resolve(result)
      }

      let recorderError: string | null = null

      const finalize = (): void => {
        if (recorderError !== null) {
          settle({ ok: false, reason: 'recorder-error', message: recorderError })
          return
        }
        if (session.chunks.length === 0) {
          settle({ ok: false, reason: 'empty' })
          return
        }
        const blob = new Blob(session.chunks, { type: 'audio/webm' })
        if (blob.size === 0) {
          settle({ ok: false, reason: 'empty' })
          return
        }
        /* Publish before resolving so an export fired from the same microtask
           as the stop always sees the new take. */
        setLastTake(blob)
        settle({ ok: true, blob })
      }

      session.recorder.onstop = finalize
      session.recorder.onerror = (event) => {
        /* MediaRecorder surfaces this as either an ErrorEvent (`message`) or a
           MediaRecorderErrorEvent (`error.message`) depending on the engine, so
           read both rather than depending on one shape. */
        const detail = event as unknown as {
          message?: unknown
          error?: { message?: unknown }
        }
        const message =
          typeof detail.message === 'string' && detail.message
            ? detail.message
            : typeof detail.error?.message === 'string' && detail.error.message
              ? detail.error.message
              : 'unknown'
        recorderError = message
        settle({ ok: false, reason: 'recorder-error', message })
      }

      if (session.recorder.state === 'inactive') {
        finalize()
        return
      }

      try {
        session.recorder.stop()
      } catch (err) {
        settle({
          ok: false,
          reason: 'recorder-error',
          message: err instanceof Error ? err.message : 'MediaRecorder failed to stop',
        })
      }
    })

    return session.stopPromise
  }

  /** Stop recording and trigger a browser download. */
  async stopAndDownload(filename = 'recording'): Promise<StopResult> {
    const result = await this.stop()
    if (!result.ok) return result

    const url = URL.createObjectURL(result.blob)
    try {
      /* Programmatic anchor click to trigger download dialog */
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.webm`
      a.click()
    } finally {
      URL.revokeObjectURL(url)
    }

    return result
  }

  /** Whether the recorder is currently capturing audio. */
  isRecording(): boolean {
    return this.session !== null
  }

  /** The last finished take, or null if nothing has been recorded this session. */
  getLastTake(): Blob | null {
    return readLastTake()
  }

  /**
   * Tear down the session's graph and references.
   *
   * Disconnects only the edges this take created. superdough's output node is
   * shared with the visualizer analyser, so a blanket disconnect() would blind
   * every canvas in the app.
   */
  private cleanup(session: RecordingSession): void {
    if (session.strudelPollTimer !== null) {
      clearTimeout(session.strudelPollTimer)
      session.strudelPollTimer = null
    }

    safeDisconnect(session.strudelTap, session.destination)
    safeDisconnect(session.masterGain, session.destination)

    /* Silent any further chunk delivery from a recorder we are abandoning. */
    session.recorder.ondataavailable = null
    session.recorder.onstop = null
    session.recorder.onerror = null

    session.strudelTap = null
    session.stopPromise = null
    session.chunks = []

    if (this.session === session) this.session = null
  }
}

/* Singleton recorder instance — one recorder per app */
let recorderInstance: AudioRecorder | null = null

export function getRecorder(): AudioRecorder {
  if (!recorderInstance) recorderInstance = new AudioRecorder()
  return recorderInstance
}

/* Export is implemented in ./wav-export; re-exported here because every caller
   has always imported it from the recorder module. */
export { exportLastTakeAsWav } from './wav-export'
export type { WavExportOutcome } from './wav-export'
