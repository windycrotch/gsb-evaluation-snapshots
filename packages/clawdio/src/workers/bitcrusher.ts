import init, { BitcrusherModule } from "clawdio-bitcrusher";
import {
  asBitcrusherModule,
  createBitcrusherProcessor,
  type BitcrusherProcessorState,
} from "./bitcrusherProcessor.ts";

export interface BitcrusherOptions {
  bits: number;
  normfreq: number;
}

class BitcrusherWorklet extends AudioWorkletProcessor {
  private readonly state: BitcrusherProcessorState;

  constructor() {
    super();

    this.state = createBitcrusherProcessor(this.port, {
      initWasm: init,
      createModule: (bits) => asBitcrusherModule(BitcrusherModule.new(bits)),
    });
    this.port.onmessage = (event) => this.state.effect.handle(event.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // The effect reports `false` once disposed so the processor gets collected.
    return this.state.effect.process(inputs, outputs);
  }
}

registerProcessor("clawdio-bitcrusher", BitcrusherWorklet);
