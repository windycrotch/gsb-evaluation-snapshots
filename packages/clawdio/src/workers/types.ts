export type AudioWorkletEventMessage<T> = {
  type: string;
  data: T;
};

export type AudioWorkletClientEvent<T> = {
  data: T;
};

export interface AudioWorkletInitWasmEvent
  extends AudioWorkletEventMessage<ArrayBuffer> {
  type: "init-wasm";
  data: ArrayBuffer;
}

/**
 * Confirmation posted back to the main thread after a parameter update has
 * been applied to the underlying WASM module. It only reports the effective
 * parameter values and never influences the audio processing itself.
 */
export interface AudioWorkletParamConfirmedEvent<T>
  extends AudioWorkletEventMessage<T> {
  type:
    | "set-bits-confirmed"
    | "set-normfreq-confirmed"
    | "set-cutoff-confirmed"
    | "set-resonance-confirmed";
  data: T;
}
