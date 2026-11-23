import type { ParameterName } from "../shared/parameters.ts";
import { EffectProcessor, type ProcessorPort } from "./effectProcessor.ts";

/** Minimal contract of a wasm-bindgen class, for dependency injection. */
export type BitcrusherWasmModule = {
  setBits: (bits: number) => boolean;
  process: (samples: Float32Array, normfreq: number) => Float32Array;
  free?: () => void;
};

export type BitcrusherWasmBindings = {
  /** `init` export from the wasm-bindgen package. */
  initWasm: (module: Promise<WebAssembly.Module>) => Promise<unknown>;
  createModule: (bits: number) => BitcrusherWasmModule;
};

export type BitcrusherProcessorState = {
  effect: EffectProcessor<BitcrusherWasmModule>;
  /** Normalised frequency consumed by `process()` on every block. */
  normfreq: number;
};

/**
 * Cast a wasm-bindgen generated module to the interface this worklet needs.
 *
 * The Rust source and the published `clawdio-*` package can drift (the setter
 * only exists in builds made from this source), so the cast is paired with a
 * runtime check in `applyParameter` rather than trusting the type.
 */
export const asBitcrusherModule = (module: unknown): BitcrusherWasmModule =>
  module as BitcrusherWasmModule;

/**
 * Builds the processor around a message port and a WASM bindings pair.
 *
 * Kept separate from the worklet class so it can be unit tested in Node with
 * either the real wasm-bindgen output or a fake module.
 */
export const createBitcrusherProcessor = (
  port: ProcessorPort,
  bindings: BitcrusherWasmBindings
): BitcrusherProcessorState => {
  const state = { normfreq: 0.1 } as BitcrusherProcessorState;

  state.effect = new EffectProcessor<BitcrusherWasmModule>({
    port,
    initWasmModule: bindings.initWasm,
    parameters: ["bits", "normfreq"],
    createModule: (initial) => bindings.createModule(initial.bits),
    applyParameter: (module, parameter: ParameterName, value) => {
      if (parameter === "normfreq") {
        // Read by `process()`; no state inside Rust depends on it.
        state.normfreq = value;
        return true;
      }
      if (typeof module.setBits !== "function") {
        // A stale WASM package (built before live parameter updates existed).
        // Refusing here surfaces a clear parameter-error on the main thread
        // instead of a TypeError from inside the audio thread.
        return false;
      }
      return module.setBits(value);
    },
    processChannel: (module, input, output) => {
      const processing = module.process(input, state.normfreq);
      const length = Math.min(processing.length, output.length);
      for (let index = 0; index < length; index++) {
        output[index] = processing[index];
      }
    },
  });

  return state;
};
