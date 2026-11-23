import init, { MoogModule } from "clawdio-moog";
import {
  asMoogModule,
  createMoogProcessor,
  type MoogProcessorState,
} from "./moogProcessor.ts";

export interface MoogOptions {
  cutoff: number;
  resonance: number;
}

class MoogWorklet extends AudioWorkletProcessor {
  private readonly state: MoogProcessorState;

  constructor() {
    super();

    this.state = createMoogProcessor(this.port, {
      initWasm: init,
      createModule: (cutoff, resonance) =>
        asMoogModule(MoogModule.new(cutoff, resonance)),
    });
    this.port.onmessage = (event) => this.state.effect.handle(event.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    // The effect reports `false` once disposed so the processor gets collected.
    return this.state.effect.process(inputs, outputs);
  }
}

registerProcessor("clawdio-moog", MoogWorklet);
