// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/**
 * Export the last finished take as a WAV through the Electron main process.
 *
 * Decoding happens HERE, not in main: the IPC handler takes raw float32 PCM,
 * and shipping a WebM container across the bridge would put a demuxer in the
 * privileged process.
 *
 * The old shape returned `null` for "no take", "not Electron" and "dialog
 * cancelled" alike, so every caller had to invent the same three-way guess and
 * one of them (`export-audio` from the menu) did not even catch a decode
 * failure. The discriminated result below exists so each outcome gets its own
 * message and no path can throw into an unhandled rejection.
 */

import { getSharedContext } from './context'
import { getLastTake } from './take-store'

export type WavExportOutcome =
  /** Written to disk. */
  | { status: 'saved'; path: string }
  /** Nothing recorded yet this session. */
  | { status: 'no-take' }
  /** Not running under Electron, or the preload bridge is missing exportWav. */
  | { status: 'unavailable' }
  /** The user dismissed the native save dialog. */
  | { status: 'cancelled' }
  /** Decode failed, main rejected the parameters, or the write failed. */
  | { status: 'failed'; message: string }

/** Shape of the preload bridge, kept local so this module has no Electron import. */
interface ExportBridge {
  exportWav?: (
    buffer: ArrayBuffer,
    sampleRate: number,
    channels: number,
  ) => Promise<{ path: string } | { error: string } | null>
}

function getExportBridge(): ExportBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { electronAPI?: ExportBridge }).electronAPI
  return api?.exportWav ? api : null
}

/**
 * Interleave a decoded AudioBuffer into the float32 layout encodeWav expects,
 * capped at stereo — the IPC handler rejects anything wider.
 */
function interleave(decoded: AudioBuffer): {
  data: Float32Array<ArrayBuffer>
  sampleRate: number
  channels: number
} {
  const channels = Math.min(2, decoded.numberOfChannels)
  const frames = decoded.length
  const interleaved = new Float32Array(frames * channels) as Float32Array<ArrayBuffer>
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c)
    for (let i = 0; i < frames; i++) interleaved[i * channels + c] = data[i]
  }
  return { data: interleaved, sampleRate: decoded.sampleRate, channels }
}

/**
 * Export the last take. Never throws and never rejects.
 */
export async function exportLastTakeAsWav(): Promise<WavExportOutcome> {
  const take = getLastTake()
  if (!take) return { status: 'no-take' }

  const bridge = getExportBridge()
  if (!bridge?.exportWav) return { status: 'unavailable' }

  let decoded: AudioBuffer
  try {
    const ctx = getSharedContext()
    decoded = await ctx.decodeAudioData(await take.arrayBuffer())
  } catch (err) {
    return {
      status: 'failed',
      message: `Could not decode the recording: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    }
  }

  const { data, sampleRate, channels } = interleave(decoded)

  let response: { path: string } | { error: string } | null | undefined
  try {
    response = await bridge.exportWav(data.buffer, sampleRate, channels)
  } catch (err) {
    /* An IPC rejection (handler threw, main process gone) is a failure with a
       reason, not a silent null. */
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Export failed',
    }
  }

  /* null (or a bridge that resolved nothing) means the save dialog was
     dismissed — a cancellation, not an error. */
  if (response === null || response === undefined) return { status: 'cancelled' }
  if (typeof response !== 'object') {
    return { status: 'failed', message: 'The main process returned no result' }
  }
  if ('error' in response && typeof response.error === 'string') {
    /* Main-process validation is the authority on what it rejected; surface its
       text verbatim so the user learns which parameter was wrong. */
    return { status: 'failed', message: response.error }
  }
  if ('path' in response && typeof response.path === 'string') {
    return { status: 'saved', path: response.path }
  }
  /* An unexpected shape is still a failure with a reason, never a silent one. */
  return { status: 'failed', message: 'The main process returned an unexpected result' }
}
