/**
 * Chopper behaviour tests. Everything here is synthetic: buffers are silent
 * arrays created in memory and the Web Audio graph is the fake in
 * `helpers/fake-audio.ts`, so the suite runs with plain `node --test` and
 * needs no audio device, music files or network access.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ChopPlayer,
  chopFadeSeconds,
  chopPlaybackRate,
  computeChopRegion
} from '../src/renderer/src/studio/chop.ts'
import type { ChopSettings } from '../src/renderer/src/studio/types.ts'
import { FakeAudioContext, FakeGainNode, makeBuffer } from './helpers/fake-audio.ts'

const BASE: ChopSettings = {
  trackId: 'test',
  source: 'mix',
  bpm: 120,
  offset: 0.25,
  sliceBeats: 2,
  startBeat: 1,
  fitToTempo: true,
  pitch: 0,
  choke: true,
  fade: 0.004,
  reverb: 0
}

function settings(patch: Partial<ChopSettings> = {}): ChopSettings {
  return { ...BASE, ...patch }
}

/** Connect a player to a fake context with a dry and reverb destination. */
function makePlayer(bufferSeconds: number, chopSettings: ChopSettings = settings()) {
  const ctx = new FakeAudioContext()
  const player = new ChopPlayer(chopSettings)
  const dry = new FakeGainNode()
  const reverb = new FakeGainNode()
  player.connect(ctx as unknown as AudioContext, dry as unknown as AudioNode, reverb as unknown as AudioNode)
  player.setBuffer(makeBuffer(bufferSeconds) as unknown as AudioBuffer)
  return { ctx, player, dry, reverb }
}

test('pad regions follow the beat grid inside the loaded buffer', () => {
  const s = settings()
  // 120 BPM → 0.5 s per beat; pad 0 = the beat after the 0.25 s grid offset.
  assert.deepEqual(computeChopRegion(8, s, 0), { start: 0.75, end: 1.75 })
  assert.deepEqual(computeChopRegion(8, s, 3), { start: 3.75, end: 4.75 })
  // The same grid in a longer sample reaches pad 7 (7.75–8.75 s).
  assert.deepEqual(computeChopRegion(9, s, 7), { start: 7.75, end: 8.75 })
})

test('a pad that only partly fits the sample returns null instead of a clipped slice', () => {
  const s = settings()
  // Pad 7 would end at 8.75 s in an 8 s buffer.
  assert.equal(computeChopRegion(8, s, 7), null)
  // Starts at 3.75 s, ends at 4.75 s: only partially inside a 4.5 s buffer.
  assert.equal(computeChopRegion(4.5, s, 3), null)
  // Entirely past the end.
  assert.equal(computeChopRegion(4, s, 15), null)
  // A negative grid offset would otherwise clamp into a shifted slice; it is rejected.
  assert.equal(computeChopRegion(8, settings({ offset: -1, startBeat: 0 }), 0), null)
  // No buffer / nonsense input.
  assert.equal(computeChopRegion(0, s, 0), null)
  assert.equal(computeChopRegion(Number.NaN, s, 0), null)
  assert.equal(computeChopRegion(8, s, -1), null)
})

test('playback rate matches tempo then transposes only when fitting is off', () => {
  const fitted = settings({ bpm: 100, pitch: 3, fitToTempo: true })
  assert.ok(Math.abs(chopPlaybackRate(140, fitted) - (140 / 100) * 2 ** (3 / 12)) < 1e-12)

  const free = settings({ bpm: 100, pitch: -5, fitToTempo: false })
  assert.ok(Math.abs(chopPlaybackRate(140, free) - 2 ** (-5 / 12)) < 1e-12)

  // Degenerate BPM values never produce a zero, negative or NaN rate.
  assert.equal(chopPlaybackRate(140, settings({ bpm: 0, fitToTempo: true })), 1)
  assert.ok(chopPlaybackRate(0, settings({ fitToTempo: true })) > 0)
})

test('fade never exceeds half of the time the chop actually sounds', () => {
  assert.equal(chopFadeSeconds(0.4, 1), 0.4)
  assert.equal(chopFadeSeconds(0.4, 0.2), 0.1)
  assert.equal(chopFadeSeconds(0.004, 0.001), 0.0005)
  for (const requested of [0, 0.001, 0.02, 0.05, 1]) {
    for (const duration of [0.0001, 0.002, 0.03, 0.5, 4]) {
      const fade = chopFadeSeconds(requested, duration)
      assert.ok(fade >= 0 && fade <= duration / 2, `${requested} / ${duration} → ${fade}`)
    }
  }
})

test('triggering a normal pad plays exactly its region at the tempo-correct rate', () => {
  const chop = settings({ bpm: 100, pitch: 2, fitToTempo: true, fade: 0.004 })
  const { ctx, player } = makePlayer(8, chop)
  const expectedRate = (140 / 100) * 2 ** (2 / 12)

  assert.equal(player.trigger(0, 1, 1, 140), true)
  assert.equal(ctx.sources.length, 1)
  const source = ctx.sources[0]
  const region = computeChopRegion(8, chop, 0)!
  assert.ok(Math.abs(source.playbackRate.value - Math.max(0.01, expectedRate)) < 1e-12)
  assert.deepEqual(source.starts, [
    { when: 1, offset: region.start, duration: region.end - region.start }
  ])
  const realDuration = (region.end - region.start) / Math.max(0.01, expectedRate)
  assert.ok(Math.abs(source.stops[0] - (1 + realDuration + 0.01)) < 1e-9)
})

test('an out-of-range pad is silent and does not choke the chop already playing', () => {
  const { ctx, player } = makePlayer(3, settings())
  assert.equal(player.trigger(0, 1, 1), true)
  assert.equal(player.activeCount, 1)
  const playing = ctx.sources[0]
  // Every trigger schedules its own end stop; that is the only one so far.
  const scheduledEnd = playing.stops[0]

  // Pad 15 starts far past the end of a 3 second sample.
  assert.equal(player.region(15), null)
  assert.equal(player.trigger(15, 1, 2), false)
  assert.equal(ctx.sources.length, 1, 'no new buffer source was created')
  assert.equal(player.activeCount, 1, 'the sounding chop is untouched')
  assert.deepEqual(playing.stops, [scheduledEnd], 'the sounding chop was not choked')
})

test('loading a different buffer stops chops from the previous sample', () => {
  const chop = settings({ startBeat: 0, offset: 0 })
  const { ctx, player } = makePlayer(10, chop)
  // Pad 2 = 2–3 s, valid in the 10 s sample.
  assert.equal(player.trigger(2, 1, 1), true)
  const old = ctx.sources[0]
  const scheduledEnd = old.stops[0]
  assert.equal(player.activeCount, 1)

  player.setBuffer(makeBuffer(2) as unknown as AudioBuffer)
  assert.equal(player.activeCount, 0)
  assert.equal(old.stops.length, 2, 'old source was stopped early')
  assert.ok(old.stops[1] < scheduledEnd, 'the new stop comes before the natural end')

  // The pad that was valid in the 10 s sample no longer fits in the 2 s one.
  assert.equal(player.region(2), null)
  assert.equal(player.trigger(2, 1, 2), false)
  assert.equal(ctx.sources.length, 1)
})

test('a fade longer than the slice is clamped to half of its real duration', () => {
  // 0.5 s slice at 4× rate → 0.125 s of audio; ask for a 0.4 s fade.
  const chop = settings({
    bpm: 120,
    sliceBeats: 1,
    offset: 0,
    startBeat: 0,
    fade: 0.4,
    fitToTempo: false,
    pitch: 24
  })
  const { ctx, player } = makePlayer(4, chop)
  assert.equal(player.trigger(0, 1, 1), true)

  const source = ctx.sources[0]
  const rate = source.playbackRate.value
  assert.ok(Math.abs(rate - 4) < 1e-9)
  const realDuration = 0.5 / rate

  // The player creates exactly one gain node per trigger (plus its reverb send).
  const gain = ctx.gains[0]
  const ramps = gain.gain.events.filter(
    (e) => e.type === 'exponentialRampToValueAtTime' && e.value > 0.0002
  )
  assert.equal(ramps.length, 1, 'fade-in reaches full level once')
  assert.ok(Math.abs(ramps[0].time - (1 + realDuration / 2)) < 1e-9, 'fade-in clamped to half the slice')

  const end = gain.gain.events.at(-1)!
  assert.equal(end.type, 'exponentialRampToValueAtTime')
  assert.ok(Math.abs(end.time - (1 + realDuration)) < 1e-9, 'chop ends after its real duration')
})

test('choke fades the previous chop but only when a new one actually plays', () => {
  const { ctx, player } = makePlayer(8, settings({ choke: true }))
  player.trigger(0, 1, 1)
  player.trigger(1, 1, 1.2)
  assert.equal(player.activeCount, 1, 'only the newest chop remains')
  const [first, second] = ctx.sources
  assert.equal(first.stops.length, 2, 'the first chop got an early stop plus its natural end')
  assert.ok(Math.min(...first.stops) <= 1.2 + 0.02, 'the first chop is stopped around the new hit')
  assert.equal(second.stops.length, 1)

  // With choke off, both chops keep sounding.
  const free = makePlayer(8, settings({ choke: false }))
  free.player.trigger(0, 1, 1)
  free.player.trigger(1, 1, 1.2)
  assert.equal(free.player.activeCount, 2)
})

test('stop() stops everything and a later trigger still works', () => {
  const { ctx, player } = makePlayer(8, settings({ choke: false }))
  player.trigger(0, 1, 1)
  player.trigger(1, 1, 1.1)
  player.stop()
  assert.equal(player.activeCount, 0)
  // Each source has its natural stop from trigger() plus the early stop from stop().
  assert.ok(ctx.sources.every((s) => s.stops.length === 2))

  assert.equal(player.trigger(2, 1, 2), true)
  assert.equal(player.activeCount, 1)
})

test('changing the grid stops chops that no longer match it; tone tweaks do not', () => {
  const { ctx, player } = makePlayer(8, settings({ choke: false }))
  player.trigger(0, 1, 1)
  assert.equal(player.activeCount, 1)

  // Pitch/fade/reverb only shape future triggers.
  player.setSettings(settings({ choke: false, pitch: 5, fade: 0.02, reverb: 0.5 }))
  assert.equal(player.activeCount, 1)

  // Moving the grid re-maps the pads, so the ringing chop no longer matches it.
  player.setSettings(settings({ choke: false, sliceBeats: 4 }))
  assert.equal(player.activeCount, 0)
  assert.equal(ctx.sources[0].stops.length, 2)
})
