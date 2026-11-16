/**
 * Integration-level chopper checks through the public StudioEngine API, using
 * the same fake Web Audio context as the unit tests. No real audio files are
 * decoded: buffers are built in memory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StudioEngine } from '../src/renderer/src/studio/engine.ts'
import type { ChopSettings } from '../src/renderer/src/studio/types.ts'
import { FakeAudioContext, FakeGainNode, makeBuffer } from './helpers/fake-audio.ts'

const CHOP: ChopSettings = {
  trackId: 'demo',
  source: 'mix',
  bpm: 120,
  offset: 0,
  sliceBeats: 1,
  startBeat: 0,
  fitToTempo: true,
  pitch: 0,
  choke: true,
  fade: 0.004,
  reverb: 0
}

function setup(bufferSeconds: number, patch: Partial<ChopSettings> = {}) {
  const ctx = new FakeAudioContext()
  const engine = new StudioEngine()
  const destination = new FakeGainNode()
  engine.init(ctx as unknown as AudioContext, destination as unknown as AudioNode)
  const chopper = (engine as unknown as {
    chopper: { activeCount: number }
  }).chopper
  engine.setChopSettings({ ...CHOP, ...patch })
  engine.setChopBuffer(makeBuffer(bufferSeconds) as unknown as AudioBuffer)
  return { ctx, engine, chopper }
}

test('StudioEngine.chopRegion reports the same ranges it will play', () => {
  const { engine } = setup(4)
  assert.deepEqual(engine.chopRegion(0), { start: 0, end: 0.5 })
  assert.deepEqual(engine.chopRegion(7), { start: 3.5, end: 4 })
  // Pad 8 starts exactly at the 4 s end: no audio to play.
  assert.equal(engine.chopRegion(8), null)
  assert.equal(engine.chopRegion(15), null)

  // Changing slice length moves the grid: 4-beat chops are 2 s each at 120 BPM.
  engine.setChopSettings({ ...CHOP, sliceBeats: 4 })
  assert.deepEqual(engine.chopRegion(0), { start: 0, end: 2 })
  assert.deepEqual(engine.chopRegion(1), { start: 2, end: 4 })
  assert.equal(engine.chopRegion(2), null, 'starts exactly at the sample end')
})

test('StudioEngine.triggerChop is silent for pads outside the buffer', () => {
  const { ctx, engine, chopper } = setup(4)
  engine.triggerChop(0, 1, 0.5)
  assert.equal(chopper.activeCount, 1)
  const sourcesBefore = ctx.sources.length
  const playing = ctx.sources.at(-1)!
  const naturalEnd = playing.stops[0]

  engine.triggerChop(12, 1, 1)
  assert.equal(ctx.sources.length, sourcesBefore, 'no new source for an invalid pad')
  assert.equal(chopper.activeCount, 1, 'the sounding chop keeps playing')
  assert.deepEqual(playing.stops, [naturalEnd], 'invalid pad does not choke')
})

test('StudioEngine swapping buffers stops the old sample before playing the new one', () => {
  const { ctx, engine, chopper } = setup(4)
  engine.triggerChop(0, 1, 0.5)
  const oldSource = ctx.sources.at(-1)!
  const naturalEnd = oldSource.stops[0]

  engine.setChopBuffer(makeBuffer(1) as unknown as AudioBuffer)
  assert.equal(chopper.activeCount, 0)
  assert.ok(Math.min(...oldSource.stops) < naturalEnd, 'old sample is stopped early')

  engine.triggerChop(0, 1, 1)
  const newSource = ctx.sources.at(-1)!
  assert.notEqual(newSource, oldSource)
  assert.equal(newSource.buffer?.duration, 1, 'plays the newly loaded sample')
  // Pad 2 now lies past the new buffer's end.
  assert.equal(engine.chopRegion(2), null)
})

test('StudioEngine without a sample never plays or chokes', () => {
  const ctx = new FakeAudioContext()
  const engine = new StudioEngine()
  engine.init(ctx as unknown as AudioContext, new FakeGainNode() as unknown as AudioNode)
  engine.setChopSettings(CHOP)
  assert.equal(engine.chopRegion(0), null)
  engine.triggerChop(0)
  assert.equal(ctx.sources.length, 0)
})
