/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createImpactTimeline } from './impactTimeline'

// Deterministic "random" sequence for seed assertions
const sequencer = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]
}

describe('advance', () => {
  test('progresses by delta / duration and returns the time for panel write-back', () => {
    const tl = createImpactTimeline({ duration: 0.5 })
    expect(tl.advance(0.1)).toBeCloseTo(0.2)
    expect(tl.advance(0.1)).toBeCloseTo(0.4)
    expect(tl.state.time).toBeCloseTo(0.4)
  })

  test('returns null and does not advance while paused', () => {
    const tl = createImpactTimeline({ duration: 0.5, playing: false })
    expect(tl.advance(0.1)).toBeNull()
    expect(tl.state.time).toBe(0)
  })

  test('wraps to 0 with a fresh seed when passing the end', () => {
    const tl = createImpactTimeline({ duration: 0.5, seed: 7 }, sequencer(0.42))
    expect(tl.advance(0.6)).toBe(0) // 0.6 / 0.5 = 1.2 > 1 -> reset
    expect(tl.state.time).toBe(0)
    expect(tl.state.seed).toBe(420)
  })
})

describe('scrub', () => {
  test('keeps the user value and pauses auto-advance', () => {
    const tl = createImpactTimeline({ duration: 0.5 })
    tl.scrub(0.7)
    expect(tl.state.time).toBe(0.7)
    expect(tl.state.playing).toBe(false)
    expect(tl.advance(0.1)).toBeNull()
    expect(tl.state.time).toBe(0.7) // not overwritten by the next frame
  })
})

describe('setPlaying', () => {
  test('resuming continues from the current value', () => {
    const tl = createImpactTimeline({ duration: 1 })
    tl.scrub(0.6)
    expect(tl.setPlaying(true)).toBe(false)
    expect(tl.advance(0.1)).toBeCloseTo(0.7)
  })

  test('resuming from the end restarts at 0 with a fresh seed', () => {
    const tl = createImpactTimeline({ duration: 1, seed: 3 }, sequencer(0.99))
    tl.scrub(1)
    expect(tl.setPlaying(true)).toBe(true)
    expect(tl.state.time).toBe(0)
    expect(tl.state.seed).toBe(990)
    expect(tl.advance(0.2)).toBeCloseTo(0.2)
  })
})

describe('applyPreset', () => {
  test('atomically resets time, adopts the new duration, reseeds and resumes', () => {
    const tl = createImpactTimeline({ duration: 0.5, seed: 1 }, sequencer(0.5))
    tl.scrub(0.9) // paused mid-timeline
    tl.applyPreset({ duration: 2 })
    expect(tl.state).toEqual({ time: 0, duration: 2, seed: 500, playing: true })
  })

  test('the very next frame advances with the new duration, never the old one', () => {
    const tl = createImpactTimeline({ duration: 0.5 }, sequencer(0.5))
    tl.applyPreset({ duration: 2 })
    // If the old duration (0.5) leaked into this frame, time would be 0.2;
    // with the new duration it must be 0.05.
    expect(tl.advance(0.1)).toBeCloseTo(0.05)
  })
})

describe('setDuration', () => {
  test('panel duration edits take effect on the next frame', () => {
    const tl = createImpactTimeline({ duration: 1 })
    tl.setDuration(0.25)
    expect(tl.advance(0.1)).toBeCloseTo(0.4)
  })
})
