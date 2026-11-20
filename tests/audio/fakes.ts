// Minimal, deterministic Web Audio stand-ins so the audio engine can run under
// Node in `vitest` with no browser, no AudioContext and no real worklet.
//
// The fakes record what production code asks of the platform: which parameters
// were scheduled, which nodes were connected, and which messages were posted to
// the freeze worklet. Tests assert on that record rather than on real audio.

export type ParamEvent = { type: "cancel"; time: number } | { type: "set"; value: number; time: number } | { type: "ramp"; value: number; time: number };

export class FakeParam {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancel", time });
  }

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "ramp", value, time });
  }

  get ramps(): number[] {
    return this.events.flatMap((e) => (e.type === "ramp" ? [e.value] : []));
  }

  get lastScheduled(): number | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === "set" || event.type === "ramp") return event.value;
    }
    return null;
  }
}

export class FakeNode {
  readonly connections: FakeNode[] = [];

  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node);
    return node;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;

  constructor(value = 0) {
    super();
    this.gain = new FakeParam(value);
  }
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  readonly starts: Array<{ when: number; offset: number }> = [];
  readonly stops: number[] = [];
  started = false;
  private readonly clock: () => number;

  constructor(clock: () => number = () => 0) {
    super();
    this.clock = clock;
  }

  /** True once a stop has been requested and its scheduled time has arrived. */
  get ended(): boolean {
    const now = this.clock();
    return this.stops.some((when) => when <= now + 1e-9);
  }

  start(when = 0, offset = 0) {
    this.starts.push({ when, offset });
    this.started = true;
  }

  stop(when = 0) {
    if (!this.started) throw new DOMException("not started", "InvalidStateError");
    this.stops.push(when);
  }
}

export class FakeOscillator extends FakeNode {
  type = "sine";
  readonly frequency = new FakeParam(440);
  started = false;
  ended = false;

  start() {
    this.started = true;
  }

  stop() {
    if (!this.started) throw new DOMException("not started", "InvalidStateError");
    this.ended = true;
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  minDecibels = -100;
  maxDecibels = -10;
  smoothingTimeConstant = 0.8;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }

  getFloatFrequencyData(target: Float32Array) {
    target.fill(-Infinity);
  }
}

export class FakeAudioBuffer {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;

  constructor(length = 44100, numberOfChannels = 2, sampleRate = 44100) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  copyFromChannel(target: Float32Array, channel: number) {
    for (let i = 0; i < target.length; i++) target[i] = Math.sin((2 * Math.PI * (220 + channel * 110) * i) / this.sampleRate) * 0.5;
  }
}

export type FreezePost =
  | { type: "set-stretch-parameters"; params: unknown }
  | { type: "load"; channels: Float32Array[] }
  | { type: "seek"; position: number; jump: boolean }
  | { type: "active"; active: boolean };

export interface Recorder {
  posts: FreezePost[];
  worklets: FakeWorkletNode[];
}

export class FakeWorkletNode extends FakeNode {
  readonly port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  readonly parameters: Map<string, FakeParam>;
  readonly processorName: string;

  constructor(name: string, recorder: Recorder) {
    super();
    this.processorName = name;
    this.port = { onmessage: null, postMessage: (message) => recorder.posts.push(message as FreezePost) };
    this.parameters = new Map<string, FakeParam>([
      ["pitch", new FakeParam(1)],
      ["pitchSemitones", new FakeParam(0)],
      ["playbackRate", new FakeParam(1)],
    ]);
    recorder.worklets.push(this);
  }

  setStretchParameters(params: unknown) {
    this.port.postMessage({ type: "set-stretch-parameters", params });
  }
}

export class FakeAudioContext {
  static last: FakeAudioContext | null = null;

  currentTime = 0;
  readonly sampleRate = 44100;
  readonly destination = new FakeNode();
  state: "running" | "suspended" | "closed" = "running";
  baseLatency = 0;
  outputLatency = 0;
  readonly audioWorklet = { addModule: () => Promise.resolve() };
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly oscillators: FakeOscillator[] = [];
  resumeCount = 0;

  constructor() {
    FakeAudioContext.last = this;
  }

  createGain() {
    const gain = new FakeGain(1);
    this.gains.push(gain);
    return gain;
  }

  createBufferSource() {
    const source = new FakeSource(() => this.currentTime);
    this.sources.push(source);
    return source;
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createAnalyser() {
    return new FakeAnalyser();
  }

  resume() {
    this.resumeCount++;
    return Promise.resolve();
  }

  async decodeAudioData() {
    return new FakeAudioBuffer();
  }
}

export interface FakeAudio {
  ctx: FakeAudioContext;
  recorder: Recorder;
  restore(): void;
}

/** Installs the fake Web Audio globals and returns handles onto them. */
export function installFakeAudio(): FakeAudio {
  const recorder: Recorder = { posts: [], worklets: [] };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = globalThis as Record<string, unknown>;
  const define = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    globals[key] = value;
  };

  class WorkletNode extends FakeWorkletNode {
    constructor(name: string) {
      super(name, recorder);
    }
  }
  class Compressor extends FakeNode {}

  define("AudioContext", FakeAudioContext);
  define("AudioWorkletNode", WorkletNode);
  define("DynamicsCompressorNode", Compressor);
  define("document", { addEventListener: () => {} });

  return {
    get ctx() {
      return FakeAudioContext.last!;
    },
    recorder,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
      }
      FakeAudioContext.last = null;
    },
  };
}

export const wait = <T>(value: T) => value;
