/**
 * Test-only shims for the AudioWorklet global scope. The worklet modules read
 * sampleRate off globalThis and extend AudioWorkletProcessor; provide plain
 * stand-ins so the same DSP code runs under Node without a browser.
 */

export const TEST_SAMPLE_RATE = 48000;

(globalThis as { sampleRate?: number }).sampleRate = TEST_SAMPLE_RATE;

export class FakeAudioWorkletProcessor {
  port: FakePort;

  constructor() {
    this.port = new FakePort();
  }
}

(
  globalThis as {
    AudioWorkletProcessor?: typeof FakeAudioWorkletProcessor;
  }
).AudioWorkletProcessor = FakeAudioWorkletProcessor;

(
  globalThis as {
    registerProcessor?: (name: string, ctor: unknown) => void;
  }
).registerProcessor = () => {};

export type PostedMessage = Record<string, unknown>;

/**
 * One end of a virtual MessagePort. postMessage queues a microtask that
 * delivers to the paired port's onmessage — matching the real port's async,
 * FIFO ordering, which is what the revision/ack protocol relies on.
 */
export class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private queue: unknown[] = [];
  private scheduled = false;

  postMessage(message: unknown): void {
    this.queue.push(message);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.drain());
    }
  }

  private drain(): void {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    for (const message of batch) {
      this.onmessage?.({ data: message } as MessageEvent);
    }
  }
}

/** A paired main-thread/worklet port pair, connected like new MessageChannel(). */
export function createPortPair(): { main: FakePort; worklet: FakePort } {
  const main = new FakePort();
  const worklet = new FakePort();
  const mainPost = main.postMessage.bind(main);
  const workletPost = worklet.postMessage.bind(worklet);
  main.postMessage = (message: unknown) => workletPost(message);
  worklet.postMessage = (message: unknown) => mainPost(message);
  return { main, worklet };
}

/** Flush all queued microtasks (all pending port deliveries). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Run the processor for one 128-sample block and return the stereo output. */
export function runBlock(processor: {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ) => boolean;
}): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  processor.process([], [[left, right]], {});
  return { left, right };
}

export function allFinite(buffer: Float32Array): boolean {
  for (const value of buffer) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

export function isSilent(buffer: Float32Array): boolean {
  for (const value of buffer) {
    if (value !== 0) return false;
  }
  return true;
}
