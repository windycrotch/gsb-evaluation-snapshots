/**
 * A tiny fake of the Web Audio nodes the studio engine touches.
 *
 * Only what the engine calls is implemented: parameter automation is recorded
 * so tests can assert on the exact ramp times, and buffer sources remember how
 * they were started and stopped. This keeps the tests hermetic — no real audio
 * device, no worklets, no music files.
 */

export interface ParamEvent {
  type:
    | 'setValueAtTime'
    | 'linearRampToValueAtTime'
    | 'exponentialRampToValueAtTime'
    | 'setTargetAtTime'
    | 'cancelAndHoldAtTime'
    | 'cancelScheduledValues'
  value: number
  time: number
}

export class FakeParam {
  value: number
  readonly events: ParamEvent[] = []

  constructor(value = 1) {
    this.value = value
  }

  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'setValueAtTime', value, time })
    this.value = value
    return this
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linearRampToValueAtTime', value, time })
    this.value = value
    return this
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time })
    this.value = value
    return this
  }

  setTargetAtTime(value: number, time: number): this {
    this.events.push({ type: 'setTargetAtTime', value, time })
    this.value = value
    return this
  }

  cancelAndHoldAtTime(time: number): this {
    this.events.push({ type: 'cancelAndHoldAtTime', value: this.value, time })
    return this
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancelScheduledValues', value: this.value, time })
    return this
  }
}

export class FakeNode {
  readonly outputs: FakeNode[] = []
  disconnectCalls = 0

  connect<T extends FakeNode>(destination: T): T {
    this.outputs.push(destination)
    return destination
  }

  disconnect(): void {
    this.disconnectCalls++
    this.outputs.length = 0
  }
}

export class FakeGainNode extends FakeNode {
  readonly gain = new FakeParam(1)
}

export class FakeBufferSourceNode extends FakeNode {
  buffer: FakeAudioBuffer | null = null
  loop = false
  readonly playbackRate = new FakeParam(1)
  onended: (() => void) | null = null
  readonly starts: Array<{ when: number; offset: number; duration: number | undefined }> = []
  readonly stops: number[] = []

  start(when = 0, offset = 0, duration?: number): void {
    this.starts.push({ when, offset, duration })
  }

  stop(when = 0): void {
    this.stops.push(when)
  }
}

export class FakeOscillatorNode extends FakeNode {
  type: OscillatorType = 'sine'
  readonly frequency = new FakeParam(440)
  readonly detune = new FakeParam(0)
  onended: (() => void) | null = null
  readonly starts: number[] = []
  readonly stops: number[] = []

  start(when = 0): void {
    this.starts.push(when)
  }

  stop(when = 0): void {
    this.stops.push(when)
  }
}

export class FakeBiquadFilterNode extends FakeNode {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeParam(350)
  readonly Q = new FakeParam(1)
  readonly detune = new FakeParam(0)
}

export class FakeDelayNode extends FakeNode {
  readonly delayTime = new FakeParam(0)
}

export class FakeStereoPannerNode extends FakeNode {
  readonly pan = new FakeParam(0)
}

export class FakeConvolverNode extends FakeNode {
  buffer: FakeAudioBuffer | null = null
}

export class FakeWaveShaperNode extends FakeNode {
  curve: Float32Array | null = null
  oversample: 'none' | '2x' | '4x' = 'none'
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  private readonly channels: Float32Array[]

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length)
    )
  }

  get duration(): number {
    return this.length / this.sampleRate
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0]
  }
}

/** Build a silent buffer of a given length without filling its samples. */
export function makeBuffer(seconds: number, sampleRate = 8000): FakeAudioBuffer {
  return new FakeAudioBuffer(2, Math.max(1, Math.round(seconds * sampleRate)), sampleRate)
}

export class FakeAudioContext {
  currentTime = 0
  sampleRate = 8000
  readonly sources: FakeBufferSourceNode[] = []
  readonly gains: FakeGainNode[] = []
  readonly oscillators: FakeOscillatorNode[] = []

  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode()
    this.sources.push(node)
    return node
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode()
    this.gains.push(node)
    return node
  }

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode()
    this.oscillators.push(node)
    return node
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode()
  }

  createDelay(_maxDelayTime: number): FakeDelayNode {
    return new FakeDelayNode()
  }

  createStereoPanner(): FakeStereoPannerNode {
    return new FakeStereoPannerNode()
  }

  createConvolver(): FakeConvolverNode {
    return new FakeConvolverNode()
  }

  createWaveShaper(): FakeWaveShaperNode {
    return new FakeWaveShaperNode()
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate)
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }
}
