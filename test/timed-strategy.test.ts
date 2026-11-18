import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import { StopEvent, UnderrunEvent } from '../src/events'
import { createFillerFrameBufferContext } from '../src/filler-frame-buffer-context'
import type { FrameBufferFiller } from '../src/frame-buffer-filler'
import {
  FakeTimerHost,
  connectPorts,
  driveUntilStopped,
  getNodeInternals,
  getNodePort,
  installNodeGlobals,
  loadProcessor,
  writeFrames,
  type ProcessorConstructor,
} from './fakes'

let OutputStreamNode: typeof import('../src/output-stream-node').OutputStreamNode
let TimedBufferWriteStrategy: typeof import('../src/write-strategy/timed-strategy').TimedBufferWriteStrategy
let ProcessorClass: ProcessorConstructor
let timers: FakeTimerHost

beforeAll(async () => {
  installNodeGlobals()
  timers = new FakeTimerHost()
  const g = globalThis as unknown as Record<string, unknown>
  g.window = {
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  }
  ProcessorClass = await loadProcessor()
  ;({ OutputStreamNode } = await import('../src/output-stream-node'))
  ;({ TimedBufferWriteStrategy } = await import('../src/write-strategy/timed-strategy'))
})

interface TimedResult {
  node: InstanceType<typeof OutputStreamNode>
  stopEvents: StopEvent[]
  underrunEvents: UnderrunEvent[]
}

/**
 * Starts a timed-strategy node with the given filler, fires the fill timer
 * once and drives the processor until it stops.
 */
const runTimedNode = async (filler: FrameBufferFiller): Promise<TimedResult> => {
  const context = createFillerFrameBufferContext({ channelCount: 2, sampleRate: 48000, fillInterval: 20 })
  const strategy = new TimedBufferWriteStrategy(context, filler)
  const node = await OutputStreamNode.create({} as BaseAudioContext, context, strategy)
  const processor = new ProcessorClass({ processorOptions: context })
  connectPorts(getNodePort(node), processor.port)
  const stopEvents: StopEvent[] = []
  const underrunEvents: UnderrunEvent[] = []
  node.addEventListener(StopEvent.type, event => stopEvents.push(event))
  node.addEventListener(UnderrunEvent.type, event => underrunEvents.push(event))
  expect(node.start()).toBe(true)
  expect(timers.activeCount).toBe(1)
  // Fire the timer once: the fill result/exception stops the timer and
  // requests the node stop, then drive the processor to completion.
  timers.tick()
  driveUntilStopped(processor)
  return { node, stopEvents, underrunEvents }
}

describe('TimedBufferWriteStrategy filler failure handling', () => {
  it('stops the timer and stops the node at the written frames when fill throws', async () => {
    let callCount = 0
    const filler: FrameBufferFiller = {
      fill: vi.fn((writer: FrameBufferWriter): boolean => {
        ++callCount
        if (callCount === 1) {
          writeFrames(writer, 256)
          return true
        }
        throw new Error('filler failure')
      }),
    }

    const { node, stopEvents, underrunEvents } = await runTimedNode(filler)

    // The timer was cleared: nothing is left to fire again.
    expect(timers.activeCount).toBe(0)
    // fill ran for the initial fill and the first tick only.
    expect(filler.fill).toHaveBeenCalledTimes(2)
    // The node stopped at the frames written so far.
    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(256n)
    expect(underrunEvents).toHaveLength(0)
    expect(getNodeInternals(node).disconnectCount).toBe(1)
    expect(getNodePort(node).isClosed).toBe(true)

    // A further tick cannot invoke the filler again.
    timers.tick()
    expect(filler.fill).toHaveBeenCalledTimes(2)
  })

  it('stops the timer and stops the node at the written frames when fill returns false', async () => {
    let callCount = 0
    const filler: FrameBufferFiller = {
      fill: vi.fn((writer: FrameBufferWriter): boolean => {
        ++callCount
        if (callCount === 1) {
          writeFrames(writer, 384)
          return true
        }
        return false
      }),
    }

    const { node, stopEvents, underrunEvents } = await runTimedNode(filler)

    expect(timers.activeCount).toBe(0)
    expect(filler.fill).toHaveBeenCalledTimes(2)
    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(384n)
    expect(underrunEvents).toHaveLength(0)
    expect(getNodeInternals(node).disconnectCount).toBe(1)
    expect(getNodePort(node).isClosed).toBe(true)

    timers.tick()
    expect(filler.fill).toHaveBeenCalledTimes(2)
  })
})
