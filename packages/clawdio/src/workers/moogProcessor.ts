import type { ParameterName } from "../shared/parameters.ts";
import { EffectProcessor, type ProcessorPort } from "./effectProcessor.ts";

/** Minimal contract of a wasm-bindgen class, for dependency injection. */
export type MoogWasmModule = {
  setCutoff: (cutoff: number) => boolean;
  setResonance: (resonance: number) => boolean;
  process: (samples: Float32Array) => Float32Array;
  free?: () => void;
};

export type MoogWasmBindings = {
  /** `init` export from the wasm-bindgen package. */
  initWasm: (module: Promise<WebAssembly.Module>) => Promise<unknown>;
  createModule: (cutoff: number, resonance: number) => MoogWasmModule;
};

export type MoogProcessorState = {
  effect: EffectProcessor<MoogWasmModule>;
};

/**
 * Cast a wasm-bindgen generated module to the interface this worklet needs.
 *
 * The Rust source and the published `clawdio-*` package can drift (the setters
 * only exist in builds made from this source), so the cast is paired with a
 * runtime check in `applyParameter` rather than trusting the type.
 */
export const asMoogModule = (module: unknown): MoogWasmModule =>
  module as MoogWasmModule;

/**
 * Builds the processor around a message port and a WASM bindings pair.
 *
 * Kept separate from the worklet class so it can be unit tested in Node with
 * either the real wasm-bindgen output or a fake module.
 */
export const createMoogProcessor = (
  port: ProcessorPort,
  bindings: MoogWasmBindings
): MoogProcessorState => {
  const effect = new EffectProcessor<MoogWasmModule>({
    port,
    initWasmModule: bindings.initWasm,
    parameters: ["cutoff", "resonance"],
    createModule: (initial) =>
      bindings.createModule(initial.cutoff, initial.resonance),
    applyParameter: (module, parameter: ParameterName, value) => {
      const setter = parameter === "cutoff" ? module.setCutoff : module.setResonance;
      if (typeof setter !== "function") {
        // Stale WASM package built before live parameter updates existed.
        return false;
      }
      return setter.call(module, value);
    },
    processChannel: (module, input, output) => {
      const processing = module.process(input);
      const length = Math.min(processing.length, output.length);
      for (let index = 0; index < length; index++) {
        output[index] = processing[index];
      }
    },
  });

  return { effect };
};
