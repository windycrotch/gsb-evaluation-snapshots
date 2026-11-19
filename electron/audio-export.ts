// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/**
 * Validation for the `audio:export-wav` IPC payload.
 *
 * Everything here is supplied by the renderer and therefore by evaluated
 * pattern code, which this app runs through Function() by design. Each check
 * returns a specific, user-presentable message: the renderer shows whatever
 * text comes back, so "Invalid sample rate" is a diagnosis the user can act on
 * while a bare `false` would only be a shrug.
 *
 * Kept free of Electron imports so it can be unit-tested in a node environment.
 */

/** 30 minutes of stereo float32 at 48 kHz — far beyond any plausible take. */
export const MAX_PCM_BYTES = 48_000 * 4 * 2 * 60 * 30

/** Range accepted by the WAV header's 32-bit sample-rate field, in practice. */
export const MIN_SAMPLE_RATE = 8_000
export const MAX_SAMPLE_RATE = 384_000

export type ExportRejection =
  | 'Invalid audio buffer'
  | 'Recording too large to export'
  | 'Audio data is not a whole number of frames'
  | 'Invalid sample rate'
  | 'Invalid channel count'

export interface ValidatedExport {
  buffer: ArrayBuffer
  sampleRate: number
  channels: number
}

export type ValidationResult =
  | { ok: true; value: ValidatedExport }
  | { ok: false; error: ExportRejection }

/**
 * Validate a renderer-supplied export request.
 *
 * Order matters: the size cap is checked before the frame-alignment division so
 * an absurd byteLength never reaches arithmetic, and callers allocate from the
 * validated buffer rather than the raw one.
 *
 * `maxBytes` exists so the cap can be exercised without allocating hundreds of
 * megabytes in a test; production always uses the default.
 */
export function validateExportRequest(
  buffer: unknown,
  sampleRate: unknown,
  channels: unknown,
  maxBytes: number = MAX_PCM_BYTES
): ValidationResult {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return { ok: false, error: 'Invalid audio buffer' }
  }
  if (buffer.byteLength > maxBytes) {
    return { ok: false, error: 'Recording too large to export' }
  }
  if (
    typeof sampleRate !== 'number' ||
    !Number.isFinite(sampleRate) ||
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    return { ok: false, error: 'Invalid sample rate' }
  }
  if (typeof channels !== 'number' || !Number.isInteger(channels) || channels < 1 || channels > 2) {
    return { ok: false, error: 'Invalid channel count' }
  }

  /* float32 samples, interleaved: the byte length must describe whole frames.
     A truncated tail would shift every later sample by a channel. */
  const bytesPerFrame = 4 * channels
  if (buffer.byteLength % bytesPerFrame !== 0) {
    return { ok: false, error: 'Audio data is not a whole number of frames' }
  }

  return { ok: true, value: { buffer, sampleRate, channels } }
}
