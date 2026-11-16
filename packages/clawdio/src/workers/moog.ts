import init, { MoogModule } from "clawdio-moog";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
  AudioWorkletParamConfirmedEvent,
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

export type MoogCutoffConfirmed = AudioWorkletParamConfirmedEvent<{
  cutoff: number;
  resonance: number;
}>;
export type MoogResonanceConfirmed = AudioWorkletParamConfirmedEvent<{
  cutoff: number;
  resonance: number;
}>;

export type MoogOptions = {
  cutoff: number;
  resonance: number;
};

class MoogWorklet extends AudioWorkletProcessor {
  worklet: MoogModule | null = null;
  cutoff = 0.065;
  resonance = 3.5;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
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
      // Keep the local fields in sync with the constructed module so later
      // set_params calls and confirmation messages report the real values.
      this.cutoff = cutoff;
      this.resonance = resonance;
      this.worklet = MoogModule.new(cutoff, resonance);
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-cutoff") {
      this.cutoff = event.data;

      // Until the WASM module is initialized there is nothing to update.
      // Safely ignore the message instead of throwing.
      if (this.worklet == null) return;

      // Push both parameters into the Rust module together. The module keeps
      // its four pole outputs and input histories, so the filter state is
      // not reset and the next processed block uses the new cutoff.
      this.worklet.set_params(this.cutoff, this.resonance);

      // Confirm the effective values back to the main thread. This is purely
      // informational and does not alter the audio processing result.
      const confirmed: MoogCutoffConfirmed = {
        type: "set-cutoff-confirmed",
        data: { cutoff: this.cutoff, resonance: this.resonance },
      };
      this.port.postMessage(confirmed);
    }
    if (event.type === "set-resonance") {
      this.resonance = event.data;

      // Until the WASM module is initialized there is nothing to update.
      // Safely ignore the message instead of throwing.
      if (this.worklet == null) return;

      // Push both parameters into the Rust module together without resetting
      // the filter's internal state; the next block uses the new resonance.
      this.worklet.set_params(this.cutoff, this.resonance);

      const confirmed: MoogResonanceConfirmed = {
        type: "set-resonance-confirmed",
        data: { cutoff: this.cutoff, resonance: this.resonance },
      };
      this.port.postMessage(confirmed);
    }
  };

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // Check if we have worklet initialized
    if (this.worklet == null) return true;

    inputs.forEach((channels, channelIndex) => {
      channels.forEach((inputSamples, sampleIndex) => {
        // We check again since TS insists (and maybe it changes over course of loop?)
        if (this.worklet == null) return true;

        // Process samples using Rust WASM module
        const processing = this.worklet.process(inputSamples);

        // Make sure you loop through each output value and assign it manually
        // can't just assign a whole array
        processing.forEach(
          (val, index) => (outputs[channelIndex][sampleIndex][index] = val)
        );
      });
    });

    // outputs = inputs;

    return true;
  }
}

registerProcessor("clawdio-moog", MoogWorklet);
