// @vitest-environment node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/* Tests for the main-process side of "Export Audio": parameter validation,
 * the save dialog, WAV layout, and the disk write.
 *
 * The dialog, the filesystem and the IPC registry are replaced with stand-ins —
 * no window, no real file picker, no writes. encodeWav is wrapped (not replaced)
 * so validation tests can assert it was never reached while layout tests still
 * exercise the real encoder. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn() }
})

vi.mock('../wav-encoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wav-encoder')>()
  return { ...actual, encodeWav: vi.fn(actual.encodeWav) }
})

import { ipcMain, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { encodeWav } from '../wav-encoder'
import { registerAudioHandlers } from './audio'

/** 30 minutes of stereo float32 at 48 kHz, mirrored from the handler. */
const MAX_PCM_BYTES = 48_000 * 4 * 2 * 60 * 30

type ExportResult = { path: string } | { error: string } | null
type Handler = (
  event: unknown,
  buffer: unknown,
  sampleRate: unknown,
  channels: unknown
) => Promise<ExportResult>

const handleMock = ipcMain.handle as unknown as Mock
const showSaveDialog = dialog.showSaveDialog as unknown as Mock
const writeFileMock = writeFile as unknown as Mock
const encodeWavMock = encodeWav as unknown as Mock

let handler: Handler
let mainWindow: object

/** PCM in the shape the renderer sends: interleaved float32 samples. */
function pcm(samples: readonly number[]): ArrayBuffer {
  return new Float32Array(samples).buffer
}

/**
 * An ArrayBuffer that reports a byteLength without allocating it — the cap is
 * ~691 MB, far too much for a unit test to materialise.
 */
function bufferOfByteLength(byteLength: number): ArrayBuffer {
  const buffer = new ArrayBuffer(0)
  Object.defineProperty(buffer, 'byteLength', { value: byteLength, configurable: true })
  return buffer
}

/** ASCII tag at a byte offset, e.g. "RIFF". */
function tag(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString('ascii', offset, offset + length)
}

beforeEach(() => {
  vi.clearAllMocks()
  showSaveDialog.mockReset().mockResolvedValue({ canceled: true, filePath: undefined })
  writeFileMock.mockReset().mockResolvedValue(undefined)
  handleMock.mockReset()
  encodeWavMock.mockClear()

  mainWindow = { id: 1 }
  registerAudioHandlers(mainWindow as never)

  const registration = handleMock.mock.calls.at(-1)
  expect(registration?.[0]).toBe('audio:export-wav')
  handler = registration?.[1] as Handler
})

/** Validation failures must short-circuit before dialog, encode, or write. */
function expectRejectedBeforeSideEffects(result: ExportResult, message: string): void {
  expect(result).toEqual({ error: message })
  expect(showSaveDialog).not.toHaveBeenCalled()
  expect(encodeWavMock).not.toHaveBeenCalled()
  expect(writeFileMock).not.toHaveBeenCalled()
}

describe('registerAudioHandlers — registration', () => {
  it('registers exactly one audio:export-wav handler', () => {
    expect(handleMock).toHaveBeenCalledTimes(1)
    expect(handleMock.mock.calls[0][0]).toBe('audio:export-wav')
    expect(handleMock.mock.calls[0][1]).toBeTypeOf('function')
  })
})

describe('registerAudioHandlers — buffer validation', () => {
  it.each([
    ['a Uint8Array view', new Uint8Array(4)],
    ['a plain object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'RIFF'],
    ['an empty ArrayBuffer', new ArrayBuffer(0)],
  ])('rejects %s without touching the dialog, encoder or disk', async (_label, buffer) => {
    expectRejectedBeforeSideEffects(
      await handler(null, buffer, 48_000, 2),
      'Invalid audio buffer'
    )
  })

  it('rejects a buffer one byte over the 30-minute cap', async () => {
    expectRejectedBeforeSideEffects(
      await handler(null, bufferOfByteLength(MAX_PCM_BYTES + 1), 48_000, 2),
      'Recording too large to export'
    )
  })

  it('accepts a buffer exactly at the cap (the limit is exclusive)', async () => {
    expect(await handler(null, bufferOfByteLength(MAX_PCM_BYTES), 48_000, 2)).toBeNull()
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
  })
})

describe('registerAudioHandlers — sample rate validation', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['below 8000', 7999],
    ['a fraction above 8000', 8000.5],
    ['a fraction below the ceiling', 44_100.5],
    ['above 384000', 384_001],
    ['a numeric string', '48000'],
  ])('rejects %s without encoding or writing', async (_label, sampleRate) => {
    expectRejectedBeforeSideEffects(
      await handler(null, pcm([0, 0.5]), sampleRate, 2),
      'Invalid sample rate'
    )
  })

  it.each([8000, 44_100, 48_000, 384_000])('accepts %i Hz', async (sampleRate) => {
    expect(await handler(null, pcm([0, 0.5]), sampleRate, 2)).toBeNull()
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
  })
})

describe('registerAudioHandlers — channel validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['three', 3],
    ['a fraction between 1 and 2', 1.5],
    ['a fraction above 2', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '2'],
  ])('rejects %s channels without encoding or writing', async (_label, channels) => {
    expectRejectedBeforeSideEffects(
      await handler(null, pcm([0, 0.5, 0.25, 0.75]), 48_000, channels),
      'Invalid channel count'
    )
  })

  it.each([1, 2])('accepts %i channel(s)', async (channels) => {
    expect(await handler(null, pcm([0, 0.5]), 48_000, channels)).toBeNull()
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
  })
})

describe('registerAudioHandlers — save dialog', () => {
  it('offers a WAV filename and filter, parented to the main window', async () => {
    await handler(null, pcm([0]), 48_000, 1)

    expect(showSaveDialog).toHaveBeenCalledTimes(1)
    const [window, options] = showSaveDialog.mock.calls[0]
    expect(window).toBe(mainWindow)
    expect(options).toMatchObject({
      title: 'Export Audio',
      defaultPath: 'recording.wav',
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    })
  })

  it.each([
    ['canceled', { canceled: true, filePath: '/tmp/take.wav' }],
    ['canceled without a path', { canceled: false, filePath: undefined }],
    ['canceled with an empty path', { canceled: false, filePath: '' }],
  ])('returns null when the dialog is %s, without encoding or writing', async (_label, reply) => {
    showSaveDialog.mockResolvedValue(reply)

    expect(await handler(null, pcm([0, 0.5]), 48_000, 1)).toBeNull()
    expect(encodeWavMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('registerAudioHandlers — successful export', () => {
  it('encodes stereo PCM, writes it to the chosen path and returns that path', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/home/user/take.wav' })

    const result = await handler(null, pcm([1.5, -1.5, 0.25, -0.25]), 44_100, 2)

    expect(result).toEqual({ path: '/home/user/take.wav' })
    expect(encodeWavMock).toHaveBeenCalledTimes(1)
    expect(writeFileMock).toHaveBeenCalledTimes(1)

    const [writtenPath, written] = writeFileMock.mock.calls[0]
    expect(writtenPath).toBe('/home/user/take.wav')

    const wav = written as Buffer
    expect(tag(wav, 0, 4)).toBe('RIFF')
    expect(tag(wav, 8, 4)).toBe('WAVE')
    expect(tag(wav, 12, 4)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16)
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(24)).toBe(44_100)
    expect(wav.readUInt32LE(28)).toBe(44_100 * 2 * 2)
    expect(wav.readUInt16LE(32)).toBe(4)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(tag(wav, 36, 4)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(4 * 2)
    expect(wav.length).toBe(44 + 4 * 2)
    expect(wav.readInt16LE(44)).toBe(32_767)
    expect(wav.readInt16LE(46)).toBe(-32_768)
    expect(wav.readInt16LE(48)).toBe(Math.round(0.25 * 32_767))
    expect(wav.readInt16LE(50)).toBe(-Math.round(0.25 * 32_768))
  })

  it('reports a write failure instead of throwing across the bridge', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/readonly/take.wav' })
    writeFileMock.mockRejectedValue(new Error('EACCES'))

    expect(await handler(null, pcm([0, 0.5]), 48_000, 1)).toEqual({
      error: 'Failed to encode or write the WAV file',
    })
  })

  it('reports an encoder failure and does not write a partial file', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/take.wav' })
    encodeWavMock.mockImplementationOnce(() => {
      throw new Error('out of range')
    })

    expect(await handler(null, pcm([0, 0.5]), 48_000, 1)).toEqual({
      error: 'Failed to encode or write the WAV file',
    })
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

describe('encodeWav', () => {
  it('writes a 16-bit PCM header whose data length is samples × 2', () => {
    const samples = pcm([0, 0.5, -0.5, 1])
    const wav = encodeWav(samples, 8_000, 1)

    expect(wav.length).toBe(44 + 4 * 2)
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
    expect(tag(wav, 0, 4)).toBe('RIFF')
    expect(tag(wav, 8, 4)).toBe('WAVE')
    expect(tag(wav, 12, 4)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16)
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(8_000)
    expect(wav.readUInt32LE(28)).toBe(8_000 * 1 * 2)
    expect(wav.readUInt16LE(32)).toBe(2)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(tag(wav, 36, 4)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(4 * 2)

    expect(wav.readInt16LE(44)).toBe(0)
    expect(wav.readInt16LE(46)).toBe(16_384) // 0.5 × 32767 → 16383.5, rounded
    expect(wav.readInt16LE(48)).toBe(-16_384)
    expect(wav.readInt16LE(50)).toBe(32_767)
  })

  it('clamps float32 samples to the int16 boundaries', () => {
    const wav = encodeWav(pcm([2, -2, 1.5, -1.5, 1, -1]), 48_000, 1)

    const values = Array.from(
      { length: 6 },
      (_, i) => wav.readInt16LE(44 + i * 2)
    )
    expect(values).toEqual([32_767, -32_768, 32_767, -32_768, 32_767, -32_768])
  })

  it('writes a valid empty data chunk for zero samples', () => {
    const wav = encodeWav(new ArrayBuffer(0), 48_000, 2)

    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(4)).toBe(36)
    expect(wav.readUInt32LE(40)).toBe(0)
    expect(tag(wav, 36, 4)).toBe('data')
  })
})
