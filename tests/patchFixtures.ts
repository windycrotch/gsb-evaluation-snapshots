import type {
  Connection,
  Graph,
  ModuleDefinition,
  ModuleKind,
  ModuleParams,
} from '../src/types/graph';

/** Small builders for hand-made test patches. */

export const mod = (id: string, kind: ModuleKind, params?: ModuleParams): ModuleDefinition => ({
  id,
  kind,
  params,
});

export const cable = (
  fromId: string,
  fromPort: string,
  toId: string,
  toPort: string
): Connection => ({
  from: { id: fromId, port: fromPort },
  to: { id: toId, port: toPort },
});

export const patch = (modules: ModuleDefinition[], connections: Connection[]): Graph => ({
  modules,
  connections,
});

export const BLOCK = 128;

/** Renders `blocks` audio blocks and returns the last stereo block. */
export function renderBlocks(
  runtime: { renderBlock(channels: Float32Array[]): void },
  blocks = 1
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let block = 0; block < blocks; block += 1) {
    runtime.renderBlock([left, right]);
  }
  return { left, right };
}

export function rms(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

/** Records how many times a module's process() runs. */
export function countProcessCalls(module: { process(): void }): { readonly count: number } {
  const original = module.process.bind(module);
  let count = 0;
  module.process = () => {
    count += 1;
    original();
  };
  return {
    get count() {
      return count;
    },
  };
}
