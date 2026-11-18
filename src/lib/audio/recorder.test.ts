// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/* Tests for the renderer half of "Export Audio" — exportLastTakeAsWav.
 *
 * The AudioContext and the Electron bridge are both stand-ins: decodeAudioData
 * returns a canned buffer, and window.electronAPI.exportWav is a spy. Nothing
 * touches a real sound card, file picker or network.
 *
 * The take itself is installed on the singleton recorder as a Blob-shaped stub
 * whose only used method is arrayBuffer() — what exportLastTakeAsWav calls. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const decodeAudioData = vi.hoisted(() => vi.fn())

vi.mock('./context', () => ({
  getSharedContext: () => ({ decodeAudioData }),
  getMasterGain: () => null,
}))

vi.mock('./strudel-tap', () => ({
  getStrudelOutputNode: async () => null,
}))

import { exportLastTakeAsWav, getRecorder } from './recorder'

type ExportArg = { buffer: ArrayBuffer; sampleRate: number; channels: number }
type ExportReply = { path: string } | { error: string } | null

/** The recorder's take is private state; only exportLastTakeAsWav reads it. */
const recorder = getRecorder() as unknown as { lastTake: Blob | null }

/** A take whose bytes are never inspected — arrayBuffer() is the only call. */
function stubTake(): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob
}

/** A decoded take with one Float32Array per channel. */
function decodedTake(channelData: readonly Float32Array[], sampleRate = 44_100) {
  return {
    numberOfChannels: channelData.length,
    length: channelData[0]?.length ?? 0,
    sampleRate,
    getChannelData: (index: number) => channelData[index],
  }
}

/** Installs (or removes) the preload bridge the exporter looks for. */
function installElectronApi(api: unknown): void {
  Object.defineProperty(window, 'electronAPI', { value: api, configurable: true, writable: true })
}

function removeElectronApi(): void {
  Reflect.deleteProperty(window, 'electronAPI')
}

beforeEach(() => {
  vi.clearAllMocks()
  recorder.lastTake = null
  removeElectronApi()
  decodeAudioData.mockReset().mockResolvedValue(decodedTake([new Float32Array([0, 0.5])]))
})

afterEach(() => {
  recorder.lastTake = null
  removeElectronApi()
})

describe('exportLastTakeAsWav — no take or no Electron', () => {
  it('returns null when nothing has been recorded', async () => {
    const exportWav = vi.fn(async () => ({ path: '/tmp/take.wav' }))
    installElectronApi({ exportWav })

    expect(await exportLastTakeAsWav()).toBeNull()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(exportWav).not.toHaveBeenCalled()
  })

  it.each([
    ['window.electronAPI is absent', () => removeElectronApi()],
    ['electronAPI has no exportWav', () => installElectronApi({})],
    ['exportWav is undefined', () => installElectronApi({ exportWav: undefined })],
    ['electronAPI is null', () => installElectronApi(null)],
  ])('returns null without decoding when %s', async (_label, setup) => {
    recorder.lastTake = stubTake()
    setup()

    expect(await exportLastTakeAsWav()).toBeNull()
    expect(decodeAudioData).not.toHaveBeenCalled()
  })

  it('returns null when the main process resolves undefined', async () => {
    recorder.lastTake = stubTake()
    installElectronApi({ exportWav: vi.fn(async () => undefined) })

    expect(await exportLastTakeAsWav()).toBeNull()
  })
})

describe('exportLastTakeAsWav — save dialog outcomes', () => {
  it.each([
    ['a user cancel (null)', null],
    ['a validation error object', { error: 'Invalid audio buffer' }],
  ])('passes through %s', async (_label, reply: ExportReply) => {
    recorder.lastTake = stubTake()
    installElectronApi({ exportWav: vi.fn(async () => reply) })

    expect(await exportLastTakeAsWav()).toEqual(reply)
  })

  it('returns the saved path', async () => {
    recorder.lastTake = stubTake()
    installElectronApi({ exportWav: vi.fn(async () => ({ path: '/tmp/take.wav' })) })

    expect(await exportLastTakeAsWav()).toEqual({ path: '/tmp/take.wav' })
  })
})

describe('exportLastTakeAsWav — channel layout', () => {
  /** Spies on the bridge and returns it typed as a mock for call inspection. */
  function exportSpy(): Mock {
    const exportWav = vi.fn(
      async (
        _buffer: ArrayBuffer,
        _sampleRate: number,
        _channels: number
      ) => ({ path: '/tmp/take.wav' })
    )
    installElectronApi({ exportWav })
    return exportWav as unknown as Mock
  }

  /** The three positional arguments the bridge is called with. */
  function exportedArg(exportWav: Mock): ExportArg {
    const [buffer, sampleRate, channels] = exportWav.mock.calls[0]
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    return {
      buffer: buffer as ArrayBuffer,
      sampleRate: sampleRate as number,
      channels: channels as number,
    }
  }

  function samplesOf(arg: ExportArg): number[] {
    return Array.from(new Float32Array(arg.buffer))
  }

  it('interleaves mono frames and reports one channel', async () => {
    recorder.lastTake = stubTake()
    decodeAudioData.mockResolvedValue(
      decodedTake([new Float32Array([0.1, 0.2, 0.3])], 48_000)
    )
    const exportWav = exportSpy()

    await exportLastTakeAsWav()

    const arg = exportedArg(exportWav)
    expect(arg.channels).toBe(1)
    expect(arg.sampleRate).toBe(48_000)
    expect(samplesOf(arg)).toEqual([0.1, 0.2, 0.3].map(Math.fround))
  })

  it('interleaves stereo frame-first: L0, R0, L1, R1, …', async () => {
    recorder.lastTake = stubTake()
    decodeAudioData.mockResolvedValue(
      decodedTake(
        [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])],
        44_100
      )
    )
    const exportWav = exportSpy()

    await exportLastTakeAsWav()

    const arg = exportedArg(exportWav)
    expect(arg.channels).toBe(2)
    expect(arg.sampleRate).toBe(44_100)
    expect(samplesOf(arg)).toEqual([0.1, 0.4, 0.2, 0.5, 0.3, 0.6].map(Math.fround))
  })

  it('handles a single stereo frame', async () => {
    recorder.lastTake = stubTake()
    decodeAudioData.mockResolvedValue(
      decodedTake([new Float32Array([-0.5]), new Float32Array([0.5])], 48_000)
    )
    const exportWav = exportSpy()

    await exportLastTakeAsWav()

    const arg = exportedArg(exportWav)
    expect(arg.channels).toBe(2)
    expect(samplesOf(arg)).toEqual([-0.5, 0.5].map(Math.fround))
  })

  it('caps surround audio to the first two channels, still frame-first', async () => {
    recorder.lastTake = stubTake()
    decodeAudioData.mockResolvedValue(
      decodedTake(
        [
          new Float32Array([0.1, 0.2]),
          new Float32Array([0.3, 0.4]),
          new Float32Array([9, 9]),
          new Float32Array([9, 9]),
        ],
        48_000
      )
    )
    const exportWav = exportSpy()

    await exportLastTakeAsWav()

    const arg = exportedArg(exportWav)
    expect(arg.channels).toBe(2)
    expect(samplesOf(arg)).toEqual([0.1, 0.3, 0.2, 0.4].map(Math.fround))
  })

  it('decodes the take bytes it was handed, not a fresh capture', async () => {
    const bytes = new ArrayBuffer(8)
    const take = { arrayBuffer: vi.fn(async () => bytes) } as unknown as Blob
    recorder.lastTake = take
    exportSpy()

    await exportLastTakeAsWav()

    expect(take.arrayBuffer).toHaveBeenCalledTimes(1)
    expect(decodeAudioData).toHaveBeenCalledWith(bytes)
  })
})
