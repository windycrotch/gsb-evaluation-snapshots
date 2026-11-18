import type { Graph } from '../types/graph';
import type { WorkletMessage } from '../types/messages';
import { GraphRuntime } from './GraphRuntime';

/**
 * AudioWorklet shell: message plumbing and block rendering only. The
 * synthesis graph itself lives in {@link GraphRuntime} so it can also be
 * exercised outside the audio thread. See `orderGraph.ts` for how the per-block
 * schedule and feedback delays are derived.
 */
export class ModularProcessor extends AudioWorkletProcessor {
  private readonly runtime = new GraphRuntime();
  private scopeTick = 0;
  private readonly scopeStride = 12;

  constructor() {
    super();
    this.port.onmessage = (e) => this.handleMsg(e.data as WorkletMessage);
  }

  handleMsg(msg: WorkletMessage): void {
    if (msg.type === 'setParam') {
      this.runtime.setParam(msg.id, msg.param, msg.value);
      return;
    }
    if (msg.type === 'loadGraph') {
      try {
        this.loadGraph(msg.graph);
        this.port.postMessage({ type: 'graphLoaded', success: true });
      } catch (err) {
        this.port.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  loadGraph(graph: Graph): void {
    this.runtime.loadGraph(graph);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    this.runtime.renderBlock(outputs[0] ?? []);

    this.scopeTick += 1;
    if (this.scopeTick % this.scopeStride === 0) {
      const frames = this.runtime.scopeFrames();
      if (frames.length > 0) {
        this.port.postMessage({ type: 'scopeData', frames });
      }
    }

    return true;
  }
}
