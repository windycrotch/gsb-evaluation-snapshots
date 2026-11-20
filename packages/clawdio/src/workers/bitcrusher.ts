import init, { BitcrusherModule } from "clawdio-bitcrusher";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
} from "./types";
import { initWasm } from "./utils";

export interface BitcrusherEventInitModule
  extends AudioWorkletEventMessage<BitcrusherOptions> {
  type: "init-module";
  data: BitcrusherOptions;
}

export interface BitcrusherEventSetBits
  extends AudioWorkletEventMessage<number> {
  type: "set-bits";
  data: number;
}
export interface BitcrusherEventSetNormfreq
  extends AudioWorkletEventMessage<number> {
  type: "set-normfreq";
  data: number;
}

export type BitcrusherOptions = {
  bits: number;
  normfreq?: number;
};

const MIN_BITS = 1;
const MAX_BITS = 32;

const sanitizeBits = (bits: number): number => {
  if (!Number.isFinite(bits)) return MIN_BITS;
  return Math.min(MAX_BITS, Math.max(MIN_BITS, Math.round(bits)));
};

const sanitizeNormfreq = (normfreq: number): number =>
  Number.isFinite(normfreq) ? normfreq : 0;

class BitcrusherWorklet extends AudioWorkletProcessor {
  worklet: BitcrusherModule | null = null;
  bits = 4;
  normfreq = 0.1;
  // Parameter requests that arrive before the WASM module exists. They are
  // folded into module creation so no setter is ever silently dropped.
  private pendingBits: number | null = null;
  private pendingNormfreq: number | null = null;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
  }

  /**
   * Factory seam. Production code constructs the real WASM module; tests can
   * override it (e.g. to simulate a reconstruction failure).
   */
  protected createModule(bits: number): BitcrusherModule {
    return BitcrusherModule.new(bits);
  }

  /**
   * Rebuild the underlying module for a new bit depth. The swap is atomic:
   * a block being processed always sees either the old or the fully built
   * new module, never a half-initialized one. If construction fails the old
   * module stays in place and audio continues uninterrupted.
   */
  private rebuildForBits(rawBits: number) {
    const bits = sanitizeBits(rawBits);
    this.bits = bits;

    // No module yet: remember the request until `init-module` arrives.
    if (this.worklet == null) {
      this.pendingBits = bits;
      return;
    }

    const previous = this.worklet;
    let replacement: BitcrusherModule;
    try {
      replacement = this.createModule(bits);
      // Carry over phaser/held-sample state so the hand-over is click-free.
      replacement.adopt_state_from(previous);
    } catch (error) {
      // Keep serving audio with the old module; surface the failure instead
      // of going silent or throwing into the audio render thread.
      this.port.postMessage({
        type: "set-bits-failed",
        data: { bits, error: String(error) },
      });
      return;
    }

    // Single assignment = atomic from process()'s point of view.
    this.worklet = replacement;
    previous.free();
  }

  onmessage = (
    event:
      | AudioWorkletInitWasmEvent
      | BitcrusherEventInitModule
      | BitcrusherEventSetBits
      | BitcrusherEventSetNormfreq
  ) => {
    // Handle loading WASM module
    initWasm(event as AudioWorkletInitWasmEvent, init, this.port);

    if (event.type === "init-module") {
      const bits = sanitizeBits(
        this.pendingBits ?? event.data.bits ?? this.bits
      );
      this.bits = bits;
      if (event.data.normfreq != null) {
        this.normfreq = sanitizeNormfreq(event.data.normfreq);
      }
      if (this.pendingNormfreq != null) {
        this.normfreq = this.pendingNormfreq as number;
      }
      this.pendingBits = null;
      this.pendingNormfreq = null;

      try {
        this.worklet = this.createModule(bits);
      } catch (error) {
        this.port.postMessage({
          type: "init-module-failed",
          data: { error: String(error) },
        });
      }
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-bits") {
      this.rebuildForBits(event.data);
    }
    if (event.type === "set-normfreq") {
      const normfreq = sanitizeNormfreq(event.data);
      this.normfreq = normfreq;
      if (this.worklet == null) {
        this.pendingNormfreq = normfreq;
      }
    }
  };

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // Check if we have worklet initialized
    if (this.worklet == null) return true;

    // Snapshot once per block: a setter message arriving mid-block cannot
    // tear the reference, and the next block picks up the new value.
    const module = this.worklet;
    const normfreq = this.normfreq;

    inputs.forEach((channels, channelIndex) => {
      channels.forEach((inputSamples, sampleIndex) => {
        // Process samples using Rust WASM module
        const processing = module.process(inputSamples, normfreq);

        // Make sure you loop through each output value and assign it manually
        // can't just assign a whole array
        processing.forEach(
          (val, index) => (outputs[channelIndex][sampleIndex][index] = val)
        );
      });
    });

    return true;
  }
}

registerProcessor("clawdio-bitcrusher", BitcrusherWorklet);
