import init, { BitcrusherModule } from "clawdio-bitcrusher";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
} from "./types";
import { initWasm } from "./utils";
import {
  PendingParams,
  outputsAreFinite,
  sanitizeInt,
  sanitizeNumber,
  silenceOutputs,
} from "./params";

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

/** Legal parameter ranges — keep in sync with the Rust `*_MIN`/`*_MAX` constants. */
const BITS_RANGE = { min: 1, max: 16 };
const NORMFREQ_RANGE = { min: 0, max: 1 };

type PendingParam = "bits" | "normfreq";

class BitcrusherWorklet extends AudioWorkletProcessor {
  worklet: BitcrusherModule | null = null;
  bits = 4;
  normfreq = 0.1;

  /**
   * Latest parameter values that arrived while the WASM module was not
   * ready yet. Applied (and cleared) the moment a module initializes, so
   * the effective value always equals the last message received.
   */
  private pending = new PendingParams<PendingParam>();

  /** WASM compile/init lifecycle flags shared with the `initWasm` helper. */
  private wasmStatus = { wasmReady: false, wasmFailed: false };

  /**
   * Set after a processing call throws or produces non-finite data. While
   * true the processor emits silence. It clears on the next successful
   * parameter update or when a fresh module is initialized, so the worklet
   * can recover without being recreated.
   */
  private processingFailed = false;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
  }

  onmessage = (
    event:
      | AudioWorkletInitWasmEvent
      | BitcrusherEventInitModule
      | BitcrusherEventSetBits
      | BitcrusherEventSetNormfreq,
  ) => {
    // Handle loading WASM module
    initWasm(
      event as AudioWorkletInitWasmEvent,
      init,
      this.port,
      this.wasmStatus,
    );

    if (event.type === "init-module") {
      const { bits, normfreq } = event.data;
      this.initializeModule(bits, normfreq);
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-bits") {
      this.setBits(event.data);
    }
    if (event.type === "set-normfreq") {
      this.setNormfreq(event.data);
    }
  };

  /**
   * Create (or recreate) the Rust module and reconcile it with every
   * parameter value cached while WASM was unavailable.
   */
  private initializeModule(bits: number, normfreq?: number) {
    // Local fields always reflect the last *sanitized* value; the cached
    // set-* messages take precedence over the construction config.
    const sanitizedBits = sanitizeInt(bits, BITS_RANGE);
    if (sanitizedBits !== null) {
      this.bits = sanitizedBits;
    }
    if (normfreq !== undefined) {
      const sanitizedNormfreq = sanitizeNumber(normfreq, NORMFREQ_RANGE);
      if (sanitizedNormfreq !== null) {
        this.normfreq = sanitizedNormfreq;
      }
    }

    try {
      this.worklet = BitcrusherModule.new(this.bits);
      // The Rust module owns the live normfreq; keep it in sync from the
      // first block it processes.
      this.worklet.set_normfreq(this.normfreq);
      this.applyPendingParams();
      this.wasmStatus.wasmFailed = false;
      this.wasmStatus.wasmReady = true;
      this.processingFailed = false;
    } catch (error) {
      console.error("Failed to initialize Bitcrusher module", error);
      this.worklet = null;
      this.wasmStatus.wasmFailed = true;
    }
  }

  /** Push every parameter cached before the module existed into the module. */
  private applyPendingParams() {
    if (!this.worklet || this.pending.size === 0) return;

    const pendingBits = this.pending.get("bits");
    if (pendingBits !== undefined) {
      this.bits = pendingBits;
      this.worklet.set_bits(pendingBits);
    }
    const pendingNormfreq = this.pending.get("normfreq");
    if (pendingNormfreq !== undefined) {
      this.normfreq = pendingNormfreq;
      this.worklet.set_normfreq(pendingNormfreq);
    }
    this.pending.clear();
    // A successful module-level write proves the WASM instance is healthy
    // again, so audio can resume.
    this.processingFailed = false;
  }

  private setBits(rawBits: unknown) {
    const sanitized = sanitizeInt(rawBits, BITS_RANGE);
    if (sanitized === null) {
      console.warn("Ignoring invalid set-bits value", rawBits);
      return;
    }

    this.bits = sanitized;
    if (this.worklet && !this.wasmStatus.wasmFailed) {
      try {
        this.worklet.set_bits(sanitized);
        // Recover from a previous processing failure as soon as the module
        // proves it can accept updates again.
        this.processingFailed = false;
      } catch (error) {
        console.error("Failed to update bits on WASM module", error);
        this.pending.set("bits", sanitized);
      }
    } else {
      // Module not ready yet: cache the latest value, last write wins.
      this.pending.set("bits", sanitized);
    }
  }

  private setNormfreq(rawNormfreq: unknown) {
    const sanitized = sanitizeNumber(rawNormfreq, NORMFREQ_RANGE);
    if (sanitized === null) {
      console.warn("Ignoring invalid set-normfreq value", rawNormfreq);
      return;
    }

    this.normfreq = sanitized;
    if (this.worklet && !this.wasmStatus.wasmFailed) {
      try {
        this.worklet.set_normfreq(sanitized);
        // Recover from a previous processing failure as soon as the module
        // proves it can accept updates again.
        this.processingFailed = false;
      } catch (error) {
        console.error("Failed to update normfreq on WASM module", error);
        this.pending.set("normfreq", sanitized);
      }
    } else {
      // Module not ready yet: cache the latest value, last write wins.
      this.pending.set("normfreq", sanitized);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // No module yet (WASM still loading/compiling) or initialization
    // failed: keep the output silent rather than passing data through.
    if (!this.worklet || this.wasmStatus.wasmFailed || this.processingFailed) {
      silenceOutputs(outputs);
      return true;
    }

    try {
      inputs.forEach((channels, channelIndex) => {
        channels.forEach((inputSamples, sampleIndex) => {
          // We check again since TS insists (and maybe it changes over course of loop?)
          if (this.worklet == null) return;

          // Process samples using Rust WASM module. normfreq lives on the
          // module itself, so set-normfreq messages take effect immediately.
          const processing = this.worklet.process(inputSamples);

          // Make sure you loop through each output value and assign it manually
          // can't just assign a whole array
          processing.forEach(
            (val, index) => (outputs[channelIndex][sampleIndex][index] = val),
          );
        });
      });
    } catch (error) {
      // A failed WASM call must never kill the audio graph: mute and keep
      // the processor alive so later messages can recover it.
      console.error("Bitcrusher processing error", error);
      this.processingFailed = true;
      silenceOutputs(outputs);
      return true;
    }

    // Defense in depth: never let a non-finite sample reach the speakers.
    if (!outputsAreFinite(outputs)) {
      console.error("Bitcrusher produced non-finite samples; muting output");
      this.processingFailed = true;
      silenceOutputs(outputs);
    }

    return true;
  }
}

registerProcessor("clawdio-bitcrusher", BitcrusherWorklet);

export default BitcrusherWorklet;
