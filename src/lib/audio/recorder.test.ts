// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media
/* ──────────────────────────────────────────────────────────
   Tests for the record → stop → export chain.

   WebAudio and MediaRecorder do not exist in jsdom, so both are
   replaced with small deterministic fakes. What is under test is
   the wiring: one recorder per take, taps on both buses, clean
   teardown, and a discriminated export result for every outcome.
   ────────────────────────────────────────────────────────── */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AudioRecorder } from './recorder'
import { setLastTake, getLastTake, clearLastTake } from './take-store'
import { exportLastTakeAsWav } from './wav-export'
import { validateExportRequest } from '../../../electron/audio-export'

/* ── Hoisted fixture state — vi.mock factories run before imports ── */

const fixture = vi.hoisted(() => ({
  strudelNode: null as unknown,
  strudelLookups: 0,
  decoded: null as unknown,
  decodeError: null as Error | null,
  ctx: null as unknown,
  destinations: [] as Array<{
    stream: unknown
    context: unknown
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }>,
  masterConnects: [] as unknown[],
  masterDisconnects: [] as unknown[],
}))

vi.mock('./context', () => {
  const ctx = {
    createMediaStreamDestination: vi.fn(() => {
      const dest = {
        stream: { id: `stream-${fixture.destinations.length}` },
        context: ctx,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      fixture.destinations.push(dest)
      return dest
    }),
    decodeAudioData: vi.fn(async () => {
      if (fixture.decodeError) throw fixture.decodeError
      return fixture.decoded
    }),
  }
  fixture.ctx = ctx

  const masterGain = {
    context: ctx,
    connect: vi.fn((target: unknown) => {
      fixture.masterConnects.push(target)
    }),
    disconnect: vi.fn((target: unknown) => {
      fixture.masterDisconnects.push(target)
    }),
  }

  return {
    getSharedContext: () => ctx,
    getMasterGain: () => masterGain,
    resumeContext: vi.fn(),
    adoptSharedContextForStrudel: vi.fn(),
    setMasterVolume: vi.fn(),
    disposeContext: vi.fn(),
  }
})

vi.mock('./strudel-tap', () => ({
  getStrudelOutputNode: async () => {
    fixture.strudelLookups++
    return fixture.strudelNode
  },
}))

/* ── MediaRecorder fake ── */

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []

  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null

  constructor(
    readonly stream: unknown,
    options?: { mimeType?: string }
  ) {
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    /* The real MediaRecorder fires onstop on a later task, not inside stop().
       Firing it synchronously here would let onstop beat an onerror that the
       test delivers immediately after calling stop(). */
    queueMicrotask(() => this.onstop?.())
  }

  /** Deliver a chunk the way ondataavailable would during a take. */
  emit(contents = 'audio'): void {
    this.ondataavailable?.({ data: new Blob([contents], { type: 'audio/webm' }) })
  }
}

/** Let every pending promise continuation run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function currentRecorder(): FakeMediaRecorder {
  const instance = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
  if (!instance) throw new Error('no MediaRecorder was constructed')
  return instance
}

/** A decodeAudioData result with distinct per-channel data for interleave checks. */
function decodedBuffer(
  channelData: number[][],
  sampleRate = 48_000
): AudioBuffer {
  const length = channelData[0]?.length ?? 0
  return {
    numberOfChannels: channelData.length,
    length,
    sampleRate,
    getChannelData: (c: number) => Float32Array.from(channelData[c]),
  } as unknown as AudioBuffer
}

function fakeTake(): Blob {
  return {
    type: 'audio/webm',
    size: 16,
    arrayBuffer: async () => new ArrayBuffer(16),
  } as unknown as Blob
}

function installElectronApi(exportWav: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    value: { exportWav },
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  fixture.strudelNode = null
  fixture.strudelLookups = 0
  fixture.decoded = null
  fixture.decodeError = null
  fixture.destinations = []
  fixture.masterConnects = []
  fixture.masterDisconnects = []
  clearLastTake()
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearLastTake()
  Reflect.deleteProperty(window, 'electronAPI')
})

describe('AudioRecorder.start', () => {
  it('taps the master bus and records into one destination', () => {
    const recorder = new AudioRecorder()
    const result = recorder.start()

    expect(result).toEqual({ ok: true })
    expect(recorder.isRecording()).toBe(true)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(fixture.destinations).toHaveLength(1)
    expect(fixture.masterConnects).toEqual([fixture.destinations[0]])
    expect(currentRecorder().mimeType).toBe('audio/webm;codecs=opus')
  })

  it('refuses a second start instead of creating a parallel recorder', async () => {
    const recorder = new AudioRecorder()
    expect(recorder.start()).toEqual({ ok: true })

    const second = recorder.start()

    expect(second).toEqual({ ok: false, reason: 'already-recording' })
    /* The core guarantee: no second MediaRecorder, no second destination, and
       no second edge from masterGain. */
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(fixture.destinations).toHaveLength(1)
    expect(fixture.masterConnects).toHaveLength(1)

    await flushMicrotasks()
    expect(fixture.strudelLookups).toBe(1)
  })

  it('connects superdough output if it already exists', async () => {
    const ctx = fixture.ctx
    const strudelNode = {
      context: ctx,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    fixture.strudelNode = strudelNode

    const recorder = new AudioRecorder()
    recorder.start()
    await flushMicrotasks()

    expect(strudelNode.connect).toHaveBeenCalledWith(fixture.destinations[0])
  })

  it('keeps polling so a node that appears mid-take is still captured', async () => {
    vi.useFakeTimers()
    try {
      const recorder = new AudioRecorder()
      recorder.start()
      await vi.advanceTimersByTimeAsync(0)

      /* First note has not played yet — the take starts without a tap. */
      expect(fixture.strudelLookups).toBe(1)

      const strudelNode = {
        context: fixture.ctx,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      fixture.strudelNode = strudelNode

      await vi.advanceTimersByTimeAsync(600)

      expect(strudelNode.connect).toHaveBeenCalledWith(fixture.destinations[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never connects a node from a different AudioContext', async () => {
    /* Connecting across contexts produces no audio while looking successful,
       and would also make cleanup's disconnect() a no-op. */
    const foreignContext = {}
    const foreignNode = {
      context: foreignContext,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    fixture.strudelNode = foreignNode

    const recorder = new AudioRecorder()
    recorder.start()
    await flushMicrotasks()

    expect(foreignNode.connect).not.toHaveBeenCalled()

    currentRecorder().emit()
    await recorder.stop()
    expect(foreignNode.disconnect).not.toHaveBeenCalled()
  })

  it('keeps recording when the Strudel lookup throws', async () => {
    const recorder = new AudioRecorder()
    const tapModule = await import('./strudel-tap')
    const spy = vi
      .spyOn(tapModule, 'getStrudelOutputNode')
      .mockRejectedValueOnce(new Error('controller exploded'))

    recorder.start()
    await flushMicrotasks()

    /* The optional tap really did fail — asserting the spy ran keeps this test
       from passing vacuously if the mock stopped taking effect. */
    expect(spy).toHaveBeenCalled()
    expect(recorder.isRecording()).toBe(true)

    currentRecorder().emit()
    await expect(recorder.stop()).resolves.toMatchObject({ ok: true })

    spy.mockRestore()
  })
})

describe('AudioRecorder.stop', () => {
  it('publishes the take to the shared store and returns the blob', async () => {
    const recorder = new AudioRecorder()
    recorder.start()
    currentRecorder().emit('first')
    currentRecorder().emit('second')

    const result = await recorder.stop()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.blob.size).toBeGreaterThan(0)
    expect(getLastTake()).not.toBeNull()
    expect(getLastTake()).toBe(result.ok ? result.blob : null)
    expect(recorder.isRecording()).toBe(false)
  })

  it('reports not-recording instead of rejecting when stopped first', async () => {
    const recorder = new AudioRecorder()

    await expect(recorder.stop()).resolves.toEqual({
      ok: false,
      reason: 'not-recording',
    })
  })

  it('disconnects both taps on stop, including a Strudel tap', async () => {
    const strudelNode = {
      context: fixture.ctx,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    fixture.strudelNode = strudelNode

    const recorder = new AudioRecorder()
    recorder.start()
    await flushMicrotasks()
    currentRecorder().emit()

    await recorder.stop()

    const destination = fixture.destinations[0]
    expect(fixture.masterDisconnects).toEqual([destination])
    expect(strudelNode.disconnect).toHaveBeenCalledWith(destination)
  })

  it('does not treat an empty take as a new recording', async () => {
    setLastTake(fakeTake())
    const previous = getLastTake()

    const recorder = new AudioRecorder()
    recorder.start()
    /* No chunks emitted — e.g. stop clicked a moment after start. */
    const result = await recorder.stop()

    expect(result).toEqual({ ok: false, reason: 'empty' })
    /* The previous good take must survive a stray record/stop. */
    expect(getLastTake()).toBe(previous)
  })

  it('cancels the Strudel poll so a late node never connects', async () => {
    vi.useFakeTimers()
    try {
      const recorder = new AudioRecorder()
      recorder.start()
      await vi.advanceTimersByTimeAsync(0)

      currentRecorder().emit()
      await recorder.stop()

      const lateNode = {
        context: fixture.ctx,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      fixture.strudelNode = lateNode
      await vi.advanceTimersByTimeAsync(2_000)

      expect(lateNode.connect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts cleanly again after a full stop', async () => {
    const recorder = new AudioRecorder()
    recorder.start()
    currentRecorder().emit('one')
    await recorder.stop()

    expect(recorder.start()).toEqual({ ok: true })
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(fixture.destinations).toHaveLength(2)
    /* The new take got a fresh edge; the old one was already released. */
    expect(fixture.masterConnects).toEqual([
      fixture.destinations[0],
      fixture.destinations[1],
    ])
    expect(recorder.isRecording()).toBe(true)
  })

  it('surfaces a MediaRecorder failure as a reason, not an exception', async () => {
    const recorder = new AudioRecorder()
    recorder.start()

    const pending = recorder.stop()
    currentRecorder().onerror?.({ message: 'device lost' })

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'recorder-error',
      message: 'device lost',
    })
    expect(recorder.isRecording()).toBe(false)
  })
})

describe('exportLastTakeAsWav', () => {
  it('exports the last take as interleaved float32 PCM', async () => {
    fixture.decoded = decodedBuffer([
      [0.1, 0.3],
      [0.2, 0.4],
    ], 44_100)
    const exportWav = vi.fn(async () => ({ path: '/tmp/take.wav' }))
    installElectronApi(exportWav)
    setLastTake(fakeTake())

    const outcome = await exportLastTakeAsWav()

    expect(outcome).toEqual({ status: 'saved', path: '/tmp/take.wav' })
    expect(exportWav).toHaveBeenCalledTimes(1)
    const [buffer, sampleRate, channels] = exportWav.mock.calls[0] as [
      ArrayBuffer,
      number,
      number,
    ]
    expect(sampleRate).toBe(44_100)
    expect(channels).toBe(2)
    /* Frame-interleaved: L0, R0, L1, R1. */
    expect(Array.from(new Float32Array(buffer))).toEqual([
      0.10000000149011612, 0.20000000298023224, 0.30000001192092896,
      0.4000000059604645,
    ])
  })

  it('stops recording and exports without an intermediate step', async () => {
    fixture.decoded = decodedBuffer([[0.5]], 48_000)
    const exportWav = vi.fn(async () => ({ path: '/tmp/take.wav' }))
    installElectronApi(exportWav)

    /* The whole user journey in one test: record, stop, export. */
    const recorder = new AudioRecorder()
    recorder.start()
    currentRecorder().emit()
    await recorder.stop()

    const outcome = await exportLastTakeAsWav()
    expect(outcome.status).toBe('saved')
  })

  it('reports no-take when nothing has been recorded', async () => {
    installElectronApi(vi.fn())

    await expect(exportLastTakeAsWav()).resolves.toEqual({ status: 'no-take' })
  })

  it('reports unavailable outside Electron', async () => {
    setLastTake(fakeTake())

    await expect(exportLastTakeAsWav()).resolves.toEqual({ status: 'unavailable' })
  })

  it('reports cancelled when the save dialog is dismissed', async () => {
    fixture.decoded = decodedBuffer([[0.1]], 48_000)
    installElectronApi(vi.fn(async () => null))
    setLastTake(fakeTake())

    await expect(exportLastTakeAsWav()).resolves.toEqual({ status: 'cancelled' })
  })

  it('passes the main process rejection text through to the caller', async () => {
    fixture.decoded = decodedBuffer([[0.1]], 48_000)
    installElectronApi(vi.fn(async () => ({ error: 'Invalid sample rate' })))
    setLastTake(fakeTake())

    await expect(exportLastTakeAsWav()).resolves.toEqual({
      status: 'failed',
      message: 'Invalid sample rate',
    })
  })

  it('surfaces the specific rejection when real validation refuses the PCM', async () => {
    /* End-to-end across the bridge contract: the fake speaks for main, but the
       validation it runs is the real one. A renderer that sent a truncated
       buffer must end up showing the reason main would give, not a generic
       failure. */
    fixture.decoded = decodedBuffer([[0.1, 0.2]], 48_000)
    installElectronApi(
      vi.fn(async (buffer: ArrayBuffer, sampleRate: number, channels: number) => {
        const verdict = validateExportRequest(buffer, sampleRate, channels)
        return verdict.ok ? { path: '/tmp/take.wav' } : { error: verdict.error }
      })
    )
    setLastTake(fakeTake())

    await expect(exportLastTakeAsWav()).resolves.toEqual({
      status: 'saved',
      path: '/tmp/take.wav',
    })

    /* Same flow with a payload main must refuse: an impossible sample rate. */
    fixture.decoded = { ...decodedBuffer([[0.1]], 48_000) } as AudioBuffer
    Object.defineProperty(fixture.decoded, 'sampleRate', { value: 12 })
    await expect(exportLastTakeAsWav()).resolves.toEqual({
      status: 'failed',
      message: 'Invalid sample rate',
    })
  })

  it('reports a decode failure as failed instead of throwing', async () => {
    fixture.decodeError = new Error('bad container')
    installElectronApi(vi.fn())
    setLastTake(fakeTake())

    const outcome = await exportLastTakeAsWav()
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.message).toContain('bad container')
  })

  it('reports a rejected IPC call as failed', async () => {
    fixture.decoded = decodedBuffer([[0.1]], 48_000)
    installElectronApi(vi.fn(async () => Promise.reject(new Error('main gone'))))
    setLastTake(fakeTake())

    const outcome = await exportLastTakeAsWav()
    expect(outcome).toEqual({ status: 'failed', message: 'main gone' })
  })
})
