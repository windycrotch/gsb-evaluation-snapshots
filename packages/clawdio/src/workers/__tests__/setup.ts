/**
 * Vitest setup: install AudioWorkletGlobalScope stubs before any worklet
 * module is imported. The worklets call the global registerProcessor() at
 * module-eval time, so these must exist on globalThis first.
 */
import {
  AudioWorkletProcessor,
  registerProcessor,
  getRegisteredProcessor,
  FakeMessagePort,
} from "./worklet-globals";

const g = globalThis as unknown as Record<string, unknown>;
g.AudioWorkletProcessor = AudioWorkletProcessor;
g.registerProcessor = registerProcessor;

export { getRegisteredProcessor, FakeMessagePort };
