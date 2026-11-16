import init, { BitcrusherModule } from "clawdio-bitcrusher";
import type {
  AudioWorkletEventMessage,
  AudioWorkletInitWasmEvent,
  AudioWorkletParamConfirmedEvent,
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

export type BitcrusherBitsConfirmed =
  AudioWorkletParamConfirmedEvent<{ bits: number }>;
export type BitcrusherNormfreqConfirmed =
  AudioWorkletParamConfirmedEvent<{ normfreq: number }>;

export type BitcrusherOptions = {
  bits: number;
};

class BitcrusherWorklet extends AudioWorkletProcessor {
  worklet: BitcrusherModule | null = null;
  bits = 4;
  normfreq = 0.1;

  constructor() {
    super();

    this.port.onmessage = (event) => this.onmessage(event.data);
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
      const { bits } = event.data;
      this.bits = bits;
      // normfreq is supplied in the init config and is read per block inside
      // `process`; sync the local field so the worklet starts with it.
      const normfreq = (event.data as { normfreq?: number }).normfreq;
      if (typeof normfreq === "number") this.normfreq = normfreq;
      this.worklet = BitcrusherModule.new(bits);
    }

    // Setters for internal properties (since we can't mutate this directly)
    if (event.type === "set-bits") {
      this.bits = event.data;

      // Until the WASM module is initialized there is nothing to update.
      // Safely ignore the message instead of throwing.
      if (this.worklet == null) return;

      // Push the new bit depth into the Rust module without resetting its
      // phaser position or held sample, so the next processed block uses it.
      this.worklet.set_bits(this.bits);

      // Confirm the effective value back to the main thread. This is purely
      // informational and does not alter the audio processing result.
      const confirmed: BitcrusherBitsConfirmed = {
        type: "set-bits-confirmed",
        data: { bits: this.bits },
      };
      this.port.postMessage(confirmed);
    }
    if (event.type === "set-normfreq") {
      this.normfreq = event.data;

      // normfreq is passed into `process` per block, so it takes effect on
      // the next block once the module exists; ignore safely until then.
      if (this.worklet == null) return;

      const confirmed: BitcrusherNormfreqConfirmed = {
        type: "set-normfreq-confirmed",
        data: { normfreq: this.normfreq },
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
        const processing = this.worklet.process(inputSamples, this.normfreq);

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

registerProcessor("clawdio-bitcrusher", BitcrusherWorklet);
