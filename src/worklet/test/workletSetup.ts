/**
 * Minimal AudioWorklet global scope for unit-testing ModularProcessor
 * outside a browser. The real AudioWorkletProcessor delivers messages on a
 * MessagePort; the shim gives every processor an in-memory port that records
 * outbound messages and can deliver inbound ones via `receive()`.
 */

export interface OutboundMessage {
  type: string;
  [key: string]: unknown;
}

class FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly outbound: unknown[] = [];

  postMessage(message: unknown): void {
    this.outbound.push(message);
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

class FakeAudioWorkletProcessor {
  readonly port: FakePort;

  constructor() {
    this.port = new FakePort();
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.AudioWorkletProcessor = FakeAudioWorkletProcessor;
g.sampleRate = 48000;

export function getPort(processor: unknown): FakePort {
  return (processor as { port: FakePort }).port;
}
