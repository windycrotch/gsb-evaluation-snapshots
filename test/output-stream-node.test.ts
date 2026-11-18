import { beforeAll, describe, expect, it } from 'vitest'
import { createFrameBufferContext, type FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import { StopEvent, UnderrunEvent } from '../src/events'
import { ManualBufferWriteStrategy } from '../src/write-strategy/manual-strategy'
import {
  connectPorts,
  driveProcess,
  driveUntilStopped,
  getNodeInternals,
  getNodePort,
  installNodeGlobals,
  loadProcessor,
  writeFrames,
  type FakePort,
  type ProcessorConstructor,
  type ProcessorLike,
} from './fakes'

let OutputStreamNode: typeof import('../src/output-stream-node').OutputStreamNode
let ProcessorClass: ProcessorConstructor

beforeAll(async () => {
  installNodeGlobals()
  ProcessorClass = await loadProcessor()
  ;({ OutputStreamNode } = await import('../src/output-stream-node'))
})

interface Harness {
  node: InstanceType<typeof OutputStreamNode>
  processor: ProcessorLike
  nodePort: FakePort
  writer: FrameBufferWriter
  stopEvents: StopEvent[]
  underrunEvents: UnderrunEvent[]
  eventOrder: string[]
}

const createHarness = async (frameCount = 4096, channelCount = 2): Promise<Harness> => {
  const context = createFrameBufferContext({ frameCount, channelCount })
  const strategy = new ManualBufferWriteStrategy(context)
  const node = await OutputStreamNode.create({} as BaseAudioContext, context, strategy)
  const processor = new ProcessorClass({ processorOptions: context })
  const nodePort = getNodePort(node)
  connectPorts(nodePort, processor.port)
  const stopEvents: StopEvent[] = []
  const underrunEvents: UnderrunEvent[] = []
  const eventOrder: string[] = []
  node.addEventListener(StopEvent.type, (event) => {
    stopEvents.push(event)
    eventOrder.push('stop')
  })
  node.addEventListener(UnderrunEvent.type, (event) => {
    underrunEvents.push(event)
    eventOrder.push('underrun')
  })
  return { node, processor, nodePort, writer: strategy.writer, stopEvents, underrunEvents, eventOrder }
}

describe('OutputStreamNode stop and underrun handling', () => {
  it('stops at the requested frame position and dispatches StopEvent exactly once', async () => {
    const { node, processor, nodePort, writer, stopEvents, underrunEvents } = await createHarness()
    writeFrames(writer, 512)
    expect(node.start()).toBe(true)

    const stopPromise = node.stop(512n)
    expect(driveUntilStopped(processor)).toBe(4)
    await stopPromise

    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(512n)
    // Normal feeding must not produce underrun events.
    expect(underrunEvents).toHaveLength(0)
    // The node is disconnected and the port is closed after the event.
    expect(getNodeInternals(node).disconnectCount).toBe(1)
    expect(nodePort.isClosed).toBe(true)
    expect(node.isStart).toBe(false)
  })

  it('repeated stop calls neither re-dispatch StopEvent nor throw', async () => {
    const { node, processor, nodePort, writer, stopEvents } = await createHarness()
    writeFrames(writer, 256)
    expect(node.start()).toBe(true)

    const firstStop = node.stop(256n)
    // A second stop while stopping must not post another message.
    const secondStop = node.stop(0n)
    expect(driveUntilStopped(processor)).toBe(2)
    await firstStop
    await secondStop

    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(256n)
    expect(nodePort.postedMessages).toHaveLength(1)

    // Stops after the node has stopped are no-ops: no event, no message
    // to the closed port, no exception.
    await node.stop()
    await node.stop(128n)
    expect(stopEvents).toHaveLength(1)
    expect(nodePort.postedMessages).toHaveLength(1)
    expect(getNodeInternals(node).disconnectCount).toBe(1)
  })

  it('reports accumulated underrun frames once on recovery and again before stop', async () => {
    const { node, processor, writer, stopEvents, underrunEvents, eventOrder } = await createHarness()
    expect(node.start()).toBe(true)

    writeFrames(writer, 128)
    expect(driveProcess(processor)).toBe(true) // reads 128 frames, no underrun
    expect(driveProcess(processor)).toBe(true) // underrun: 128 silent frames
    expect(driveProcess(processor)).toBe(true) // underrun: 128 more silent frames
    // Nothing is reported while the underrun is still accumulating.
    expect(underrunEvents).toHaveLength(0)

    writeFrames(writer, 128)
    expect(driveProcess(processor)).toBe(true) // recovery: flush accumulated underrun
    expect(underrunEvents).toHaveLength(1)
    expect(underrunEvents[0].frameCount).toBe(256)

    // Normal feeding after recovery produces no further underrun events.
    writeFrames(writer, 128)
    expect(driveProcess(processor)).toBe(true)
    expect(underrunEvents).toHaveLength(1)

    // Underrun again, then stop: the accumulated frames are reported once,
    // and the UnderrunEvent is dispatched before the StopEvent.
    expect(driveProcess(processor)).toBe(true) // underrun: 128 silent frames
    const stopPromise = node.stop()
    expect(driveProcess(processor)).toBe(false)
    await stopPromise

    expect(underrunEvents).toHaveLength(2)
    expect(underrunEvents[1].frameCount).toBe(128)
    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(384n)
    expect(eventOrder).toEqual(['underrun', 'underrun', 'stop'])
  })
})
