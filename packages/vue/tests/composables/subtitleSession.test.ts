import type { Track } from '@vue-player/core'
import { describe, expect, it, vi } from 'vitest'
import { createSubtitleSession } from '../../src/composables/useSubtitleSession'

const en: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
const de: Track = { src: '/de.vtt', label: 'Deutsch', language: 'de' }
const fr: Track = { src: '/fr.vtt', label: 'Français', language: 'fr' }

function setup() {
  const applied: Array<Track | null> = []
  const session = createSubtitleSession((track) => applied.push(track))
  return { session, applied }
}

describe('createSubtitleSession', () => {
  it('enables the default track once a source finishes loading', () => {
    const { session, applied } = setup()

    session.startSession([en, de])
    // Nothing is applied while the new source is still loading.
    expect(session.selectedTrack.value).toBeNull()
    expect(applied.at(-1)).toBeNull()

    session.onLoadComplete([en, de])
    expect(session.selectedTrack.value).toEqual(en)
    expect(applied.at(-1)).toEqual(en)
  })

  it('starts with subtitles off when no default track exists', () => {
    const { session } = setup()
    session.startSession([de, fr])
    session.onLoadComplete([de, fr])
    expect(session.selectedTrack.value).toBeNull()
  })

  it('keeps an explicit user "Off" when the load-complete event fires again', () => {
    const { session, applied } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    expect(session.selectedTrack.value).toEqual(en)

    // User explicitly turns subtitles off.
    session.selectTrack(null)
    expect(session.selectedTrack.value).toBeNull()
    expect(applied.at(-1)).toBeNull()

    // A late/repeated canplay (e.g. after a buffering stall) must not reopen.
    session.onLoadComplete([en, de])
    expect(session.selectedTrack.value).toBeNull()
    expect(applied.at(-1)).toBeNull()
  })

  it('re-enables the default on the next source even after "Off" in the previous one', () => {
    const { session } = setup()
    session.startSession([en])
    session.onLoadComplete([en])
    session.selectTrack(null)
    expect(session.selectedTrack.value).toBeNull()

    // Switching sources starts a new session — the old "Off" is not carried over.
    session.startSession([en])
    session.onLoadComplete([en])
    expect(session.selectedTrack.value).toEqual(en)
  })

  it('falls back to the default track when the old selection is absent from the new source', () => {
    const { session } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    session.selectTrack(de)
    expect(session.selectedTrack.value).toEqual(de)

    // New source only has English/French — the German selection is invalid.
    session.startSession([en, fr])
    expect(session.selectedTrack.value).toBeNull()
    session.onLoadComplete([en, fr])
    expect(session.selectedTrack.value).toEqual(en)
  })

  it('falls back to off when the old selection is invalid and no default exists', () => {
    const { session } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    session.selectTrack(de)

    session.startSession([fr])
    session.onLoadComplete([fr])
    expect(session.selectedTrack.value).toBeNull()
  })

  it('preserves a still-valid explicit selection across a switch once loaded', () => {
    const { session } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    session.selectTrack(de)

    session.startSession([en, de])
    // During loading nothing is active.
    expect(session.selectedTrack.value).toEqual(de)
    session.onLoadComplete([en, de])
    expect(session.selectedTrack.value).toEqual(de)
  })

  it('clears selection immediately when a new source session starts', () => {
    const { session, applied } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    expect(session.selectedTrack.value).toEqual(en)

    session.startSession([en, de])
    // The rendering layer is told to disable tracks right away, so no stale
    // subtitles from the previous source can remain on screen.
    expect(applied.at(-1)).toBeNull()
  })

  it('does not apply tracks when load completes with an empty track list', () => {
    const { session } = setup()
    session.startSession([])
    session.onLoadComplete([])
    expect(session.selectedTrack.value).toBeNull()

    session.startSession(undefined)
    session.onLoadComplete(undefined)
    expect(session.selectedTrack.value).toBeNull()
  })

  it('repairs a selection that disappears from the source on repeated load completion', () => {
    const { session } = setup()
    session.startSession([en, de])
    session.onLoadComplete([en, de])
    session.selectTrack(de)

    // Same session, but the available tracks change (e.g. prop update).
    session.onLoadComplete([fr])
    expect(session.selectedTrack.value).toBeNull()
  })

  it('invokes the apply callback for every change', () => {
    const apply = vi.fn()
    const session = createSubtitleSession(apply)
    session.startSession([en])
    session.onLoadComplete([en])
    session.selectTrack(null)
    session.startSession([en])

    // startSession(off) → default → off → startSession(off)
    expect(apply).toHaveBeenCalledTimes(4)
    expect(apply.mock.calls.map((c) => c[0])).toEqual([null, en, null, null])
  })
})
