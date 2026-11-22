import type { ModuleParams } from '../../types/graph';

export interface ConnectionSource {
  buffer: Float32Array;
  sourceId: string;
  sourcePort: string;
}

export abstract class Module {
  id: string;
  kind: string;
  params: ModuleParams;
  inputs: Record<string, Float32Array>;
  outputs: Record<string, Float32Array>;
  inputConnections: Record<string, ConnectionSource[]>;
  scratchBuffers: Map<string, Float32Array>;

  constructor(id: string, kind: string, params: ModuleParams = {}) {
    this.id = id;
    this.kind = kind;
    this.params = params;
    this.inputs = {};
    this.outputs = {};
    this.inputConnections = {};
    this.scratchBuffers = new Map();
  }

  abstract process(): void;

  /**
   * Live parameter update from the UI. Subclasses that cache params in
   * fields override applyParams() to re-read them; there is no rebuild, so
   * oscillator phases and delay buffers survive the change.
   */
  setParam(key: string, value: number | string): void {
    (this.params as Record<string, number | string>)[key] = value;
    this.applyParams();
  }

  protected applyParams(): void {}

  /**
   * Called by the processor when a structural reload creates a fresh module
   * with the same id and kind as one that already existed. Subclasses with
   * internal DSP state (oscillator phase, delay line, integrator...) copy
   * that state across, so a graph rebuild does not click, mute or reset
   * feedback-loop dynamics. Parameter-only edits never rebuild at all and
   * therefore never reach this path.
   */
  adoptState(_previous: Module): void {}

  /**
   * Replace any non-finite output sample with silence. A NaN or Infinity
   * injected into a feedback loop would otherwise circulate forever and
   * make every downstream module blow up as well.
   */
  protected sanitizeOutputs(): void {
    for (const port of Object.keys(this.outputs)) {
      const buffer = this.outputs[port];
      for (let i = 0; i < buffer.length; i++) {
        if (!Number.isFinite(buffer[i])) buffer[i] = 0;
      }
    }
  }

  getScratchBuffer(): Float32Array {
    if (!this.scratchBuffers.has('temp')) {
      this.scratchBuffers.set('temp', new Float32Array(128));
    }
    return this.scratchBuffers.get('temp')!;
  }
}
