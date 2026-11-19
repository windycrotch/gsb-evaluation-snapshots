import init, { MoogModule } from "clawdio-moog";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
} from "./types";
import { initWasm } from "./utils";
import {
  PendingParams,
  outputsAreFinite,
  sanitizeNumber,
  silenceOutputs,
} from "./params";

export interface MoogEventInitModule
  extends AudioWorkletEventMessage<MoogOptions> {
  type: "init-module";
  data: MoogOptions;
}

export interface MoogEventSetCutoff extends AudioWorkletEventMessage<number> {
  type: "set-cutoff";
  data: number;
}
export interface MoogEventSetResonance
  extends AudioWorkletEventMessage<number> {
  type: "set-resonance";
  data: number;
}

export type MoogOptions = {
  cutoff: number;
  resonance: number;
};

/** Legal parameter ranges — keep in sync with the Rust `*_MIN`/`*_MAX` constants. */
const CUTOFF_RANGE = { min: 0, max: 1 };
const RESONANCE_RANGE = { min: 0, max: 4 };

type PendingParam = "cutoff" | "resonance";

class MoogWorklet extends AudioWorkletProcessor {
  worklet: MoogModule | null = null;
  cutoff = 0.065;
  resonance = 3.5;

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
   * parameter update or when a fresh module is initialized.
   */
  private processingFailed = false;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
  }

  onmessage = (
    event:
      | AudioWorkletInitWasmEvent
      | MoogEventInitModule
      | MoogEventSetCutoff
      | MoogEventSetResonance,
  ) => {
    // Handle loading WASM module
    initWasm(
      event as AudioWorkletInitWasmEvent,
      init,
      this.port,
      this.wasmStatus,
    );

    if (event.type === "init-module") {
      const { cutoff = 0.065, resonance = 3.5 } = event.data;
      this.initializeModule(cutoff, resonance);
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-cutoff") {
      this.setCutoff(event.data);
    }
    if (event.type === "set-resonance") {
      this.setResonance(event.data);
    }
  };

  /**
   * Create (or recreate) the Rust module and reconcile it with every
   * parameter value cached while WASM was unavailable.
   */
  private initializeModule(cutoff: number, resonance: number) {
    // Local fields always reflect the last *sanitized* value; the cached
    // set-* messages take precedence over the construction config.
    const sanitizedCutoff = sanitizeNumber(cutoff, CUTOFF_RANGE);
    if (sanitizedCutoff !== null) {
      this.cutoff = sanitizedCutoff;
    }
    const sanitizedResonance = sanitizeNumber(resonance, RESONANCE_RANGE);
    if (sanitizedResonance !== null) {
      this.resonance = sanitizedResonance;
    }

    try {
      this.worklet = MoogModule.new(this.cutoff, this.resonance);
      this.applyPendingParams();
      this.wasmStatus.wasmFailed = false;
      this.wasmStatus.wasmReady = true;
      this.processingFailed = false;
    } catch (error) {
      console.error("Failed to initialize Moog module", error);
      this.worklet = null;
      this.wasmStatus.wasmFailed = true;
    }
  }

  /** Push every parameter cached before the module existed into the module. */
  private applyPendingParams() {
    if (!this.worklet || this.pending.size === 0) return;

    const pendingCutoff = this.pending.get("cutoff");
    if (pendingCutoff !== undefined) {
      this.cutoff = pendingCutoff;
      this.worklet.set_cutoff(pendingCutoff);
    }
    const pendingResonance = this.pending.get("resonance");
    if (pendingResonance !== undefined) {
      this.resonance = pendingResonance;
      this.worklet.set_resonance(pendingResonance);
    }
    this.pending.clear();
    // A successful module-level write proves the WASM instance is healthy
    // again, so audio can resume.
    this.processingFailed = false;
  }

  private setCutoff(rawCutoff: unknown) {
    const sanitized = sanitizeNumber(rawCutoff, CUTOFF_RANGE);
    if (sanitized === null) {
      console.warn("Ignoring invalid set-cutoff value", rawCutoff);
      return;
    }

    this.cutoff = sanitized;
    if (this.worklet && !this.wasmStatus.wasmFailed) {
      try {
        this.worklet.set_cutoff(sanitized);
        // Recover from a previous processing failure as soon as the module
        // proves it can accept updates again.
        this.processingFailed = false;
      } catch (error) {
        console.error("Failed to update cutoff on WASM module", error);
        this.pending.set("cutoff", sanitized);
      }
    } else {
      // Module not ready yet: cache the latest value, last write wins.
      this.pending.set("cutoff", sanitized);
    }
  }

  private setResonance(rawResonance: unknown) {
    const sanitized = sanitizeNumber(rawResonance, RESONANCE_RANGE);
    if (sanitized === null) {
      console.warn("Ignoring invalid set-resonance value", rawResonance);
      return;
    }

    this.resonance = sanitized;
    if (this.worklet && !this.wasmStatus.wasmFailed) {
      try {
        this.worklet.set_resonance(sanitized);
        // Recover from a previous processing failure as soon as the module
        // proves it can accept updates again.
        this.processingFailed = false;
      } catch (error) {
        console.error("Failed to update resonance on WASM module", error);
        this.pending.set("resonance", sanitized);
      }
    } else {
      // Module not ready yet: cache the latest value, last write wins.
      this.pending.set("resonance", sanitized);
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

          // Process samples using Rust WASM module. cutoff/resonance live
          // on the module itself, so set-* messages take effect immediately.
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
      console.error("Moog processing error", error);
      this.processingFailed = true;
      silenceOutputs(outputs);
      return true;
    }

    // Defense in depth: never let a non-finite sample reach the speakers.
    if (!outputsAreFinite(outputs)) {
      console.error("Moog produced non-finite samples; muting output");
      this.processingFailed = true;
      silenceOutputs(outputs);
    }

    return true;
  }
}

registerProcessor("clawdio-moog", MoogWorklet);

export default MoogWorklet;
