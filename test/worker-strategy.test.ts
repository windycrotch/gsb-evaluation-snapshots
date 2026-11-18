import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import { StopEvent } from '../src/events'
import { createFillerFrameBufferContext, type FillerFrameBufferContext } from '../src/filler-frame-buffer-context'
import type { FrameBufferFiller } from '../src/frame-buffer-filler'
import { BufferFillWorker } from '../src/write-strategy/worker/worker'
import type { MessageToStrategy, MessageToWorker } from '../src/write-strategy/worker/message'
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
let WorkerBufferWriteStrategy: typeof import('../src/write-strategy/worker-strategy').WorkerBufferWriteStrategy
let ProcessorClass: ProcessorConstructor

beforeAll(async () => {
  installNodeGlobals()
  ProcessorClass = await loadProcessor()
  ;({ OutputStreamNode } = await import('../src/output-stream-node'))
  ;({ WorkerBufferWriteStrategy } = await import('../src/write-strategy/worker-strategy'))
})

// ---------------------------------------------------------------------------
// Worker-side tests: drive the real BufferFillWorker/Context logic with a
// fake `self` (fake timers + captured postMessage).
// ---------------------------------------------------------------------------

type FillerAction = 'fill' | 'false' | 'throw'

interface FillerParams {
  actions: FillerAction[]
  framesPerFill: number
}

class TestFiller implements FrameBufferFiller {
  public static fillCallCount = 0
  private readonly _actions: FillerAction[]
  private readonly _framesPerFill: number

  public constructor(params: FillerParams) {
    this._actions = [...params.actions]
    this._framesPerFill = params.framesPerFill
  }

  public fill(writer: FrameBufferWriter): boolean {
    ++TestFiller.fillCallCount
    const action = this._actions.shift() ?? 'fill'
    if (action === 'throw') {
      throw new Error('filler failure')
    }
    if (action === 'false') {
      return false
    }
    writeFrames(writer, this._framesPerFill)
    return true
  }
}

interface WorkerHarness {
  timers: FakeTimerHost
  posted: MessageToStrategy[]
  send: (message: MessageToWorker<FillerParams>) => void
}

const createWorkerHarness = (): WorkerHarness => {
  const timers = new FakeTimerHost()
  const posted: MessageToStrategy[] = []
  const fakeSelf: {
    onmessage: ((event: { data: MessageToWorker<FillerParams> }) => void) | null
    setInterval: (callback: () => void, intervalMs: number) => number
    clearInterval: (id: number) => void
    postMessage: (message: MessageToStrategy) => void
  } = {
    onmessage: null,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    postMessage: (message) => {
      posted.push(message)
    },
  }
  const g = globalThis as unknown as Record<string, unknown>
  g.self = fakeSelf
  return {
    timers,
    posted,
    send: (message) => {
      if (!fakeSelf.onmessage) {
        throw new Error('Worker onmessage handler is not installed.')
      }
      fakeSelf.onmessage({ data: message })
    },
  }
}

const initWorker = async (harness: WorkerHarness, context: FillerFrameBufferContext, params: FillerParams): Promise<void> => {
  harness.send({ type: 'init', config: context, fillerParams: params })
  await vi.waitFor(() => {
    expect(harness.posted).toContainEqual({ type: 'init-done' })
  })
}

const stopMessagesOf = (posted: MessageToStrategy[]): Array<{ type: 'stop', stopFrames: bigint }> => {
  return posted.filter((message): message is { type: 'stop', stopFrames: bigint } => message.type === 'stop')
}

describe('BufferFillWorker filler failure handling', () => {
  it('stops its timer and posts a single stop message when fill returns false', async () => {
    const harness = createWorkerHarness()
    TestFiller.fillCallCount = 0
    const worker = new BufferFillWorker<FillerParams>(TestFiller)
    expect(worker).toBeDefined()
    const context = createFillerFrameBufferContext({ channelCount: 2, sampleRate: 48000, fillInterval: 20 })
    await initWorker(harness, context, { actions: ['fill', 'false'], framesPerFill: 128 })

    harness.send({ type: 'start' })
    expect(harness.timers.activeCount).toBe(1)

    harness.timers.tick() // second fill returns false
    expect(harness.timers.activeCount).toBe(0)
    expect(stopMessagesOf(harness.posted)).toEqual([{ type: 'stop', stopFrames: 128n }])

    // No timer is left running and no further stop message is posted.
    harness.timers.tick()
    expect(stopMessagesOf(harness.posted)).toHaveLength(1)
    expect(TestFiller.fillCallCount).toBe(2)
  })

  it('stops its timer and posts a single stop message when fill throws', async () => {
    const harness = createWorkerHarness()
    TestFiller.fillCallCount = 0
    const worker = new BufferFillWorker<FillerParams>(TestFiller)
    expect(worker).toBeDefined()
    const context = createFillerFrameBufferContext({ channelCount: 2, sampleRate: 48000, fillInterval: 20 })
    await initWorker(harness, context, { actions: ['fill', 'throw'], framesPerFill: 128 })

    harness.send({ type: 'start' })
    expect(harness.timers.activeCount).toBe(1)

    harness.timers.tick() // second fill throws
    expect(harness.timers.activeCount).toBe(0)
    expect(stopMessagesOf(harness.posted)).toEqual([{ type: 'stop', stopFrames: 128n }])

    harness.timers.tick()
    expect(stopMessagesOf(harness.posted)).toHaveLength(1)
    expect(TestFiller.fillCallCount).toBe(2)
  })

  it('reports stop immediately on start when the initial fill did not continue', async () => {
    const harness = createWorkerHarness()
    const worker = new BufferFillWorker<FillerParams>(TestFiller)
    expect(worker).toBeDefined()
    const context = createFillerFrameBufferContext({ channelCount: 2, sampleRate: 48000, fillInterval: 20 })
    await initWorker(harness, context, { actions: ['false'], framesPerFill: 0 })

    harness.send({ type: 'start' })
    // No timer was started and the stop was reported at 0 written frames.
    expect(harness.timers.activeCount).toBe(0)
    expect(stopMessagesOf(harness.posted)).toEqual([{ type: 'stop', stopFrames: 0n }])
  })
})

// ---------------------------------------------------------------------------
// Main-thread-side tests: WorkerBufferWriteStrategy with a fake Worker.
// ---------------------------------------------------------------------------

class FakeWorker extends EventTarget {
  public static instances: FakeWorker[] = []
  public onmessage: ((event: MessageEvent) => void) | null = null
  public isTerminated = false
  public readonly received: unknown[] = []

  public constructor() {
    super()
    FakeWorker.instances.push(this)
  }

  public postMessage(message: unknown): void {
    if (this.isTerminated) {
      throw new Error('postMessage called on a terminated worker')
    }
    this.received.push(message)
    if ((message as { type: string }).type === 'init') {
      queueMicrotask(() => this.emit({ type: 'init-done' }))
    }
  }

  public emit(data: unknown): void {
    const event = new MessageEvent('message', { data })
    this.onmessage?.(event)
    this.dispatchEvent(event)
  }

  public terminate(): void {
    this.isTerminated = true
  }
}

describe('WorkerBufferWriteStrategy stop handling', () => {
  it('stops the node at the reported frames and stays silent after termination', async () => {
    FakeWorker.instances = []
    const context = createFillerFrameBufferContext({ channelCount: 2, sampleRate: 48000, fillInterval: 20 })
    const strategy = new WorkerBufferWriteStrategy<unknown>(
      context, FakeWorker as unknown as new () => Worker, undefined)
    const node = await OutputStreamNode.create({} as BaseAudioContext, context, strategy)
    const processor = new ProcessorClass({ processorOptions: context })
    const nodePort = getNodePort(node)
    connectPorts(nodePort, processor.port)
    const stopEvents: StopEvent[] = []
    node.addEventListener(StopEvent.type, event => stopEvents.push(event))

    const worker = FakeWorker.instances[0]
    if (!worker) {
      throw new Error('Fake worker was not created.')
    }
    expect(worker.received.map(message => (message as { type: string }).type)).toEqual(['init'])

    expect(node.start()).toBe(true)
    expect(worker.received.map(message => (message as { type: string }).type)).toEqual(['init', 'start'])

    // Simulate the worker-side filler having written 128 frames into the
    // shared buffer and then reporting the stop position.
    writeFrames(new FrameBufferWriter(context), 128)
    worker.emit({ type: 'stop', stopFrames: 128n })
    expect(driveUntilStopped(processor)).toBe(1)

    expect(stopEvents).toHaveLength(1)
    expect(stopEvents[0].stoppedAtFrame).toBe(128n)
    expect(worker.isTerminated).toBe(true)
    expect(getNodeInternals(node).disconnectCount).toBe(1)
    expect(nodePort.isClosed).toBe(true)

    // Late messages from the terminated worker are ignored, repeated stops
    // are no-ops, and nothing is posted to the closed node port.
    worker.emit({ type: 'stop', stopFrames: 9999n })
    await node.stop()
    expect(stopEvents).toHaveLength(1)
    expect(nodePort.postedMessages).toHaveLength(1)

    // Strategy teardown is idempotent.
    expect(() => strategy.onStopped()).not.toThrow()
    expect(worker.received).toHaveLength(2)
  })
})
