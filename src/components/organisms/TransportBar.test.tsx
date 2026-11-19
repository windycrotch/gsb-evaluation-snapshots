// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media
/* ──────────────────────────────────────────────────────────
   TransportBar recording/export tests — the button is the real
   entry point users hit, so these exercise it rather than the
   module underneath:

     · a click starts, a second click stops and downloads
     · a recorder that refuses to start does not light the button
     · an already-recording refusal leaves the UI in step
     · export distinguishes no-take / failure / cancellation

   The recorder itself is mocked; the single-session guarantee is
   covered against the real AudioRecorder in recorder.test.ts.
   ────────────────────────────────────────────────────────── */

import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { useAppStore } from '../../lib/store'

const recorderMock = vi.hoisted(() => ({
  isRecording: vi.fn(() => false),
  start: vi.fn(),
  stop: vi.fn(),
  stopAndDownload: vi.fn(),
}))

const exportMock = vi.hoisted(() => ({
  exportLastTakeAsWav: vi.fn(),
}))

/* `isElectron` is evaluated once when TransportBar's module graph loads, so the
   bridge has to exist before the imports below run. vi.hoisted is the only
   hook that fires early enough. */
const notifyMock = vi.hoisted(() => {
  const notify = vi.fn()
  Object.defineProperty(window, 'electronAPI', {
    value: { notify },
    configurable: true,
    writable: true,
  })
  return notify
})

vi.mock('../../lib/audio/recorder', () => ({
  getRecorder: () => recorderMock,
  exportLastTakeAsWav: exportMock.exportLastTakeAsWav,
}))

/* The orchestrator is not exercised by these paths, but TransportBar imports
   it at module scope; a stub keeps engine construction out of jsdom. */
vi.mock('../../lib/orchestrator', () => ({
  getOrchestrator: () => ({ stop: vi.fn(), start: vi.fn(), evaluate: vi.fn(), setBpm: vi.fn() }),
}))

/* Keep the page from pulling in the share/gist/settings dialogs. */
vi.mock('../molecules', async () => {
  const actual = await vi.importActual<typeof import('../molecules')>('../molecules')
  return { ...actual, ShareDialog: () => null }
})

vi.mock('./GistDialog', () => ({ GistDialog: () => null }))
vi.mock('./SettingsPanel', () => ({ SettingsPanel: () => null }))

import TransportBar from './TransportBar'

function renderBar() {
  return render(
    <MemoryRouter>
      <TransportBar />
    </MemoryRouter>
  )
}

/**
 * The record button: the one labelled by the translated Record/Stop-recording
 * string, or falling back to the non-export icon buttons in transport order.
 */
function recordButton(): HTMLElement {
  const byLabel = Array.from(document.querySelectorAll('button')).find((b) => {
    const label = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return label === 'record' || label === 'stop recording'
  })
  if (byLabel) return byLabel as HTMLElement
  /* i18n may not resolve locale keys under test; the record button is the
     third transport control. */
  const buttons = Array.from(document.querySelectorAll('button'))
  const fallback = buttons[2]
  if (!fallback) throw new Error('record button not found')
  return fallback as HTMLElement
}

/** Export Audio renders only in the desktop build, with a download icon. */
function exportButton(): HTMLElement | null {
  const button = Array.from(document.querySelectorAll('button')).find((b) =>
    b.querySelector('svg.lucide-download')
  )
  return (button as HTMLElement | undefined) ?? null
}

beforeEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState())
  /* jsdom has no matchMedia; the media-query hook calls it during render. */
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )

  recorderMock.isRecording.mockReset()
  recorderMock.start.mockReset()
  recorderMock.stop.mockReset()
  recorderMock.stopAndDownload.mockReset()
  exportMock.exportLastTakeAsWav.mockReset()
  notifyMock.mockReset()

  recorderMock.isRecording.mockReturnValue(false)
  recorderMock.start.mockReturnValue({ ok: true })
  recorderMock.stop.mockResolvedValue({ ok: true, blob: new Blob(['x']) })
  recorderMock.stopAndDownload.mockResolvedValue({ ok: true, blob: new Blob(['x']) })
})

afterEach(() => {
  cleanup()
})

describe('TransportBar record button', () => {
  it('starts recording and lights the button from the recorder state', async () => {
    recorderMock.start.mockImplementation(() => {
      recorderMock.isRecording.mockReturnValue(true)
      return { ok: true }
    })

    renderBar()
    fireEvent.click(recordButton())

    await waitFor(() => {
      expect(recorderMock.start).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().isRecording).toBe(true)
    })
  })

  it('stops and downloads when clicked while recording', async () => {
    recorderMock.isRecording.mockReturnValue(true)
    /* stopAndDownload ends the take, so the recorder stops reporting itself as
       recording — that is what the button must follow. */
    recorderMock.stopAndDownload.mockImplementation(async () => {
      recorderMock.isRecording.mockReturnValue(false)
      return { ok: true, blob: new Blob(['x']) }
    })

    renderBar()
    fireEvent.click(recordButton())

    await waitFor(() => {
      expect(recorderMock.stopAndDownload).toHaveBeenCalledWith('live-music-coder')
    })
    expect(recorderMock.start).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(useAppStore.getState().isRecording).toBe(false)
    })
  })

  it('stays unlit when the recorder refuses to start', async () => {
    /* start() answering already-recording means this click created nothing, so
       the store must not claim a recording is live. */
    recorderMock.isRecording.mockReturnValue(false)
    recorderMock.start.mockReturnValue({ ok: false, reason: 'already-recording' })

    renderBar()
    fireEvent.click(recordButton())

    await waitFor(() => {
      expect(recorderMock.start).toHaveBeenCalledTimes(1)
    })
    expect(useAppStore.getState().isRecording).toBe(false)
    expect(recorderMock.stopAndDownload).not.toHaveBeenCalled()
  })

  it('reports an unavailable recorder instead of pretending to record', async () => {
    recorderMock.start.mockReturnValue({
      ok: false,
      reason: 'unsupported',
      message: 'MediaRecorder is not available',
    })

    renderBar()
    fireEvent.click(recordButton())

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        'Recording unavailable',
        'MediaRecorder is not available'
      )
    })
    expect(useAppStore.getState().isRecording).toBe(false)
  })
})

describe('TransportBar export button', () => {
  it('renders only in the desktop build', () => {
    renderBar()
    expect(exportButton()).not.toBeNull()
  })

  it('says there is nothing to export rather than silently doing nothing', async () => {
    exportMock.exportLastTakeAsWav.mockResolvedValue({ status: 'no-take' })

    renderBar()
    fireEvent.click(exportButton()!)

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith('Nothing to export', expect.any(String))
    })
  })

  it('shows the main process rejection text when export fails', async () => {
    exportMock.exportLastTakeAsWav.mockResolvedValue({
      status: 'failed',
      message: 'Invalid sample rate',
    })

    renderBar()
    fireEvent.click(exportButton()!)

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith('Export failed', 'Invalid sample rate')
    })
  })

  it('stays silent when the save dialog is cancelled', async () => {
    exportMock.exportLastTakeAsWav.mockResolvedValue({ status: 'cancelled' })

    renderBar()
    fireEvent.click(exportButton()!)

    await waitFor(() => {
      expect(exportMock.exportLastTakeAsWav).toHaveBeenCalled()
    })
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('stays silent on a successful save', async () => {
    exportMock.exportLastTakeAsWav.mockResolvedValue({
      status: 'saved',
      path: '/tmp/take.wav',
    })

    renderBar()
    fireEvent.click(exportButton()!)

    await waitFor(() => {
      expect(exportMock.exportLastTakeAsWav).toHaveBeenCalled()
    })
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

