import type { FrameBufferWriter } from '@ain1084/audio-frame-buffer'

/**
 * FakePort class
 * A synchronous, controllable stand-in for the MessagePort used between
 * OutputStreamNode and OutputStreamProcessor. Messages posted on one port
 * are delivered to the peer port's onmessage handler synchronously, which
 * keeps the tests deterministic.
 */
export class FakePort {
  public onmessage: ((event: { data: unknown }) => void) | null = null
  public peer: FakePort | null = null
  public isClosed = false
  public readonly postedMessages: unknown[] = []

  public postMessage(message: unknown): void {
    if (this.isClosed) {
      throw new Error('postMessage called on a closed port')
    }
    this.postedMessages.push(message)
    this.peer?.deliver(message)
  }

  public deliver(message: unknown): void {
    this.onmessage?.({ data: message })
  }

  public close(): void {
    this.isClosed = true
  }
}

/**
 * FakeAudioWorkletNode class
 * Stand-in for the browser's AudioWorkletNode base class. Installed as
 * globalThis.AudioWorkletNode before importing output-stream-node.ts.
 */
export class FakeAudioWorkletNode extends EventTarget {
  public readonly port: FakePort = new FakePort()
  public numberOfOutputs = 1
  public disconnectCount = 0

  public constructor(
    public readonly context: unknown,
    public readonly processorName: string,
    public readonly options?: unknown,
  ) {
    super()
  }

  public connect(): void {}
  public disconnect(): void {
    ++this.disconnectCount
  }
}

/**
 * The runtime shape of OutputStreamProcessor instances created in tests.
 */
export interface ProcessorLike {
  readonly port: FakePort
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

export type ProcessorConstructor = new (options: { processorOptions: unknown }) => ProcessorLike

/**
 * Installs the fake AudioWorkletNode base class as a global.
 * Must be called before importing src/output-stream-node.ts.
 */
export const installNodeGlobals = (): void => {
  const g = globalThis as unknown as Record<string, unknown>
  g.AudioWorkletNode = FakeAudioWorkletNode
}

/**
 * Installs fake AudioWorkletProcessor/registerProcessor globals, imports
 * src/output-stream-processor.ts and returns the registered processor class.
 */
export const loadProcessor = async (): Promise<ProcessorConstructor> => {
  const g = globalThis as unknown as Record<string, unknown>
  class FakeAudioWorkletProcessor {
    public readonly port: FakePort = new FakePort()
  }
  let captured: ProcessorConstructor | null = null
  g.AudioWorkletProcessor = FakeAudioWorkletProcessor
  g.registerProcessor = (_name: string, processorConstructor: ProcessorConstructor): void => {
    captured = processorConstructor
  }
  await import('../src/output-stream-processor')
  if (!captured) {
    throw new Error('OutputStreamProcessor was not registered.')
  }
  return captured
}

/**
 * Connects the node-side port and the processor-side port as peers.
 */
export const connectPorts = (nodePort: FakePort, processorPort: FakePort): void => {
  nodePort.peer = processorPort
  processorPort.peer = nodePort
}

/**
 * Returns the fake port of a node created through OutputStreamNode.create.
 */
export const getNodePort = (node: unknown): FakePort => {
  return (node as { port: FakePort }).port
}

/**
 * Returns the fake base-class internals of a node (disconnect count etc.).
 */
export const getNodeInternals = (node: unknown): FakeAudioWorkletNode => {
  return node as FakeAudioWorkletNode
}

/**
 * Writes the given number of frames through a FrameBufferWriter.
 */
export const writeFrames = (writer: FrameBufferWriter, frameCount: number): void => {
  let remaining = frameCount
  while (remaining > 0) {
    const written = writer.write(segment => Math.min(segment.frameCount, remaining))
    if (written <= 0) {
      throw new Error('Frame buffer is full.')
    }
    remaining -= written
  }
}

/**
 * Drives one process() call of the processor with a silent output block.
 */
export const driveProcess = (processor: ProcessorLike, frameCount = 128, channelCount = 2): boolean => {
  const outputs: Float32Array[][] = [Array.from({ length: channelCount }, () => new Float32Array(frameCount))]
  return processor.process([], outputs)
}

/**
 * Drives process() until the processor returns false.
 * @returns The number of process() calls made (including the final one).
 */
export const driveUntilStopped = (processor: ProcessorLike, maxIterations = 100): number => {
  for (let i = 0; i < maxIterations; ++i) {
    if (!driveProcess(processor)) {
      return i + 1
    }
  }
  throw new Error('Processor did not stop.')
}

/**
 * FakeTimerHost class
 * A manually driven replacement for window.setInterval/clearInterval and
 * self.setInterval/clearInterval, letting tests assert that no timer is
 * left running after a strategy stops.
 */
export class FakeTimerHost {
  private _nextId = 1
  private readonly _timers = new Map<number, () => void>()

  public readonly setInterval = (callback: () => void): number => {
    const id = this._nextId++
    this._timers.set(id, callback)
    return id
  }

  public readonly clearInterval = (id: number): void => {
    this._timers.delete(id)
  }

  public get activeCount(): number {
    return this._timers.size
  }

  /**
   * Runs every currently active timer callback once.
   */
  public tick(): void {
    for (const callback of [...this._timers.values()]) {
      callback()
    }
  }
}
