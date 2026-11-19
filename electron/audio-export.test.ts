// @vitest-environment node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

import { describe, expect, it } from 'vitest'
import {
  MAX_PCM_BYTES,
  MAX_SAMPLE_RATE,
  MIN_SAMPLE_RATE,
  validateExportRequest,
} from './audio-export'
import { encodeWav } from './wav-encoder'

/** A valid interleaved stereo payload with room to spare. */
function stereoPcm(frames = 4): ArrayBuffer {
  return new ArrayBuffer(frames * 4 * 2)
}

describe('validateExportRequest', () => {
  it('accepts a well-formed stereo request', () => {
    const buffer = stereoPcm()
    const result = validateExportRequest(buffer, 48_000, 2)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.buffer).toBe(buffer)
      expect(result.value.sampleRate).toBe(48_000)
      expect(result.value.channels).toBe(2)
    }
  })

  it('accepts mono at the minimum sample rate', () => {
    expect(validateExportRequest(stereoPcm(2), MIN_SAMPLE_RATE, 1).ok).toBe(true)
  })

  it('rejects a non-ArrayBuffer or an empty buffer', () => {
    expect(validateExportRequest(null, 48_000, 2)).toEqual({
      ok: false,
      error: 'Invalid audio buffer',
    })
    expect(validateExportRequest(new ArrayBuffer(0), 48_000, 2)).toEqual({
      ok: false,
      error: 'Invalid audio buffer',
    })
    expect(validateExportRequest('not a buffer', 48_000, 2)).toEqual({
      ok: false,
      error: 'Invalid audio buffer',
    })
  })

  it('rejects a payload over the size cap', () => {
    /* The cap is checked before any arithmetic on byteLength, and before
       encodeWav allocates. Exercised with a tiny cap so the test does not have
       to allocate 660 MB to prove the branch exists. */
    expect(validateExportRequest(stereoPcm(4), 48_000, 2, 8)).toEqual({
      ok: false,
      error: 'Recording too large to export',
    })
  })

  it('enforces the real 30-minute stereo cap by default', () => {
    /* 30 min × 48 kHz × 2 ch × 4 bytes is a legitimate upper bound. */
    expect(MAX_PCM_BYTES).toBe(48_000 * 4 * 2 * 60 * 30)
    expect(validateExportRequest(stereoPcm(4), 48_000, 2, MAX_PCM_BYTES).ok).toBe(true)
  })

  it('rejects sample rates that are NaN, non-integer, or out of range', () => {
    for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, 44_100.5, 7_999, MAX_SAMPLE_RATE + 1]) {
      expect(validateExportRequest(stereoPcm(), rate, 2)).toEqual({
        ok: false,
        error: 'Invalid sample rate',
      })
    }
  })

  it('rejects sample rates that are not numbers', () => {
    expect(validateExportRequest(stereoPcm(), '48000', 2)).toEqual({
      ok: false,
      error: 'Invalid sample rate',
    })
  })

  it('rejects channel counts outside 1–2 or non-integer', () => {
    for (const channels of [0, 3, 2.5, -1]) {
      expect(validateExportRequest(stereoPcm(), 48_000, channels)).toEqual({
        ok: false,
        error: 'Invalid channel count',
      })
    }
  })

  it('rejects a buffer whose length is not a whole number of frames', () => {
    /* 4 bytes per float sample, 2 channels: 12 bytes is 1.5 frames. */
    expect(validateExportRequest(new ArrayBuffer(12), 48_000, 2)).toEqual({
      ok: false,
      error: 'Audio data is not a whole number of frames',
    })
  })
})

describe('encodeWav', () => {
  it('writes a valid 16-bit stereo RIFF header for interleaved input', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])
    const wav = encodeWav(samples.buffer as ArrayBuffer, 48_000, 2)

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(2) // channels
    expect(wav.readUInt32LE(24)).toBe(48_000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2)
    expect(wav.length).toBe(44 + samples.length * 2)
  })

  it('clamps out-of-range floats to the int16 extremes', () => {
    const samples = new Float32Array([2, -2])
    const wav = encodeWav(samples.buffer as ArrayBuffer, 48_000, 1)

    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
  })

  it('scales full-scale floats to full-scale ints', () => {
    const samples = new Float32Array([1, -1, 0])
    const wav = encodeWav(samples.buffer as ArrayBuffer, 48_000, 1)

    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
    expect(wav.readInt16LE(48)).toBe(0)
  })
})
