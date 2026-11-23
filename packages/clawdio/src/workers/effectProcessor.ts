import {
  type ParameterName,
  resolveInitialParameter,
} from "../shared/parameters.ts";
import {
  ParameterController,
  type ParameterErrorMessage,
  type ParameterSnapshot,
} from "./parameterController.ts";
import { createWasmLoader, type WasmLoader } from "./utils.ts";

/** Minimal surface of a wasm-bindgen generated module. */
export type WasmModuleLike = {
  free?: () => void;
};

/** The parts of `MessagePort` the processor actually uses. */
export type ProcessorPort = {
  postMessage: (message: unknown) => void;
  close?: () => void;
};

export type ParameterValues = Partial<Record<ParameterName, number>>;

export type EffectProcessorConfig<T extends WasmModuleLike> = {
  port: ProcessorPort;
  /** `init` export from the wasm-bindgen package. */
  initWasmModule: (module: Promise<WebAssembly.Module>) => Promise<unknown>;
  /** Parameters this processor understands, in documentation order. */
  parameters: readonly ParameterName[];
  /** Builds the Rust module. Only called once per processor. */
  createModule: (initial: Record<ParameterName, number>) => T;
  /**
   * Applies a validated parameter to the live module. Return false if the
   * module refused it. Parameters the module does not own (e.g. a value only
   * read from `process`) can return true and rely on {@link valueOf}.
   */
  applyParameter: (module: T, parameter: ParameterName, value: number) => boolean;
  /** Processes one channel in place. Called once per channel per block. */
  processChannel: (module: T, input: Float32Array, output: Float32Array) => void;
  /** Clears the port handler; invoked on dispose. */
  clearHandlers?: () => void;
};

/**
 * Framework-free heart of an effect AudioWorkletProcessor.
 *
 * It is intentionally *not* an `AudioWorkletProcessor` subclass so it can be
 * exercised in plain Node tests (see `tests/`). The worklet files in this
 * folder are thin adapters around it.
 *
 * Responsibilities:
 * - WASM loading (idempotent, reports failures back to the main thread)
 * - `init-module` handling that never rebuilds an existing module (which would
 *   reset per-sample state and click)
 * - queueing parameter updates until the module exists (the slider-before-init race)
 * - rejecting illegal values without touching the last legal ones
 * - disposing the module/port when the node goes away
 */
export class EffectProcessor<T extends WasmModuleLike> {
  module: T | null = null;
  disposed = false;

  private readonly port: ProcessorPort;
  private readonly parameters: readonly ParameterName[];
  private readonly createModule: EffectProcessorConfig<T>["createModule"];
  private readonly processChannel: EffectProcessorConfig<T>["processChannel"];
  private readonly clearHandlers?: () => void;
  private readonly controller: ParameterController<T>;
  private readonly messageTypes = new Map<string, ParameterName>();

  private processingErrorReported = false;
  /** `init-module` payload waiting for the WASM module to finish compiling. */
  private pendingInit: ParameterValues | null = null;
  private readonly wasmLoader: WasmLoader;

  constructor(config: EffectProcessorConfig<T>) {
    this.port = config.port;
    this.parameters = config.parameters;
    this.createModule = config.createModule;
    this.processChannel = config.processChannel;
    this.clearHandlers = config.clearHandlers;

    for (const parameter of config.parameters) {
      this.messageTypes.set(`set-${parameter}`, parameter);
    }

    this.wasmLoader = createWasmLoader(
      config.initWasmModule,
      config.port,
      {
        // If `init-module` raced ahead of the compile, build the module now
        // rather than dropping the request on the floor.
        onLoaded: () => this.flushPendingInit(),
      }
    );

    this.controller = new ParameterController<T>({
      parameters: config.parameters,
      post: (message) => this.post(message),
      apply: (module, parameter, value) =>
        config.applyParameter(module, parameter, value),
    });
  }

  /** Last known legal value for a parameter, or undefined before init. */
  valueOf(parameter: ParameterName): number | undefined {
    return this.controller.snapshot[parameter];
  }

  get values(): ParameterSnapshot {
    return this.controller.snapshot;
  }

  get pendingCount(): number {
    return this.controller.pendingCount;
  }

  get isReady(): boolean {
    return this.module !== null;
  }

  /** Dispatch a raw port message. Safe to call with anything. */
  handle(event: unknown): void {
    if (this.disposed) return;
    if (typeof event !== "object" || event === null) return;

    const message = event as { type?: unknown; data?: unknown };
    if (typeof message.type !== "string") return;

    // Handle loading the WASM module. The loader ignores duplicates.
    this.wasmLoader.handle(message as { type: string });

    if (message.type === "dispose") {
      this.dispose();
      return;
    }

    if (message.type === "init-module") {
      this.initModule((message.data ?? {}) as ParameterValues);
      return;
    }

    const parameter = this.messageTypes.get(message.type);
    if (parameter) {
      this.controller.set(parameter, message.data);
    }
  }

  private initModule(data: ParameterValues): void {
    if (this.module) {
      // A repeated `init-module` (retry) is applied as parameter updates so the
      // per-sample state (phaser / ladder) survives. Rebuilding would click.
      for (const parameter of this.parameters) {
        this.controller.set(
          parameter,
          resolveInitialParameter(parameter, data[parameter])
        );
      }
      return;
    }

    // The Rust constructor only exists once the WASM instance is initialised.
    // The main thread normally waits for `wasm-loaded` before posting
    // `init-module`, but if it races ahead while the payload is still being
    // compiled we must neither throw (module is empty) nor drop the request.
    // Defer it until the loader reports success.
    if (this.wasmLoader.state() === "loading") {
      this.pendingInit = data;
      return;
    }

    this.buildModule(data);
  }

  private flushPendingInit(): void {
    if (this.disposed || this.module || !this.pendingInit) return;
    const data = this.pendingInit;
    this.pendingInit = null;
    this.buildModule(data);
  }

  private buildModule(data: ParameterValues): void {
    const initial = {} as Record<ParameterName, number>;
    for (const parameter of this.parameters) {
      initial[parameter] = resolveInitialParameter(parameter, data[parameter]);
    }

    let module: T;
    try {
      module = this.createModule(initial);
    } catch (error) {
      if (!this.wasmLoader.isLoaded()) {
        // Constructor requires the compiled WASM instance. A racing or early
        // `init-module` must be retried once loading finishes rather than
        // surfacing as an error the user cannot act on.
        this.pendingInit = data;
        return;
      }

      this.post({
        type: "wasm-error",
        data: {
          message: `Failed to create the audio module: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      return;
    }

    this.module = module;
    this.controller.attach(module, initial);
  }

  /**
   * Runs one render quantum. Returns the `AudioWorkletProcessor` keep-alive
   * flag: false once disposed, true otherwise.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.disposed) return false;
    if (this.module == null) return true;

    const input = inputs?.[0];
    const output = outputs?.[0];
    if (!input || !output || input.length === 0) return true;

    const module = this.module;
    const channels = Math.min(input.length, output.length);

    for (let channel = 0; channel < channels; channel++) {
      const inputSamples = input[channel];
      const outputSamples = output[channel];
      if (!inputSamples || !outputSamples) continue;

      try {
        this.processChannel(module, inputSamples, outputSamples);

        // Defensive: never let a NaN/Infinity reach downstream nodes where it
        // would turn the whole graph into a silent, stuck voice.
        for (let index = 0; index < outputSamples.length; index++) {
          if (!Number.isFinite(outputSamples[index])) outputSamples[index] = 0;
        }
      } catch (error) {
        // Report once, then keep the processor alive for future blocks.
        this.reportProcessingError(error);
      }
    }

    return true;
  }

  private reportProcessingError(error: unknown): void {
    if (this.processingErrorReported) return;
    this.processingErrorReported = true;
    this.post({
      type: "processing-error",
      data: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  private post(message: ParameterErrorMessage | Record<string, unknown>): void {
    if (this.disposed) return;
    try {
      this.port.postMessage(message);
    } catch {
      // The other side may already be gone (page unloading).
    }
  }

  /** Release the Rust module and stop listening. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.pendingInit = null;
    this.clearHandlers?.();

    const module = this.module;
    this.module = null;
    if (module && typeof module.free === "function") {
      try {
        module.free();
      } catch {
        // Ignore double-free style errors during teardown.
      }
    }

    try {
      this.port.close?.();
    } catch {
      // Port may already be closed by the main thread.
    }
  }
}
