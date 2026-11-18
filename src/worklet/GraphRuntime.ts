import type { Graph, ModuleDefinition, Connection, ModuleKind } from '../types/graph';
import { Module } from './modules/Module';
import { VCO } from './modules/VCO';
import { VCA } from './modules/VCA';
import { LFO } from './modules/LFO';
import { Slew } from './modules/Slew';
import { Pan } from './modules/Pan';
import { Delay } from './modules/Delay';
import { Rectifier } from './modules/Rectifier';
import { Atten } from './modules/Atten';
import { OutputModule } from './modules/OutputModule';
import { planProcessing } from './orderGraph';

const INPUT_PORTS: Record<string, readonly string[]> = {
  VCO: ['pitch', 'fm'],
  VCA: ['in', 'cv'],
  LFO: ['rate'],
  SLEW: ['in'],
  PAN: ['in', 'pan'],
  DELAY: ['in', 'time', 'feedback', 'mix'],
  RECTIFIER: ['in'],
  ATTEN: ['in'],
  OUTPUT: ['in', 'inL', 'inR'],
};

const OUTPUT_PORTS: Record<string, readonly string[]> = {
  VCO: ['out'],
  VCA: ['out'],
  LFO: ['out'],
  SLEW: ['out'],
  PAN: ['outL', 'outR'],
  DELAY: ['out'],
  RECTIFIER: ['out'],
  ATTEN: ['out'],
  OUTPUT: ['out'],
};

export const getInputPorts = (kind: string): readonly string[] => INPUT_PORTS[kind] ?? [];
export const getOutputPorts = (kind: string): readonly string[] => OUTPUT_PORTS[kind] ?? [];

export const BLOCK_SIZE = 128;

/**
 * The synthesis engine proper: owns the modules, the per-block processing
 * schedule and the feedback delays. Kept free of AudioWorklet specifics so it
 * can be driven directly from tests.
 *
 * Every module is processed at most once per block. The order comes from
 * `planProcessing`: modules always run after everything that feeds them
 * through an acyclic path, and cables that close a loop read the source's
 * output from the previous block instead of this one.
 */
export class GraphRuntime {
  private modules: Map<string, Module> = new Map();
  private order: Module[] = [];
  private outputModule: OutputModule | null = null;
  private historyLinks: Array<{ source: Float32Array; history: Float32Array }> = [];

  loadGraph(graph: Graph): void {
    this.modules.clear();
    this.order = [];
    this.historyLinks = [];
    this.outputModule = null;

    for (const modDef of graph.modules) {
      const module = this.createModule(modDef);
      this.modules.set(modDef.id, module);

      if (modDef.kind === 'OUTPUT') {
        this.outputModule = module as OutputModule;
      }
    }

    this.rebuild(graph.connections || []);
  }

  private createModule(def: ModuleDefinition): Module {
    const moduleClasses: Record<
      ModuleKind,
      new (id: string, kind: string, params: object) => Module
    > = {
      VCO,
      VCA,
      LFO,
      SLEW: Slew,
      PAN: Pan,
      DELAY: Delay,
      RECTIFIER: Rectifier,
      ATTEN: Atten,
      OUTPUT: OutputModule,
    };

    const ModuleClass = moduleClasses[def.kind];
    if (!ModuleClass) {
      throw new Error(`Unknown module kind: ${def.kind}`);
    }

    return new ModuleClass(def.id, def.kind, def.params || {});
  }

  private rebuild(connections: Connection[]): void {
    // The schedule is derived from the cables themselves: strongly connected
    // groups are condensed and sorted topologically, and each cycle is laid
    // out with a DFS so exactly one of its cables closes the loop. See
    // planProcessing().
    const plan = planProcessing(
      [...this.modules.keys()],
      connections.map((conn) => ({ from: conn.from.id, to: conn.to.id }))
    );

    this.order = plan.order.map((id) => this.modules.get(id)!);
    this.historyLinks = [];
    const historyByPort = new Map<string, Float32Array>();

    // Initialize all modules
    for (const module of this.modules.values()) {
      // Initialize output buffers
      for (const port of getOutputPorts(module.kind)) {
        module.outputs[port] = new Float32Array(BLOCK_SIZE);
      }

      // Initialize input buffers and connection tracking
      module.inputs = {};
      module.inputConnections = {};
      for (const port of getInputPorts(module.kind)) {
        module.inputs[port] = new Float32Array(BLOCK_SIZE);
        module.inputConnections[port] = [];
      }
    }

    // Wire connections, choosing between live and one-block-old sources.
    connections.forEach((conn, index) => {
      const fromModule = this.modules.get(conn.from.id);
      const toModule = this.modules.get(conn.to.id);

      if (!fromModule || !toModule) {
        throw new Error(`Invalid connection: ${conn.from.id} -> ${conn.to.id}`);
      }
      if (!getOutputPorts(fromModule.kind).includes(conn.from.port)) {
        throw new Error(
          `Invalid connection: module ${conn.from.id} (${fromModule.kind}) has no output "${conn.from.port}"`
        );
      }
      if (!getInputPorts(toModule.kind).includes(conn.to.port)) {
        throw new Error(
          `Invalid connection: module ${conn.to.id} (${toModule.kind}) has no input "${conn.to.port}"`
        );
      }

      // A cable that closes a loop (or any back edge inside a cycle) cannot
      // read this block's output: it reads the snapshot taken at the end of
      // the previous block, which gives the loop one block of delay.
      let buffer = fromModule.outputs[conn.from.port];
      if (plan.delayed[index]) {
        const key = `${conn.from.id}\u0000${conn.from.port}`;
        let history = historyByPort.get(key);
        if (!history) {
          history = new Float32Array(BLOCK_SIZE);
          historyByPort.set(key, history);
          this.historyLinks.push({ source: buffer, history });
        }
        buffer = history;
      }

      // Track connection: store reference to source output buffer
      toModule.inputConnections[conn.to.port].push({
        buffer,
        sourceId: conn.from.id,
        sourcePort: conn.from.port,
      });
    });
  }

  /** Live parameter edit, no rebuild: module state (phase, delay tail) survives. */
  setParam(id: string, param: string, value: number | string): boolean {
    const module = this.modules.get(id);
    if (!module) return false;
    module.setParam(param, value);
    return true;
  }

  /** Module ids in the order they are processed within a block. */
  get processingOrder(): string[] {
    return this.order.map((module) => module.id);
  }

  getModule(id: string): Module | undefined {
    return this.modules.get(id);
  }

  /** Gathers one module's inputs, summing every cable into the same port. */
  private collectInputs(module: Module): void {
    for (const [portName, sources] of Object.entries(module.inputConnections)) {
      const inputBuffer = module.inputs[portName];

      if (sources.length === 0) {
        // No connection, fill with zero volts
        inputBuffer.fill(0);
      } else if (sources.length === 1) {
        // Single source: copy from source buffer
        const sourceBuffer = sources[0].buffer;
        for (let i = 0; i < BLOCK_SIZE; i++) {
          inputBuffer[i] = sourceBuffer[i];
        }
      } else {
        // Multiple sources: sum into input buffer (banana stacking)
        inputBuffer.fill(0);
        for (const source of sources) {
          for (let i = 0; i < BLOCK_SIZE; i++) {
            inputBuffer[i] += source.buffer[i];
          }
        }
      }
    }
  }

  /** Saves the outputs that feedback cables will read on the next block. */
  private saveFeedbackSnapshots(): void {
    for (const { source, history } of this.historyLinks) {
      history.set(source);
    }
  }

  /** Runs one audio block. Every module runs exactly once. */
  process(): void {
    for (const module of this.order) {
      this.collectInputs(module);
      module.process();
    }
    this.saveFeedbackSnapshots();
  }

  /** Writes the Output module's soft-clipped stereo signal into `channels`. */
  writeOutput(channels: Float32Array[]): void {
    const left = channels[0];
    const right = channels[1];
    if (!left) return;

    if (!this.outputModule) {
      left.fill(0);
      right?.fill(0);
      return;
    }

    const outputModule = this.outputModule;
    const hasLeft = (outputModule.inputConnections.inL?.length ?? 0) > 0;
    const hasRight = (outputModule.inputConnections.inR?.length ?? 0) > 0;
    const leftSource =
      hasLeft && outputModule.inputs.inL ? outputModule.inputs.inL : outputModule.outputs.out;
    const rightSource =
      hasRight && outputModule.inputs.inR ? outputModule.inputs.inR : outputModule.outputs.out;
    const hasStereoInputs = hasLeft || hasRight;
    const drive = outputModule.drive;

    // Apply soft clipping (tanh) to prevent harsh clipping
    for (let i = 0; i < BLOCK_SIZE; i++) {
      let sampleLeft = 0;
      let sampleRight = 0;

      if (hasStereoInputs) {
        sampleLeft =
          hasLeft && leftSource ? leftSource[i] : hasRight && rightSource ? rightSource[i] : 0;
        sampleRight =
          hasRight && rightSource ? rightSource[i] : hasLeft && leftSource ? leftSource[i] : 0;
      } else {
        sampleLeft = leftSource ? leftSource[i] : 0;
        sampleRight = rightSource ? rightSource[i] : sampleLeft;
      }

      left[i] = Math.tanh(sampleLeft * drive);
      if (right) {
        right[i] = Math.tanh(sampleRight * drive);
      }
    }
  }

  /** Render one full block: run the graph, then produce the stereo output. */
  renderBlock(channels: Float32Array[]): void {
    this.process();
    this.writeOutput(channels);
  }

  /** Downsampled output traces, one frame per module that has an output port. */
  scopeFrames(): Array<{ id: string; samples: number[] }> {
    const frames: Array<{ id: string; samples: number[] }> = [];
    for (const module of this.order) {
      const samples = this.getScopeSamples(module);
      if (samples) frames.push({ id: module.id, samples });
    }
    return frames;
  }

  private getScopeSamples(module: Module): number[] | null {
    const outputPorts = getOutputPorts(module.kind);
    const out = outputPorts.includes('out') ? module.outputs.out : undefined;
    const outL = outputPorts.includes('outL') ? module.outputs.outL : undefined;
    const outR = outputPorts.includes('outR') ? module.outputs.outR : undefined;

    if (out) {
      return this.downsample(out);
    }

    if (outL && outR) {
      const mixed = new Float32Array(outL.length);
      for (let i = 0; i < outL.length; i++) {
        mixed[i] = (outL[i] + outR[i]) * 0.5;
      }
      return this.downsample(mixed);
    }

    if (outL) return this.downsample(outL);
    if (outR) return this.downsample(outR);
    return null;
  }

  private downsample(buffer: Float32Array): number[] {
    const target = 32;
    const step = Math.max(1, Math.floor(buffer.length / target));
    const samples: number[] = [];
    for (let i = 0; i < target; i++) {
      samples.push(buffer[i * step]);
    }
    return samples;
  }
}
