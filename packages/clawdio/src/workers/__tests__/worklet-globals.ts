/**
 * Minimal AudioWorkletGlobalScope stubs for running processors under Node.
 * These mirror only the surface used by the worklet implementations:
 * - registerProcessor(name, ctor): captures the constructor for the harness
 * - AudioWorkletProcessor: base class exposing a MessagePort
 * No real audio device or rendering thread is involved.
 */

export type WorkletProcessorCtor = new () => {
  port: {
    postMessage: (message: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters?: Record<string, Float32Array>
  ) => boolean;
};

export class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Messages the worklet sends back to the node (outbound). */
  readonly outbound: unknown[] = [];

  postMessage(message: unknown) {
    this.outbound.push(message);
  }

  /** Deliver a node -> worklet message asynchronously, like a real port. */
  deliver(data: unknown) {
    queueMicrotask(() => {
      this.onmessage?.({ data });
    });
  }
}

export class AudioWorkletProcessor {
  readonly port: FakeMessagePort;

  constructor() {
    this.port = new FakeMessagePort();
  }
}

const registry = new Map<string, WorkletProcessorCtor>();

export function registerProcessor(
  name: string,
  ctor: WorkletProcessorCtor
): void {
  registry.set(name, ctor);
}

export function getRegisteredProcessor(
  name: string
): WorkletProcessorCtor | undefined {
  return registry.get(name);
}
