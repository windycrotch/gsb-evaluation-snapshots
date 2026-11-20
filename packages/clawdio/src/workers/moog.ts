import init, { MoogModule } from "clawdio-moog";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
} from "./types";
import { initWasm } from "./utils";

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

const MIN_CUTOFF = 0;
const MAX_CUTOFF = 1;
const MIN_RESONANCE = 0;
const MAX_RESONANCE = 10;

const sanitizeCutoff = (cutoff: number): number => {
  if (!Number.isFinite(cutoff)) {
    return cutoff === Number.POSITIVE_INFINITY ? MAX_CUTOFF : MIN_CUTOFF;
  }
  return Math.min(MAX_CUTOFF, Math.max(MIN_CUTOFF, cutoff));
};

const sanitizeResonance = (resonance: number): number => {
  if (!Number.isFinite(resonance)) {
    return resonance === Number.POSITIVE_INFINITY
      ? MAX_RESONANCE
      : MIN_RESONANCE;
  }
  return Math.min(MAX_RESONANCE, Math.max(MIN_RESONANCE, resonance));
};

class MoogWorklet extends AudioWorkletProcessor {
  worklet: MoogModule | null = null;
  cutoff = 0.065;
  resonance = 3.5;
  // Parameter requests that arrive before the WASM module exists. They are
  // folded into module creation so no setter is ever silently dropped.
  private pendingCutoff: number | null = null;
  private pendingResonance: number | null = null;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
  }

  /**
   * Factory seam. Production code constructs the real WASM module; tests can
   * override it to simulate construction failures.
   */
  protected createModule(cutoff: number, resonance: number): MoogModule {
    return MoogModule.new(cutoff, resonance);
  }

  onmessage = (
    event:
      | AudioWorkletInitWasmEvent
      | MoogEventInitModule
      | MoogEventSetCutoff
      | MoogEventSetResonance
  ) => {
    // Handle loading WASM module
    initWasm(event as AudioWorkletInitWasmEvent, init, this.port);

    if (event.type === "init-module") {
      const { cutoff = 0.065, resonance = 3.5 } = event.data;
      this.cutoff = sanitizeCutoff(this.pendingCutoff ?? cutoff);
      this.resonance = sanitizeResonance(this.pendingResonance ?? resonance);
      this.pendingCutoff = null;
      this.pendingResonance = null;

      try {
        this.worklet = this.createModule(this.cutoff, this.resonance);
      } catch (error) {
        this.port.postMessage({
          type: "init-module-failed",
          data: { error: String(error) },
        });
      }
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-cutoff") {
      this.cutoff = sanitizeCutoff(event.data);
      this.applyParamsToModule();
    }
    if (event.type === "set-resonance") {
      this.resonance = sanitizeResonance(event.data);
      this.applyParamsToModule();
    }
  };

  /**
   * Push the latest parameters into the live WASM module. The Rust side
   * updates its coefficients in place and keeps the four-pole filter state,
   * so parameter changes cross-fade instead of clicking. Messages are
   * processed serially, so after a burst of setters the module holds the
   * value from the last message.
   */
  private applyParamsToModule() {
    if (this.worklet == null) {
      // Module not built yet: remember the latest request.
      this.pendingCutoff = this.cutoff;
      this.pendingResonance = this.resonance;
      return;
    }

    try {
      this.worklet.set_cutoff(this.cutoff);
      this.worklet.set_resonance(this.resonance);
    } catch (error) {
      // The module keeps its previous parameters; audio continues.
      this.port.postMessage({
        type: "set-params-failed",
        data: {
          cutoff: this.cutoff,
          resonance: this.resonance,
          error: String(error),
        },
      });
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // Check if we have worklet initialized
    if (this.worklet == null) return true;

    // Snapshot once per block: a setter message arriving mid-block cannot
    // change coefficients halfway through a block (no intra-block zipper),
    // and the next block picks up the newest values.
    const module = this.worklet;

    inputs.forEach((channels, channelIndex) => {
      channels.forEach((inputSamples, sampleIndex) => {
        // Process samples using Rust WASM module
        const processing = module.process(inputSamples);

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

registerProcessor("clawdio-moog", MoogWorklet);
