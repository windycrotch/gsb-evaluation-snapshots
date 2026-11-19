// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { encodeWav } from '../wav-encoder'
import { validateExportRequest } from '../audio-export'

/**
 * Register audio export IPC handlers.
 * Encodes float32 PCM data to WAV and saves to disk.
 *
 * Everything crossing this boundary is renderer-supplied and therefore
 * attacker-supplied: this app evaluates shared patterns through Function() by
 * design. Validate before allocating, not after — encodeWav does
 * `Buffer.alloc(44 + n * 2)` in the MAIN process, so an oversized buffer stalls
 * the whole app, and a NaN or negative sampleRate throws ERR_OUT_OF_RANGE
 * inside writeUInt32LE.
 *
 * Every rejection carries its own message. The renderer shows that text as-is,
 * so it is the difference between "Export failed" and "Export failed: Invalid
 * sample rate".
 */
export function registerAudioHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    'audio:export-wav',
    async (
      _event,
      buffer: unknown,
      sampleRate: unknown,
      channels: unknown
    ) => {
      const validation = validateExportRequest(buffer, sampleRate, channels)
      if (!validation.ok) return { error: validation.error }

      const { buffer: pcm, sampleRate: rate, channels: channelCount } = validation.value

      /* The dialog is also the rate limit: it is modal on the parent window, so
         a loop calling exportWav() cannot queue an unbounded stack of sheets. */
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Audio',
        defaultPath: 'recording.wav',
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
      })

      if (result.canceled || !result.filePath) return null

      try {
        const wavBuffer = encodeWav(pcm, rate, channelCount)
        await writeFile(result.filePath, wavBuffer)
        return { path: result.filePath }
      } catch (err) {
        /* Name the actual failure (disk full, permissions, unwritable path)
           instead of collapsing every cause into one sentence. */
        const detail = err instanceof Error ? err.message : 'unknown error'
        return { error: `Failed to write the WAV file: ${detail}` }
      }
    }
  )
}
