/**
 * Chopper playback.
 *
 * Maps pad numbers onto regions of the currently loaded sample and plays them.
 * This is deliberately separate from the rest of the studio graph: it only
 * needs an AudioContext plus a dry and a reverb destination, which makes it
 * straightforward to exercise with synthetic buffers and a minimal fake Web
 * Audio context in tests.
 */
import type { ChopSettings } from './types'

const EPSILON = 0.0001
/** Regions shorter than this are treated as empty. */
const MIN_REGION_SECONDS = 1e-6
const MIN_FADE_SECONDS = 0.001
const MIN_PLAYBACK_RATE = 0.01
/** Existing chops fade out this fast when the buffer is replaced. */
const BUFFER_SWITCH_FADE = 0.02
/** A new chop cuts off the previous one this fast when choke is on. */
const CHOKE_FADE = 0.005

export interface ChopRegion {
  /** Seconds into the sample. */
  start: number
  /** Seconds into the sample; always > start and <= buffer duration. */
  end: number
}

interface ActiveChop {
  source: AudioBufferSourceNode
  gain: GainNode
  nodes: AudioNode[]
  stopped: boolean
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function holdAt(param: AudioParam, when: number): void {
  try {
    param.cancelAndHoldAtTime(when)
  } catch {
    param.cancelScheduledValues(when)
    param.setValueAtTime(Math.max(EPSILON, param.value), when)
  }
}

/**
 * Region of `pad` in sample seconds, or null when the pad does not fit inside
 * `bufferDuration`. Pads that start before the sample, run past its end, or
 * would produce an empty region return null — never a clamped partial slice,
 * so the sounding range always matches the range the UI draws.
 */
export function computeChopRegion(
  bufferDuration: number,
  settings: ChopSettings,
  pad: number
): ChopRegion | null {
  if (!Number.isFinite(bufferDuration) || bufferDuration <= 0) return null
  if (!Number.isFinite(pad) || pad < 0) return null

  const bpm = settings.bpm
  const sliceBeats = settings.sliceBeats
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(sliceBeats) || sliceBeats <= 0) return null

  const beatSeconds = 60 / bpm
  const offset = Number.isFinite(settings.offset) ? settings.offset : 0
  const startBeat = Number.isFinite(settings.startBeat) ? settings.startBeat : 0
  const index = Math.floor(pad)
  const rawStart = offset + (startBeat + index * sliceBeats) * beatSeconds
  const rawEnd = rawStart + sliceBeats * beatSeconds
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null

  // Out of bounds on either side means the pad is silent and disabled.
  if (rawStart < -MIN_REGION_SECONDS) return null
  if (rawEnd > bufferDuration + MIN_REGION_SECONDS) return null

  const start = Math.min(Math.max(rawStart, 0), bufferDuration)
  const end = Math.min(Math.max(rawEnd, 0), bufferDuration)
  if (end - start <= MIN_REGION_SECONDS) return null
  return { start, end }
}

/**
 * Playback rate for chops. Fit-to-tempo matches the sample's tempo to the
 * project tempo; both modes then transpose by `settings.pitch` semitones.
 */
export function chopPlaybackRate(projectBpm: number, settings: ChopSettings): number {
  const pitch = Number.isFinite(settings.pitch) ? settings.pitch : 0
  const transpose = 2 ** (pitch / 12)
  let rate = transpose
  if (settings.fitToTempo) {
    const project = Number.isFinite(projectBpm) && projectBpm > 0 ? projectBpm : 120
    const sample = Number.isFinite(settings.bpm) && settings.bpm > 0 ? settings.bpm : project
    rate = (project / sample) * transpose
  }
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.max(MIN_PLAYBACK_RATE, rate)
}

/**
 * Fade applied at each edge of a chop, in seconds. Never exceeds half the
 * time the chop actually sounds (which depends on the playback rate), so a
 * long fade cannot swallow a short slice.
 */
export function chopFadeSeconds(requested: number, realDuration: number): number {
  if (!Number.isFinite(realDuration) || realDuration <= 0) return 0
  const wanted = Number.isFinite(requested)
    ? Math.max(MIN_FADE_SECONDS, requested)
    : MIN_FADE_SECONDS
  return Math.min(wanted, realDuration / 2)
}

export class ChopPlayer {
  private ctx: AudioContext | null = null
  private dry: AudioNode | null = null
  private reverb: AudioNode | null = null
  private buffer: AudioBuffer | null = null
  private settings: ChopSettings
  private readonly active = new Set<ActiveChop>()

  constructor(settings: ChopSettings) {
    this.settings = { ...settings }
  }

  connect(ctx: AudioContext, dry: AudioNode, reverb: AudioNode): void {
    this.ctx = ctx
    this.dry = dry
    this.reverb = reverb
  }

  /** Load a new sample; anything still sounding from the old one is stopped first. */
  setBuffer(buffer: AudioBuffer | null): void {
    if (this.buffer === buffer) return
    this.stop()
    this.buffer = buffer
  }

  setSettings(settings: ChopSettings): void {
    // A grid change re-maps every pad, so anything still ringing belongs to a
    // region that no longer exists on screen — stop it. Pitch/fade/reverb
    // changes only affect future triggers and leave the current chop alone.
    const gridChanged =
      settings.bpm !== this.settings.bpm ||
      settings.offset !== this.settings.offset ||
      settings.sliceBeats !== this.settings.sliceBeats ||
      settings.startBeat !== this.settings.startBeat
    if (gridChanged) this.stop()
    this.settings = { ...settings }
  }

  /** Number of chops still scheduled/sounding (useful for diagnostics and tests). */
  get activeCount(): number {
    return this.active.size
  }

  region(pad: number): ChopRegion | null {
    return computeChopRegion(this.buffer?.duration ?? Number.NaN, this.settings, pad)
  }

  /**
   * Play `pad` at `when` (AudioContext time). Returns false — and does not
   * touch sounding chops — when the pad has no valid region in the loaded
   * buffer or the audio graph is not ready yet.
   */
  trigger(pad: number, velocity = 1, when?: number, projectBpm = 120): boolean {
    const region = this.region(pad)
    if (!region) return false

    const ctx = this.ctx
    const buffer = this.buffer
    const dry = this.dry
    const reverb = this.reverb
    if (!ctx || !buffer || !dry || !reverb) return false

    const time = Math.max(when ?? ctx.currentTime, ctx.currentTime)
    // Only a trigger that will actually sound may choke what is already playing.
    if (this.settings.choke) this.choke(time, CHOKE_FADE)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const playbackRate = chopPlaybackRate(projectBpm, this.settings)
    source.playbackRate.value = playbackRate

    const gain = ctx.createGain()
    const send = ctx.createGain()
    send.gain.value = clamp01(this.settings.reverb)
    source.connect(gain)
    gain.connect(dry)
    gain.connect(send)
    send.connect(reverb)

    const sourceDuration = region.end - region.start
    const realDuration = sourceDuration / playbackRate
    const fade = chopFadeSeconds(this.settings.fade, realDuration)
    const level = Math.max(EPSILON, clamp01(velocity))
    gain.gain.setValueAtTime(EPSILON, time)
    gain.gain.exponentialRampToValueAtTime(level, time + fade)
    gain.gain.setValueAtTime(level, Math.max(time + fade, time + realDuration - fade))
    gain.gain.exponentialRampToValueAtTime(EPSILON, time + realDuration)

    const active: ActiveChop = { source, gain, nodes: [source, gain, send], stopped: false }
    this.active.add(active)
    source.onended = () => {
      this.active.delete(active)
      for (const node of active.nodes) node.disconnect()
    }
    source.start(time, region.start, sourceDuration)
    source.stop(time + realDuration + 0.01)
    return true
  }

  /** Fade out and stop every chopped sound. */
  stop(): void {
    const ctx = this.ctx
    if (!ctx) {
      this.active.clear()
      return
    }
    this.choke(ctx.currentTime, BUFFER_SWITCH_FADE)
  }

  private choke(when: number, fade: number): void {
    for (const chop of this.active) {
      if (chop.stopped) continue
      chop.stopped = true
      holdAt(chop.gain.gain, when)
      chop.gain.gain.exponentialRampToValueAtTime(EPSILON, when + fade)
      try {
        chop.source.stop(when + fade + 0.005)
      } catch {
        // Already ended.
      }
    }
    this.active.clear()
  }
}
