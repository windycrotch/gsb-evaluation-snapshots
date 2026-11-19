/**
 * Test harness for the AudioWorklet processors.
 *
 * The real `AudioWorkletProcessor` / `registerProcessor` globals only
 * exist inside an AudioWorklet scope, so we provide minimal fakes that
 * capture the registered processor class and its `MessagePort`.
 */

export class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  public readonly messages: unknown[] = [];

  postMessage(data: unknown): void {
    this.messages.push(data);
  }
}

export const installWorkletGlobals = (): Map<string, unknown> => {
  const registrations = new Map<string, unknown>();
  (globalThis as unknown as Record<string, unknown>).AudioWorkletProcessor =
    class {
      port = new FakeMessagePort();
    };
  (globalThis as unknown as Record<string, unknown>).registerProcessor = (
    name: string,
    processor: unknown,
  ) => {
    registrations.set(name, processor);
  };
  return registrations;
};

/** Let all the promise-based WASM handshake microtasks settle. */
export const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export const makeIo = (
  frames = 4,
): {
  inputs: Float32Array[][];
  outputs: Float32Array[][];
} => ({
  inputs: [[Float32Array.from({ length: frames }, (_, i) => 0.1 * (i + 1))]],
  outputs: [[new Float32Array(frames)]],
});

export const isSilent = (outputs: Float32Array[][]): boolean =>
  outputs.every((channels) =>
    channels.every((channel) => Array.from(channel).every((v) => v === 0)),
  );

export const allFinite = (outputs: Float32Array[][]): boolean =>
  outputs.every((channels) =>
    channels.every((channel) =>
      Array.from(channel).every((v) => Number.isFinite(v)),
    ),
  );
